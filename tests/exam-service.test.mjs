import test from 'node:test';
import assert from 'node:assert/strict';
import {createExamService} from '../web/exam-service.js';
import {createPracticeService} from '../web/web-practice-service.js';
import {runRule} from '../rules/runtime.js';

const copy=value=>structuredClone(value);
function fixture({history=true,exam=true,manual=false}={}){
  let time=1700000000000,state=null;
  const documents=new Map(),calls=[];
  const bank={title:'考试测试',features:{history,exam},extension:{path:'extensions/test'},questions:[{id:'q1',title:'题目',data:{prompt:'2+2',key:4,manual}}]};
  const raw={manifest:{id:'test',version:'1.0.0',requiresApi:{major:1,minMinor:4,capabilities:['practice','score','manual-review']},requiresRichText:{documentProfile:'advanced-v1'}},
    html:'<main>frozen</main>',script:'/* frozen */',style:'',assets:[],questionSchema:true,answerSchema:{type:'object',required:['value'],properties:{value:{type:'number'}},additionalProperties:false},
    rules:`QF.defineType({project(d,s){return {prompt:d.prompt,...(s.submitted?{key:d.key}:{})}},grade(d,a){return d.manual?{gradingStatus:'pending',score:null,maxScore:2,correct:null,feedback:'待评分'}:{score:a.value===d.key?2:0,maxScore:2,correct:a.value===d.key,feedback:''}},getScore(d,s){return {score:s.submitted?s.result.score:0,maxScore:2}},review(d,a,r){return {gradingStatus:'graded',score:r.score,maxScore:2,correct:r.score===2,feedback:'人工评分'}}});`};
  const native=async(method,args={})=>{
    calls.push({method,args:copy(args)});
    if(method==='documents.list')return [...documents.keys()];
    if(method==='documents.read')return copy(documents.get(args.key)||null);
    if(method==='documents.write'){
      assert.equal(documents.get(args.key)?.revision||0,args.expectedRevision);
      const next={...copy(args.value),revision:args.expectedRevision+1};documents.set(args.key,next);return copy(next);
    }
    if(method==='library.list')return [{id:'b1',title:bank.title,questionCount:1,features:bank.features}];
    if(method==='library.readBank')return {id:'b1',title:bank.title,bank:copy(bank)};
    if(method==='library.readExtension')return copy(raw);
    if(method==='state.read')return copy(state);
    if(method==='state.write'){assert.equal(state?.revision||0,args.expectedRevision);state={...copy(args.state),revision:args.expectedRevision+1};return copy(state);}
    if(method==='rules.run'||method==='rules.evaluate'){
      const extension=args.extension||raw,result=runRule({...args.request,rules:extension.rules,questionSchema:true,answerSchema:extension.answerSchema,apiVersion:{major:1,minor:4}});
      if(!result.ok)throw Object.assign(Error(result.error),{code:result.code});return result.data;
    }
    throw Error('Unexpected native '+method);
  };
  const loadText=async name=>name.endsWith('service.json')?JSON.stringify({api:{major:1,minor:1,documentFormat:1},profiles:[{id:'advanced-v1',provider:{version:'1.1.3'},capabilities:[]}]}):'/* pinned */';
  const options={loadText,prepareAssets:async value=>value};
  const practice=createPracticeService(native,{...options,examEnabled:true});
  const make=(extra={})=>createExamService(native,{practice,loadText,now:()=>time,makePractice:(wire,settings)=>createPracticeService(wire,{...options,...settings}),...extra});
  const service=make();
  const send=(target,method='GET',body=null,selected=service)=>selected.handle({path:target,method,body});
  const start=(durationMinutes=null)=>send('/api/collections/bank/b1/exams','POST',{requestId:'start-'+crypto.randomUUID(),durationMinutes});
  return {service,send,start,make,documents,bank,raw,calls,advance:ms=>{time+=ms;}};
}
const route=(exam,suffix='')=>`/api/collections/exam/${exam.id}${suffix}`;
async function save(f,exam,value,selected){
  const payload=await f.send(route(exam,'/questions/q1'),'GET',null,selected);
  return f.send(route(exam,'/questions/q1/actions'),'POST',{requestId:'answer-'+crypto.randomUUID(),revision:payload.state.revision,contentVersion:payload.stamp.contentVersion,action:'draft',data:{answer:{value}}},selected);
}

test('exam isolates ordinary practice, locks per-question submission and adds completed frozen history',async()=>{
  const f=fixture(),exam=await f.start();await save(f,exam,4);
  const overview=await f.send(route(exam)),extension=overview.extensions[0];
  const page=await f.send(`/api/extensions/${extension.pageId}/${extension.version}/page`);
  assert.equal(page.html,'<main>frozen</main>');assert.ok(page.script.startsWith('/* pinned */'));assert.deepEqual(page.examActionSelectors,['#submit-button','#retry-button']);
  await assert.rejects(f.send(route(exam,'/questions/q1/actions'),'POST',{action:'submit'}),{code:'EXAM_ACTION_DISABLED'});
  await assert.rejects(f.send(route(exam,'/summary')),{code:'EXAM_ACTION_DISABLED'});
  const done=await f.send(route(exam,'/exam'),'POST',{});assert.equal(done.status,'completed');assert.equal(done.summary.score,2);
  await assert.rejects(save(f,exam,1),{code:'EXAM_ACTION_DISABLED'});
  const ordinary=await f.service.handle({path:'/api/collections/bank/b1/history'});assert.equal(ordinary.records.length,1);assert.equal(ordinary.records[0].mode,'exam');
  const history=await f.send('/api/collections/bank/b1/history/'+ordinary.records[0].id);assert.equal(history.questions[0].payload.state.answer.value,4);
  assert.equal(f.calls.filter(row=>row.method==='state.write').length,0,'Exam must not overwrite ordinary bank state');
});
test('persisted deadline closes a restored exam and rejects late writes using frozen source',async()=>{
  const f=fixture(),exam=await f.start(1);await save(f,exam,4);
  f.bank.questions[0].data.key=9;f.raw.rules='throw Error("new extension must not run")';f.advance(60001);
  const restarted=f.make(),done=await f.send(route(exam,'/exam'),'GET',null,restarted);
  assert.equal(done.status,'completed');assert.equal(done.submissionReason,'timeout');assert.equal(done.summary.score,2);
  await assert.rejects(save(f,exam,9,restarted),{code:'EXAM_ACTION_DISABLED'});
});
test('pending manual grade stays locked until review completes the exam',async()=>{
  const f=fixture({manual:true}),exam=await f.start();await save(f,exam,4);
  assert.equal((await f.send(route(exam,'/exam'),'POST',{})).status,'grading');
  const payload=await f.send(route(exam,'/questions/q1'));
  await f.send(route(exam,'/questions/q1/actions'),'POST',{requestId:'review-'+crypto.randomUUID(),revision:payload.state.revision,contentVersion:payload.stamp.contentVersion,action:'review',data:{review:{score:2}}});
  assert.equal((await f.send(route(exam,'/exam'))).status,'completed');
});
test('history-disabled exams are page-local and authored exam restrictions remain effective',async()=>{
  const f=fixture({history:false}),exam=await f.start();await save(f,exam,4);assert.equal(f.documents.size,0);
  const image=await f.send(route(exam,'/resources'),'POST',{mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII='});
  assert.equal((await f.send(route(exam,'/resources/'+image.id))).mime,'image/png');assert.equal(f.documents.size,0);
  await assert.rejects(f.send(route(exam,'/exam'),'GET',null,f.make()),{code:'COLLECTION_NOT_FOUND'});
  const denied=fixture({exam:false});await assert.rejects(denied.start(),{code:'FEATURE_DISABLED'});
});
test('start request is idempotent and deleting an unfinished attempt prevents later deadline grading',async()=>{
  const f=fixture(),body={requestId:'stable-exam-request',durationMinutes:1};
  const exam=await f.send('/api/collections/bank/b1/exams','POST',body),same=await f.send('/api/collections/bank/b1/exams','POST',body);assert.equal(exam.id,same.id);
  await assert.rejects(f.send('/api/collections/bank/b1/exams','POST',{...body,durationMinutes:2}),{code:'REQUEST_ID_REUSED'});
  await f.send(route(exam,'/exam'),'DELETE');f.advance(60001);
  assert.deepEqual((await f.send('/api/collections/bank/b1/exams')).records,[]);
  await assert.rejects(f.send(route(exam,'/exam')),{code:'COLLECTION_NOT_FOUND'});
});

test('resource GET consults the mounting bank while resource POST stays with the active exam',async()=>{
  const f=fixture(),exam=await f.start(),contexts=[];
  const service=f.make({resourceContext:options=>{
    contexts.push(copy(options));
    return options?.reading===true?{kind:'bank',bankId:'candidate-bank',editing:false}:{kind:'exam',bankId:exam.id,editing:false};
  }});
  assert.equal(await f.send('/api/resources/'+'a'.repeat(64),'GET',null,service),undefined,'An old active exam must not capture the mounting bank image request');
  assert.deepEqual(contexts,[{reading:true}]);
  const image=await f.send('/api/resources','POST',{mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII='},service);
  assert.equal(contexts[1],undefined,'Uploads must use the existing active context');
  assert.ok(f.documents.get(exam.id).resources[image.id]);
  assert.equal(f.calls.filter(call=>call.method==='state.write').length,0);
});
