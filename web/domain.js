import {answerAreaComponent} from './answer-area-component.js';
import {prepareAnswerAreas,draftWithoutAnswerInk} from './answer-area-host.js';

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const error = (code,message) => Object.assign(new Error(message),{code});
const emptyQuestion = () => ({status:'unanswered',answer:null,result:null,revision:0});
const newState = () => ({schemaVersion:1,revision:0,roundId:crypto.randomUUID(),questions:{},ink:{},history:[],finished:false});
const featuresFor = bank => Object.fromEntries(['editing','whiteboard','history','exam'].map(key=>[key,bank.features?.[key]!==false]));
const denied = (code,message) => ({ok:false,error:{code,message}});
const own=(map,key)=>Object.hasOwn(map,key)?map[key]:undefined;
const put=(map,key,value)=>{Object.defineProperty(map,key,{value,writable:true,enumerable:true,configurable:true});return value;};
const digestJson=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');

/** Trusted app host. Raw questions never enter a question-type iframe. */
export function createDomain(nativeCall, options={}) {
  const noCommit=Symbol('confirmed-read');
  const sessions=new Map(),queues=new Map(),sourceCache=new Map(),textCache=new Map();
  const loadText=options.loadText || (async relative=>{
    const response=await fetch(new URL(relative,import.meta.url));
    if(!response.ok)throw error('SDK_UNAVAILABLE','离线题型组件不完整，请重新安装应用');
    return response.text();
  });
  const prepareAssets=options.prepareAssets || (async assets=>{
    const {inlinePageAssets}=await import('./vendor/web/development/development-preview.js');
    return inlinePageAssets(assets);
  });
  const api={onChanged:null,onNavigate:null};
  const notify=details=>{try{api.onChanged?.(details);}catch{}};
  async function text(relative){
    if(!textCache.has(relative))textCache.set(relative,Promise.resolve(loadText(relative)));
    try{return await textCache.get(relative);}catch(e){textCache.delete(relative);throw e;}
  }
  function session(id){
    if(sessions.has(id))return sessions.get(id);
    const pending=(async()=>{
    const result=await nativeCall('library.readBank',{bankId:id});
    const bank=result.bank,features=featuresFor(bank);
    if(!Array.isArray(bank.questions)||!bank.questions.length)throw error('INVALID_BANK','题库没有可用题目');
    const state=features.history ? await nativeCall('state.read',{bankId:id}) : null;
    if(state && (state.schemaVersion!==1||!state.questions||!Array.isArray(state.history)))throw error('INVALID_STATE','已有练习记录无法读取，原文件已保留');
    const reportSequence=Math.max(0,...Object.values(state?.questions||{}).map(q=>Number(q.answerStateId)||0));
    const value={id,title:result.title||bank.title,bank,features,sourceVersion:result.sourceVersion,questionVersions:clone(result.questionVersions),state:state||newState(),reports:new Map(),reportSequence,resources:new Map(),extensions:new Map()};
    return value;
    })();
    sessions.set(id,pending);
    pending.catch(()=>{if(sessions.get(id)===pending)sessions.delete(id);});
    return pending;
  }
  function enqueue(id,fn){
    const task=(queues.get(id)||Promise.resolve()).catch(()=>{}).then(fn);
    queues.set(id,task);return task;
  }
  async function refreshSession(id,{deleted=false,changedQuestionId}={}){
    const previous=await Promise.resolve(sessions.get(id)).catch(()=>null);
    sessions.delete(id);
    for(const key of sourceCache.keys())if(key.startsWith(id+'|'))sourceCache.delete(key);
    if(deleted){notify({bankId:id,type:'deleted'});return;}
    const current=await session(id);
    // An authored history=false bank keeps its practice data in this page only.
    // Reloading source metadata must not silently discard unrelated live input.
    if(previous&&!previous.features.history&&!current.features.history){
      current.state=clone(previous.state);current.resources=previous.resources;
      current.reports=previous.reports;current.reportSequence=previous.reportSequence;
      if(changedQuestionId){
        delete current.state.questions[changedQuestionId];delete current.state.ink[changedQuestionId];
        if(current.state.webDrafts)delete current.state.webDrafts[changedQuestionId];
        current.reports.delete(changedQuestionId);
        current.state.roundId=crypto.randomUUID();current.state.finished=false;
        current.state.webRoundStarted=false;current.state.webReceipts=[];delete current.state.summary;
      }
    }
    notify({bankId:id,questionId:changedQuestionId,type:changedQuestionId?'edited':'library-changed',persisted:current.features.history});
    return current;
  }
  async function mutate(id,kind,qid,change){
    return enqueue(id,async()=>{
      const s=await session(id),next=clone(s.state);
      const result=await change(next,s);
      if(result?.[noCommit])return result.value;
      if(qid)next.currentQuestionId=qid;
      if(s.features.history){s.state=await nativeCall('state.write',{bankId:id,state:next,expectedRevision:s.state.revision});}
      else s.state={...next,revision:s.state.revision+1};
      notify({bankId:id,questionId:qid,type:kind==='finished'&&result?.finished===false?'saved':kind,persisted:s.features.history});
      return result;
    });
  }
  function findQuestion(s,id){const value=s.bank.questions.find(q=>q.id===id);if(!value)throw error('QUESTION_NOT_FOUND','题目不存在');return value;}
  function pathFor(s,q){const path=q.extension?.path||s.bank.extension?.path;if(typeof path!=='string')throw error('INVALID_EXTENSION','题目没有准确的题型绑定');return path;}
  async function extension(s,q){
    const path=pathFor(s,q),key=s.id+'|'+path;
    if(sourceCache.has(key))return sourceCache.get(key);
    const raw=await nativeCall('library.readExtension',{bankId:s.id,path}),m=raw.manifest;
    const required=m.requiresApi||{major:1,minMinor:0};
    if(required.major!==1||required.minMinor>5)throw error('UNSUPPORTED_API_VERSION','此题型要求尚未支持的接口能力，当前安卓预览版支持 API 1.0–1.5');
    const answerAreasDeclared=required.minMinor>=5&&required.capabilities?.includes('answer-areas')===true;
    if(required.capabilities?.includes('answer-areas')&&!answerAreasDeclared)throw error('INVALID_API_REQUIREMENT','answer-areas 能力需要明确声明 API 1.5');
    const requirements=m.requiresRichText;
    let profile=requirements?.documentProfile || (m.dependencies?.some(x=>x.version==='1.0.0')?'basic-v1':'advanced-v1');
    if(!['basic-v1','advanced-v1'].includes(profile))throw error('UNSUPPORTED_RICHTEXT','不支持此富文本格式');
    const registry=JSON.parse(await text('./vendor/shared/richtext/service.json'));
    const service=registry.profiles.find(p=>p.id===profile),version=service.provider.version;
    const sdkRoot=`./vendor/shared/richtext/${version}/`;
    const libraries=[{script:await text(sdkRoot+'richtext.js'),style:await text(sdkRoot+'richtext.css')}];
    const resolved={html:raw.html,script:raw.script,style:raw.style,assets:raw.assets||[],entryPath:raw.entryPath,stylePath:raw.stylePath,
      apiVersion:{major:1,minor:required.minMinor||0},answerStateDeclared:required.capabilities?.includes('answer-state')===true,
      dependencies:[{id:'quizforge.richtext',version}],contentApi:{...registry.api,documentProfile:profile,capabilities:service.capabilities},libraries,
      ...(answerAreasDeclared?{answerAreasDeclared:true,answerAreaComponent:clone(options.answerAreaComponent===undefined?answerAreaComponent():options.answerAreaComponent)}:{})};
    // Keep the authored API version. A newer host never opts a package into new APIs.
    const assets=await prepareAssets(resolved);
    const value={raw,assets,version};sourceCache.set(key,value);return value;
  }
  async function run(s,q,request){return nativeCall('rules.run',{bankId:s.id,path:pathFor(s,q),request});}
  const memoryResource=(s,id)=>s.resources.get(id)||options.temporaryResources?.get(id);
  async function readResource(s,id){return memoryResource(s,id)||nativeCall('resource.get',{bankId:s.id,id});}
  async function storeResource(s,args){
    if(s.features.history)return nativeCall('resource.put',{bankId:s.id,...args});
    const resource=await temporaryResource(args);
    if(!s.resources.has(resource.id)&&(s.resources.size>=200||[...s.resources.values()].reduce((sum,item)=>sum+item.size,0)+resource.size>32*1024*1024))throw error('RESOURCE_SESSION_LIMIT','当前临时练习图片已达到上限，请先完成本轮');
    s.resources.set(resource.id,resource);const {data,...descriptor}=resource;return descriptor;
  }
  async function prepareAnswer(s,q,answer,{submit=false,targetIds=null}={}){
    if(!(await extension(s,q)).assets.answerAreasDeclared)return clone(answer);
    return prepareAnswerAreas(answer,{submit,targetIds,nativeCall,readResource:id=>readResource(s,id),storeResource:args=>storeResource(s,args)});
  }
  async function currentContext(s,q,state=own(s.state.questions,q.id)||emptyQuestion(),history=false){
    const projected=await run(s,q,{op:'project',data:q.data,state:{submitted:state.status==='submitted',result:state.result}});
    // Web rule project returns its public value directly.
    return {mode:history?'history':'practice',completed:s.state.finished,
      question:{id:q.id,title:q.title,data:projected.projected},answer:clone(state.answer),result:clone(state.result),status:state.status,aiTask:null,
      capabilities:{canSave:!history&&!s.state.finished&&state.status!=='submitted',canSubmit:!history&&!s.state.finished&&state.status!=='submitted',
        canRetry:!history&&!s.state.finished&&state.status==='submitted',canReview:!history&&!s.state.finished&&state.status==='submitted'&&((await extension(s,q)).raw.manifest.requiresApi?.capabilities||[]).includes('manual-review'),
        canAiGrade:false,canEdit:false,canWhiteboard:!history&&!s.state.finished&&s.features.whiteboard,canHistory:!history&&s.features.history}};
  }
  async function outline(s,q){
    if(q.outline?.level==='parts')return clone(q.outline.items);
    if(q.outline?.level==='question')return [];
    const ext=await extension(s,q);
    if(!ext.raw.manifest.requiresApi?.capabilities?.includes('outline-items'))return [];
    const value=await run(s,q,{op:'outlineBatch',questions:[q.data]});return value.outlineItems?.[0]||[];
  }
  api.listBanks=()=>nativeCall('library.list');
  api.openBank=async id=>{
    const s=await session(id);
    return {bank:{id,title:s.title,features:s.features},features:s.features,questions:s.bank.questions.map(q=>({id:q.id,title:q.title})),
      questionStates:clone(s.state.questions),historyCount:s.state.history.length,finished:s.state.finished,currentIndex:Math.max(0,s.bank.questions.findIndex(q=>q.id===s.state.currentQuestionId))};
  };
  api.openQuestion=async(id,index,{historyId}={})=>{
    if(queues.has(id))await queues.get(id).catch(()=>{});
    const s=await session(id);
    if(historyId){
      const entry=s.state.history.find(h=>h.id===historyId);if(!entry)throw error('HISTORY_NOT_FOUND','找不到此轮历史');
      const item=entry.questions[index];if(!item)throw error('QUESTION_NOT_FOUND','历史题目不存在');
      const pageReference=entry.pages[item.pageKey],assets=clone(typeof pageReference==='string'?s.state.frozenPages?.[pageReference]:pageReference);
      if(!assets)throw error('HISTORY_UNAVAILABLE','历史页面快照缺失，原记录已保留');
      assets.libraries=(assets.libraries||[]).map(value=>typeof value==='string'?clone(s.state.frozenLibraries?.[value]):value);
      if(assets.libraries.some(value=>!value))throw error('HISTORY_UNAVAILABLE','历史组件快照缺失，原记录已保留');
      return {assets,context:clone(item.context),ink:clone(item.ink),outlineItems:clone(item.outlineItems),index,total:entry.questions.length,questions:entry.questions.map(v=>({id:v.context.question.id,title:v.context.question.title}))};
    }
    const q=s.bank.questions[index];if(!q)throw error('QUESTION_NOT_FOUND','题目不存在');
    return {assets:clone((await extension(s,q)).assets),context:await currentContext(s,q),ink:clone(own(s.state.ink,q.id)||null),outlineItems:await outline(s,q),index,total:s.bank.questions.length};
  };
  api.getContext=async(id,qid)=>{const s=await session(id);return currentContext(s,findQuestion(s,qid));};
  function report(s,qid,args){
    if(s.state.finished||(own(s.state.questions,qid)?.status==='submitted'))return denied('READ_ONLY','此题已提交或本轮已完成');
    if(!args||!['unanswered','draft'].includes(args.status)||args.targetId!=null&&(typeof args.targetId!=='string'||!args.targetId.trim()||args.targetId.length>128))return denied('INVALID_ANSWER_STATE','作答状态无效');
    const previous=s.reports.get(qid)?.latest||{status:'unanswered',outlineStates:[]},snapshot=clone(previous);
    if(args.targetId!=null){
      const items=new Map(snapshot.outlineStates.map(x=>[x.id,x]));items.set(args.targetId,{id:args.targetId,status:args.status});snapshot.outlineStates=[...items.values()];
      if(items.size>100)return denied('INVALID_ANSWER_STATE','小题状态数量超过上限');snapshot.status=snapshot.outlineStates.some(x=>x.status==='draft')?'draft':'unanswered';
    }else snapshot.status=args.status;
    const stateId=String(++s.reportSequence),records=s.reports.get(qid)||{snapshots:new Map()};records.latest=snapshot;records.snapshots.set(stateId,clone(snapshot));
    while(records.snapshots.size>256)records.snapshots.delete(records.snapshots.keys().next().value);
    s.reports.set(qid,records);return {ok:true,data:{status:'reported',stateId}};
  }
  async function save(s,q,args){
    if(!args||!['draft','submit','review'].includes(args.purpose))throw error('INVALID_SAVE','不支持此保存操作');
    const purpose=args.purpose;
    return mutate(s.id,purpose==='draft'?'saved':purpose==='review'?'reviewed':'submitted',q.id,async next=>{
      if(next.finished)throw error('ROUND_COMPLETED','本轮已经完成，请开始新一轮');
      const old=own(next.questions,q.id)||emptyQuestion();
      if(purpose!=='review'&&old.status==='submitted')throw error('ALREADY_SUBMITTED','此题已提交');
      if(purpose==='review'){
        if(old.status!=='submitted')throw error('NOT_SUBMITTED','请先提交答案');
        const {result}=await run(s,q,{op:'review',data:q.data,answer:old.answer,state:old,review:args.data?.review});
        put(next.questions,q.id,{...old,result,status:'submitted',revision:old.revision+1});
      }else{
        if(!args.data||!Object.hasOwn(args.data,'answer'))throw error('INVALID_ANSWER','保存缺少答案');
        const answer=await prepareAnswer(s,q,args.data.answer,{submit:purpose==='submit',targetIds:(await outline(s,q)).map(item=>item.id)});
        await run(s,q,{op:'validateAnswer',data:q.data,answer});
        const answerStateId=args.answerStateId;
        let answerState=old.answerState;
        if(answerStateId!=null){answerState=s.reports.get(q.id)?.snapshots.get(String(answerStateId));if(!answerState||Number(answerStateId)<Number(old.answerStateId||0))throw error('ANSWER_STATE_EXPIRED','作答状态已过期，当前输入仍保留');}
        const result=purpose==='submit'?(await run(s,q,{op:'submit',data:q.data,answer})).result:null;
        put(next.questions,q.id,{status:purpose==='submit'?'submitted':'draft',answer,result,revision:old.revision+1,...(answerState?{answerState:clone(answerState)}:{}),...(answerStateId!=null?{answerStateId:String(answerStateId)}:old.answerStateId?{answerStateId:old.answerStateId}:{})});
      }
      const state=own(next.questions,q.id);return {status:state.status,result:clone(state.result)};
    });
  }
  api.handleRequest=async(id,qid,method,args={})=>{
    try{
      const s=await session(id),q=findQuestion(s,qid);
      if(method==='answer-state')return report(s,qid,args);
      if(method==='save')return {ok:true,data:await save(s,q,args)};
      if(method==='action'){
        if(args.action==='retry')return {ok:true,data:await mutate(id,'saved',qid,next=>{
          if(next.finished)throw error('ROUND_COMPLETED','请先开始新一轮');
          const answer=own(next.questions,qid)?.answer;
          if(own(next.ink,qid))put(next.ink,qid,draftWithoutAnswerInk(next.ink[qid],answer));
          if(next.webDrafts&&own(next.webDrafts,qid))put(next.webDrafts,qid,draftWithoutAnswerInk(next.webDrafts[qid],answer));
          put(next.questions,qid,{...emptyQuestion(),revision:(own(next.questions,qid)?.revision||0)+1});s.reports.delete(qid);return {status:'unanswered',result:null};
        })};
        if(['previous','next','goToQuestion'].includes(args.action)){
          const current=s.bank.questions.findIndex(v=>v.id===qid),index=args.action==='previous'?current-1:args.action==='next'?current+1:s.bank.questions.findIndex(v=>v.id===(args.params?.questionId||args.params?.id));
          if(index<0||index>=s.bank.questions.length)return denied('NAVIGATION_UNAVAILABLE','已经到达题库边界');
          setTimeout(()=>api.onNavigate?.({bankId:id,index}),0);return {ok:true,data:{status:'navigating'}};
        }
        return denied('UNKNOWN_ACTION','当前安卓版不支持此操作');
      }
      if(method==='resource-get'){
        const resource=s.resources.get(args.id)||await nativeCall('resource.get',{bankId:id,id:args.id});return {ok:true,data:resource};
      }
      if(method==='resource-put'){
        if(s.state.finished||own(s.state.questions,qid)?.status==='submitted')return denied('READ_ONLY','已提交答案不能上传图片');
        if(s.features.history)return {ok:true,data:await nativeCall('resource.put',{bankId:id,...args})};
        const resource=await temporaryResource(args);
        if(!s.resources.has(resource.id)&&(s.resources.size>=200||[...s.resources.values()].reduce((sum,r)=>sum+r.size,0)+resource.size>32*1024*1024))throw error('RESOURCE_SESSION_LIMIT','当前临时练习图片已达到上限，请先完成本轮');
        s.resources.set(resource.id,resource);return {ok:true,data:{id:resource.id,mime:resource.mime,size:resource.size}};
      }
      if(method==='sdk-editor'){
        const ext=await extension(s,q);
        if(args.id!=='quizforge.richtext'||args.version!==ext.version)return denied('SDK_UNAVAILABLE','题型没有绑定此编辑器版本');
        return {ok:true,data:{script:await text(`./vendor/shared/richtext/${ext.version}/richtext-editor.js`)}};
      }
      if(method==='ai-task')return {ok:true,data:{task:null}};
      if(method.startsWith('ai-'))return denied('AI_UNAVAILABLE','此版本专注离线刷题，暂未接入在线 AI 评分，可使用人工评分');
      return denied('UNSUPPORTED_METHOD','当前安卓版暂未支持此接口');
    }catch(e){return denied(e.code||'HOST_ERROR',e.message||'操作失败，输入已保留');}
  };
  api.saveInk=(id,qid,ink)=>mutate(id,'ink',qid,(next,s)=>{
    findQuestion(s,qid);
    if(next.finished||!s.features.whiteboard)throw error('READ_ONLY','此视图不能修改草稿');
    validateInk(ink);put(next.ink,qid,clone(ink));
  });
  api.listHistory=async id=>{const s=await session(id);return s.state.history.map(({id,createdAt,score,maxScore})=>({id,createdAt,score,maxScore})).reverse();};
  api.finish=id=>mutate(id,'finished',null,async(next,s)=>{
    if(next.finished){const last=next.history.at(-1)||next.summary;return {finished:true,score:last?.score??0,maxScore:last?.maxScore??0};}
    for(const q of s.bank.questions){
      const state=own(next.questions,q.id);
      if(state?.status==='draft'&&(!state.answerState||state.answerState.status==='draft')){
        state.answer=await prepareAnswer(s,q,state.answer,{submit:true,targetIds:(await outline(s,q)).map(item=>item.id)});
        state.result=(await run(s,q,{op:'submit',data:q.data,answer:state.answer})).result;state.status='submitted';state.revision++;
      }
    }
    const pendingCount=Object.values(next.questions).filter(x=>x.result?.gradingStatus==='pending').length;
    if(pendingCount)return {finished:false,pendingCount};
    let score=0,maxScore=0;const pages={},questions=[];
    for(const q of s.bank.questions){
      const state=own(next.questions,q.id)||emptyQuestion();
      const aggregate=await run(s,q,{op:'scoreBatch',questions:[{data:q.data,state}]});
      score+=aggregate.scores[0].score||0;maxScore+=aggregate.scores[0].maxScore;
      const ext=await extension(s,q),pageKey=pathFor(s,q);
      if(!pages[pageKey]){
        next.frozenPages??={};next.frozenLibraries??={};
        const frozen=clone(ext.assets),references=[];
        for(const library of frozen.libraries||[]){const key=await digestJson(library);next.frozenLibraries[key]??=library;references.push(key);}
        frozen.libraries=references;const key=await digestJson(frozen);next.frozenPages[key]??=frozen;pages[pageKey]=key;
      }
      const context=await currentContext(s,q,state,true);context.completed=true;
      questions.push({pageKey,context,outlineItems:await outline(s,q),ink:clone(own(next.ink,q.id)||null)});
    }
    const entry={id:next.roundId,createdAt:new Date().toISOString(),score,maxScore,pages,questions};
    if(s.features.history)next.history.push(entry);
    next.finished=true;next.summary={score,maxScore};return {finished:true,score,maxScore,pendingCount:0};
  });
  api.startNewRound=id=>mutate(id,'saved',null,next=>{
    if(!next.finished)throw error('ROUND_NOT_COMPLETED','请先完成当前练习');
    next.roundId=crypto.randomUUID();next.questions={};next.ink={};next.finished=false;delete next.summary;
  });
  // The original Web application uses a REST-shaped host. This private adapter
  // surface shares this domain's queues, extension resolver and atomic storage;
  // it never enters a question-type iframe or a public question response.
  api.host={
    invalidate:(id,options)=>enqueue(id,()=>refreshSession(id,options)),
    externalChange:(id,kind,qid,fn)=>enqueue(id,async()=>{
      const current=await session(id);
      const result=await fn({id:current.id,title:current.title,bank:clone(current.bank),features:clone(current.features),state:clone(current.state),sourceVersion:current.sourceVersion,questionVersions:clone(current.questionVersions)});
      await refreshSession(id,{changedQuestionId:kind==='edited'&&result?.dataChanged!==false&&result?.replayed!==true?qid:undefined});
      return result;
    }),
    async read(id){
      if(queues.has(id))await queues.get(id).catch(()=>{});
      const s=await session(id);return {id:s.id,title:s.title,bank:clone(s.bank),features:clone(s.features),sourceVersion:s.sourceVersion,questionVersions:clone(s.questionVersions),state:clone(s.state)};
    },
    transact:(id,kind,qid,fn)=>mutate(id,kind,qid,(next,s)=>fn(next,{id:s.id,title:s.title,bank:clone(s.bank),features:clone(s.features),sourceVersion:s.sourceVersion,questionVersions:clone(s.questionVersions)})),
    unchanged:value=>({[noCommit]:true,value}),
    async extension(id,qid){const s=await session(id);return clone(await extension(s,findQuestion(s,qid)));},
    answerAreaComponent:()=>clone(options.answerAreaComponent===undefined?answerAreaComponent():options.answerAreaComponent),
    async prepareAnswer(id,qid,answer,settings){const s=await session(id);return prepareAnswer(s,findQuestion(s,qid),answer,settings);},
    async readResource(id,assetId){return readResource(await session(id),assetId);},
    async cachedMemoryResource(id,assetId){const current=sessions.get(id);return current?memoryResource(await current,assetId):undefined;},
    async memoryResource(id,assetId){return clone(memoryResource(await session(id),assetId)||null);},
    async run(id,qid,request){const s=await session(id);return run(s,findQuestion(s,qid),request);},
    async sdk(version,editor=false){
      if(typeof version!=='string'||!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version))throw error('SDK_UNAVAILABLE','富文本组件版本无效');
      return editor?{script:await text(`./vendor/shared/richtext/${version}/richtext-editor.js`)}:
        {script:await text(`./vendor/shared/richtext/${version}/richtext.js`),style:await text(`./vendor/shared/richtext/${version}/richtext.css`)};
    },
    temporaryResource,
  };
  return api;
}

export function validateInk(ink){
  if(!ink||ink.formatVersion!==1||ink.width!==760||!Number.isFinite(ink.height)||ink.height<1||ink.height>100000||!Array.isArray(ink.strokes)||ink.strokes.length>2000)throw error('INVALID_INK','草稿格式或笔画数量无效');
  let points=0;
  for(const stroke of ink.strokes){
    if(typeof stroke.id!=='string'||!/^#[a-f0-9]{6}$/i.test(stroke.color)||!Number.isFinite(stroke.width)||stroke.width<0.5||stroke.width>32||!Array.isArray(stroke.points)||stroke.points.length>10000)throw error('INVALID_INK','草稿笔画无效');
    points+=stroke.points.length;
    for(const p of stroke.points)if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>1000000||Math.abs(p.y)>1000000||!Number.isFinite(p.pressure)||p.pressure<0||p.pressure>1)throw error('INVALID_INK','草稿坐标或压感无效');
  }
  if(points>100000)throw error('INK_LIMIT','草稿点数超过上限，请先保存并减少笔画');
}

async function temporaryResource(args){
  if(!args||!['image/png','image/jpeg','image/webp','image/gif'].includes(args.mime)||typeof args.data!=='string'||args.data.length>5592408)throw error('IMAGE_SIZE_LIMIT','图片格式无效或超过 4 MiB');
  let bytes;try{bytes=Uint8Array.from(atob(args.data),c=>c.charCodeAt(0));}catch{throw error('INVALID_IMAGE','图片编码无效');}
  if(!bytes.length||bytes.length>4194304)throw error('IMAGE_SIZE_LIMIT','图片超过 4 MiB');
  const ascii=(start,count)=>String.fromCharCode(...bytes.subarray(start,start+count));
  const detected=bytes.length>=24&&bytes[0]===137&&ascii(1,3)==='PNG'&&ascii(12,4)==='IHDR'?'image/png':bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217?'image/jpeg':bytes.length>=12&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP'?'image/webp':bytes.length>=10&&['GIF87a','GIF89a'].includes(ascii(0,6))?'image/gif':null;
  if(detected!==args.mime)throw error('IMAGE_TYPE_MISMATCH','图片内容与声明格式不符');
  const digest=await crypto.subtle.digest('SHA-256',bytes),id=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
  return {id,mime:args.mime,size:bytes.length,data:args.data};
}

