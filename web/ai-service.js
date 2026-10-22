const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message,status=400)=>Object.assign(Error(message),{code,status});
const id=value=>typeof value==='string'&&value.length>0&&value.length<=128&&value===value.trim()&&!/[\u0000-\u001f\u007f-\u009f<>]/u.test(value);
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),x=>x.toString(16).padStart(2,'0')).join('');
export const SAVED_KEY_PLACEHOLDER='QuizForge-saved-key-kept-on-device';
export function parseModelOutput(output){
  if(typeof output!=='string'||output.length>24000)return null;
  let text=output.trim();if(text.startsWith('```')){const match=/^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n?```$/i.exec(text);if(!match)return null;text=match[1].trim();}
  try{const value=JSON.parse(text);return plain(value)&&Object.keys(value).length===2&&Number.isFinite(value.score)&&typeof value.feedback==='string'&&value.feedback.trim()&&value.feedback.length<=18000?value:null;}catch{return null;}
}
function validateInput(value){
  if(!plain(value)||value.protocolVersion!==1||![value.maxScore,value.scoreStep].every(x=>Number.isFinite(x)&&x>0)
    ||Object.keys(value).some(key=>!['protocolVersion','question','answer','referenceAnswer','rubric','maxScore','scoreStep'].includes(key)))throw fail('INVALID_AI_INPUT','题型 AI 评分输入无效',422);
  let chars=0,images=0;
  for(const key of ['question','answer','referenceAnswer',...(value.rubric===undefined?[]:['rubric'])]){
    const blocks=value[key];if(!Array.isArray(blocks)||blocks.length>2000||!blocks.length&&!(key==='referenceAnswer'&&value.rubric))throw fail('INVALID_AI_INPUT','AI 评分内容分区无效',422);
    for(const block of blocks){
      if(!plain(block))throw fail('INVALID_AI_INPUT','AI 评分内容块无效',422);
      if(block.type==='text'){if(Object.keys(block).length!==2||typeof block.text!=='string'||(chars+=block.text.length)>100000)throw fail('AI_INPUT_LIMIT','AI 评分文字超出限制',413);}
      else if(block.type==='image'){if(Object.keys(block).some(k=>!['type','assetId','alt'].includes(k))||!/^[a-f0-9]{64}$/.test(block.assetId)||++images>8||block.alt!==undefined&&(typeof block.alt!=='string'||block.alt.length>500))throw fail('INVALID_AI_INPUT','AI 图片引用无效',422);}
      else throw fail('INVALID_AI_INPUT','AI 内容块类型无效',422);
    }
  }
  if(new TextEncoder().encode(JSON.stringify(value)).length>1024*1024)throw fail('AI_INPUT_LIMIT','AI 评分输入超过 1 MiB',413);
  return clone(value);
}

/** Original Web AI REST contract. Only native code handles model credentials/network. */
export function createAiService(nativeCall,options={}){
  const scopes=new Map(),records=new Map(),queues=new Map(),live=new Set(),support=new Map(),scheduled=new Set();
  let pumping=Promise.resolve(),closed=false;
  const documentKey=async(kind,bank,qid,op,requestId)=>hash(['android-ai-v1',kind,bank,qid,op,requestId]);
  function serialized(key,fn){const work=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(fn);queues.set(key,work);return work.finally(()=>{if(queues.get(key)===work)queues.delete(key);});}
  function cacheRecord(key,value){
    records.delete(key);records.set(key,value);
    let bytes=0,count=0;for(const row of records.values())if(!row.memoryOnly){count++;bytes+=JSON.stringify(row).length*2;}
    for(const [id,row]of records){if(count<=128&&bytes<=8*1024*1024)break;if(!row.memoryOnly&&!live.has(id)&&id!==key){records.delete(id);count--;bytes-=JSON.stringify(row).length*2;}}
  }
  async function load(key){if(records.has(key))return records.get(key);const value=await nativeCall('documents.read',{namespace:'ai-task',key});if(value)cacheRecord(key,value);return value;}
  async function store(key,value){
    if(JSON.stringify(value).length>2*1024*1024)throw fail('AI_TASK_SIZE_LIMIT','AI 任务记录过大',413);
    const previous=await load(key);
    if(value.memoryOnly){const memory=[...records.entries()].filter(([id,row])=>row.memoryOnly&&id!==key);if(memory.length>=256||memory.reduce((bytes,[,row])=>bytes+JSON.stringify(row).length*2,0)+JSON.stringify(value).length*2>32*1024*1024)throw fail('AI_TASK_SESSION_LIMIT','当前临时 AI 任务已达到上限，请保留作答后重新打开',413);}
    const saved=value.memoryOnly?{...clone(value),revision:(previous?.revision||0)+1}:await nativeCall('documents.write',{namespace:'ai-task',key,value:clone(value),expectedRevision:previous?.revision||0});cacheRecord(key,saved);return saved;
  }
  function scope(kind){const value=scopes.get(kind);if(!value)throw fail('AI_GRADING_UNAVAILABLE','此练习模式尚未接入 AI 评分',409);return value;}
  async function context(kind,bank,qid){const value=await scope(kind).context(bank,qid);if(!value||value.state?.status!=='submitted'||value.snapshot?.state?.finished||value.available===false)throw fail('AI_GRADING_UNAVAILABLE','请先提交支持 AI 的答案，已完成练习可查看历史',409);return value;}
  async function supports(extension){
    const key=await hash([extension.raw.rules,extension.raw.manifest,extension.raw.answerSchema]);
    if(!support.has(key))support.set(key,extension.canAiGrade===true);return support.get(key);
  }
  async function stampContext(value,target=null){
    const {snapshot,q,state,extension}=value;
    return hash([snapshot.id,snapshot.state.roundId,q.id,q.title,q.data,q.extension?.path||snapshot.bank.extension?.path,extension.raw.rules,extension.raw.manifest,
      extension.raw.questionSchema,extension.raw.answerSchema,state.answer,state.submissionGeneration||0,state.gradingGeneration||0,target,target===null?0:state.aiTargetGenerations?.[target]||0]);
  }
  const boundTaskId=(value,target)=>target==null?value.state.aiTaskId:value.state.aiTaskIds?.[target];
  const assessmentFor=(value,task)=>task.targetId==null?value.state.result?.aiAssessment:value.state.result?.aiAssessments?.[task.targetId];
  async function validFor(task,value){return boundTaskId(value,task.targetId)===task.taskId&&await stampContext(value,task.targetId??null)===task.contextHash;}
  async function currentValid(task){try{return await validFor(task,await context(task.kind,task.bankId,task.questionId));}catch(error){if(['BANK_NOT_FOUND','QUESTION_NOT_FOUND','AI_GRADING_UNAVAILABLE'].includes(error.code))return false;throw error;}}
  function wasApplied(task,value){const assessment=assessmentFor(value,task);return task.candidate&&assessment?.taskId===task.taskId&&assessment.candidateVersion===task.candidate.version;}
  const publicTask=task=>{const value=clone(task);for(const key of ['schemaVersion','revision','kind','bankId','questionId','requestHash','contextHash','input','alias','autoApply','memoryOnly'])delete value[key];return value;};
  async function mark(task,status,code=null,message=null){const next={...clone(task),status,updatedAt:new Date().toISOString()};if(code){next.errorCode=code;next.errorMessage=message;}return store(task.taskId,next);}
  async function taskFor(kind,bank,qid,key){let task=await load(key);if(task?.alias)task=await load(task.alias);if(!task||task.kind!==kind||task.bankId!==bank||task.questionId!==qid)throw fail('AI_TASK_NOT_FOUND','评分任务不存在',404);return task;}
  async function check(task){
    if(task.status==='confirmed'||task.status==='superseded')return task;
    try{if(wasApplied(task,await scope(task.kind).context(task.bankId,task.questionId)))return mark(task,'confirmed');}catch(error){if(!['BANK_NOT_FOUND','QUESTION_NOT_FOUND','AI_GRADING_UNAVAILABLE'].includes(error.code))throw error;}
    if(!await currentValid(task))return mark(task,'superseded','AI_RESULT_STALE','题目、答案或评分已变化，这次结果不会覆盖当前内容');
    if(['queued','running'].includes(task.status)&&!live.has(task.taskId))return mark(task,'failed','AI_INTERRUPTED','评分被应用中断，请手动重试；未自动追加模型请求');
    return task;
  }
  async function existing(kind,bank,qid,target=null){
    let value;try{value=await context(kind,bank,qid);}catch(error){if(error.code==='AI_GRADING_UNAVAILABLE')return null;throw error;}
    const key=target===null?value.state.aiTaskId:value.state.aiTaskIds?.[target];if(!key)return null;
    const task=await taskFor(kind,bank,qid,key),current=await check(task);if(current.status==='confirmed'){
      try{const value=await context(kind,bank,qid),assessment=target===null?value.state.result?.aiAssessment:value.state.result?.aiAssessments?.[target];if(assessment?.taskId===current.taskId)return current;}catch{}
    }else if(await currentValid(current))return current;return null;
  }
  function request(value,fields){if(!plain(value)||!id(value.requestId)||Object.keys(value).some(key=>!['requestId',...fields].includes(key)))throw fail('INVALID_REQUEST','AI 请求参数无效');}
  async function apply(task,body,automatic=false){
    if(!task.candidate||!['succeeded','confirmed'].includes(task.status))throw fail('AI_CANDIDATE_UNAVAILABLE','尚无可保存的评分建议',409);
    const version=body.candidateVersion??task.candidate.version;if(version!==task.candidate.version)throw fail('AI_CANDIDATE_CONFLICT','评分建议已更新，请重新查看',409);
    const score=body.score??task.candidate.score;if(!Number.isFinite(score))throw fail('AI_OUTPUT_INVALID','评分分数无效',422);
    if(task.status==='confirmed'){
      const value=await context(task.kind,task.bankId,task.questionId),assessment=task.targetId==null?value.state.result?.aiAssessment:value.state.result?.aiAssessments?.[task.targetId];
      if(assessment?.taskId!==task.taskId||assessment.candidateVersion!==version)throw fail('AI_RESULT_STALE','此评分已被后续操作更新',409);
      if(score!==assessment.reviewScore)throw fail('AI_CANDIDATE_CONFLICT','AI 评分已保存，调整分数请使用人工评分',409);
      return {...publicTask(task),payload:await scope(task.kind).payload(task.bankId,task.questionId)};
    }
    const assessment={...clone(task.candidate),taskId:task.taskId,candidateVersion:version,reviewScore:score,...(task.targetId==null?{}:{targetId:task.targetId})};delete assessment.version;
    const payload=await scope(task.kind).applyAiReview(task.bankId,task.questionId,{requestId:body.requestId,score,assessment,
      assert:async value=>{if(!await validFor(task,value))throw fail('AI_RESULT_STALE','题目、答案或评分已变化，AI 结果未覆盖当前内容',409);}});
    task=await mark(task,'confirmed');return {...publicTask(task),payload};
  }
  async function execute(key){
    let task=await load(key);
    try{
      if(closed)throw fail('AI_INTERRUPTED','评分服务已停止');
      if(!await currentValid(task)){await mark(task,'superseded','AI_RESULT_STALE','当前答案已变化');return;}
      task=await mark(task,'running');
      let result,candidate;
      for(let attempt=0;attempt<2;attempt++){
        task=await store(key,{...clone(task),calls:task.calls+1});
        const attachments=await scope(task.kind).attachments?.(task.bankId,task.questionId,task.input)||[];
        if(!await currentValid(task)){await mark(task,'superseded','AI_RESULT_STALE','题目、答案或人工评分已变化');return;}
        result=await nativeCall('ai.request',{bankId:task.bankId,input:clone(task.input),...(attachments.length?{attachments}:{}),...(task.configurationVersion?{configurationVersion:task.configurationVersion}:{}),...(attempt?{repair:true,invalidOutput:result.output}:{})});
        if(!await currentValid(task)){await mark(task,'superseded','AI_RESULT_STALE','题目、答案或人工评分已变化，返回结果未保存');return;}
        candidate=parseModelOutput(result.output);if(candidate)break;
      }
      if(!candidate)throw fail('AI_OUTPUT_INVALID','模型未返回有效评分，请手动重试或人工评分',422);
      candidate={...candidate,provider:String(result.provider||'openai-compatible').slice(0,100),model:String(result.model||'').slice(0,200),responseId:String(result.responseId||'').slice(0,200),
        usage:clone(result.usage||{}),gradedAt:new Date().toISOString(),protocolVersion:1,maxScore:task.input.maxScore,scoreStep:task.input.scoreStep};candidate.version=await hash([key,candidate]);
      task=await store(key,{...clone(task),candidate,status:'succeeded',updatedAt:new Date().toISOString()});
      if(task.autoApply)await apply(task,{requestId:'auto-'+key,candidateVersion:candidate.version});
    }catch(error){try{if(task){const latest=await load(key);let applied=false;try{applied=wasApplied(latest,await scope(latest.kind).context(latest.bankId,latest.questionId));}catch{}
      await mark(latest,applied?'confirmed':error.code==='AI_RESULT_STALE'?'superseded':'failed',applied?null:error.code||'AI_TASK_FAILED',applied?null:error.code?error.message:'评分未完成，当前作答已保留，请手动重试');}}catch{/* preserve last durable evidence */}}
    finally{live.delete(key);}
  }
  function enqueue(task){live.add(task.taskId);pumping=pumping.catch(()=>{}).then(()=>execute(task.taskId));}
  async function start(kind,bank,qid,body,{automatic=false,retryOf=null}={}){
    request(body,['contentVersion','force','targetId']);if(body.targetId!==undefined&&!id(body.targetId))throw fail('INVALID_REQUEST','评分目标无效');
    return serialized([kind,bank,qid].join(':'),async()=>{
      const key=await documentKey(kind,bank,qid,retryOf?'retry':'start',body.requestId),requestHash=await hash([body,retryOf]),prior=await load(key);
      if(prior){if(prior.requestHash!==requestHash)throw fail('REQUEST_ID_REUSED','相同请求编号不能用于不同 AI 请求',409);return publicTask(await check(await taskFor(kind,bank,qid,key)));}
      const settings=await nativeCall('settings.ai.get',{});if(!settings.enabled)throw fail('AI_NOT_CONFIGURED','请先配置并启用 AI 评分',409);
      const value=await context(kind,bank,qid);if(!await supports(value.extension))throw fail('AI_GRADING_UNAVAILABLE','此题型没有提供 AI 评分规则',409);
      if(body.contentVersion!==undefined&&body.contentVersion!==value.contentVersion)throw fail('CONTENT_CONFLICT','题目内容已变化，请重新读取',409);
      const target=body.targetId??null,current=await existing(kind,bank,qid,target);
      if(current&&(['queued','running'].includes(current.status)||!retryOf&&!body.force&&['succeeded','confirmed'].includes(current.status))){
        await store(key,{taskId:key,kind,bankId:bank,questionId:qid,alias:current.taskId,requestHash,memoryOnly:current.memoryOnly});return publicTask(current);
      }
      const prepared=await value.run({op:'prepareAiGrading',data:value.q.data,answer:value.state.answer,state:{...value.state,submitted:true},...(target===null?{}:{targetId:target})});
      const input=validateInput(prepared.gradingInput),now=new Date().toISOString();
      if(live.size>=16)throw fail('AI_QUEUE_FULL','评分任务较多，请稍后重试',429);
      const task=await store(key,{taskId:key,kind,bankId:bank,questionId:qid,targetId:target,requestHash,contextHash:await stampContext(value,target),input,configurationVersion:settings.configurationVersion,memoryOnly:value.snapshot.features.history===false,
        status:'queued',calls:0,autoApply:true,createdAt:now,updatedAt:now,...(retryOf?{previousTaskId:retryOf}:{})});
      try{await scope(kind).bindTask?.(bank,qid,task,async current=>{if(await stampContext(current,target)!==task.contextHash)throw fail('AI_RESULT_STALE','答案已变化，未请求模型',409);});}
      catch(error){await mark(task,'failed',error.code||'AI_BIND_FAILED','AI 任务未能绑定，未发起模型请求');throw error;}
      enqueue(task);return publicTask(task);
    });
  }
  async function automatic(kind,bank,qid){
    try{
      const settings=await nativeCall('settings.ai.get',{});if(!settings.enabled||!settings.autoGrade)return;
      const value=await context(kind,bank,qid);if(!await supports(value.extension))return;
      const prepared=await value.run({op:'prepareAiGrading',data:value.q.data,answer:value.state.answer,state:{...value.state,submitted:true},automatic:true});
      const targets=prepared.gradingInput?.targets;
      if(targets!==undefined){if(!Array.isArray(targets)||targets.length>256||new Set(targets.map(t=>t.targetId)).size!==targets.length||targets.some(t=>!id(t.targetId)))throw fail('INVALID_AI_INPUT','自动评分目标无效');
        for(const target of targets)await start(kind,bank,qid,{requestId:'automatic-'+await hash([await stampContext(value,target.targetId),target.targetId]),targetId:target.targetId});
      }else await start(kind,bank,qid,{requestId:'automatic-'+await stampContext(value)});
    }catch{/* persisted submission stays available for manual grading */}
  }
  // Called with an already-read snapshot from the practice transaction. Never
  // reenter that bank's read queue while finish owns its atomic state mutation.
  async function completionStatus(value){
    const keys=[value.state.aiTaskId,...Object.values(value.state.aiTaskIds||{})].filter(Boolean);let running=false,error=false;
    for(const key of new Set(keys)){
      const task=await load(key);if(!task)continue;
      if(wasApplied(task,value))continue;
      if(!await validFor(task,value))continue;
      if(['queued','running','succeeded'].includes(task.status))running=true;
      else if(task.status==='failed')error=true;
    }
    let needsAutomatic=false;
    if(!keys.length&&value.state.aiAutoEligible&&await supports(value.extension)){
      try{const settings=await nativeCall('settings.ai.get',{});needsAutomatic=settings.enabled&&settings.autoGrade;}
      catch{/* a broken optional AI configuration must not block offline use */}
    }
    return {pending:running||needsAutomatic,error,needsAutomatic};
  }
  async function handle({path,method='GET',body=null}){
    const url=new URL(path,'https://appassets.androidplatform.net'),parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);method=method.toUpperCase();if(typeof body==='string')body=JSON.parse(body);
    if(parts.join('/').startsWith('api/settings/ai')){
      if(parts.length===3&&method==='GET')return nativeCall('settings.ai.get',{});
      if(parts[3]==='credential'&&method==='GET'){const settings=await nativeCall('settings.ai.get',{});return {apiKey:settings.apiKeyConfigured?SAVED_KEY_PLACEHOLDER:''};}
      if(parts.length===3&&method==='PUT'){const profile=clone(body);if(profile.apiKey===SAVED_KEY_PLACEHOLDER){delete profile.apiKey;delete profile.clearApiKey;}return nativeCall('settings.ai.update',{profile});}
      if(parts[3]==='test'&&method==='POST')return nativeCall('settings.ai.test',{});
      // Hub account for the free AI quota (Web /api/settings/ai/hub*); the token stays native.
      if(parts[3]==='hub'&&parts.length===4&&method==='GET')return nativeCall('hub.connection.account',{});
      if(parts[3]==='hub'&&parts.length===5&&method==='POST'&&['login','logout','redeem'].includes(parts[4]))return nativeCall('hub.connection.'+parts[4],parts[4]==='redeem'?{code:plain(body)?body.code:undefined}:{});
      throw fail('NOT_FOUND','AI 设置接口不存在',404);
    }
    if(parts[0]!=='api'||parts[1]!=='collections'||parts[4]!=='questions'||parts[6]!=='ai')return undefined;
    const [kind,bank,qid]=[parts[2],parts[3],parts[5]],op=parts[7];scope(kind);
    if(op==='grade'&&parts.length===8&&method==='POST')return start(kind,bank,qid,body);
    if(op==='current'&&parts.length===8&&method==='GET'){const target=url.searchParams.get('targetId');if(target!==null&&!id(target))throw fail('INVALID_REQUEST','评分目标无效');const task=await existing(kind,bank,qid,target);return {task:task?publicTask(task):null};}
    if(op==='tasks'&&/^[a-f0-9]{64}$/.test(parts[8]||'')){
      const task=await check(await taskFor(kind,bank,qid,parts[8]));
      if(parts.length===9&&method==='GET')return publicTask(task);
      if(parts[9]==='confirm'&&method==='POST'){request(body,['candidateVersion','score']);return apply(task,body);}
      if(parts[9]==='retry'&&method==='POST'){request(body,[]);return start(kind,bank,qid,{requestId:body.requestId,...(task.targetId==null?{}:{targetId:task.targetId})},{retryOf:task.taskId});}
    }
    throw fail('NOT_FOUND','AI 评分接口不存在',404);
  }
  const service={handle,bindScope:(kind,adapter)=>scopes.set(kind,adapter),completionStatus,
    supports:async value=>{if(value.extension.canAiGrade===undefined)value.extension.canAiGrade=(await value.run({op:'capabilities'})).canAiGrade;return supports(value.extension);},
    scheduleAutomatic:(kind,bank,qid)=>{const pending=Promise.resolve().then(()=>automatic(kind,bank,qid));scheduled.add(pending);pending.finally(()=>scheduled.delete(pending));},
    current:async(kind,bank,qid)=>{const task=await existing(kind,bank,qid);return task?publicTask(task):null;},
    settled:async()=>{while(scheduled.size)await Promise.allSettled([...scheduled]);await pumping;},close:()=>{closed=true;}};
  return service;
}
