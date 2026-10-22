import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiService,SAVED_KEY_PLACEHOLDER,parseModelOutput} from '../web/ai-service.js';
import {createPracticeService} from '../web/web-practice-service.js';
import {runRule} from '../rules/runtime.js';
import {normalizeDraft} from '../vendor/quizforge-web/core/web/draft/whiteboard-model.js';

const clone=value=>structuredClone(value),path='/api/collections/bank/b1/questions/q1';
const rules=`QF.defineType({project(data,state){return {prompt:data.prompt,...(state.submitted?{key:'reference'}:{})};},grade(){return {gradingStatus:'pending',score:null,maxScore:5,correct:null,feedback:'待评分'};},review(data,answer,review){return {gradingStatus:'graded',score:review.score,maxScore:5,correct:review.score===5,feedback:review.feedback||'人工评分'};},getScore(data,state){return {score:state.submitted||state.status==='submitted'?state.result.score:0,maxScore:5};},prepareAiGrading(data,answer,context){return {protocolVersion:1,question:[{type:'text',text:data.prompt}],answer:[{type:'text',text:answer.text}],referenceAnswer:[{type:'text',text:'reference'}],maxScore:5,scoreStep:0.5};}});`;
function fixture({persistent=true,auto=false,enabled=true,stored=null,docs=new Map(),ruleSource=rules,model=async()=>({output:'{"score":2.5,"feedback":"建议反馈"}',model:'fake-model',provider:'openai-compatible',usage:{total_tokens:5}})}={}){
 let state=clone(stored),generation=0,settings={enabled,autoGrade:auto,apiKeyConfigured:true,baseUrl:'https://model.invalid/v1',model:'fake-model'},failWrite=false,failTaskConfirmation=false;
 const calls=[],bank={id:'source',title:'AI fixture',features:{history:persistent},extension:{path:'extensions/Test'},questions:[{id:'q1',title:'题一',data:{prompt:'fictional question'}}]};
 const native=async(method,args={})=>{
  calls.push({method,args:clone(args)});
  if(method==='library.readBank')return {id:'b1',title:bank.title,bank:clone(bank)};
  if(method==='library.list')return [{id:'b1',title:bank.title,features:bank.features}];
  if(method==='library.readExtension')return {manifest:{id:'test',name:'Test',version:'1.0.0',requiresApi:{major:1,minMinor:4,capabilities:['practice','score','manual-review','ai-grading','richtext']},requiresRichText:{documentProfile:'advanced-v1'}},html:'<main></main>',script:'',style:'',rules:ruleSource,questionSchema:true,answerSchema:true,assets:[]};
  if(method==='state.read')return clone(state);
  if(method==='state.write'){if(failWrite)throw Object.assign(Error('disk unavailable'),{code:'IO_ERROR'});assert.equal(args.expectedRevision,state?.revision||0);state={...clone(args.state),revision:(state?.revision||0)+1};return clone(state);}
  if(method==='rules.run'){const result=runRule({...args.request,rules:ruleSource,questionSchema:true,answerSchema:true,apiVersion:{major:1,minor:4}});if(!result.ok)throw Object.assign(Error(result.error),{code:result.code||'RULE_REJECTED'});return result.data;}
  if(method==='settings.ai.get')return clone(settings);
  if(method==='settings.ai.update'){settings={...settings,...clone(args.profile)};return clone(settings);}
  if(method==='settings.ai.test')return {status:'passed',settings:clone(settings)};
  if(method==='documents.list')return [...docs.keys()];
  if(method==='documents.read')return clone(docs.get(args.key)||null);
  if(method==='documents.write'){if(failTaskConfirmation&&args.value.status==='confirmed')throw Object.assign(Error('synthetic confirmation store failure'),{code:'IO_ERROR'});assert.equal(args.expectedRevision,docs.get(args.key)?.revision||0);const value={...clone(args.value),schemaVersion:1,revision:args.expectedRevision+1};docs.set(args.key,value);return clone(value);}
  if(method==='ai.request')return model(args,generation++);
  throw Error('unexpected '+method);
 };
 const ai=createAiService(native),practice=createPracticeService(native,{aiService:ai,normalizeDraft,prepareAssets:async value=>value,
  loadText:async path=>path.endsWith('service.json')?JSON.stringify({api:{major:1,minor:1,documentFormat:1},profiles:[{id:'advanced-v1',provider:{id:'quizforge.richtext',version:'1.1.3'},capabilities:['basic-formatting']}]}):'/* pinned fixture */'});
 const handle=async(path,method='GET',body=null)=>{const request={path,method,body};const result=await ai.handle(request);return result===undefined?practice.handle(request):result;};
 return {ai,practice,handle,native,calls,docs,bank,get state(){return clone(state);},get settings(){return clone(settings);},fail(value){failWrite=value;},failConfirmation(value){failTaskConfirmation=value;}};
}
async function action(f,name,data,id=crypto.randomUUID()){
 const q=await f.handle(path);return f.handle(path+'/actions','POST',{requestId:id,revision:q.state.revision,contentVersion:q.stamp.contentVersion,action:name,data});
}
async function submitted(f){return action(f,'submit',{answer:{text:'student answer'}});}
const modelCalls=f=>f.calls.filter(call=>call.method==='ai.request');

test('settings adapter preserves saved credentials by sentinel and supports clear/replace without a native credential read',async()=>{
 const f=fixture();assert.deepEqual(await f.handle('/api/settings/ai/credential'),{apiKey:SAVED_KEY_PLACEHOLDER});
 await f.handle('/api/settings/ai','PUT',{enabled:true,apiKey:SAVED_KEY_PLACEHOLDER});
 assert.equal(Object.hasOwn(f.calls.at(-1).args.profile,'apiKey'),false);
 await f.handle('/api/settings/ai','PUT',{clearApiKey:true});assert.equal(f.calls.at(-1).args.profile.clearApiKey,true);
 await f.handle('/api/settings/ai','PUT',{apiKey:'new-synthetic-value'});assert.equal(f.calls.at(-1).args.profile.apiKey,'new-synthetic-value');
 assert.equal(f.calls.some(call=>call.method==='settings.ai.credential'),false);
});

test('durable job auto-applies validated rule review, survives reload, and request replay never calls the model again',async()=>{
 const f=fixture();await submitted(f);const body={requestId:'first-ai'};
 const task=await f.handle(path+'/ai/grade','POST',body);assert.equal(task.status,'queued');assert.equal(task.input,undefined);
 await f.ai.settled();const saved=await f.handle(path+'/ai/tasks/'+task.taskId);assert.equal(saved.status,'confirmed');assert.equal(modelCalls(f).length,1);
 const q=await f.handle(path);assert.equal(q.state.result.score,2.5);assert.equal(q.state.result.aiAssessment.taskId,task.taskId);assert.equal(q.state.result.gradingSource,'ai');
 const receipt=await f.handle(path+'/ai/tasks/'+task.taskId+'/confirm','POST',{requestId:'confirm-again',candidateVersion:saved.candidate.version});assert.equal(receipt.payload.state.result.score,2.5);
 assert.equal((await f.handle(path+'/ai/grade','POST',body)).taskId,task.taskId);assert.equal(modelCalls(f).length,1);
 const reloaded=fixture({stored:f.state,docs:f.docs});assert.equal((await reloaded.handle(path+'/ai/grade','POST',body)).status,'confirmed');assert.equal(modelCalls(reloaded).length,0);
});

test('same request ID with changed data is rejected and explicit retry is the only new call after interruption',async()=>{
 const f=fixture({model:async()=>{throw Object.assign(Error('synthetic network interruption'),{code:'AI_NETWORK'});}});await submitted(f);const task=await f.handle(path+'/ai/grade','POST',{requestId:'dedupe'});await f.ai.settled();
 await assert.rejects(f.handle(path+'/ai/grade','POST',{requestId:'dedupe',force:true}),e=>e.code==='REQUEST_ID_REUSED');
 const stored=clone(f.docs.get(task.taskId));stored.status='running';delete stored.candidate;f.docs.set(task.taskId,stored);
 const g=fixture({stored:f.state,docs:f.docs});assert.equal((await g.handle(path+'/ai/tasks/'+task.taskId)).errorCode,'AI_INTERRUPTED');assert.equal(modelCalls(g).length,0);
 const next=await g.handle(path+'/ai/tasks/'+task.taskId+'/retry','POST',{requestId:'explicit-retry'});await g.ai.settled();assert.notEqual(next.taskId,task.taskId);assert.equal(modelCalls(g).length,1);
});

test('a model returning after manual review cannot overwrite the newer score',async()=>{
 let release;const promise=new Promise(resolve=>release=resolve),f=fixture({model:()=>promise});await submitted(f);
 const task=await f.handle(path+'/ai/grade','POST',{requestId:'late'});await new Promise(resolve=>setTimeout(resolve,10));
 await action(f,'review',{review:{score:4,feedback:'人工确认'}});release({output:'{"score":1,"feedback":"迟到结果"}'});await f.ai.settled();
 assert.equal((await f.handle(path)).state.result.score,4);assert.equal((await f.handle(path+'/ai/tasks/'+task.taskId)).status,'superseded');
});

test('whiteboard revisions do not invalidate otherwise-current AI input',async()=>{
 let release;const promise=new Promise(resolve=>release=resolve),f=fixture({model:()=>promise});await submitted(f);
 const task=await f.handle(path+'/ai/grade','POST',{requestId:'ink-while-model'});await new Promise(resolve=>setTimeout(resolve,10));
 await action(f,'whiteboard',{draft:{schemaVersion:1,viewport:{x:0,y:0,zoom:1},paper:{color:'#ffffff',pattern:'plain'},strokes:[]}});
 release({output:'{"score":3,"feedback":"评分有效"}'});await f.ai.settled();assert.equal((await f.handle(path+'/ai/tasks/'+task.taskId)).status,'confirmed');assert.equal((await f.handle(path)).state.result.score,3);
});

test('invalid model JSON has one bounded repair, then fails without replacing the submitted answer',async()=>{
 const f=fixture({model:async()=>({output:'not json'})});await submitted(f);const task=await f.handle(path+'/ai/grade','POST',{requestId:'bad-output'});await f.ai.settled();
 assert.equal(modelCalls(f).length,2);assert.equal(modelCalls(f)[1].args.repair,true);assert.equal((await f.handle(path+'/ai/tasks/'+task.taskId)).errorCode,'AI_OUTPUT_INVALID');
 assert.equal((await f.handle(path)).state.result.gradingStatus,'pending');assert.equal(f.state.questions.q1.answer.text,'student answer');
});

test('disabled AI and failed durable submission never trigger automatic paid requests',async()=>{
 const f=fixture({enabled:false,auto:true});await submitted(f);await f.ai.settled();assert.equal(modelCalls(f).length,0);
 await assert.rejects(f.handle(path+'/ai/grade','POST',{requestId:'off'}),e=>e.code==='AI_NOT_CONFIGURED');
 const failed=fixture({auto:true});failed.fail(true);await assert.rejects(submitted(failed),e=>e.code==='IO_ERROR');await failed.ai.settled();assert.equal(modelCalls(failed).length,0);
});

test('automatic mode schedules only after successful submission and temporary practice never persists tasks',async()=>{
 const f=fixture({auto:true});await submitted(f);await f.ai.settled();assert.equal(modelCalls(f).length,1);assert.equal((await f.handle(path)).state.result.score,2.5);
 const temporary=fixture({persistent:false});await submitted(temporary);await temporary.handle(path+'/ai/grade','POST',{requestId:'memory-ai'});await temporary.ai.settled();
 assert.equal(modelCalls(temporary).length,1);assert.equal(temporary.state,null);assert.equal(temporary.calls.some(call=>call.method==='documents.write'),false);
});

test('model output parser accepts existing fenced contract but rejects extra fields and nonfinite scores',()=>{
 assert.deepEqual(parseModelOutput('```json\n{"score":1,"feedback":"ok"}\n```'),{score:1,feedback:'ok'});
 assert.equal(parseModelOutput('{"score":1,"feedback":"ok","execute":"bad"}'),null);assert.equal(parseModelOutput('{"score":1e999,"feedback":"ok"}'),null);
});

test('manual review of one declared target invalidates only that target and preserves another AI result',async()=>{
 const multi=`QF.defineType({project(data){return data;},grade(){return {gradingStatus:'pending',score:null,maxScore:5,correct:null,feedback:'pending',parts:{a:null,b:null}};},review(data,answer,review,context){const parts={...context.state.result.parts,[review.targetId]:review.score},pending=Object.values(parts).some(v=>v===null);return {parts,gradingStatus:'graded',score:(parts.a||0)+(parts.b||0),maxScore:5,correct:(parts.a||0)+(parts.b||0)===5,feedback:'reviewed'};},getScore(data,state){return {score:state.submitted||state.status==='submitted'?state.result.score:0,maxScore:5};},prepareAiGrading(data,answer,context){return {protocolVersion:1,question:[{type:'text',text:context.targetId||'a'}],answer:[{type:'text',text:answer.text}],referenceAnswer:[{type:'text',text:'reference'}],maxScore:2.5,scoreStep:0.5};}});`;
 let release;const pending=new Promise(resolve=>release=resolve),f=fixture({ruleSource:multi,model:async args=>args.input.question[0].text==='a'?pending:{output:'{"score":2,"feedback":"小题b"}'}});
 await submitted(f);const first=await f.handle(path+'/ai/grade','POST',{requestId:'target-a',targetId:'a'}),second=await f.handle(path+'/ai/grade','POST',{requestId:'target-b',targetId:'b'});
 await action(f,'review',{review:{score:1,feedback:'人工a',targetId:'a'}});release({output:'{"score":0,"feedback":"迟到a"}'});await f.ai.settled();
 assert.equal((await f.handle(path+'/ai/tasks/'+first.taskId)).status,'superseded');assert.equal((await f.handle(path+'/ai/tasks/'+second.taskId)).status,'confirmed');
 const result=(await f.handle(path)).state.result;assert.deepEqual(result.parts,{a:1,b:2});assert.equal(result.score,3);assert.equal(result.aiAssessments.a,undefined);assert.equal(result.aiAssessments.b.taskId,second.taskId);
});

const gradedZeroRules=rules.replace("gradingStatus:'pending',score:null,maxScore:5,correct:null","gradingStatus:'graded',score:0,maxScore:5,correct:false");
async function finishRequest(f,id='finish-with-ai'){
 const summary=await f.handle('/api/collections/bank/b1/summary');return {requestId:id,roundId:summary.roundId,summaryVersion:summary.summaryVersion};
}

test('finish auto-submits graded-zero drafts but waits for automatic AI before freezing the round',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve),f=fixture({auto:true,ruleSource:gradedZeroRules,model:()=>pending});
 await action(f,'draft',{answer:{text:'draft answer'}});const request=await finishRequest(f);
 const waiting=await f.handle('/api/collections/bank/b1/finish','POST',request);assert.equal(waiting.completionPending,true);assert.equal(waiting.finished,false);assert.equal(f.state.finished,false);
 await new Promise(resolve=>setTimeout(resolve,10));release({output:'{"score":4,"feedback":"自动完成评分"}'});await f.ai.settled();
 const complete=await f.handle('/api/collections/bank/b1/finish','POST',request);assert.equal(complete.finished,true);assert.equal(complete.score,4);assert.equal(modelCalls(f).length,1);
 const history=await f.handle('/api/collections/bank/b1/history/'+complete.historyId);assert.equal(history.summary.score,4);
});

test('finish waits for manual AI in flight and exposes failure until manual grading resolves it',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve),f=fixture({ruleSource:gradedZeroRules,model:()=>pending});await submitted(f);
 await f.handle(path+'/ai/grade','POST',{requestId:'running-before-finish'});const request=await finishRequest(f,'manual-ai-finish');
 assert.equal((await f.handle('/api/collections/bank/b1/finish','POST',request)).completionPending,true);assert.equal(f.state.finished,false);
 release({output:'{"score":3,"feedback":"评分完成"}'});await f.ai.settled();assert.equal((await f.handle('/api/collections/bank/b1/finish','POST',request)).score,3);
 const failed=fixture({ruleSource:gradedZeroRules,model:async()=>{throw Object.assign(Error('synthetic upstream failure'),{code:'AI_UPSTREAM'});}});await submitted(failed);
 await failed.handle(path+'/ai/grade','POST',{requestId:'failed-before-finish'});await failed.ai.settled();const retry=await finishRequest(failed,'failed-ai-finish');
 const blocked=await failed.handle('/api/collections/bank/b1/finish','POST',retry);assert.equal(blocked.completionPending,true);assert.match(blocked.completionError,/AI/);assert.equal(failed.state.finished,false);
 await action(failed,'review',{review:{score:2,feedback:'人工处理'}});assert.equal((await failed.handle('/api/collections/bank/b1/finish','POST',retry)).score,2);assert.equal(modelCalls(failed).length,1);
});

test('retry while running aliases the active task and never launches another model request',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve),f=fixture({model:()=>pending});await submitted(f);
 const active=await f.handle(path+'/ai/grade','POST',{requestId:'active'});await new Promise(resolve=>setTimeout(resolve,10));
 const retried=await f.handle(path+'/ai/tasks/'+active.taskId+'/retry','POST',{requestId:'retry-while-running'});assert.equal(retried.taskId,active.taskId);
 release({output:'{"score":3,"feedback":"single result"}'});await f.ai.settled();assert.equal(modelCalls(f).length,1);assert.equal((await f.handle(path)).state.result.score,3);
});

test('replaced task binding rejects an old result even when answer and generations are identical',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve),f=fixture({model:()=>pending});await submitted(f);
 const old=await f.handle(path+'/ai/grade','POST',{requestId:'old-binding'});await new Promise(resolve=>setTimeout(resolve,10));
 await f.practice.domain.host.transact('b1','test-binding','q1',state=>{state.questions.q1.aiTaskId='f'.repeat(64);return {};});
 release({output:'{"score":1,"feedback":"old result"}'});await f.ai.settled();assert.equal((await f.handle(path+'/ai/tasks/'+old.taskId)).status,'superseded');assert.equal((await f.handle(path)).state.result.gradingStatus,'pending');
});

test('a committed AI review recovers confirmation after a task-file write interruption without another paid call',async()=>{
 const f=fixture();await submitted(f);f.failConfirmation(true);const task=await f.handle(path+'/ai/grade','POST',{requestId:'confirmation-gap'});await f.ai.settled();
 assert.equal(f.state.questions.q1.result.score,2.5);assert.equal(f.docs.get(task.taskId).status,'succeeded');
 const restored=fixture({stored:f.state,docs:f.docs});const recovered=await restored.handle(path+'/ai/tasks/'+task.taskId);assert.equal(recovered.status,'confirmed');
 assert.equal((await restored.handle(path+'/ai/grade','POST',{requestId:'confirmation-gap'})).status,'confirmed');assert.equal(modelCalls(restored).length,0);
});



test('free-quota grading keeps the provider the native gateway actually used',async()=>{
 const f=fixture({model:async()=>({output:'{"score":2.5,"feedback":"建议反馈"}',model:'quizforge-official',provider:'quizforge-official',usage:{total_tokens:7}})});
 await submitted(f);const task=await f.handle(path+'/ai/grade','POST',{requestId:'official-ai'});await f.ai.settled();
 const saved=await f.handle(path+'/ai/tasks/'+task.taskId);assert.equal(saved.candidate.provider,'quizforge-official');assert.equal(saved.candidate.model,'quizforge-official');
});
