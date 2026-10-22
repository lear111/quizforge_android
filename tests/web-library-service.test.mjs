import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {createLibraryService, ANDROID_CAPABILITIES, ANDROID_UNAVAILABLE_SELECTORS} from '../web/web-library-service.js';

const firstId = '798f3e09-866e-4d8f-bb37-bb7ea8cfa158';
const secondId = '406b34a4-e906-4d09-a259-7669dd498210';
const descriptors = () => [
  {id: firstId, title: '阅读理解', group: '英语', questionCount: 3, features: {editing: true, whiteboard: false, history: true, exam: false}, importedAt: 1234},
  {id: secondId, title: '独立题库', group: '', questionCount: 1, features: {}, importedAt: 2345},
];

test('native catalog preserves installed identities, labels, grouping and authored feature flags', async () => {
  const source = descriptors(), calls = [];
  source[0].questions = [{answer: 'private'}];
  source[0].bankPath = 'private/source.json';
  const service = createLibraryService(async (...args) => {calls.push(args); return {banks:source,groups:['空分组']};});
  const index = await service.handle({path: '/api/library/index'});
  assert.deepEqual(calls, [['library.catalog', {}]]);
  assert.deepEqual(index.banks.map(row => [row.id, row.kind, row.title, row.group, row.questionCount]), [
    [firstId, 'bank', '阅读理解', '英语', 3], [secondId, 'bank', '独立题库', '', 1],
  ]);
  assert.deepEqual(index.banks[0].features, source[0].features);
  assert.deepEqual(index.banks[1].features, {editing: true, whiteboard: true, history: true, exam: true});
  assert.equal(index.banks[0].importedAt, 1234);
  assert.deepEqual(index.groups, {banks: ['空分组','英语'], extensions: []});
  assert.deepEqual(index.extensions, []);
  assert.equal(index.canManage, true);
  assert.equal(index.developmentEnabled, false);
  assert.equal(index.banks[0].questions, undefined);
  assert.equal(index.banks[0].bankPath, undefined);
  index.banks[0].features.whiteboard = true;
  index.capabilities.import = false;
  assert.equal(source[0].features.whiteboard, false);
  assert.equal((await service.handle({path: '/api/library/index'})).capabilities.import, true);
});

test('each refresh sees newly imported banks without caching or reading private bank content', async () => {
  const rows = [];
  const service = createLibraryService(async method => {assert.equal(method, 'library.catalog'); return {banks:structuredClone(rows),groups:[]};});
  assert.deepEqual((await service.handle({path: '/api/library/index?refresh=1'})).banks, []);
  rows.push(...descriptors(), {...descriptors()[0], id: '99838bca-6490-4944-a86a-3beb0307fdce'});
  const value = await service.handle({path: '/api/library/index'});
  assert.equal(value.banks.length, 3);
  assert.deepEqual(value.groups.banks, ['英语']);
});

test('offline startup and settings reads never call native storage or claim online services', async () => {
  const service = createLibraryService(async () => {throw new Error('unexpected native call');});
  assert.deepEqual(await service.handle({path: '/api/settings/development'}), {enabled: false, canManage: false});
  const network = await service.handle({path: '/api/settings/network?refresh=1'});
  assert.equal(network.offline, true);
  assert.equal(network.canManage, false);
  assert.equal(network.enabled, false);
  assert.equal(network.publicEnabled, false);
  assert.deepEqual(network.urls, []);
  assert.deepEqual(network.publicIpv6Urls, []);
  assert.equal(network.https, null);
  const ai = await service.handle({path: '/api/settings/ai'});
  assert.equal(ai.enabled, false);
  assert.equal(ai.apiKeyConfigured, false);
  assert.equal(ai.canManage, false);
});

test('unsupported writes and login fail explicitly without side effects', async () => {
  let calls = 0;
  const service = createLibraryService(async () => {calls++;});
  for (const [path, method] of [
    ['/api/library/index', 'POST'], ['/api/settings/development', 'PUT'],
    ['/api/settings/network', 'PUT'], ['/api/settings/network/https/regenerate', 'POST'],
    ['/api/settings/ai', 'PUT'], ['/api/settings/ai/credential', 'GET'], ['/api/settings/ai/test', 'POST'],
    ['/api/library/import', 'POST'],
    ['/api/auth/login', 'POST'],
  ]) {
    await assert.rejects(service.handle({path, method, body: {anything: true}}), error => error.status === 409 && error.code === 'ANDROID_FEATURE_UNAVAILABLE');
  }
  assert.equal(calls, 0);
});

test('practice, resources, SDK and unknown routes remain available to the practice adapter', async () => {
  const service = createLibraryService(async () => {throw new Error('unexpected native call');});
  for (const path of [
    '/api/collections/bank/a', '/api/resources/abc', '/api/sdk/x/1.0.0', '/api/extensions/a/1/page',
    '/api/library/index-extra', '/unrelated', '//other.example/api/library/index', 'https://other.example/api/library/index',
  ]) assert.equal(await service.handle({path}), undefined);
});

test('corrupt catalog data is rejected explicitly instead of presenting a partial or empty library', async () => {
  const invalid = [
    null, {}, [null], [{...descriptors()[0], id: ''}], [{...descriptors()[0], title: ''}],
    [{...descriptors()[0], questionCount: -1}], [{...descriptors()[0], questionCount: 1.5}],
    [{...descriptors()[0], group: {}}], [{...descriptors()[0], features: []}],
    [{...descriptors()[0], features: {history: 'false'}}], [descriptors()[0], descriptors()[0]],
  ];
  for (const rows of invalid) {
    await assert.rejects(createLibraryService(async () => ({banks:rows})).handle({path: '/api/library/index'}), error => error.status === 500 && error.code === 'INVALID_LIBRARY_INDEX');
  }
});

test('native read failure remains an error and a later refresh can recover', async () => {
  let fail = true;
  const cause = Object.assign(new Error('storage unavailable'), {code: 'STORAGE_UNAVAILABLE'});
  const service = createLibraryService(async () => {if (fail) throw cause; return {banks:descriptors()};});
  await assert.rejects(service.handle({path: '/api/library/index'}), error => error === cause);
  fail = false;
  assert.equal((await service.handle({path: '/api/library/index'})).banks.length, 2);
});

test('host capability selectors retain original settings, appearance, import and practice entries', async () => {
  const html = await readFile(new URL('../vendor/quizforge-web/core/web/index.html', import.meta.url), 'utf8');
  const {document} = new JSDOM(html).window;
  for (const selector of ANDROID_UNAVAILABLE_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) node.remove();
  }
  for (const id of ['library-import', 'refresh', 'network-settings-open', 'settings-appearance-tab', 'appearance-settings-panel', 'history-open', 'draft-toggle', 'previous', 'next', 'outline-toggle']) {
    assert.ok(document.getElementById(id), `${id} should remain usable`);
  }
  assert.equal(document.getElementById('settings-network-tab'), null);
  assert.equal(document.getElementById('settings-ai-tab'), null);
  assert.ok(document.getElementById('library-new-group'));
  assert.ok(document.getElementById('edit-open'));
  assert.equal(ANDROID_CAPABILITIES.login, false);
  assert.equal(ANDROID_CAPABILITIES.cloudSync, false);
  const locked = await createLibraryService(async () => ({banks:[]}), {canImport: false}).handle({path: '/api/library/index'});
  assert.equal(locked.canManage, false);
  assert.equal(locked.capabilities.import, false);
});

function managedFixture(){
 let banks=descriptors(),groups=['英语','空分组'],exportResult={exported:true,filename:'本机题库.qbank'},fail=null;const calls=[],invalidated=[],trash=[];
 const native=async(method,args={})=>{
  calls.push({method,args:structuredClone(args)});if(fail&&method!=='library.catalog')throw fail;
  if(method==='library.catalog')return {banks:structuredClone(banks),groups:[...groups],trash:structuredClone(trash)};
  if(method==='library.change'){
   if(args.target==='group'&&args.action==='create')groups.push(args.name);
   else if(args.target==='group'&&args.action==='update'){groups=groups.map(g=>g===args.path?args.name:g);for(const b of banks)if(b.group===args.path)b.group=args.name;}
   else if(args.action==='delete'){const removed=banks.filter(b=>args.target==='item'?b.id===args.bankId:b.group===args.path);banks=banks.filter(b=>!removed.includes(b));if(args.target==='group')groups=groups.filter(g=>g!==args.path);trash.push({id:'trash-'+trash.length,banks:structuredClone(removed)});return {trashId:trash.at(-1).id,archivedTo:'回收站/'+trash.at(-1).id,removedBanks:removed.map(b=>b.id)};}
   else{const bank=banks.find(b=>b.id===args.bankId);bank.title=args.name;bank.group=args.group;}
   return {changed:true};
  }
  if(method==='library.export')return structuredClone(exportResult);
  if(method==='library.trash')return {records:trash.map(({id})=>({id}))};
  if(method==='library.restore'){const row=trash.find(r=>r.id===args.trashId);banks.push(...row.banks);trash.splice(trash.indexOf(row),1);return {restored:structuredClone(row.banks)};}
  throw Error('Unexpected '+method);
 };
 return {service:createLibraryService(native,{host:{invalidate:async(...args)=>invalidated.push(args)}}),calls,invalidated,get banks(){return structuredClone(banks);},fail(value){fail=value;},export(value){exportResult=value;}};
}
const manage=(s,body)=>s.handle({path:'/api/library/manage',method:'POST',body});

test('original group creation/rename and bank rename/move retain opaque bank identity and author flags',async()=>{
 const f=managedFixture(),s=f.service;
 await manage(s,{kind:'bank',target:'group',action:'create',name:'新分组',group:''});assert.equal(f.invalidated.length,0);
 let result=await manage(s,{kind:'bank',target:'item',action:'update',path:'英语/'+firstId,name:'更新名称',group:'新分组'});
 assert.equal(result.catalog.banks[0].id,firstId);assert.equal(result.catalog.banks[0].title,'更新名称');assert.equal(result.catalog.banks[0].group,'新分组');assert.equal(result.catalog.banks[0].features.whiteboard,false);
 assert.deepEqual(f.calls.find(c=>c.method==='library.change'&&c.args.target==='item').args,{kind:'bank',target:'item',action:'update',bankId:firstId,path:'英语/'+firstId,name:'更新名称',group:'新分组'});
 result=await manage(s,{kind:'bank',target:'group',action:'update',path:'新分组',name:'重命名组',group:''});assert.equal(result.catalog.banks[0].group,'重命名组');assert.ok(result.catalog.groups.banks.includes('空分组'));assert.deepEqual(f.invalidated,[[firstId,{deleted:false}],[firstId,{deleted:false}]]);
});

test('original delete archives only the selected bank and restore refreshes that same native identity',async()=>{
 const f=managedFixture(),s=f.service,result=await manage(s,{kind:'bank',target:'item',action:'delete',path:'英语/'+firstId});
 assert.equal(result.archivedTo,'回收站/trash-0');assert.equal(result.catalog.banks.length,1);assert.equal(result.catalog.banks[0].id,secondId);assert.deepEqual(f.invalidated,[[firstId,{deleted:true}]]);
 assert.deepEqual(await s.handle({path:'/api/library/trash'}),{records:[{id:'trash-0'}]});const restored=await s.handle({path:'/api/library/restore',method:'POST',body:{trashId:'trash-0'}});assert.ok(restored.catalog.banks.some(b=>b.id===firstId));assert.deepEqual(f.invalidated.at(-1),[firstId]);
});

test('SAF export maps original bank/group selection to native identity and preserves cancellation/failure',async()=>{
 const f=managedFixture(),s=f.service;
 assert.deepEqual(await s.handle({path:'/api/library/export',method:'POST',body:{bank:'英语/'+firstId}}),{exported:true,filename:'本机题库.qbank'});
 assert.deepEqual(f.calls.at(-1),{method:'library.export',args:{bankId:firstId}});
 f.export({cancelled:true});assert.deepEqual(await s.handle({path:'/api/library/export',method:'POST',body:{group:'英语'}}),{cancelled:true});assert.deepEqual(f.calls.at(-1).args,{group:'英语'});
 const io=Object.assign(Error('导出没有写入文件'),{code:'IO_ERROR'});f.fail(io);await assert.rejects(s.handle({path:'/api/library/export',method:'POST',body:{bank:'英语/'+firstId}}),e=>e===io);
});

test('stale/forged management targets and native write failures leave metadata and active sessions intact',async()=>{
 const f=managedFixture(),s=f.service,before=f.banks;
 for(const body of[{kind:'extension',target:'item',action:'delete',path:firstId},{kind:'bank',target:'item',action:'update',path:'../../private',name:'x',group:''},{kind:'bank',target:'group',action:'delete',path:'missing'},{kind:'bank',target:'item',action:'create',name:'x'}])await assert.rejects(manage(s,body),e=>[400,404].includes(e.status));
 assert.equal(f.calls.some(c=>c.method==='library.change'),false);
 const io=Object.assign(Error('目录写入失败'),{code:'IO_ERROR'});f.fail(io);await assert.rejects(manage(s,{kind:'bank',target:'item',action:'update',path:'英语/'+firstId,name:'x',group:''}),e=>e===io);assert.deepEqual(f.banks,before);assert.deepEqual(f.invalidated,[]);
});
