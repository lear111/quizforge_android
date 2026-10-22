import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {prepareAnswerAreas} from '../web/answer-area-host.js';
import {createPracticeService} from '../web/web-practice-service.js';
import {createExamService} from '../web/exam-service.js';
import {createAiService} from '../web/ai-service.js';
import {runRule} from '../rules/runtime.js';
import {normalizeDraft} from '../vendor/quizforge-web/core/web/draft/whiteboard-model.js';

const copy=value=>structuredClone(value),sha=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
// Protocol fixture bytes, not a rasterization oracle. Actual PNG pixels and
// font/ink parity belong to the separate native renderer/device checks.
function fixturePng(width,height,seed=''){
  const bytes=Buffer.alloc(24+Buffer.byteLength(seed));bytes.set([137,80,78,71,13,10,26,10]);bytes.writeUInt32BE(13,8);bytes.write('IHDR',12);bytes.writeUInt32BE(width,16);bytes.writeUInt32BE(height,20);bytes.write(seed,24);return bytes;
}
const stroke={id:'answer-ink',color:'#123456',width:2,points:[{x:12,y:15,pressure:.5},{x:42,y:1015,pressure:.8}]};
const area=(extra={})=>({type:'qf-answer-area',formatVersion:1,id:'answer-1',width:760,height:1800,text:'typed answer',inkSource:'draft',strokes:[copy(stroke)],...extra});
const provider={version:'1.4.1',script:'/* frozen answer provider */',style:'/* frozen answer style */'};
const rules=`QF.defineType({project(d){return {prompt:d.prompt};},grade(d,a){const v=a.area;if((v.strokes.length||v.images?.length)&&!v.snapshot)throw Error('Missing trusted snapshot');return {gradingStatus:'pending',score:null,maxScore:5,correct:null,feedback:'待评分'};},getScore(d,s){return {score:s.submitted||s.status==='submitted'?s.result.score:0,maxScore:5};},review(d,a,r){return {gradingStatus:'graded',score:r.score,maxScore:5,correct:r.score===5,feedback:r.feedback||'人工评分'};},prepareAiGrading(d,a){return {protocolVersion:1,question:[{type:'text',text:d.prompt}],answer:a.area.strokes.length||a.area.images?.length?[{type:'image',assetId:a.area.snapshot.attrs.assetId}]:[{type:'text',text:a.area.text}],referenceAnswer:[{type:'text',text:'reference'}],maxScore:5,scoreStep:1};}});`;

function fixture({history=true,withAi=false,stored=null,documents=new Map(),resources=new Map(),component=provider,bankData=null,rawExtension=null}={}){
  let state=copy(stored),failRender=false,failState=false,failStore=false;
  const calls=[],jobs=new Map(),bank={title:'答题区测试',features:{history,whiteboard:true,exam:true},extension:{path:'extensions/answer-area'},questions:[{id:'q1',title:'题一',data:{prompt:'synthetic prompt'}}],...(bankData?copy(bankData):{})};
  const raw=rawExtension||{manifest:{id:'test',name:'Test',version:'1.0.0',requiresApi:{major:1,minMinor:5,capabilities:['practice','score','manual-review','ai-grading','resources','answer-areas']},requiresRichText:{documentProfile:'advanced-v1'}},html:'<main>original page</main>',script:'/* original extension */',style:'',assets:[],questionSchema:true,answerSchema:true,rules};
  const native=async(method,args={})=>{
    calls.push({method,args:copy(args)});
    if(method==='library.list')return [{id:'b1',title:bank.title,features:bank.features}];
    if(method==='library.readBank')return {id:'b1',title:bank.title,bank:copy(bank)};
    if(method==='library.readExtension')return copy(raw);
    if(method==='state.read')return copy(state);
    if(method==='state.write'){if(failState)throw Object.assign(Error('save failure'),{code:'IO_ERROR'});assert.equal(args.expectedRevision,state?.revision||0);state={...copy(args.state),revision:args.expectedRevision+1};return copy(state);}
    if(method==='rules.run'||method==='rules.evaluate'){
      const result=runRule({...args.request,rules:args.extension?.rules||raw.rules,questionSchema:raw.questionSchema,answerSchema:raw.answerSchema,apiVersion:{major:1,minor:5}});if(!result.ok)throw Object.assign(Error(result.error),{code:result.code||'RULE_REJECTED'});return result.data;
    }
    if(method==='resource.put'){
      if(failStore)throw Object.assign(Error('image store failure'),{code:'IO_ERROR'});
      const bytes=Buffer.from(args.data,'base64'),id=await sha(bytes),resource={id,mime:args.mime,data:args.data,size:bytes.length};resources.set(args.bankId+'|'+id,resource);const {data,...descriptor}=resource;return descriptor;
    }
    if(method==='resource.get'){const value=resources.get(args.bankId+'|'+args.id);if(value)return copy(value);throw Object.assign(Error('image missing'),{code:'RESOURCE_NOT_FOUND'});}
    if(method==='answerArea.begin'){const jobId='job-'+calls.length,imageIds=[...new Set((args.document.images||[]).map(image=>image.attrs.assetId))];jobs.set(jobId,{document:copy(args.document),remainingWork:args.remainingWork});return {jobId,imageIds};}
    if(method==='answerArea.image'){assert.ok(jobs.has(args.jobId));assert.equal(await sha(Buffer.from(args.data,'base64')),args.assetId);return {width:20,height:10};}
    if(method==='answerArea.render'){
      if(failRender)throw Object.assign(Error('decode/render failure'),{code:'ANSWER_IMAGE_INVALID'});
      const doc=jobs.get(args.jobId).document,scale=doc.text?.trim()||doc.inkSource==='draft'||doc.images?.length?2:1,bytes=fixturePng(doc.width*scale,doc.height*scale,JSON.stringify(doc));return {id:await sha(bytes),mime:'image/png',data:bytes.toString('base64'),size:bytes.length,width:doc.width*scale,height:doc.height*scale,usedWork:doc.strokes.reduce((sum,item)=>sum+item.points.length*16,0)};
    }
    if(method==='answerArea.discard'){jobs.delete(args.jobId);return {discarded:true};}
    if(method==='documents.list')return [...documents.keys()].filter(key=>key.startsWith(args.namespace+'|')).map(key=>key.slice(args.namespace.length+1));
    if(method==='documents.read')return copy(documents.get(args.namespace+'|'+args.key)||null);
    if(method==='documents.write'){const key=args.namespace+'|'+args.key,old=documents.get(key);assert.equal(args.expectedRevision,old?.revision||0);const next={...copy(args.value),revision:args.expectedRevision+1};documents.set(key,next);return copy(next);}
    if(method==='settings.ai.get')return {enabled:true,autoGrade:false,configurationVersion:'test-version',apiKeyConfigured:true};
    if(method==='ai.request')return {output:'{"score":4,"feedback":"synthetic review"}',model:'mock-model',provider:'mock'};
    throw Error('Unexpected native '+method);
  };
  const ai=withAi?createAiService(native):null,options={answerAreaComponent:component,aiService:ai,examEnabled:true,normalizeDraft,prepareAssets:async value=>value,
    loadText:async name=>name.endsWith('service.json')?JSON.stringify({api:{major:1,minor:1,documentFormat:1},profiles:[{id:'advanced-v1',provider:{id:'quizforge.richtext',version:'1.1.3'},capabilities:['basic-formatting','images']}]}):'/* frozen SDK */'};
  const practice=createPracticeService(native,options),exam=createExamService(native,{practice,loadText:options.loadText,makePractice:(wire,settings)=>createPracticeService(wire,{...options,aiService:null,...settings})});
  const send=async(path,method='GET',body=null,headers={})=>{const request={path,method,body,headers};return await ai?.handle(request)??await exam.handle(request)??practice.handle(request);};
  return {practice,exam,ai,native,calls,jobs,bank,documents,resources,send,get state(){return copy(state);},failRender(value){failRender=value;},failState(value){failState=value;},failStore(value){failStore=value;}};
}
const base='/api/collections/bank/b1';
async function action(f,name,answer,root=base){const path=root+'/questions/'+encodeURIComponent(f.bank.questions[0].id),q=await f.send(path);return f.send(path+'/actions','POST',{requestId:crypto.randomUUID(),revision:q.state.revision,contentVersion:q.stamp.contentVersion,action:name,data:name==='review'?{review:{score:5,feedback:'review'}}:name==='whiteboard'?{draft:answer}:name==='retry'?{}:{answer}});}

test('draft strips caller snapshots, validates nested targets/images, and text-only submission does not render',async()=>{
  const f=fixture(),forged={type:'image',attrs:{assetId:'a'.repeat(64)}};
  const saved=await action(f,'draft',{area:area({snapshot:forged})});assert.equal(saved.state.answer.area.snapshot,undefined);assert.equal(f.calls.some(call=>call.method==='answerArea.begin'),false);
  await assert.rejects(action(f,'draft',{area:area({targetId:'unknown-part'})}),{code:'ANSWER_AREA_TARGET_UNKNOWN'});
  const only=fixture();await action(only,'submit',{area:area({text:'plain text',strokes:[]})});assert.equal(only.calls.some(call=>call.method==='answerArea.begin'),false);assert.equal(only.state.questions.q1.result.score,null);
  await assert.rejects(prepareAnswerAreas([area(),area()],{readResource:async()=>null}),{code:'ANSWER_AREA_LIMIT'});
});

test('mixed submit passes the full offscreen logical document, stores trusted PNG before rules, and releases its job',async()=>{
  const f=fixture(),bytes=fixturePng(20,10),assetId=await sha(bytes);f.resources.set('b1|'+assetId,{id:assetId,mime:'image/png',data:bytes.toString('base64'),size:bytes.length});
  const result=await action(f,'submit',{area:area({images:[{type:'image',id:'img1',attrs:{assetId},x:0,y:0,width:200,height:100}],snapshot:{type:'image',attrs:{assetId:'b'.repeat(64)}}})});
  const job=f.calls.find(call=>call.method==='answerArea.begin');assert.equal(job.args.document.height,1800);assert.equal(job.args.document.strokes[0].points[1].y,1015);assert.equal(job.args.document.snapshot,undefined);
  const snapshot=result.state.answer.area.snapshot.attrs.assetId;assert.notEqual(snapshot,'b'.repeat(64));assert.ok(f.resources.has('b1|'+snapshot));assert.equal(result.state.result.gradingStatus,'pending');assert.equal(result.state.result.correct,null);assert.equal(f.jobs.size,0);
  const order=f.calls.map(call=>call.method);assert.ok(order.indexOf('answerArea.render')<order.indexOf('resource.put'));assert.ok(order.indexOf('resource.put')<order.findIndex((method,index)=>method==='rules.run'&&f.calls[index].args.request.op==='submit'));
});

test('plain text AI stays text-only and old text-with-ink documents use the same two-times submission image',async()=>{
  const text=fixture({history:false,withAi:true});await action(text,'submit',{area:area({text:'typed answer only',strokes:[]})});
  const task=await text.send(base+'/questions/q1/ai/grade','POST',{requestId:'only-text-ai'});await text.ai.settled();
  assert.equal((await text.send(base+'/questions/q1/ai/tasks/'+task.taskId)).status,'confirmed');
  const model=text.calls.find(call=>call.method==='ai.request');assert.deepEqual(model.args.input.answer,[{type:'text',text:'typed answer only'}]);assert.equal(model.args.attachments,undefined);assert.equal(text.calls.some(call=>call.method==='answerArea.begin'),false);
  const f=fixture(),legacy=area();delete legacy.inkSource;await action(f,'submit',{area:legacy});assert.ok(f.state.questions.q1.answer.area.snapshot);assert.equal(f.jobs.size,0);
});

test('aggregate synthesis budget and native requested-resource boundaries are enforced before committing',async()=>{
  const documents=[area({id:'one'}),area({id:'two'})],calls=[],jobs=new Map();
  const nativeCall=async(method,args)=>{calls.push({method,args:copy(args)});
    if(method==='answerArea.begin'){jobs.set(args.document.id,args.document);return {jobId:args.document.id,imageIds:[]};}
    if(method==='answerArea.discard')return {discarded:true};
    const value=jobs.get(args.jobId),bytes=fixturePng(value.width*2,value.height*2);
    return {mime:'image/png',data:bytes.toString('base64'),size:bytes.length,id:await sha(bytes),width:value.width*2,height:value.height*2,usedWork:args.jobId==='one'?7000000:2000000};
  };
  await assert.rejects(prepareAnswerAreas(documents,{submit:true,nativeCall,storeResource:async value=>({id:await sha(Buffer.from(value.data,'base64'))}),readResource:async()=>null}),{code:'ANSWER_AREA_RENDER_LIMIT'});
  assert.deepEqual(calls.filter(call=>call.method==='answerArea.begin').map(call=>call.args.remainingWork),[8000000,1000000]);
  assert.equal(calls.filter(call=>call.method==='answerArea.discard').length,2);
  let stored=false,discarded=false;await assert.rejects(prepareAnswerAreas({area:area()},{submit:true,nativeCall:async(method)=>method==='answerArea.begin'?{jobId:'untrusted',imageIds:['a'.repeat(64)]}:(discarded=true),storeResource:async()=>{stored=true;},readResource:async()=>null}),{code:'ANSWER_AREA_RENDER_UNAVAILABLE'});
  assert.equal(stored,false);assert.equal(discarded,true);
});

test('oversized decoded images stop submission before reading the next area or storing partial output',async()=>{
  const reads=[],first='a'.repeat(64),second='b'.repeat(64),image=assetId=>({type:'image',id:'photo',attrs:{assetId},x:0,y:0,width:100,height:100});let stored=false;
  await assert.rejects(prepareAnswerAreas([area({id:'one',images:[image(first)]}),area({id:'two',images:[image(second)]})],{
    submit:true,readResource:async id=>{reads.push(id);return {mime:'image/png',data:'synthetic bytes'};},storeResource:async()=>{stored=true;},
    nativeCall:async(method,args)=>method==='answerArea.begin'?{jobId:'bounded',imageIds:[first]}:method==='answerArea.image'?{width:5000,height:4000}:{discarded:true},
  }),{code:'ANSWER_IMAGE_LIMIT'});assert.deepEqual(reads,[first]);assert.equal(stored,false);
});

test('render, resource and state failures keep the previously saved answer and never acknowledge partial submission',async()=>{
  for(const failure of ['failRender','failStore','failState']){
    const f=fixture();await action(f,'draft',{area:area()});const baseline=f.state;f[failure](true);
    await assert.rejects(action(f,'submit',{area:area({text:'new input'})}));assert.deepEqual(f.state,baseline);assert.equal(f.jobs.size,0);
  }
});

test('finish generates submitted snapshots and retry removes only the answer-owned source ink',async()=>{
  const f=fixture();await action(f,'draft',{area:area()});
  const summary=await f.send(base+'/summary');const pending=await f.send(base+'/finish','POST',{requestId:crypto.randomUUID(),summaryVersion:summary.summaryVersion,roundId:summary.roundId});assert.equal(pending.finished,false);assert.ok(f.state.questions.q1.answer.area.snapshot);
  await action(f,'whiteboard',{schemaVersion:1,viewport:{x:0,y:0,zoom:1},paper:{color:'#ffffff',pattern:'plain'},strokes:[copy(stroke),{...copy(stroke),id:'ordinary-note'}]});
  await action(f,'retry');assert.deepEqual(f.state.webDrafts.q1.strokes.map(item=>item.id),['ordinary-note']);
});

test('history stores the exact answer component and existing snapshots do not render again after reload',async()=>{
  const f=fixture();await action(f,'submit',{area:area()});await action(f,'review');const summary=await f.send(base+'/summary');const done=await f.send(base+'/finish','POST',{requestId:crypto.randomUUID(),summaryVersion:summary.summaryVersion,roundId:summary.roundId});assert.equal(done.finished,true);
  const record=f.state.webHistory[0],page=Object.values(record.pages)[0];assert.equal(record.apiVersion.minor,5);assert.deepEqual(page.answerAreaComponent,provider);
  const next=fixture({stored:f.state,resources:f.resources,component:{version:'9.9.9',script:'new provider',style:''}}),history=await next.send(base+'/history/'+record.id);assert.deepEqual(Object.values(history.pages)[0].answerAreaComponent,provider);assert.equal(next.calls.some(call=>call.method==='answerArea.render'),false);
});

test('temporary mixed answers and AI attachments remain memory-only while still resolving snapshot images',async()=>{
  const f=fixture({history:false,withAi:true});const result=await action(f,'submit',{area:area()});const assetId=result.state.answer.area.snapshot.attrs.assetId;
  const image=await f.send('/api/resources/'+assetId);assert.equal(image.mime,'image/png');
  const task=await f.send(base+'/questions/q1/ai/grade','POST',{requestId:'temporary-ai'});await f.ai.settled();assert.equal((await f.send(base+'/questions/q1/ai/tasks/'+task.taskId)).status,'confirmed');
  const model=f.calls.find(call=>call.method==='ai.request');assert.deepEqual(model.args.input.answer,[{type:'image',assetId}]);assert.deepEqual(model.args.attachments.map(item=>item.assetId),[assetId]);
  assert.equal(f.calls.some(call=>['state.write','documents.write','resource.put'].includes(call.method)),false);
});

test('exam hand-in uses native synthesis within its own frozen provider/resource scope',async()=>{
  const f=fixture(),exam=await f.send(base+'/exams','POST',{requestId:'answer-area-exam',durationMinutes:null}),root='/api/collections/exam/'+exam.id;
  await action(f,'draft',{area:area()},root);const before=f.state;
  const submitted=await f.send(root+'/exam','POST');assert.equal(submitted.status,'grading');assert.deepEqual(submitted.gradingErrors,[]);assert.equal(f.state,before);
  const record=f.documents.get('exam|'+exam.id);assert.deepEqual(record.snapshot.answerAreaComponent,provider);const id=record.state.questions.q1.answer.area.snapshot.attrs.assetId;assert.ok(record.resources[id]);assert.equal(f.resources.size,0);assert.equal(f.jobs.size,0);
});

test('the pinned Web answer-area sample keeps its actual schemas, rules and text/image AI protocol',async()=>{
  const root=new URL('../vendor/quizforge-web/core/examples/handwritten-short-answer/',import.meta.url),text=path=>readFile(new URL(path,root),'utf8');
  const rawExtension={manifest:JSON.parse(await text('manifest.json')),html:await text('practice.html'),script:await text('practice.js'),style:await text('practice.css'),rules:await text('rules.js'),questionSchema:JSON.parse(await text('question.schema.json')),answerSchema:JSON.parse(await text('answer.schema.json')),assets:[]},bankData=JSON.parse(await text('examples/bank.json'));
  for(const handwriting of [false,true]){
    const f=fixture({withAi:true,bankData,rawExtension}),q=bankData.questions[0],config=q.data.areas[0],document=area({id:config.id,height:config.height,text:'Web sample answer',strokes:handwriting?[{...copy(stroke),points:[{x:20,y:30,pressure:.5}]}]:[]});
    const submitted=await action(f,'submit',{areas:[document]});assert.equal(submitted.state.result.score,null);assert.equal(submitted.state.result.correct,null);
    const task=await f.send(base+'/questions/'+q.id+'/ai/grade','POST',{requestId:'web-sample-'+handwriting});await f.ai.settled();assert.equal((await f.send(base+'/questions/'+q.id+'/ai/tasks/'+task.taskId)).status,'confirmed');
    const input=f.calls.find(call=>call.method==='ai.request').args.input;assert.equal(input.answer.length,1);assert.equal(input.answer[0].type,handwriting?'image':'text');assert.equal(input.scoreStep,.5);
    if(handwriting)assert.equal(input.answer[0].assetId,submitted.state.answer.areas[0].snapshot.attrs.assetId);else assert.match(input.answer[0].text,/Web sample answer/);
  }
});
