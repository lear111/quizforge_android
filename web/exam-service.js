import {createPracticeService} from './web-practice-service.js';

const copy=value=>value==null?value:JSON.parse(JSON.stringify(value));
const failure=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const path=(id,suffix='')=>`/api/collections/bank/${encodeURIComponent(id)}${suffix}`;
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);

/** Offline exam host. Deadlines and snapshots survive app termination. */
export function createExamService(nativeCall,{practice,loadText,resourceContext=()=>null,now=()=>Date.now(),makePractice=createPracticeService}={}){
  const records=new Map(),queues=new Map();let loading;
  const enqueue=(key,fn)=>{const task=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(fn);queues.set(key,task);return task;};
  async function initialize(){
    if(!loading)loading=(async()=>{
      for(const id of await nativeCall('documents.list',{namespace:'exam'})){
        const value=await nativeCall('documents.read',{namespace:'exam',key:id});
        if(!object(value)||value.id!==id||!value.snapshot||!['in-progress','grading','completed','deleted'].includes(value.status))throw failure('EXAM_UNAVAILABLE','考试记录无法读取，已保留原文件',503);
        records.set(id,{value});
      }
    })().catch(error=>{loading=null;throw error;});
    return loading;
  }
  async function commit(record,next){
    const value=copy(next);
    if(value.features.history!==false)record.value=await nativeCall('documents.write',{namespace:'exam',key:value.id,expectedRevision:record.value.revision||0,value});
    else record.value={...value,revision:(record.value.revision||0)+1};
    return record.value;
  }
  function publicRecord(record){
    const {snapshot,state,resources,revision,startRequest,...value}=record.value;
    return {...copy(value),serverTime:new Date(now()).toISOString()};
  }
  const missing=()=>failure('COLLECTION_NOT_FOUND','考试不存在或已删除',404);
  function requireRecord(id){const record=records.get(id);if(!record||record.value.status==='deleted')throw missing();return record;}
  function engine(record){
    if(record.practice)return record.practice;
    const wire=async(method,args={})=>{
      const value=record.value,snapshot=value.snapshot;
      if(method==='library.list')return [{id:value.id,title:value.title,questionCount:snapshot.bank.questions.length,features:value.features}];
      if(method==='library.readBank')return {id:value.id,title:value.title,bank:{...copy(snapshot.bank),features:{...value.features,editing:false,exam:false}},sourceVersion:snapshot.sourceVersion,questionVersions:copy(snapshot.questionVersions)};
      if(method==='library.readExtension'){
        const extension=snapshot.extensions[args.path];if(!extension)throw failure('EXTENSION_NOT_FOUND','考试没有绑定此题型',404);return copy(extension);
      }
      if(method==='state.read')return copy(value.state);
      if(method==='state.write'){
        if(args.expectedRevision!==(value.state?.revision||0))throw failure('REVISION_CONFLICT','考试作答已变化，请重新读取');
        const state={...copy(args.state),revision:args.expectedRevision+1};await commit(record,{...value,state});return copy(state);
      }
      if(method==='rules.run'){
        const extension=snapshot.extensions[args.path];if(!extension)throw failure('EXTENSION_NOT_FOUND','考试没有绑定此题型',404);
        return nativeCall('rules.evaluate',{extension,request:args.request});
      }
      if(method==='resource.put'){
        const resource=await practice.domain.host.temporaryResource(args),resources={...value.resources,[resource.id]:resource};
        if(Object.keys(resources).length>200||Object.values(resources).reduce((n,item)=>n+item.size,0)>32*1024*1024)throw failure('RESOURCE_SESSION_LIMIT','考试图片达到上限，原答案已保留',413);
        await commit(record,{...value,resources});const {data,...descriptor}=resource;return descriptor;
      }
      if(method==='resource.get'){
        const resource=value.resources?.[args.id];if(!resource)throw failure('RESOURCE_NOT_FOUND','考试图片不存在',404);return copy(resource);
      }
      if(['answerArea.begin','answerArea.image','answerArea.render','answerArea.discard'].includes(method))return nativeCall(method,args);
      throw failure('EXAM_ACTION_DISABLED','考试期间不提供此操作',403);
    };
    record.practice=makePractice(wire,{loadText:async name=>Object.hasOwn(record.value.snapshot.sdkFiles,name)?record.value.snapshot.sdkFiles[name]:loadText(name),
      ...(Object.hasOwn(record.value.snapshot,'answerAreaComponent')?{answerAreaComponent:copy(record.value.snapshot.answerAreaComponent)}:{})});
    return record.practice;
  }
  function frozenPage(record,page){
    const libraries=(page.dependencies||[]).filter(item=>item.id==='quizforge.richtext').map(item=>{
      const base=`./vendor/shared/richtext/${item.version}/`,files=record.value.snapshot.sdkFiles;
      if(typeof files[base+'richtext.js']!=='string'||typeof files[base+'richtext.css']!=='string')throw failure('EXAM_UNAVAILABLE','考试富文本快照缺失，原记录已保留',503);
      return {script:files[base+'richtext.js']+'\n;\n'+(files[base+'richtext-editor.js']||''),style:files[base+'richtext.css']};
    });
    return {...page,script:libraries.map(item=>item.script+'\n;\n').join('')+(page.script||''),style:libraries.map(item=>item.style).join('\n')+'\n'+(page.style||''),examActionSelectors:['#submit-button','#retry-button']};
  }
  async function request(record,suffix='',method='GET',body=null,headers={}){
    return engine(record).handle({path:path(record.value.id,suffix),method,body,headers});
  }
  async function resources(record,resourceId,method,body){
    if(method==='GET'){
      const image=record.value.resources?.[resourceId];if(!image)throw failure('RESOURCE_NOT_FOUND','考试图片不存在',404);
      return {__qfBinary:true,mime:image.mime,data:image.data};
    }
    if(method!=='POST'||record.value.status!=='in-progress')throw failure('EXAM_ACTION_DISABLED','交卷后不能添加作答图片',403);
    const image=await practice.domain.host.temporaryResource(body),all={...record.value.resources,[image.id]:image};
    if(Object.keys(all).length>200||Object.values(all).reduce((n,item)=>n+item.size,0)>32*1024*1024)throw failure('RESOURCE_SESSION_LIMIT','考试图片达到上限，原答案已保留',413);
    await commit(record,{...record.value,resources:all});const {data,...descriptor}=image;return descriptor;
  }
  async function handIn(record,reason){
    if(record.value.status==='completed')return;
    if(record.value.status==='in-progress')await commit(record,{...record.value,status:'grading',submittedAt:new Date(now()).toISOString(),submissionReason:reason,gradingErrors:[]});
    const errors=[];
    for(const question of record.value.snapshot.bank.questions){
      try{
        const payload=await request(record,`/questions/${encodeURIComponent(question.id)}`);
        if(payload.state.status!=='submitted'&&payload.state.answer!==null)await request(record,`/questions/${encodeURIComponent(question.id)}/actions`,'POST',{
          requestId:`exam-submit-${question.id}`.slice(0,128),revision:payload.state.revision,contentVersion:payload.stamp.contentVersion,action:'submit',data:{answer:payload.state.answer},
        });
      }catch(error){errors.push({questionId:question.id,code:error.code||'GRADING_FAILED',message:'该题评分未完成，已保存答案仍保留。'});}
    }
    await commit(record,{...record.value,gradingErrors:errors});
    if(!errors.length)await complete(record);
  }
  async function complete(record){
    if(record.value.status!=='grading'||record.value.gradingErrors?.length)return;
    const summary=await request(record,'/summary');
    if(summary.pendingCount)return;
    const finished=summary.finished?summary:await request(record,'/finish','POST',{requestId:`exam-finish-${record.value.id}`,summaryVersion:summary.summaryVersion,roundId:summary.roundId});
    if(finished.finished)await commit(record,{...record.value,status:'completed',finishedAt:new Date(now()).toISOString(),summary:finished});
  }
  async function advance(record){
    if(record.value.status==='in-progress'&&record.value.deadline&&now()>=Date.parse(record.value.deadline))await handIn(record,'timeout');
    else if(record.value.status==='grading'&&!record.value.gradingErrors?.length)await complete(record);
  }
  async function start(bankId,body){
    if(!object(body)||!validId(body.requestId)||Object.keys(body).some(key=>!['requestId','durationMinutes'].includes(key))
      ||body.durationMinutes!==null&&(!Number.isInteger(body.durationMinutes)||body.durationMinutes<1||body.durationMinutes>1440))throw failure('INVALID_REQUEST','考试时长须为 1–1440 分钟或不限时',400);
    const prior=[...records.values()].find(record=>record.value.bankId===bankId&&record.value.startRequest?.requestId===body.requestId);
    if(prior){if(JSON.stringify(prior.value.startRequest)!==JSON.stringify(body))throw failure('REQUEST_ID_REUSED','同一请求编号不能用于不同考试');return publicRecord(prior);}
    const source=await practice.domain.host.read(bankId);
    if(source.features.exam===false)throw failure('FEATURE_DISABLED','此题库没有开放考试',403);
    const extensions={},sdkFiles={},resources={};
    const registry='./vendor/shared/richtext/service.json';sdkFiles[registry]=await loadText(registry);
    for(const question of source.bank.questions){
      const binding=question.extension?.path||source.bank.extension?.path;
      if(!extensions[binding]){
        const extension=await practice.domain.host.extension(bankId,question.id);extensions[binding]=copy(extension.raw);
        const base=`./vendor/shared/richtext/${extension.version}/`;
        for(const filename of ['richtext.js','richtext.css','richtext-editor.js'])sdkFiles[base+filename]=await loadText(base+filename);
      }
    }
    // Capture authored resource references as well as the extension/page bytes.
    for(const id of new Set(JSON.stringify(source.bank).match(/[a-f0-9]{64}/g)||[])){
      try{resources[id]=await nativeCall('resource.get',{bankId,id});}catch(error){if(error.code!=='RESOURCE_NOT_FOUND')throw error;}
    }
    const id=crypto.randomUUID(),record={value:{schemaVersion:1,revision:0,id,title:source.title,bankKind:'bank',bankId,status:'in-progress',startedAt:new Date(now()).toISOString(),
      durationMinutes:body.durationMinutes,deadline:body.durationMinutes===null?null:new Date(now()+body.durationMinutes*60000).toISOString(),
      features:copy(source.features),startRequest:copy(body),snapshot:{bank:copy(source.bank),extensions,sdkFiles,sourceVersion:source.sourceVersion,questionVersions:copy(source.questionVersions),
        ...(typeof practice.domain.host.answerAreaComponent==='function'?{answerAreaComponent:practice.domain.host.answerAreaComponent()}:{})},state:null,resources}};
    await commit(record,record.value);records.set(id,record);return publicRecord(record);
  }
  async function examHistory(bankId,historyId,method){
    const id=historyId.slice(5),record=requireRecord(id);
    if(record.value.bankId!==bankId||record.value.status!=='completed'||record.value.features.history===false)throw failure('HISTORY_NOT_FOUND','考试历史不存在',404);
    return enqueue(id,async()=>{
      const history=await request(record,'/history');const current=history.records?.find(row=>row.id===record.value.summary?.roundId);
      if(!current)throw failure('HISTORY_NOT_FOUND','考试历史不存在',404);
      if(method==='DELETE')return request(record,`/history/${encodeURIComponent(current.id)}`,'DELETE');
      const entry=await request(record,`/history/${encodeURIComponent(current.id)}`);return {...entry,id:historyId,mode:'exam',examId:id,createdAt:record.value.startedAt,updatedAt:record.value.finishedAt};
    });
  }
  async function handle({path:target,method='GET',body=null,headers={}}){
    const url=new URL(target,'https://appassets.androidplatform.net'),parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if(parts[0]==='api'&&parts[1]==='extensions'&&parts[4]==='page'&&method.toUpperCase()==='GET'){
      const match=/^a\.([^.]+)\./.exec(parts[2]||'');
      if(match){await initialize();if(records.has(match[1]))return enqueue(match[1],async()=>{
        const record=requireRecord(match[1]);await advance(record);
        return frozenPage(record,await engine(record).handle({path:target,method,body,headers}));
      });}
      return;
    }
    if(parts[0]==='api'&&parts[1]==='resources'){
      const context=method.toUpperCase()==='GET'?resourceContext({reading:true}):resourceContext();
      if(context?.kind==='exam'){
        await initialize();return enqueue(context.bankId,async()=>{
          const record=requireRecord(context.bankId);await advance(record);
          if(method.toUpperCase()==='POST'&&record.value.status!=='in-progress')throw failure('EXAM_ACTION_DISABLED','交卷后不能上传作答图片',403);
          return resources(record,parts[2],method.toUpperCase(),body);
        });
      }
      if(method.toUpperCase()==='GET'&&/^[a-f0-9]{64}$/.test(parts[2]||'')){
        await initialize();for(const record of records.values()){
          const image=record.value.status!=='deleted'&&record.value.resources?.[parts[2]];
          if(image)return {__qfBinary:true,mime:image.mime,data:image.data};
        }
      }
      return;
    }
    if(parts[0]!=='api'||parts[1]!=='collections')return;
    const kind=parts[2],id=parts[3];method=method.toUpperCase();
    if(kind==='bank'&&parts[4]!=='exams'&&parts[4]!=='history')return;
    if(!['bank','exam'].includes(kind))return;
    await initialize();
    if(kind==='bank'){
      if(parts[4]==='exams'){
        if(method==='POST')return enqueue('bank:'+id,()=>start(id,body));
        if(method!=='GET')throw failure('ACTION_UNAVAILABLE','考试列表不提供此操作',405);
        for(const record of records.values())if(record.value.bankId===id&&record.value.status!=='deleted')await enqueue(record.value.id,()=>advance(record));
        return {records:[...records.values()].filter(record=>record.value.bankId===id&&!['completed','deleted'].includes(record.value.status)).map(publicRecord).reverse()};
      }
      if(parts[5]?.startsWith('exam-'))return examHistory(id,parts[5],method);
      if(parts.length===5&&method==='GET'){
        const ordinary=await practice.handle({path:target,method,body,headers}),extra=[];
        for(const record of records.values())if(record.value.bankId===id&&record.value.features.history!==false){
          await enqueue(record.value.id,()=>advance(record));if(record.value.status!=='completed')continue;
          const history=await request(record,'/history'),entry=history.records?.find(row=>row.id===record.value.summary?.roundId);
          if(entry)extra.push({...entry,id:'exam-'+record.value.id,mode:'exam',examId:record.value.id,createdAt:record.value.startedAt,updatedAt:record.value.finishedAt});
        }
        return {...ordinary,records:[...ordinary.records,...extra].sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt)))};
      }
      return;
    }
    return enqueue(id,async()=>{
      const record=requireRecord(id);await advance(record);
      const active=record.value.status==='in-progress',suffix='/'+parts.slice(4).map(encodeURIComponent).join('/');
      if(parts[4]==='exam'){
        if(method==='GET')return publicRecord(record);
        if(method==='POST'){await handIn(record,'manual');return publicRecord(record);}
        if(method==='DELETE'){
          if(record.value.status==='completed')throw failure('EXAM_COMPLETED','考试已完成，请在历史中删除');
          await commit(record,{...record.value,status:'deleted',deletedAt:new Date(now()).toISOString()});return {deleted:id};
        }
      }
      if(parts[4]==='resources'){
        if(method==='POST'&&!active)throw failure('EXAM_ACTION_DISABLED','交卷后不能上传作答图片',403);
        return resources(record,parts[5],method,body);
      }
      if(parts[4]==='summary'&&active||['editor','edit','ai'].includes(parts[6])||['restart','finish','exams'].includes(parts[4]))throw failure('EXAM_ACTION_DISABLED','考试期间不能编辑、重做或提前查看答案',403);
      if(method!=='GET'){
        const review=parts[6]==='actions'&&body?.action==='review'&&record.value.status==='grading'&&!record.value.gradingErrors?.length;
        if(!review&&(!active||parts[6]!=='actions'||!['draft','whiteboard'].includes(body?.action)))throw failure('EXAM_ACTION_DISABLED','考试只允许保存答案与草稿，请使用交卷按钮',403);
        const result=await request(record,suffix,method,body,headers);if(review)await complete(record);return {...result,exam:publicRecord(record)};
      }
      const result=await request(record,parts.length===4?'':suffix,method,body,headers);
      if(result.capabilities){result.capabilities.canEdit=false;result.capabilities.canRetry=false;result.capabilities.canSubmit=false;result.capabilities.canAiGrade=false;
        if(active)result.capabilities.canReview=false;}
      return {...(parts[6]==='page'?frozenPage(record,result):result),exam:publicRecord(record)};
    });
  }
  return {handle};
}
