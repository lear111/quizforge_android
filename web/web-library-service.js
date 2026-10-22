const FEATURE_NAMES = ['editing', 'whiteboard', 'history', 'exam'];
const failure = (status, code, message) => Object.assign(new Error(message), {status, code});

// These capabilities describe this Android host; bank feature flags still retain
// the author's settings. The practice adapter applies effective capabilities.
export const ANDROID_CAPABILITIES = Object.freeze({
  import: true,
  libraryManagement: true,
  editing: true,
  export: true,
  network: false,
  ai: false,
  development: false,
  exam: false,
  cloudSync: false,
  login: false,
});

// Hide only unavailable operations. The original settings entry and appearance
// panel stay available, as do practice, history, draft and navigation controls.
export const ANDROID_UNAVAILABLE_SELECTORS = Object.freeze([
  '#development-badge', '#development-publish-open', '#development-edit', '#development-return',
  '#exam-start', '#exam-submit', '#exam-status', '#exam-return',
  '#settings-network-tab', '#settings-ai-tab', '#settings-development-tab',
  '#network-settings-form', '#ai-settings-panel', '#development-settings-panel',
]);

function featuresFor(value) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    throw failure(500, 'INVALID_LIBRARY_INDEX', '本机题库的功能设置无法读取，原数据已保留');
  }
  return Object.fromEntries(FEATURE_NAMES.map(name => {
    if (value?.[name] !== undefined && typeof value[name] !== 'boolean') {
      throw failure(500, 'INVALID_LIBRARY_INDEX', '本机题库的功能设置无法读取，原数据已保留');
    }
    return [name, value?.[name] !== false];
  }));
}

function bankDescriptor(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.id !== 'string' || !row.id.trim()
      || typeof row.title !== 'string' || !row.title.trim()
      || !Number.isSafeInteger(row.questionCount) || row.questionCount < 0
      || (row.group !== undefined && typeof row.group !== 'string')) {
    throw failure(500, 'INVALID_LIBRARY_INDEX', '本机题库目录无法读取，原数据已保留');
  }
  const group = row.group ?? '';
  const descriptor = {
    id: row.id, kind: 'bank', title: row.title, group,
    // This is an opaque library identity, never a filesystem path.
    path: group ? `${group}/${row.id}` : row.id,
    questionCount: row.questionCount, features: featuresFor(row.features),
  };
  if (Number.isSafeInteger(row.importedAt) && row.importedAt >= 0) descriptor.importedAt = row.importedAt;
  return descriptor;
}

function readOnly(method, message) {
  if (method !== 'GET') throw failure(409, 'ANDROID_FEATURE_UNAVAILABLE', message);
}

/** REST-shaped metadata for the unchanged Web interface, with no network I/O. */
export function createLibraryService(nativeCall, options = {}) {
  if (typeof nativeCall !== 'function') throw new TypeError('nativeCall must be a function');
  const canManage=options.canManage??options.canImport!==false;
  const capabilities = {...ANDROID_CAPABILITIES,import:canManage&&options.canImport!==false,libraryManagement:canManage,export:canManage,
    exam:options.examEnabled===true,ai:options.aiEnabled===true,network:options.networkEnabled===true};
  async function catalog(){
    const value=await nativeCall('library.catalog',{});
    if(!value||!Array.isArray(value.banks))throw failure(500,'INVALID_LIBRARY_INDEX','本机题库目录无法读取，原数据已保留');
    const banks=value.banks.map(bankDescriptor),ids=new Set(banks.map(row=>row.id));
    if(ids.size!==banks.length)throw failure(500,'INVALID_LIBRARY_INDEX','本机题库目录包含重复编号，原数据已保留');
    const groups=Array.isArray(value.groups)?value.groups:value.groups?.banks;
    if(groups!==undefined&&(!Array.isArray(groups)||groups.some(g=>typeof g!=='string'||!g.trim())))throw failure(500,'INVALID_LIBRARY_INDEX','本机题库分组无法读取，原数据已保留');
    return {banks,extensions:[],groups:{banks:[...new Set([...(groups||[]),...banks.map(b=>b.group).filter(Boolean)])],extensions:[]},canManage:capabilities.libraryManagement,developmentEnabled:false,capabilities:{...capabilities}};
  }
  function requestBody(value){if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw failure(400,'INVALID_REQUEST','请求不是有效的 JSON');}}if(!value||typeof value!=='object'||Array.isArray(value))throw failure(400,'INVALID_REQUEST','目录操作内容无效');return value;}
  function requireManage(){if(!capabilities.libraryManagement)throw failure(403,'FEATURE_DISABLED','当前主机没有开放题库管理');}
  function selectedBank(index,path){const row=index.banks.find(b=>b.path===path||b.id===path);if(!row)throw failure(404,'BANK_NOT_FOUND','题库已移动或不存在，请刷新目录后重试');return row;}
  return {
    async handle({path, method = 'GET',body=null} = {}) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return undefined;
      const pathname = path.split(/[?#]/, 1)[0];
      if (typeof method !== 'string') throw failure(400, 'INVALID_REQUEST', '请求方法无效');
      method = method.toUpperCase();
      if (pathname === '/api/library/index') {
        readOnly(method, '安卓离线版的题库目录由本机文件管理');
        return catalog();
      }
      if(pathname==='/api/library/manage'&&method==='POST'){
        requireManage();const value=requestBody(body);
        if(value.kind!=='bank'||!['item','group'].includes(value.target)||!['create','update','delete'].includes(value.action)||value.target==='item'&&value.action==='create')throw failure(400,'INVALID_REQUEST','目录操作类型无效');
        const before=await catalog(),args={kind:'bank',target:value.target,action:value.action};let affected=[];
        if(value.target==='item'){const bank=selectedBank(before,value.path);args.bankId=bank.id;args.path=bank.path;affected=[bank.id];}
        else{if(value.action!=='create'&&(typeof value.path!=='string'||!before.groups.banks.includes(value.path)))throw failure(404,'GROUP_NOT_FOUND','分组已移动或不存在，请刷新目录后重试');args.path=value.path||'';if(value.action!=='create')affected=before.banks.filter(b=>b.group===args.path||b.group.startsWith(args.path+'/')).map(b=>b.id);}
        if(value.action!=='delete'){if(typeof value.name!=='string'||!value.name.trim()||value.name.length>300||typeof(value.group??'')!=='string')throw failure(400,'INVALID_REQUEST','名称或分组无效');args.name=value.name.trim();args.group=value.group||'';}
        const changed=await nativeCall('library.change',args);
        for(const id of affected)await options.host?.invalidate?.(id,{deleted:value.action==='delete'});
        const after=await catalog();
        return {...changed,catalog:after,...(value.action==='delete'?{archivedTo:changed.archivedTo||'本机题库回收目录'}:{})};
      }
      if(pathname==='/api/library/export'&&method==='POST'){
        requireManage();const value=requestBody(body);let args;
        if(typeof value.bank==='string'&&value.group===undefined)args={bankId:selectedBank(await catalog(),value.bank).id};
        else if(typeof value.group==='string'&&value.bank===undefined){const index=await catalog();if(!index.groups.banks.includes(value.group))throw failure(404,'GROUP_NOT_FOUND','分组不存在');args={group:value.group};}
        else throw failure(400,'INVALID_REQUEST','请选择一个题库或分组导出');
        return nativeCall('library.export',args);
      }
      if(pathname==='/api/library/trash'&&method==='GET'){requireManage();return nativeCall('library.trash',{});}
      if(pathname==='/api/library/restore'&&method==='POST'){requireManage();const value=requestBody(body);if(typeof value.trashId!=='string'||!value.trashId)throw failure(400,'INVALID_REQUEST','回收记录无效');const changed=await nativeCall('library.restore',{trashId:value.trashId});for(const row of changed.restored||[])await options.host?.invalidate?.(row.id);return {...changed,catalog:await catalog()};}
      if (pathname === '/api/settings/development') {
        readOnly(method, '安卓离线版暂不提供题型拓展开发管理');
        return {enabled: false, canManage: false};
      }
      if (pathname === '/api/settings/network') {
        readOnly(method, '安卓离线版直接读取本机题库，无需开启网络服务');
        return {
          enabled: false, publicEnabled: false, publicUrl: '', port: 8787,
          passwordConfigured: false, canManage: false, offline: true,
          urls: [], publicIpv6Urls: [], ipv6Supported: false,
          tailscale: {state: 'unavailable'}, https: null,
        };
      }
      if (pathname === '/api/settings/ai') {
        readOnly(method, '安卓离线版暂不提供在线 AI 评分设置');
        return {enabled: false, autoGrade: false, baseUrl: '', model: '', apiKeyConfigured: false, canManage: false};
      }
      if (['/api/library/import', '/api/library/export', '/api/library/manage'].includes(pathname)) {
        const message = pathname === '/api/library/import'
          ? '请通过题库列表的导入按钮，使用 Android 文件选择器导入 .qbank'
          : '安卓离线版暂不提供题库目录编辑和导出';
        throw failure(409, 'ANDROID_FEATURE_UNAVAILABLE', message);
      }
      if (pathname.startsWith('/api/settings/network/') || pathname.startsWith('/api/settings/ai/')) {
        throw failure(409, 'ANDROID_FEATURE_UNAVAILABLE', '此设置需要在线主机服务，安卓离线版暂不提供');
      }
      if (pathname === '/api/auth/login') {
        throw failure(409, 'ANDROID_FEATURE_UNAVAILABLE', '安卓离线版使用本机数据，无需登录');
      }
      return undefined;
    },
  };
}
