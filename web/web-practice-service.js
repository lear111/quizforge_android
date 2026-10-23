import {createDomain} from './domain.js';
import {draftWithoutAnswerInk} from './answer-area-host.js';

const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
const own=(map,key)=>map&&Object.hasOwn(map,key)?map[key]:undefined;
const put=(map,key,value)=>Object.defineProperty(map,key,{value,writable:true,enumerable:true,configurable:true});
const empty=()=>({status:'unanswered',answer:null,result:null,revision:0});
const failure=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f-\u009f<>]/u.test(value)&&value===value.trim();
const b64=value=>btoa(String.fromCharCode(...new TextEncoder().encode(value))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const unb64=value=>new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),x=>x.charCodeAt(0)));
const header=(headers,name)=>headers instanceof Headers?headers.get(name):Object.entries(headers||{}).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** REST contracts consumed by the unmodified QuizForge Web application. */
export function createPracticeService(nativeCall,options={}){
  const temporary=new Map();
  const domain=options.domain||createDomain(nativeCall,{...options,temporaryResources:temporary}),host=domain.host;
  const effective=features=>({...features,exam:options.examEnabled===true&&features.exam!==false});
  const epoch=crypto.randomUUID(),extensions=new Map(),tokens=new Map(),outlines=new Map(),frozenSdk=new Map();
  // A question keeps only its latest successful input for each read operation.
  // Include the entire wire value: rules may inspect any answer/state field.
  const ruleMemo=new Map(),memoOperations=new Set(['scoreBatch','projectBatch','outlineBatch']),encoder=new TextEncoder();
  const memoByteLimit=8*1024*1024,memoEntryLimit=512;let memoBytes=0;
  function forgetMemo(key){const entry=ruleMemo.get(key);if(entry){memoBytes-=entry.bytes;ruleMemo.delete(key);}}
  function rememberRule(key,input,value){
    const serialized=JSON.stringify(value),bytes=encoder.encode(key).byteLength+encoder.encode(input).byteLength+encoder.encode(serialized).byteLength;
    forgetMemo(key);if(bytes>memoByteLimit)return;
    while(ruleMemo.size>=memoEntryLimit||memoBytes+bytes>memoByteLimit)forgetMemo(ruleMemo.keys().next().value);
    ruleMemo.set(key,{input,value:clone(value),bytes});memoBytes+=bytes;
  }
  let whiteboardModel=options.normalizeDraft;
  const read=id=>host.read(id);
  function invalidate(id){
    for(const cache of [extensions,tokens,outlines])for(const key of cache.keys())if(key.startsWith(id+'\0'))cache.delete(key);
    for(const key of ruleMemo.keys())if(JSON.parse(key)[0]===id)forgetMemo(key);
  }
  const question=(snapshot,qid)=>{const q=snapshot.bank.questions.find(q=>q.id===qid);if(!q)throw failure('QUESTION_NOT_FOUND','题目不存在',404);return q;};
  const binding=(snapshot,q)=>q.extension?.path||snapshot.bank.extension?.path;
  async function extension(snapshot,q){
    const path=binding(snapshot,q),key=snapshot.id+'\0'+path;
    if(!extensions.has(key))extensions.set(key,host.extension(snapshot.id,q.id).then(value=>{
      const m=value.raw.manifest;
      const metadata={id:m.id||path,version:m.version||'1.0.0',name:m.name||path.split('/').at(-1),path,pageId:`a.${snapshot.id}.${b64(path)}`};
      const page={...clone(value.assets),extension:metadata};delete page.libraries;
      return {...value,metadata,page};
    }).catch(error=>{extensions.delete(key);throw error;}));
    return extensions.get(key);
  }
  async function stamp(snapshot,q,state=own(snapshot.state.questions,q.id)||empty()){
    const ext=await extension(snapshot,q),key=snapshot.id+'\0'+q.id;
    if(!tokens.has(key))tokens.set(key,Promise.all([
      digest([epoch,'question',snapshot.id,q.id,q.title,q.data,ext.raw.rules,ext.raw.questionSchema,ext.raw.answerSchema]),
      digest([epoch,'package',snapshot.id,ext.metadata.path,ext.raw.rules,ext.page]),
    ]));
    const [fallbackVersion,packageVersion]=await tokens.get(key),nativeVersion=own(snapshot.questionVersions,q.id)?.contentVersion;
    if(nativeVersion!==undefined&&!/^[a-f0-9]{64}$/.test(nativeVersion))throw failure('INVALID_SOURCE_VERSION','本机题目版本无效，原数据已保留',500);
    return {revision:state.revision,contentVersion:nativeVersion??fallbackVersion,packageVersion};
  }
  async function batch(snapshot,operation,rows,field){
    const groups=new Map(),result=new Map();
    for(const row of rows){
      const path=binding(snapshot,row.q),memoKey=memoOperations.has(operation)?JSON.stringify([snapshot.id,row.q.id,operation]):null;
      const input=memoKey&&JSON.stringify([snapshot.id,row.q.id,path,operation,row.value]),cached=memoKey&&ruleMemo.get(memoKey);
      if(cached&&cached.input===input){ruleMemo.delete(memoKey);ruleMemo.set(memoKey,cached);result.set(row.q.id,clone(cached.value));continue;}
      if(!groups.has(path))groups.set(path,[]);groups.get(path).push({...row,memoKey,input});
    }
    for(const group of groups.values())for(let offset=0;offset<group.length;){
      const chunk=[];let bytes=0;
      while(offset<group.length&&chunk.length<64){const row=group[offset],size=JSON.stringify(row.value).length;
        if(chunk.length&&bytes+size>384*1024)break;chunk.push(row);offset++;bytes+=size;}
      const response=await host.run(snapshot.id,chunk[0].q.id,{op:operation,questions:chunk.map(row=>row.value)});
      if(!Array.isArray(response[field])||response[field].length!==chunk.length)throw failure('RULE_REJECTED','题型规则返回了不完整的数据',422);
      chunk.forEach((row,index)=>{const value=response[field][index];if(row.memoKey)rememberRule(row.memoKey,row.input,value);result.set(row.q.id,clone(value));});
    }
    return result;
  }
  async function outlineMap(snapshot){
    const pending=[];
    for(const q of snapshot.bank.questions){const key=snapshot.id+'\0'+q.id;if(outlines.has(key))continue;
      if(q.outline){outlines.set(key,q.outline.level==='parts'?clone(q.outline.items):[]);continue;}
      const ext=await extension(snapshot,q);
      if(ext.raw.manifest.requiresApi?.capabilities?.includes('outline-items'))pending.push({q,value:q.data});else outlines.set(key,[]);
    }
    if(pending.length){const result=await batch(snapshot,'outlineBatch',pending,'outlineItems');for(const [qid,items]of result)outlines.set(snapshot.id+'\0'+qid,items);}
    return new Map(snapshot.bank.questions.map(q=>[q.id,outlines.get(snapshot.id+'\0'+q.id)||[]]));
  }
  async function publicState(snapshot,q,state,scores){
    const value=clone({status:state.status,revision:state.revision,answer:state.answer,result:state.result,
      ...(state.status!=='submitted'&&state.answerState?{answerState:state.answerState}:{})});
    const ext=await extension(snapshot,q),declared=ext.assets.answerStateDeclared===true;
    if(state.status!=='submitted'&&declared){if(state.answerState)value.outlineStates=clone(state.answerState.outlineStates||[]);}
    else if((await outlineMap(snapshot)).get(q.id)?.length){
      const score=scores?.get(q.id)||(await batch(snapshot,'scoreBatch',[{q,value:{data:q.data,state}}],'scores')).get(q.id);
      if(score.outlineStates)value.outlineStates=clone(score.outlineStates);
    }
    return value;
  }
  function legacyDraft(ink){
    if(!ink)return null;if(ink.schemaVersion===1)return clone(ink);
    if(ink.formatVersion!==1||ink.width!==760||!Array.isArray(ink.strokes))throw failure('HISTORY_UNAVAILABLE','旧草稿格式无法转换，原记录已保留',409);
    return {schemaVersion:1,viewport:{x:0,y:0,zoom:1},strokes:clone(ink.strokes),paper:{color:'#ffffff',pattern:'plain'}};
  }
  async function payload(snapshot,q,projected,scores){
    const state=own(snapshot.state.questions,q.id)||empty(),ext=await extension(snapshot,q);
    if(projected===undefined)projected=(await host.run(snapshot.id,q.id,{op:'project',data:q.data,state:{submitted:state.status==='submitted',result:state.result}})).projected;
    const canReview=!snapshot.state.finished&&state.status==='submitted'&&['pending','graded'].includes(state.result?.gradingStatus)
      &&ext.raw.manifest.requiresApi?.capabilities?.includes('manual-review')===true;
    const canAiGrade=canReview&&options.aiService?await options.aiService.supports({extension:ext,run:request=>host.run(snapshot.id,q.id,request)}):false;
    return {features:effective(snapshot.features),question:{id:q.id,title:q.title,data:clone(projected)},
      state:await publicState(snapshot,q,state,scores),draft:own(snapshot.state.webDrafts,q.id)??legacyDraft(own(snapshot.state.ink,q.id)),
      stamp:await stamp(snapshot,q,state),capabilities:{canReview,canAiGrade},aiTask:typeof state.aiTaskId==='string'?{taskId:state.aiTaskId}:null,
      ...(state.aiTaskIds?{aiTasks:clone(state.aiTaskIds)}:{}),extension:clone(ext.metadata)};
  }
  async function overview(snapshot){
    const outline=await outlineMap(snapshot),types=new Map(),rows=[],states={};
    // The catalog only needs scoring for rule-derived part progress. Reported
    // answer-state already supplies unsubmitted progress; rows without parts
    // never consume a score here. Keep full scoring in summaries and grading.
    const scoreRows=[];
    for(const q of snapshot.bank.questions){
      const state=own(snapshot.state.questions,q.id)||empty();
      if(outline.get(q.id).length&&(state.status==='submitted'||(await extension(snapshot,q)).assets.answerStateDeclared!==true))scoreRows.push({q,value:{data:q.data,state}});
    }
    const scores=await batch(snapshot,'scoreBatch',scoreRows,'scores');
    for(const q of snapshot.bank.questions){const ext=await extension(snapshot,q);types.set(ext.metadata.pageId,ext.metadata);
      const row={id:q.id,title:q.title,type:clone(ext.metadata)};
      if(q.outline?.level==='question')row.outlineLabel=q.outline.label;
      else if(outline.get(q.id).length)row.outlineItems=clone(outline.get(q.id));
      rows.push(row);put(states,q.id,await publicState(snapshot,q,own(snapshot.state.questions,q.id)||empty(),scores));}
    const list=[...types.values()];
    return {id:snapshot.id,title:snapshot.title,kind:'bank',revision:snapshot.sourceVersion??await digest([epoch,snapshot.id,snapshot.bank.questions.map(q=>[q.id,q.title,binding(snapshot,q)])]),
      features:effective(snapshot.features),extension:list.length===1?clone(list[0]):null,extensions:clone(list),questions:rows,states};
  }
  const hasAnswer=state=>state.status==='draft'&&(state.answerState?state.answerState.status==='draft'||state.answerState.outlineStates?.some(x=>x.status==='draft'):state.answer!=null);
  async function summary(snapshot){
    const scores=await batch(snapshot,'scoreBatch',snapshot.bank.questions.map(q=>({q,value:{data:q.data,state:own(snapshot.state.questions,q.id)||empty()}})),'scores');
    let score=0,maxScore=0,submittedCount=0,gradedCount=0,pendingCount=0,answeredUnsubmittedCount=0;
    const questions=[];
    for(const q of snapshot.bank.questions){const state=own(snapshot.state.questions,q.id)||empty(),value=scores.get(q.id),submitted=state.status==='submitted';
      const gradingStatus=submitted?(state.result?.gradingStatus||'graded'):'unsubmitted';
      const earned=gradingStatus==='pending'?null:submitted?value.score:0;
      if(!Number.isFinite(value.maxScore)||value.maxScore<0||earned!==null&&!Number.isFinite(earned))throw failure('SCORE_UNAVAILABLE','题型分值无效',422);
      maxScore+=value.maxScore;score+=earned||0;if(submitted){submittedCount++;if(gradingStatus==='pending')pendingCount++;else gradedCount++;}else if(hasAnswer(state))answeredUnsubmittedCount++;
      const row={id:q.id,score:earned,maxScore:value.maxScore,submitted,status:state.status,gradingStatus};
      if(!submitted&&state.answerState){row.answerState=clone(state.answerState);row.outlineStates=clone(state.answerState.outlineStates||[]);}
      else if(value.outlineStates)row.outlineStates=clone(value.outlineStates);
      questions.push(row);
    }
    score=Number(score.toPrecision(14));maxScore=Number(maxScore.toPrecision(14));
    const roundId=snapshot.state.webRoundStarted||submittedCount||snapshot.state.finished?snapshot.state.roundId:null;
    const result={score,maxScore,submittedCount,gradedCount,pendingCount,answeredUnsubmittedCount,questionCount:questions.length,
      finished:!!snapshot.state.finished,status:snapshot.state.finished?'completed':'in-progress',roundId,questions};
    result.summaryVersion=await digest([epoch,snapshot.id,snapshot.state.roundId,snapshot.bank.questions.map(q=>[q.id,own(snapshot.state.questions,q.id)?.revision||0]),result]);
    return result;
  }
  function checkRequest(request){if(!plain(request)||!validId(request.requestId))throw failure('INVALID_REQUEST','缺少有效的请求编号');}
  async function prior(state,scope,request){
    const stored=(state.webReceipts||[]).find(row=>row.scope===scope&&row.id===request.requestId);
    if(!stored)return null;
    if(stored.requestHash!==await digest(request))throw failure('REQUEST_ID_REUSED','同一请求编号不能用于不同操作',409);
    return stored;
  }
  async function remember(state,scope,request,response){
    const rows=state.webReceipts??=[];rows.push({scope,id:request.requestId,requestHash:await digest(request),response:clone(response)});
    while(rows.length>128||rows.length>1&&JSON.stringify(rows).length>4*1024*1024)rows.shift();
    if(JSON.stringify(rows).length>8*1024*1024)throw failure('STATE_LIMIT','确认记录超过大小上限，旧记录已保留',413);
  }
  function answerState(value,items){
    if(!plain(value)||Object.keys(value).some(key=>!['status','outlineStates'].includes(key))||!['unanswered','draft'].includes(value.status)||!Array.isArray(value.outlineStates)||value.outlineStates.length>100)throw failure('INVALID_ANSWER_STATE','作答状态无效');
    const allowed=new Set(items.map(x=>x.id)),seen=new Set();
    for(const item of value.outlineStates){if(!plain(item)||Object.keys(item).length!==2||!validId(item.id)||seen.has(item.id)||!allowed.has(item.id)||!['unanswered','draft'].includes(item.status))throw failure('INVALID_ANSWER_STATE','小题作答状态无效');seen.add(item.id);}
    return clone(value);
  }
  async function normalize(value){
    if(!whiteboardModel)whiteboardModel=(await import('./vendor/web/draft/whiteboard-model.js')).normalizeDraft;
    try{if(value==null)throw new Error();return whiteboardModel(value);}catch{throw failure('INVALID_WHITEBOARD','草稿格式、坐标或笔画数量无效');}
  }
  async function freeze(snapshot){
    const projected=await batch(snapshot,'projectBatch',snapshot.bank.questions.map(q=>({q,value:{data:q.data,state:{submitted:own(snapshot.state.questions,q.id)?.status==='submitted',result:own(snapshot.state.questions,q.id)?.result||null}}})),'projected');
    const pages={},questions=[];const collection=await overview(snapshot),outline=await outlineMap(snapshot);
    for(const q of snapshot.bank.questions){const ext=await extension(snapshot,q),key=ext.metadata.pageId;
      if(!own(pages,key)){put(pages,key,clone(ext.page));
        snapshot.state.webSdk??={};if(!own(snapshot.state.webSdk,ext.version)){
          const library=await host.sdk(ext.version),editor=await host.sdk(ext.version,true);put(snapshot.state.webSdk,ext.version,{...library,editor:editor.script});}
      }
      questions.push({pageKey:key,payload:await payload(snapshot,q,projected.get(q.id)),outlineItems:clone(outline.get(q.id))});
    }
    const value=await summary(snapshot),now=new Date().toISOString();
    const {questions:scoreRows,...totals}=value;
    return {apiVersion:{major:1,minor:5},id:snapshot.state.roundId,createdAt:now,updatedAt:now,
      collectionTitle:snapshot.title,...totals,collection,questions,pages,features:effective(snapshot.features),summary:snapshot.state.finished?clone(value):undefined};
  }
  async function updateRound(snapshot,q,questionPayload){
    const records=snapshot.state.webHistory??=[];let record=records.find(row=>row.id===snapshot.state.roundId);
    if(!record){record=await freeze(snapshot);records.push(record);return;}
    const entry=record.questions.find(row=>row.payload.question.id===q.id);
    if(entry)entry.payload=clone(questionPayload);
    const value=await summary(snapshot),{questions:scoreRows,...totals}=value;Object.assign(record,totals,{updatedAt:new Date().toISOString()});
    if(record.collection?.states)put(record.collection.states,q.id,clone(questionPayload.state));
  }
  async function action(id,qid,request,trustedAi=null){
    checkRequest(request);
    if(!Number.isSafeInteger(request.revision)||request.revision<0||!plain(request.data))throw failure('INVALID_REQUEST','保存请求缺少版本或内容');
    return host.transact(id,'web-action',qid,async(state,meta)=>{
      const receipt=await prior(state,'question:'+qid,request);if(receipt)return host.unchanged(clone(receipt.response));
      const snapshot={...meta,state},q=question(snapshot,qid),old=own(state.questions,qid)||empty();
      if(trustedAi)await trustedAi.assert(await aiContext(id,qid,snapshot));
      if(request.contentVersion!==undefined&&request.contentVersion!==(await stamp(snapshot,q,old)).contentVersion)throw failure('CONTENT_CONFLICT','题目内容已变化，请重新读取；当前输入保留',409);
      if(request.revision!==old.revision)throw failure('REVISION_CONFLICT','作答记录已变化，请重新读取后重试',409);
      // Web keeps current scratch paper writable after completion. Its layout
      // initialization also saves a whiteboard draft without changing answers.
      // Like Web, answering goes on after completion: drafts save as usual, and a submit or 重做 starts a new
      // round while the completed one stays frozen in history.
      if(state.finished&&request.action==='review')throw failure('ROUND_COMPLETED','本轮已完成，请从分值卡开始新一轮',409);
      if(state.finished&&['submit','retry'].includes(request.action)){state.finished=false;state.webRoundStarted=false;state.roundId=crypto.randomUUID();delete state.summary;}
      if(old.revision>=Number.MAX_SAFE_INTEGER)throw failure('REVISION_LIMIT','作答版本已达到上限',409);
      const next={...clone(old),revision:old.revision+1};delete next.receipts;
      if(['draft','submit'].includes(request.action)){
        if(old.status==='submitted')throw failure('ALREADY_SUBMITTED','请先重新作答再修改答案',409);
        if(!Object.hasOwn(request.data,'answer'))throw failure('INVALID_REQUEST','保存请求缺少答案');
        const ext=await extension(snapshot,q),answer=await host.prepareAnswer(id,qid,request.data.answer,{submit:request.action==='submit',targetIds:(await outlineMap(snapshot)).get(qid).map(item=>item.id)});
        const evaluated=await host.run(id,qid,{op:request.action==='submit'?'submit':'validateAnswer',data:q.data,answer,
          ...(request.action==='draft'?{projectAfterValidation:true}:{}),withCapabilities:true});
        Object.assign(next,{status:request.action==='submit'?'submitted':'draft',answer,result:request.action==='submit'?evaluated.result:null});
        delete next.answerState;delete next.answerStateId;
        if(request.data.answerState!==undefined){
          if(request.action!=='draft'||ext.assets.answerStateDeclared!==true)throw failure('INVALID_ANSWER_STATE','此题型没有声明即时作答状态能力');
          next.answerState=answerState(request.data.answerState,(await outlineMap(snapshot)).get(qid));
        }
        if(request.action==='submit'){state.webRoundStarted=true;next.submissionGeneration=(old.submissionGeneration||0)+1;next.gradingGeneration=(old.gradingGeneration||0)+1;
          next.aiAutoEligible=true;delete next.aiTaskId;delete next.aiTaskIds;delete next.aiTargetGenerations;}
      }else if(request.action==='review'){
        if(old.status!=='submitted'||!['pending','graded'].includes(old.result?.gradingStatus))throw failure('REVIEW_UNAVAILABLE','当前题目不能人工评分',409);
        next.result=(await host.run(id,qid,{op:'review',data:q.data,answer:old.answer,state:{...old,submitted:true},review:request.data.review})).result;
        next.aiAutoEligible=false;
        const target=request.data.review?.targetId;
        if(target===undefined){next.gradingGeneration=(old.gradingGeneration||0)+1;delete next.aiTaskIds;delete next.aiTargetGenerations;
          if(trustedAi){next.result.aiAssessment=clone(trustedAi.assessment);next.result.gradingSource='ai';}else{delete next.aiTaskId;next.result.gradingSource='manual';if(old.result?.aiAssessment)next.result.aiAssessment=clone(old.result.aiAssessment);}}
        else{if(!validId(target))throw failure('INVALID_REQUEST','评分目标无效');next.aiTargetGenerations={...clone(old.aiTargetGenerations||{})};put(next.aiTargetGenerations,target,(old.aiTargetGenerations?.[target]||0)+1);delete next.aiTaskId;
          next.result.aiAssessments=clone(old.result?.aiAssessments||{});if(trustedAi){put(next.result.aiAssessments,target,clone(trustedAi.assessment));next.result.gradingSource='ai-assisted';}
          else{delete next.result.aiAssessments[target];if(next.aiTaskIds)delete next.aiTaskIds[target];next.result.gradingSource='manual';}}
      }else if(request.action==='retry'){
        if(state.webDrafts?.[qid])put(state.webDrafts,qid,draftWithoutAnswerInk(state.webDrafts[qid],old.answer));
        if(state.ink?.[qid])put(state.ink,qid,draftWithoutAnswerInk(state.ink[qid],old.answer));
        Object.assign(next,empty(),{revision:old.revision+1,submissionGeneration:(old.submissionGeneration||0)+1,gradingGeneration:(old.gradingGeneration||0)+1});
        delete next.aiAutoEligible;delete next.aiTaskId;delete next.aiTaskIds;delete next.aiTargetGenerations;
      }else if(request.action==='whiteboard'){
        if(!snapshot.features.whiteboard)throw failure('FEATURE_DISABLED','此题库没有开放白板草稿',403);
        const draft=await normalize(request.data.draft);state.webDrafts??={};put(state.webDrafts,qid,draft);
      }else throw failure('ACTION_UNAVAILABLE','此操作尚未实现',501);
      put(state.questions,qid,next);
      const response=await payload(snapshot,q);
      if(state.webRoundStarted&&!state.finished&&snapshot.features.history)await updateRound(snapshot,q,response);
      await remember(state,'question:'+qid,request,response);return response;
    });
  }
  function checkSummary(request,current){if(!Object.hasOwn(request,'roundId')||request.roundId!==current.roundId||request.summaryVersion!==current.summaryVersion)throw failure('SUMMARY_CONFLICT','练习数据已变化，请刷新分值卡后重试',409);}
  async function finish(id,request){
    checkRequest(request);
    return host.transact(id,'finished',null,async(state,meta)=>{
      const receipt=await prior(state,'finish',request);if(receipt)return host.unchanged(clone(receipt.response));
      const snapshot={...meta,state},pendingReceipt=await prior(state,'finish-pending',request);
      if(!pendingReceipt)checkSummary(request,await summary(snapshot));
      if(!state.finished){
        for(const q of snapshot.bank.questions){const saved=own(state.questions,q.id);if(saved&&hasAnswer(saved)){
          saved.answer=await host.prepareAnswer(id,q.id,saved.answer,{submit:true,targetIds:(await outlineMap(snapshot)).get(q.id).map(item=>item.id)});
          saved.result=(await host.run(id,q.id,{op:'submit',data:q.data,answer:saved.answer})).result;saved.status='submitted';saved.revision++;delete saved.answerState;state.webRoundStarted=true;
          saved.submissionGeneration=(saved.submissionGeneration||0)+1;saved.gradingGeneration=(saved.gradingGeneration||0)+1;delete saved.aiTaskId;delete saved.aiTaskIds;delete saved.aiTargetGenerations;
          saved.aiAutoEligible=true;
        }}
        const current=await summary(snapshot);
        let aiPending=false,aiError=false;
        if(options.aiService)for(const q of snapshot.bank.questions){if(own(state.questions,q.id)?.status!=='submitted')continue;
          const status=await options.aiService.completionStatus(await aiContext(id,q.id,snapshot));aiPending||=status.pending;aiError||=status.error;}
        if(current.pendingCount||aiPending||aiError){
          if(snapshot.features.history){let record=(state.webHistory??=[]).find(row=>row.id===state.roundId);
            const replacement=await freeze(snapshot);if(record)Object.assign(record,replacement,{createdAt:record.createdAt});else state.webHistory.push(replacement);}
          const response={...current,completionPending:true,finished:false,...(aiError?{completionError:'AI 评分失败，请返回题目重试或人工评分，再完成练习。'}:{})};
          if(!pendingReceipt)await remember(state,'finish-pending',request,response);return response;
        }
        state.finished=true;state.webRoundStarted=true;
        const completed=await freeze(snapshot);completed.finished=true;completed.status='completed';completed.summary=await summary(snapshot);
        if(snapshot.features.history){const rows=state.webHistory??=[],index=rows.findIndex(row=>row.id===state.roundId);if(index<0)rows.push(completed);else{completed.createdAt=rows[index].createdAt;rows[index]=completed;}}
        state.summary=clone(completed.summary);
      }
      const response={...await summary(snapshot),historyId:snapshot.features.history?state.roundId:null};
      await remember(state,'finish',request,response);return response;
    });
  }
  async function restart(id,request){
    checkRequest(request);
    return host.transact(id,'restarted',null,async(state,meta)=>{
      const receipt=await prior(state,'restart',request);if(receipt)return host.unchanged(clone(receipt.response));
      const snapshot={...meta,state};checkSummary(request,await summary(snapshot));
      if(!state.finished)throw failure('PRACTICE_NOT_FINISHED','请先完成当前练习',409);
      for(const q of snapshot.bank.questions){const old=own(state.questions,q.id)||empty();put(state.questions,q.id,{...empty(),revision:old.revision+1});}
      state.ink={};state.webDrafts={};state.roundId=crypto.randomUUID();state.finished=false;state.webRoundStarted=false;delete state.summary;
      const response={restarted:true};await remember(state,'restart',request,response);return response;
    });
  }
  function legacyHistory(snapshot,entry){
    const pages={},questions=[],states={},rows=[];
    for(const item of entry.questions||[]){
      const stored=entry.pages?.[item.pageKey],page=clone(typeof stored==='string'?snapshot.state.frozenPages?.[stored]:stored);
      if(!page)throw failure('HISTORY_UNAVAILABLE','历史页面快照缺失，原记录已保留',409);
      page.libraries=(page.libraries||[]).map(value=>typeof value==='string'?clone(snapshot.state.frozenLibraries?.[value]):value);
      if(page.libraries.some(value=>!value))throw failure('HISTORY_UNAVAILABLE','历史组件快照缺失，原记录已保留',409);
      const metadata=page.extension||{id:'android-frozen:'+item.pageKey,version:'frozen',name:item.pageKey?.split('/').at(-1)||'历史题型',path:item.pageKey};
      page.extension=clone(metadata);put(pages,item.pageKey,page);
      const context=item.context,value={question:clone(context.question),state:{status:context.status,answer:clone(context.answer),result:clone(context.result),revision:0},
        features:effective(snapshot.features),draft:legacyDraft(item.ink),capabilities:{canReview:false,canAiGrade:false},aiTask:null,extension:clone(metadata)};
      questions.push({pageKey:item.pageKey,payload:value,outlineItems:clone(item.outlineItems||[])});put(states,context.question.id,clone(value.state));rows.push({id:context.question.id,title:context.question.title,type:clone(metadata),...(item.outlineItems?.length?{outlineItems:clone(item.outlineItems)}:{})});
    }
    const submittedCount=questions.filter(q=>q.payload.state.status==='submitted').length,pendingCount=questions.filter(q=>q.payload.state.result?.gradingStatus==='pending').length;
    const value={id:entry.id,createdAt:entry.createdAt,updatedAt:entry.createdAt,status:'completed',finished:true,collectionTitle:snapshot.title,questionCount:questions.length,submittedCount,gradedCount:submittedCount-pendingCount,pendingCount,score:entry.score,maxScore:entry.maxScore,
      collection:{id:snapshot.id,title:snapshot.title,kind:'bank',questions:rows,states,features:effective(snapshot.features),extension:null},pages,questions};
    value.summary={score:value.score,maxScore:value.maxScore,finished:true,status:'completed',roundId:value.id,questionCount:value.questionCount,submittedCount,gradedCount:value.gradedCount,pendingCount,answeredUnsubmittedCount:0,
      questions:questions.map(q=>({id:q.payload.question.id,status:q.payload.state.status,submitted:q.payload.state.status==='submitted',gradingStatus:q.payload.state.result?.gradingStatus||'graded',score:q.payload.state.result?.score??0,maxScore:q.payload.state.result?.maxScore??0}))};
    return value;
  }
  async function history(id,historyId){
    const snapshot=await read(id);if(!snapshot.features.history)throw failure('FEATURE_DISABLED','此题库没有保存历史记录',403);
    const records=[...(snapshot.state.webHistory||[]),...(snapshot.state.history||[]).map(row=>legacyHistory(snapshot,row))];
    if(historyId){const record=records.find(row=>row.id===historyId);if(!record)throw failure('HISTORY_NOT_FOUND','历史记录不存在',404);
      const response=clone(record);
      for(const page of Object.values(response.pages||{})){
        const dependencies=page.dependencies||[];
        // The unchanged Web loader replaces page.libraries from its shared SDK
        // cache. Embed the actual archived provider after those cached scripts,
        // before the unchanged extension code. Its CSS likewise follows the
        // cached provider CSS. Only this returned representation is augmented.
        const libraries=page.libraries?.length?page.libraries:dependencies.map(dependency=>snapshot.state.webSdk?.[dependency.version]);
        if(libraries.some(library=>!library||typeof library.script!=='string'||typeof library.style!=='string'))
          throw failure('HISTORY_UNAVAILABLE','历史富文本组件快照缺失，原记录已保留',409);
        for(let i=0;i<libraries.length;i++)if(dependencies[i]?.id==='quizforge.richtext')frozenSdk.set(dependencies[i].version,libraries[i]);
        if(libraries.length){
          page.script=libraries.map(library=>library.script+'\n;\n'+(typeof library.editor==='string'?library.editor+'\n;\n':'')).join('\n')+(page.script||'');
          page.style=libraries.map(library=>library.style).join('\n')+'\n'+(page.style||'');
        }
      }
      return response;
    }
    return {records:records.slice().sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt))).map(({questions,pages,collection,...row})=>clone(row))};
  }
  async function deleteHistory(id,historyId){
    if(!validId(historyId))throw failure('HISTORY_NOT_FOUND','历史记录不存在',404);
    return host.transact(id,'history-deleted',null,async(state,meta)=>{
      if(!meta.features.history)throw failure('FEATURE_DISABLED','此题库没有保存历史记录',403);
      let removed=false;
      for(const key of ['webHistory','history']){
        const rows=state[key];if(!Array.isArray(rows))continue;
        const retained=rows.filter(row=>row.id!==historyId);if(retained.length!==rows.length){removed=true;state[key]=retained;}
      }
      if(!removed)throw failure('HISTORY_NOT_FOUND','历史记录不存在',404);
      if(!state.finished&&state.roundId===historyId){state.roundId=crypto.randomUUID();state.webRoundStarted=false;}
      // Shared frozen pages, SDK bytes and image resources may still belong to
      // other records. Leave them intact; deletion never clears live answers.
      return {deleted:historyId};
    });
  }
  async function resources(method,id,body,headers){
    if(method==='POST'){
      if(header(headers,'X-QuizForge-Transient-Resource')==='true'){
        const resource=await host.temporaryResource(body);
        if(!temporary.has(resource.id)&&(temporary.size>=200||[...temporary.values()].reduce((sum,x)=>sum+x.size,0)+resource.size>32*1024*1024))throw failure('RESOURCE_SESSION_LIMIT','当前临时图片已达到上限',413);
        temporary.set(resource.id,resource);return {id:resource.id,mime:resource.mime,size:resource.size};
      }
      const banks=await domain.listBanks(),context=options.resourceContext?await options.resourceContext():null;
      if(options.resourceContext&&(!context?.bankId||context.kind&&context.kind!=='bank'))throw failure('ACTIVE_BANK_UNAVAILABLE','请返回当前题库后再添加图片',409);
      const bank=context?.bankId?banks.find(row=>row.id===context.bankId):banks.find(row=>row.features?.history!==false),editing=context?.editing===true;
      if(!bank)throw context?.bankId?failure('BANK_NOT_FOUND','当前题库已移动或不存在，请刷新后重试',404):failure('FEATURE_DISABLED','当前题库没有开放图片持久保存',403);
      if(editing?bank.features?.editing===false:bank.features?.history===false)throw failure('FEATURE_DISABLED',editing?'此题库没有开放题目编辑':'当前题库没有开放图片持久保存',403);
      return nativeCall('resource.put',{mime:body?.mime,data:body?.data,bankId:bank.id,editing});
    }
    if(!/^[a-f0-9]{64}$/.test(id||''))throw failure('INVALID_RESOURCE','图片标识无效');
    let resource=temporary.get(id);
    // A displayed card normally owns its resources. Do not open every preceding
    // bank and load its complete practice/history state just to find one image.
    // Keep the active session path for memory-only answer snapshots, then use
    // the native resource store for the existing cross-bank fallback.
    const context=resource?null:await options.resourceContext?.({reading:true});
    const preferred=context&&(!context.kind||context.kind==='bank')&&validId(context.bankId)?context.bankId:null;
    if(!resource&&preferred){try{resource=await host.readResource(preferred,id);}catch(error){if(error.code!=='RESOURCE_NOT_FOUND')throw error;}}
    if(!resource){for(const bank of await domain.listBanks()){
      if(bank.id===preferred)continue;
      resource=await host.cachedMemoryResource?.(bank.id,id);if(resource)break;
      try{resource=await nativeCall('resource.get',{bankId:bank.id,id});break;}catch(error){if(error.code!=='RESOURCE_NOT_FOUND')throw error;}
    }}
    if(!resource)throw failure('RESOURCE_NOT_FOUND','图片不存在',404);
    return {__qfBinary:true,mime:resource.mime,data:resource.data};
  }
  async function editor(id,qid){
    const snapshot=await read(id),q=question(snapshot,qid);
    if(!snapshot.features.editing)throw failure('FEATURE_DISABLED','此题库没有开放题目编辑',403);
    const value=await nativeCall('editor.read',{bankId:id,questionId:qid}),ext=await extension(snapshot,q);
    if(!plain(value)||!plain(value.question)||value.question.id!==qid||typeof value.question.title!=='string'||!plain(value.question.data)
      ||!['contentVersion','sourceVersion','draftVersion'].every(k=>/^[a-f0-9]{64}$/.test(value[k]))||!Number.isSafeInteger(value.revision)||value.revision<0)throw failure('INVALID_EDITOR','本机题目编辑信息无法读取，原数据已保留',500);
    let page=null;
    const raw=value.editor===undefined?ext.raw.editor:value.editor;
    if(raw!=null){
      if(!plain(raw)||!['html','script','style'].every(k=>typeof raw[k]==='string'))throw failure('INVALID_EDITOR','题型编辑页面不完整',500);
      const input={...clone(ext.assets),...clone(raw),extension:clone(ext.metadata),assets:clone(raw.assets??ext.raw.assets??[])};
      const prepare=options.prepareAssets|| (async assets=>{const{inlinePageAssets}=await import('./vendor/web/development/development-preview.js');return inlinePageAssets(assets);});
      page=await prepare(input);delete page.libraries;
    }
    return {question:{id:qid,title:value.question.title,data:clone(value.question.data)},extension:clone(ext.metadata),revision:(own(snapshot.state.questions,qid)||empty()).revision,
      contentVersion:value.contentVersion,sourceVersion:value.sourceVersion,draftVersion:value.draftVersion,editor:page};
  }
  async function edit(id,qid,request){
    checkRequest(request);
    if(!Number.isSafeInteger(request.revision)||request.revision<0||!['contentVersion','sourceVersion'].every(k=>typeof request[k]==='string'&&/^[a-f0-9]{64}$/.test(request[k]))
      ||typeof request.title!=='string'||!request.title.trim()||request.title.length>300||!plain(request.data))throw failure('INVALID_REQUEST','题目编辑请求缺少有效内容或版本');
    const snapshot=await read(id);question(snapshot,qid);
    if(!snapshot.features.editing)throw failure('FEATURE_DISABLED','此题库没有开放题目编辑',403);
    if(typeof host.externalChange!=='function')throw failure('EDIT_UNAVAILABLE','当前主机未接入安全的题目编辑存储',503);
    const result=await host.externalChange(id,'edited',qid,current=>{
      // Old source versions must reach native receipt lookup first. A confirmed
      // edit can be replayed after new temporary answers without clearing them.
      if(current?.features?.history===false&&(!current.sourceVersion||!own(current.questionVersions,qid)?.contentVersion))throw failure('INVALID_SOURCE_VERSION','临时题库缺少安全的编辑版本，原输入已保留',503);
      if(current?.features?.history===false&&request.sourceVersion===current.sourceVersion&&request.contentVersion===own(current.questionVersions,qid)?.contentVersion
        &&request.revision!==(own(current.state.questions,qid)||empty()).revision)throw failure('REVISION_CONFLICT','当前临时作答已变化，请重新读取编辑器；当前输入保留',409);
      return nativeCall('editor.save',{bankId:id,questionId:qid,requestId:request.requestId,revision:request.revision,
        contentVersion:request.contentVersion,sourceVersion:request.sourceVersion,question:{id:qid,title:request.title.trim(),data:clone(request.data)}});
    });
    invalidate(id);
    const current=await read(id),q=question(current,qid);
    return {previousSourceVersion:result.previousSourceVersion,sourceVersion:result.sourceVersion,payload:await payload(current,q),collection:await overview(current)};
  }
  async function editorDraft(id,qid,method,body){
    const snapshot=await read(id);question(snapshot,qid);
    if(!snapshot.features.editing)throw failure('FEATURE_DISABLED','此题库没有开放题目编辑',403);
    const args={bankId:id,questionId:qid};
    if(method==='GET')return nativeCall('editorDraft.read',args);
    if(method==='DELETE')return nativeCall('editorDraft.delete',args);
    if(method!=='PUT')throw failure('ACTION_UNAVAILABLE','不支持此编辑草稿操作',405);
    if(!plain(body)||typeof body.contentVersion!=='string'||!/^[a-f0-9]{64}$/.test(body.contentVersion)||typeof body.changed!=='boolean'||!Object.hasOwn(body,'draft'))throw failure('INVALID_EDITOR_DRAFT','编辑草稿缺少有效版本或内容');
    // Drafts deliberately contain unvalidated intermediate editor input. Native
    // storage bounds size and checks the source; only final edits validate rules.
    return nativeCall('editorDraft.write',{...args,contentVersion:body.contentVersion,draft:clone(body.draft),changed:body.changed});
  }
  async function handle({path,method='GET',body=null,headers={}}){
    const url=new URL(path,'https://appassets.androidplatform.net'),parts=url.pathname.split('/').filter(Boolean).map(value=>{try{return decodeURIComponent(value);}catch{throw failure('INVALID_PATH','接口路径无效');}});
    method=method.toUpperCase();if(typeof body==='string'){try{body=JSON.parse(body);}catch{throw failure('INVALID_JSON','请求不是有效的 JSON');}}
    if(parts[0]!=='api')return undefined;
    if(parts[1]==='editor-drafts'&&parts.length===4)return editorDraft(parts[2],parts[3],method,body);
    if(parts[1]==='resources'&&(method==='POST'&&parts.length===2||method==='GET'&&parts.length===3))return resources(method,parts[2],body,headers);
    if(parts[1]==='sdk'&&parts[2]==='quizforge.richtext'&&method==='GET'){
      try{return await host.sdk(parts[3],parts[4]==='editor');}
      catch(error){const frozen=frozenSdk.get(parts[3]);if(!frozen)throw error;
        if(parts[4]==='editor'){if(typeof frozen.editor!=='string')throw error;return {script:frozen.editor};}
        return {script:frozen.script,style:frozen.style};}
    }
    if(parts[1]==='extensions'&&parts[4]==='page'&&method==='GET'){
      const match=/^a\.([^.]+)\.([A-Za-z0-9_-]+)$/.exec(parts[2]);if(!match)throw failure('EXTENSION_NOT_FOUND','题型页面不存在',404);
      let path;try{path=unb64(match[2]);}catch{throw failure('INVALID_PATH','题型路径无效');}
      const snapshot=await read(match[1]),q=snapshot.bank.questions.find(q=>binding(snapshot,q)===path);
      if(!q)throw failure('EXTENSION_NOT_FOUND','题库没有绑定此题型',404);const ext=await extension(snapshot,q);
      if(parts[3]!==ext.metadata.version)throw failure('EXTENSION_NOT_FOUND','题型版本不匹配',404);return clone(ext.page);
    }
    if(parts[1]!=='collections')return undefined;
    if(parts[2]!=='bank')throw failure('COLLECTION_UNAVAILABLE','当前离线版本仅开放已导入的题库',501);
    const id=parts[3];
    if(parts.length===4&&method==='GET')return overview(await read(id));
    if(parts[4]==='summary'&&method==='GET')return summary(await read(id));
    if(parts[4]==='finish'&&method==='POST'){const result=await finish(id,body);if(result.completionPending&&options.aiService){const snapshot=await read(id);for(const q of snapshot.bank.questions)if(snapshot.state.questions[q.id]?.status==='submitted')options.aiService.scheduleAutomatic('bank',id,q.id);}return result;}
    if(parts[4]==='restart'&&method==='POST')return restart(id,body);
    if(parts[4]==='history'){
      if(method==='GET')return history(id,parts[5]);
      if(method==='DELETE'&&parts.length===6)return deleteHistory(id,parts[5]);
      throw failure('ACTION_UNAVAILABLE','不支持此历史记录操作',501);
    }
    if(parts[4]==='questions'){
      const qid=parts[5];
      if(parts[6]==='actions'&&method==='POST'){const result=await action(id,qid,body);if(body.action==='submit'&&options.aiService)options.aiService.scheduleAutomatic('bank',id,qid);return result;}
      if(parts[6]==='editor'&&method==='GET'&&parts.length===7)return editor(id,qid);
      if(parts[6]==='edit'&&method==='POST'&&parts.length===7)return edit(id,qid,body);
      if(parts[6]==='ai'){
        if(options.aiService)return options.aiService.handle({path,method,body,headers});
        if(method==='GET'&&parts[7]==='current')return {task:null};
        throw failure('AI_UNAVAILABLE','当前版本采用离线作答与人工评分',501);
      }
      if(method==='GET'){
        const snapshot=await read(id),q=question(snapshot,qid);
        if(parts[6]==='page')return clone((await extension(snapshot,q)).page);
        const current=await stamp(snapshot,q);if(parts[6]==='stamp')return current;
        const known=header(headers,'X-QuizForge-Question-Stamp');if(known){let supplied;try{supplied=JSON.parse(known);}catch{throw failure('INVALID_STAMP','题目版本格式无效');}
          if(supplied.revision===current.revision&&supplied.contentVersion===current.contentVersion&&supplied.packageVersion===current.packageVersion)return {unchanged:true,stamp:current};}
        if(parts.length===6)return payload(snapshot,q);
      }
    }
    throw failure('ACTION_UNAVAILABLE','此离线接口尚未开放',501);
  }
  async function aiContext(id,qid,supplied=null){
    const snapshot=supplied||await read(id),q=question(snapshot,qid),state=own(snapshot.state.questions,qid)||empty(),ext=await extension(snapshot,q);
    const canAiGrade=options.aiService?await options.aiService.supports({extension:ext,run:request=>host.run(id,qid,request)}):false;
    ext.canAiGrade=canAiGrade;
    return {snapshot,q,state,extension:ext,contentVersion:(await stamp(snapshot,q,state)).contentVersion,
      available:!snapshot.state.finished&&state.status==='submitted'&&['pending','graded'].includes(state.result?.gradingStatus),run:request=>host.run(id,qid,request)};
  }
  options.aiService?.bindScope('bank',{
    context:aiContext,
    attachments:async(id,qid,input)=>{
      const snapshot=await read(id);question(snapshot,qid);if(snapshot.features.history)return [];
      const ids=[...new Set(Object.values(input).filter(Array.isArray).flat().filter(block=>block?.type==='image').map(block=>block.assetId))],attachments=[];
      for(const assetId of ids){const resource=await host.memoryResource(id,assetId);if(resource)attachments.push({assetId,mime:resource.mime,data:resource.data});}
      return attachments;
    },
    payload:async(id,qid)=>{const snapshot=await read(id);return payload(snapshot,question(snapshot,qid));},
    bindTask:(id,qid,task,assert)=>host.transact(id,'ai-bound',qid,async(state,meta)=>{
      await assert(await aiContext(id,qid,{...meta,state}));const next=state.questions[qid];
      if(task.targetId==null){next.aiTaskId=task.taskId;delete next.aiTaskIds;}
      else{next.aiTaskIds??={};put(next.aiTaskIds,task.targetId,task.taskId);delete next.aiTaskId;}
      return {bound:true};
    }),
    applyAiReview:async(id,qid,trusted)=>{
      const value=await aiContext(id,qid);
      const prior=value.snapshot.state.webReceipts?.find(row=>row.scope==='question:'+qid&&row.id===trusted.requestId);
      if(prior){const result=prior.response.state.result,assessment=trusted.assessment.targetId===undefined?result.aiAssessment:result.aiAssessments?.[trusted.assessment.targetId];
        if(assessment?.taskId!==trusted.assessment.taskId||assessment.candidateVersion!==trusted.assessment.candidateVersion||assessment.reviewScore!==trusted.score)throw failure('REQUEST_ID_REUSED','AI 确认编号冲突',409);
        return clone(prior.response);}
      return action(id,qid,{requestId:trusted.requestId,revision:value.state.revision,contentVersion:value.contentVersion,action:'review',
        data:{review:{score:trusted.score,feedback:trusted.assessment.feedback,...(trusted.assessment.targetId===undefined?{}:{targetId:trusted.assessment.targetId})}}},trusted);
    },
  });
  return {handle,domain,invalidate};
}
