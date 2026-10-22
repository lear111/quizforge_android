import test from 'node:test';
import assert from 'node:assert/strict';
import {createDomain,validateInk} from '../web/domain.js';
import {runRule} from '../rules/runtime.js';

const copy=x=>structuredClone(x);
const rules=`QF.defineType({
 project(data,state){return {prompt:data.prompt,maxScore:2,...(state.submitted?{key:data.key}:{})}},
 grade(data,answer){return data.manual?{gradingStatus:'pending',score:null,maxScore:2,correct:null,feedback:'待人工评分'}:{score:answer.value===data.key?2:0,maxScore:2,correct:answer.value===data.key,feedback:'已判分'}},
 getScore(data,state){return {score:state.submitted?state.result.score:0,maxScore:2,gradingStatus:state.submitted?(state.result.gradingStatus||'graded'):'graded'}},
 review(data,answer,review){return {score:review.score,maxScore:2,correct:review.score===2,feedback:review.feedback||'人工评分'}},
 getOutlineItems(){return [{id:'part-a',label:'小题'}]}
});`;
function fixture({persistent=true,manual=false}={}){
 let stored=null,writes=0,fail=false,source=rules;
 const bank={id:'source',title:'测试题库',features:{history:persistent},extension:{path:'extensions/demo/test'},questions:[{id:'q1',title:'第一题',data:{prompt:'2+2=?',key:4,manual}},{id:'q2',title:'第二题',data:{prompt:'1+1=?',key:2}}]};
 const manifest={requiresApi:{major:1,minMinor:4,capabilities:['practice','score','manual-review','outline-items','answer-state','appearance']},requiresRichText:{documentProfile:'advanced-v1'}};
 const request=async(method,args={})=>{
   if(method==='library.list')return [{id:'b1',title:bank.title,questionCount:2}];
   if(method==='library.readBank')return {id:'b1',title:bank.title,bank:copy(bank)};
   if(method==='library.readExtension')return {manifest:copy(manifest),html:'<div></div>',script:'/* original page */',style:'',rules:source,questionSchema:true,answerSchema:{type:'object',required:['value'],properties:{value:{type:'number'}},additionalProperties:false},assets:[]};
   if(method==='state.read')return copy(stored);
   if(method==='state.write'){
     if(fail)throw Object.assign(new Error('磁盘已满'),{code:'IO_ERROR'});
     assert.equal(args.expectedRevision,stored?.revision||0);
     stored={...copy(args.state),revision:args.expectedRevision+1};writes++;return copy(stored);
   }
   if(method==='rules.run'){
     const reply=runRule({...args.request,rules:source,questionSchema:true,answerSchema:{type:'object',required:['value'],properties:{value:{type:'number'}},additionalProperties:false},apiVersion:{major:1,minor:4},outlineItemsDeclared:true,answerStateDeclared:true});
     if(!reply.ok)throw Object.assign(new Error(reply.error),{code:reply.code||'RULE_REJECTED'});return reply.data;
   }
   throw new Error('Unexpected native call '+method);
 };
 const options={prepareAssets:async x=>x,loadText:async p=>p.endsWith('service.json')?JSON.stringify({api:{major:1,minor:1,documentFormat:1},profiles:[{id:'advanced-v1',provider:{version:'1.1.3'},capabilities:['basic-formatting','images']}]}):'/* pinned sdk */'};
 return {domain:createDomain(request,options),reload:()=>createDomain(request,options),get state(){return copy(stored)},get writes(){return writes},failWrite(v){fail=v},changeSource(v){source=v},bank};
}
const answer=(value,purpose='draft',extra={})=>({purpose,data:{answer:{value}},...extra});

test('renaming a temporary bank refreshes metadata without losing live answers',async()=>{
 const f=fixture({persistent:false}),d=f.domain;
 await d.handleRequest('b1','q1','save',answer(4));
 f.bank.title='新的题库名称';await d.host.invalidate('b1');
 assert.equal((await d.host.read('b1')).title,'新的题库名称');
 assert.equal((await d.openQuestion('b1',0)).context.answer.value,4);
 assert.equal(f.writes,0);
});
test('external content edits clear only the edited temporary answer and title-only edits retain it',async()=>{
 const f=fixture({persistent:false}),d=f.domain;
 await d.handleRequest('b1','q1','save',answer(4));await d.handleRequest('b1','q2','save',answer(2));
 await d.host.externalChange('b1','edited','q1',async()=>{f.bank.questions[0].title='修正标题';return {dataChanged:false};});
 assert.equal((await d.openQuestion('b1',0)).context.answer.value,4);
 await d.host.externalChange('b1','edited','q1',async()=>{f.bank.questions[0].data.key=5;return {dataChanged:true};});
 assert.equal((await d.openQuestion('b1',0)).context.answer,null);
 assert.equal((await d.openQuestion('b1',1)).context.answer.value,2);
 assert.equal(f.writes,0);
});
test('a rejected external edit preserves confirmed in-memory practice input',async()=>{
 const f=fixture({persistent:false}),d=f.domain;
 await d.handleRequest('b1','q1','save',answer(4));
 await assert.rejects(d.host.externalChange('b1','edited','q1',async()=>{throw Error('内容冲突');}),/内容冲突/);
 assert.equal((await d.openQuestion('b1',0)).context.answer.value,4);
});

test('projection hides answers and submit/persistence/restart preserve the same grade',async()=>{
 const f=fixture(),d=f.domain;
 const opened=await d.openQuestion('b1',0);assert.equal(opened.context.question.data.key,undefined);
 let reply=await d.handleRequest('b1','q1','save',answer(4));assert.equal(reply.ok,true);
 assert.equal((await f.reload().openQuestion('b1',0)).context.answer.value,4);
 reply=await d.handleRequest('b1','q1','save',answer(4,'submit'));assert.equal(reply.data.result.score,2);
 const restored=await f.reload().openQuestion('b1',0);assert.equal(restored.context.status,'submitted');assert.equal(restored.context.question.data.key,4);
});
test('failed storage never reports a successful save or mutates confirmed answer',async()=>{
 const f=fixture();await f.domain.handleRequest('b1','q1','save',answer(1));const before=f.state;
 f.failWrite(true);const reply=await f.domain.handleRequest('b1','q1','save',answer(4));
 assert.equal(reply.ok,false);assert.equal(reply.error.code,'IO_ERROR');assert.deepEqual(f.state,before);
 assert.equal((await f.domain.openQuestion('b1',0)).context.answer.value,1);
});
test('answer-state reports are ephemeral until the matching answer is durably saved',async()=>{
 const f=fixture(),d=f.domain;
 const report=await d.handleRequest('b1','q1','answer-state',{status:'draft',targetId:'part-a'});
 assert.equal(f.writes,0);assert.equal(report.ok,true);
 await d.handleRequest('b1','q1','save',answer(4,'draft',{answerStateId:report.data.stateId}));
 assert.deepEqual(f.state.questions.q1.answerState,{status:'draft',outlineStates:[{id:'part-a',status:'draft'}]});
 const expired=await d.handleRequest('b1','q2','save',answer(2,'draft',{answerStateId:'9999'}));assert.equal(expired.error.code,'ANSWER_STATE_EXPIRED');
});
test('pending manual grade blocks finish; review then completion freezes pages and ink',async()=>{
 const f=fixture({manual:true}),d=f.domain,events=[];d.onChanged=e=>events.push(e);
 await d.handleRequest('b1','q1','save',answer(4,'submit'));
 assert.equal((await d.finish('b1')).finished,false);assert.notEqual(events.at(-1).type,'finished');assert.equal(f.state.history.length,0);
 const review=await d.handleRequest('b1','q1','save',{purpose:'review',data:{review:{score:2,feedback:'正确'}}});assert.equal(review.ok,true);
 const ink={formatVersion:1,width:760,height:1100,strokes:[{id:'stroke',color:'#123456',width:2,points:[{x:3,y:4,pressure:.6}]}]};await d.saveInk('b1','q1',ink);
 const finish=await d.finish('b1');assert.equal(finish.finished,true);assert.equal(finish.score,2);assert.equal(finish.maxScore,4);
 const history=(await d.listHistory('b1'))[0],snapshot=await d.openQuestion('b1',0,{historyId:history.id});
 assert.equal(snapshot.context.capabilities.canSave,false);assert.deepEqual(snapshot.ink,ink);
 await d.startNewRound('b1');assert.equal((await d.openQuestion('b1',0)).context.status,'unanswered');
 assert.deepEqual((await d.openQuestion('b1',0,{historyId:history.id})).context,snapshot.context);
 assert.equal(f.state.history.length,1);
});
test('concurrent saves are serialized; stale writes cannot overwrite a later confirmed answer',async()=>{
 const f=fixture(),d=f.domain;await d.openBank('b1');
 const replies=await Promise.all([d.handleRequest('b1','q1','save',answer(1)),d.handleRequest('b1','q1','save',answer(4))]);
 assert.ok(replies.every(x=>x.ok));assert.equal(f.state.questions.q1.answer.value,4);assert.equal(f.state.revision,2);
});
test('history-disabled bank keeps all practice state in memory and clears it on app restart',async()=>{
 const f=fixture({persistent:false}),d=f.domain;
 await d.handleRequest('b1','q1','save',answer(4,'submit'));await d.finish('b1');
 assert.equal(f.writes,0);assert.equal(f.state,null);assert.deepEqual(await d.listHistory('b1'),[]);
 assert.equal((await f.reload().openQuestion('b1',0)).context.status,'unanswered');assert.equal((await d.finish('b1')).score,2);
});
test('invalid schema, oversized/nonfinite ink and unsupported capabilities fail explicitly',async()=>{
 const f=fixture();const reply=await f.domain.handleRequest('b1','q1','save',{purpose:'draft',data:{answer:{value:'wrong'}}});assert.equal(reply.ok,false);assert.equal(f.writes,0);
 assert.throws(()=>validateInk({formatVersion:1,width:760,height:1100,strokes:[{id:'bad',color:'#000000',width:2,points:[{x:Infinity,y:0,pressure:.5}]}]}),/草稿/);
 assert.equal((await f.domain.handleRequest('b1','q1','ai-grade',{})).error.code,'AI_UNAVAILABLE');
});
test('prototype-name question identifiers stay ordinary independent persisted keys',async()=>{
 const f=fixture();f.bank.questions[0].id='__proto__';f.bank.questions[1].id='constructor';
 await Promise.all([f.domain.openBank('b1'),f.domain.openQuestion('b1',0)]);
 assert.equal((await f.domain.openQuestion('b1',0)).context.status,'unanswered');
 assert.equal((await f.domain.handleRequest('b1','__proto__','save',answer(4))).ok,true);
 assert.equal((await f.domain.handleRequest('b1','constructor','save',answer(2))).ok,true);
 assert.ok(Object.hasOwn(f.state.questions,'__proto__'));assert.ok(Object.hasOwn(f.state.questions,'constructor'));
 assert.equal((await f.reload().openQuestion('b1',0)).context.answer.value,4);
});
test('an older answer-state snapshot cannot replace a newer durably saved snapshot',async()=>{
 const f=fixture(),d=f.domain;
 const old=await d.handleRequest('b1','q1','answer-state',{status:'unanswered'});
 const recent=await d.handleRequest('b1','q1','answer-state',{status:'draft'});
 assert.equal((await d.handleRequest('b1','q1','save',answer(4,'draft',{answerStateId:recent.data.stateId}))).ok,true);
 const stale=await d.handleRequest('b1','q1','save',answer(1,'draft',{answerStateId:old.data.stateId}));
 assert.equal(stale.error.code,'ANSWER_STATE_EXPIRED');assert.equal(f.state.questions.q1.answer.value,4);
});
test('completed rounds reuse immutable page/SDK bytes without storing private rules in history pages',async()=>{
 const f=fixture(),d=f.domain;
 for(let round=0;round<4;round++){
   await d.handleRequest('b1','q1','save',answer(4,'submit'));
   await d.finish('b1');
   if(round<3)await d.startNewRound('b1');
 }
 assert.equal(f.state.history.length,4);assert.equal(Object.keys(f.state.frozenLibraries).length,1);assert.equal(Object.keys(f.state.frozenPages).length,1);
 const page=Object.values(f.state.frozenPages)[0];assert.equal(page.rules,undefined);assert.equal(page.questionSchema,undefined);
 const first=f.state.history[0];assert.equal((await f.reload().openQuestion('b1',0,{historyId:first.id})).assets.libraries[0].script,'/* pinned sdk */');
});
