import test from 'node:test';
import assert from 'node:assert/strict';
import {createPracticeService} from '../web/web-practice-service.js';
import {runRule} from '../rules/runtime.js';
import {normalizeDraft} from '../vendor/quizforge-web/core/web/draft/whiteboard-model.js';
import {createHistoryView} from '../vendor/quizforge-web/core/web/history/history-view.js';
import {prepareExtensionAssets} from '../vendor/quizforge-web/core/web/bridge/page-assets.js';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';

const clone=value=>structuredClone(value);
const source=`QF.defineType({
 project(data,state){return {prompt:data.prompt,maxScore:2,...(state.submitted?{key:data.key}:{})};},
 grade(data,answer){return data.manual?{gradingStatus:'pending',score:null,maxScore:2,correct:null,feedback:'待评分'}:{score:answer.value===data.key?2:0,maxScore:2,correct:answer.value===data.key,feedback:'已判分'};},
 getScore(data,state){return {score:state.submitted?state.result.score:0,maxScore:2,...(state.submitted?{outlineStates:[{id:'a',status:state.result.correct?'correct':'incorrect'}]}:{})};},
 review(data,answer,review){return {gradingStatus:'graded',score:review.score,maxScore:2,correct:review.score===2,feedback:review.feedback||'人工评分'};},
 getOutlineItems(){return [{id:'a',label:'小题'}];}
});`;
const basePath='/api/collections/bank/b1';
function fixture({persistent=true,manual=false,stored:initial=null,listedFeatures=null,editing=true,hasEditor=true}={}){
 let stored=clone(initial),writes=0,fail=false,ruleSource=source;
 const bank={id:'author',title:'测试题库',features:{history:persistent,editing},extension:{path:'extensions/示例/题型'},
  questions:[{id:'q1',title:'第一题',data:{prompt:'2+2=?',key:4,manual}},{id:'q2',title:'第二题',data:{prompt:'1+1=?',key:2}}]};
 const manifest={id:'example-type',version:'1.0.0',name:'示例题型',requiresApi:{major:1,minMinor:4,capabilities:['practice','score','manual-review','outline-items','answer-state','appearance']},requiresRichText:{documentProfile:'advanced-v1'}};
 const resources=new Map(),calls=[],editorDrafts=new Map(),editReceipts=new Map();
 const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
 const versions=async()=>({sourceVersion:await hash(bank),questionVersions:Object.fromEntries(await Promise.all(bank.questions.map(async q=>{const v=await hash([q,ruleSource]);return[q.id,{contentVersion:v,draftVersion:v}];})))});
 const editorPage={html:'<main>原编辑器</main>',script:'/* original editor */',style:'main{color:purple}',assets:[]};
 const listedBanks=[{id:'b1',title:bank.title,questionCount:2,features:clone(listedFeatures?.[0]??{history:persistent})},
  {id:'b2',title:'另一题库',questionCount:1,features:clone(listedFeatures?.[1]??{history:persistent})}];
 const native=async(method,args={})=>{
  calls.push({method,args:clone(args)});
  if(method==='library.list')return clone(listedBanks);
  if(method==='library.readBank')return {id:args.bankId,title:bank.title,bank:clone(bank),...await versions()};
  if(method==='library.readExtension')return {path:manifest.path,manifest:clone(manifest),html:'<main>原题型</main>',script:'/* original extension page */',style:'main{color:black}',rules:ruleSource,questionSchema:true,answerSchema:{type:'object',required:['value'],properties:{value:{type:'number'}},additionalProperties:false},assets:[],editor:hasEditor?clone(editorPage):null};
  if(method==='editor.read'){
   if(!editing)throw Object.assign(Error('禁止编辑'),{code:'FEATURE_DISABLED'});
   const q=bank.questions.find(q=>q.id===args.questionId),v=await versions();return {question:clone(q),...v.questionVersions[q.id],sourceVersion:v.sourceVersion,revision:stored?.questions?.[q.id]?.revision||0,editor:hasEditor?clone(editorPage):null};
  }
  if(method==='editor.save'){
   if(!editing)throw Object.assign(Error('禁止编辑'),{code:'FEATURE_DISABLED'});
   const receipt=editReceipts.get(args.requestId),requestHash=await hash(args);
   if(receipt){if(receipt.hash!==requestHash)throw Object.assign(Error('编号复用'),{code:'REQUEST_ID_REUSED'});return {...clone(receipt.value),replayed:true};}
   const q=bank.questions.find(q=>q.id===args.questionId),v=await versions(),current=stored?.questions?.[q.id]||{status:'unanswered',answer:null,result:null,revision:0};
   if(args.sourceVersion!==v.sourceVersion||args.contentVersion!==v.questionVersions[q.id].contentVersion)throw Object.assign(Error('内容冲突'),{code:'CONTENT_CONFLICT'});
   if(persistent&&args.revision!==current.revision)throw Object.assign(Error('作答冲突'),{code:'REVISION_CONFLICT'});
   if(fail)throw Object.assign(Error('编辑原子提交失败'),{code:'IO_ERROR'});
   const dataChanged=JSON.stringify(q.data)!==JSON.stringify(args.question.data),previousSourceVersion=v.sourceVersion,next=stored?clone(stored):{schemaVersion:1,revision:0,roundId:crypto.randomUUID(),questions:{},history:[],ink:{},finished:false};
   q.title=args.question.title;q.data=clone(args.question.data);
   next.questions[q.id]=dataChanged?{status:'unanswered',answer:null,result:null,revision:current.revision+1}:{...current,revision:current.revision+1};
   if(dataChanged){delete next.ink[q.id];if(next.webDrafts)delete next.webDrafts[q.id];next.roundId=crypto.randomUUID();next.finished=false;delete next.summary;}
   next.revision++;if(persistent){stored=next;writes++;}const after=await versions(),value={saved:true,previousSourceVersion,sourceVersion:after.sourceVersion,...after.questionVersions[q.id],revision:next.questions[q.id].revision,stateRevision:next.revision,changed:true,dataChanged,questionId:q.id};editReceipts.set(args.requestId,{hash:requestHash,value:clone(value)});return value;
  }
  if(method.startsWith('editorDraft.')){
   if(!editing)throw Object.assign(Error('禁止编辑'),{code:'FEATURE_DISABLED'});const q=bank.questions.find(q=>q.id===args.questionId),v=(await versions()).questionVersions[q.id];
   if(method==='editorDraft.read')return clone(editorDrafts.get(q.id)||{draft:null,changed:false,contentVersion:v.draftVersion});
   if(method==='editorDraft.delete'){editorDrafts.delete(q.id);return {deleted:true,memoryOnly:!persistent};}
   if(args.contentVersion!==v.draftVersion)throw Object.assign(Error('草稿内容版本冲突'),{code:'CONTENT_CONFLICT'});
   if(fail)throw Object.assign(Error('草稿存储失败'),{code:'IO_ERROR'});const value={draft:clone(args.draft),changed:args.changed,contentVersion:args.contentVersion};if(persistent)editorDrafts.set(q.id,value);return {...value,memoryOnly:!persistent};
  }
  if(method==='state.read')return clone(stored);
  if(method==='state.write'){
   if(fail)throw Object.assign(new Error('磁盘故障'),{code:'IO_ERROR'});
   if(args.expectedRevision!==(stored?.revision||0))throw Object.assign(new Error('并发版本冲突'),{code:'REVISION_CONFLICT'});
   stored={...clone(args.state),revision:(stored?.revision||0)+1};writes++;return clone(stored);
  }
  if(method==='rules.run'){
   const result=runRule({...args.request,rules:ruleSource,questionSchema:true,answerSchema:{type:'object',required:['value'],properties:{value:{type:'number'}},additionalProperties:false},apiVersion:{major:1,minor:4},outlineItemsDeclared:true,answerStateDeclared:manifest.requiresApi.capabilities.includes('answer-state')});
   if(!result.ok)throw Object.assign(new Error(result.error),{code:result.code||'RULE_REJECTED'});return result.data;
  }
  if(method==='resource.put'){
   const features=listedBanks.find(row=>row.id===args.bankId)?.features||{};
   if(args.editing?features.editing===false:features.history===false)throw Object.assign(new Error('题库没有开放图片保存'),{code:'FEATURE_DISABLED'});
   const bytes=Uint8Array.from(atob(args.data),x=>x.charCodeAt(0)),id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
   const resource={id,mime:args.mime,data:args.data,size:bytes.length};resources.set(args.bankId+'|'+id,resource);return {id,mime:args.mime,size:bytes.length};
  }
  if(method==='resource.get'){
   const resource=resources.get(args.bankId+'|'+args.id);if(resource)return clone(resource);
   throw Object.assign(new Error('图片不存在'),{code:'RESOURCE_NOT_FOUND'});
  }
  throw new Error('Unexpected native call: '+method);
 };
 const options={normalizeDraft,prepareAssets:async x=>x,
  loadText:async p=>p.endsWith('service.json')?JSON.stringify({api:{major:1,minor:1,documentFormat:1},profiles:[{id:'advanced-v1',provider:{id:'quizforge.richtext',version:'1.1.3'},capabilities:['basic-formatting','images','advanced-formatting']}]}):p.endsWith('richtext-editor.js')?'/* pinned original editor */':'/* pinned original provider */'};
 const make=(extra={})=>createPracticeService(native,{...options,...extra});
 return {service:make(),reload:make,native,bank,manifest,resources,calls,get state(){return clone(stored);},get writes(){return writes;},fail(value){fail=value;},changeSource(value){ruleSource=value;}};
}
const request=(service,path,method='GET',body=null,headers={})=>service.handle({path,method,body,headers});
const readQuestion=(service,qid='q1')=>request(service,`${basePath}/questions/${qid}`);
async function save(service,{qid='q1',purpose='draft',value=4,id=crypto.randomUUID(),extra={}}={}){
 const current=await readQuestion(service,qid),body={requestId:id,revision:current.state.revision,contentVersion:current.stamp.contentVersion,action:purpose,data:{answer:{value},...extra}};
 return {body,response:await request(service,`${basePath}/questions/${qid}/actions`,'POST',body)};
}
const webDraft={schemaVersion:1,viewport:{x:12,y:-7,zoom:.75},paper:{color:'#ffffff',pattern:'grid'},layout:{width:890,padding:0,top:0},
 strokes:[{id:'stroke-1',color:'#123456',width:2.5,points:[{x:3,y:4,pressure:.6},{x:30,y:40,pressure:.9}]}]};

test('original Web collection, extension page, SDK and question responses contain the required shape',async()=>{
 const f=fixture(),s=f.service,collection=await request(s,basePath);
 assert.equal(collection.kind,'bank');assert.equal(collection.features.editing,true);assert.equal(collection.features.exam,false);
 assert.equal(collection.questions.length,2);assert.equal(collection.states.q1.status,'unanswered');assert.equal(collection.questions[0].outlineItems[0].id,'a');
 const q=await readQuestion(s);assert.equal(q.question.data.key,undefined);assert.equal(q.state.revision,0);assert.equal(q.draft,null);
 assert.equal(typeof q.stamp.contentVersion,'string');assert.equal(q.extension.path,'extensions/示例/题型');
 const page=await request(s,`/api/extensions/${encodeURIComponent(q.extension.pageId)}/${q.extension.version}/page`);
 assert.equal(page.html,'<main>原题型</main>');assert.equal(page.rules,undefined);assert.equal(page.questionSchema,undefined);assert.deepEqual(page.extension,q.extension);
 assert.equal((await request(s,'/api/sdk/quizforge.richtext/1.1.3')).script,'/* pinned original provider */');
 assert.equal((await request(s,'/api/sdk/quizforge.richtext/1.1.3/editor')).script,'/* pinned original editor */');
 const stamp=await request(s,`${basePath}/questions/q1/stamp`);
 assert.deepEqual(await request(s,`${basePath}/questions/q1`,'GET',null,{'X-QuizForge-Question-Stamp':JSON.stringify(stamp)}),{unchanged:true,stamp});
});

test('draft action returns full payload and saves Web answer-state atomically',async()=>{
 const f=fixture(),s=f.service,state={status:'draft',outlineStates:[{id:'a',status:'draft'}]};
 const {response}=await save(s,{extra:{answerState:state}});
 assert.equal(response.question.data.key,undefined);assert.equal(response.state.answer.value,4);assert.deepEqual(response.state.answerState,state);
 assert.equal(response.stamp.revision,1);assert.deepEqual(f.state.questions.q1.answerState,state);
 assert.equal((await readQuestion(f.reload())).state.answer.value,4);
});

test('request replay survives app reload; conflicting ID, revision and content requests do not overwrite data',async()=>{
 const f=fixture(),{body,response}=await save(f.service,{id:'request-one'}),before=f.writes;
 assert.deepEqual(await request(f.service,`${basePath}/questions/q1/actions`,'POST',body),response);assert.equal(f.writes,before);
 assert.deepEqual(await request(f.reload(),`${basePath}/questions/q1/actions`,'POST',body),response);assert.equal(f.writes,before);
 await assert.rejects(request(f.service,`${basePath}/questions/q1/actions`,'POST',{...body,data:{answer:{value:1}}}),e=>e.code==='REQUEST_ID_REUSED');
 await assert.rejects(request(f.service,`${basePath}/questions/q1/actions`,'POST',{...body,requestId:'stale'}),e=>e.code==='REVISION_CONFLICT');
 await assert.rejects(request(f.service,`${basePath}/questions/q1/actions`,'POST',{...body,requestId:'content',revision:1,contentVersion:'0'.repeat(64)}),e=>e.code==='CONTENT_CONFLICT');
 assert.equal(f.state.questions.q1.answer.value,4);assert.equal(f.writes,before);
});

test('failed atomic storage is not acknowledged and an identical request can safely retry',async()=>{
 const f=fixture(),current=await readQuestion(f.service),body={requestId:'io-retry',revision:0,contentVersion:current.stamp.contentVersion,action:'draft',data:{answer:{value:4}}};
 f.fail(true);await assert.rejects(request(f.service,`${basePath}/questions/q1/actions`,'POST',body),e=>e.code==='IO_ERROR');
 assert.equal(f.state,null);assert.equal((await readQuestion(f.service)).state.status,'unanswered');
 f.fail(false);assert.equal((await request(f.service,`${basePath}/questions/q1/actions`,'POST',body)).state.answer.value,4);assert.equal(f.writes,1);
});

test('original whiteboard geometry, camera and layout survive persistence without conversion',async()=>{
 const f=fixture(),s=f.service,q=await readQuestion(s),body={requestId:'ink',revision:0,contentVersion:q.stamp.contentVersion,action:'whiteboard',data:{draft:webDraft}};
 const result=await request(s,`${basePath}/questions/q1/actions`,'POST',body);
 assert.equal(result.state.revision,1);assert.deepEqual(result.draft,webDraft);assert.deepEqual(f.state.webDrafts.q1,webDraft);
 assert.deepEqual((await readQuestion(f.reload())).draft,webDraft);
 const invalid=clone(body);invalid.requestId='bad-ink';invalid.revision=1;invalid.data.draft.strokes[0].points[0].x=Infinity;
 await assert.rejects(request(s,`${basePath}/questions/q1/actions`,'POST',invalid),e=>e.code==='INVALID_WHITEBOARD');
 assert.deepEqual(f.state.webDrafts.q1,webDraft);
});

test('legacy Android ink is read compatibly while original state remains untouched',async()=>{
 const legacy={schemaVersion:1,revision:1,roundId:'legacy-round',questions:{},history:[],finished:false,ink:{q1:{formatVersion:1,width:760,height:1200,strokes:webDraft.strokes}}};
 const f=fixture({stored:legacy}),q=await readQuestion(f.service);
 assert.equal(q.draft.schemaVersion,1);assert.deepEqual(q.draft.strokes,webDraft.strokes);assert.deepEqual(f.state,legacy);assert.equal(f.writes,0);
});

test('legacy Android frozen histories open in the original Web viewer without executing current rules',async()=>{
 const pageKey='extensions/示例/旧题型',context={mode:'history',question:{id:'old-q',title:'旧题目',data:{prompt:'原始快照',key:4}},answer:{value:4},result:{score:2,maxScore:2,correct:true,feedback:'正确'},status:'submitted',capabilities:{canSave:false}};
 const legacy={schemaVersion:1,revision:2,roundId:'old-round',questions:{},ink:{},finished:true,history:[{id:'old-round',createdAt:'2026-10-01T00:00:00Z',score:2,maxScore:2,
  pages:{[pageKey]:{apiVersion:{major:1,minor:4},html:'<main>旧页面</main>',script:'/* frozen */',style:''}},questions:[{pageKey,context,ink:{formatVersion:1,width:760,height:1000,strokes:webDraft.strokes},outlineItems:[]}]}]};
 const f=fixture({stored:legacy});f.changeSource('throw Error("Current extension must not execute");');
 const record=await request(f.service,`${basePath}/history/old-round`),view=createHistoryView(record);
 assert.equal(view.entry('old-q').payload.question.data.prompt,'原始快照');assert.deepEqual(view.entry('old-q').payload.draft.strokes,webDraft.strokes);
 assert.equal(view.entry('old-q').page.script,'/* frozen */');assert.equal(f.calls.some(x=>x.method==='rules.run'),false);
 assert.deepEqual(f.state,legacy);assert.equal(f.writes,0);
});

test('archived history SDK runs after an already-warm Web SDK cache and before unchanged extension code',async()=>{
 const frameBundle=await build({entryPoints:[fileURLToPath(new URL('../vendor/quizforge-web/core/web/bridge/frame.js',import.meta.url))],bundle:true,format:'iife',globalName:'WebFrame',write:false,platform:'browser',target:'es2020'});
 const provider=label=>`globalThis.__runOrder.push(${JSON.stringify(label)});globalThis.QFRichText={version:'1.1.3',configure(){},render(node){node.textContent=${JSON.stringify(label)};},createEditor(){return globalThis.QFRichText._createEditor?.()||'fallback';}};`;
 const archived={script:provider('archived</script>provider'),style:'#result{color:rgb(0,128,0)}'},warm={script:provider('warm-provider'),style:'#result{color:rgb(255,0,0)}'};
 const archivedEditor="globalThis.__runOrder.push('archived-editor');globalThis.QFRichText._createEditor=()=> 'archived-editor';";
 for(const modern of [false,true]){
  const key='extensions/旧组/旧题型',context={mode:'history',question:{id:'old-q',title:'旧题目',data:{}},answer:null,result:null,status:'unanswered',capabilities:{canSave:false}};
  const extensionScript="QF.content.render(document.getElementById('result'));globalThis.__runOrder.push('extension');"+(modern?"globalThis.__editor=QF.content.createEditor({});":"");
  const page={apiVersion:{major:1,minor:4},html:'<div id="result"></div>',script:extensionScript,style:'#result{font-weight:bold}',dependencies:[{id:'quizforge.richtext',version:'1.1.3'}],
   contentApi:{major:1,minor:1,documentFormat:1,documentProfile:'advanced-v1',capabilities:['basic-formatting','images']}};
  const initial={schemaVersion:1,revision:2,roundId:'archived-round',questions:{},ink:{},finished:true,history:[]};
  if(modern){
   initial.webSdk={'1.1.3':{...archived,editor:archivedEditor}};
   initial.webHistory=[{id:'archived-round',pages:{[key]:page},questions:[{pageKey:key,payload:{question:context.question,state:{status:'unanswered',answer:null,result:null,revision:0}}}]}];
  }else{
   initial.frozenLibraries={old:archived};
   initial.history=[{id:'archived-round',createdAt:'2026-10-01T00:00:00Z',score:0,maxScore:2,pages:{[key]:{...page,libraries:['old']}},questions:[{pageKey:key,context,ink:null,outlineItems:[]}]}];
  }
  const f=fixture({stored:initial}),response=await request(f.service,`${basePath}/history/archived-round`);
  const received=response.pages[key];
  // Simulate the original loader's already-filled version cache. It discards
  // the archived libraries field exactly as the real Web application does.
  const prepared=await prepareExtensionAssets(received,async()=>warm);
  assert.equal(prepared.libraries[0].script,warm.script);
  const parent=new JSDOM('<div id="host"></div>',{url:'https://appassets.androidplatform.net/assets/web/index.html',runScripts:'dangerously'});
  let child;
  try{
   parent.window.eval(frameBundle.outputFiles[0].text);
   const mounted=parent.window.WebFrame.mountExtension(parent.window.document.getElementById('host'),prepared,context,{onRequest:()=>Promise.resolve({ok:true,data:{}})});
   const html=mounted.frame.srcdoc;mounted.destroy();
   child=new JSDOM(html,{url:'https://appassets.androidplatform.net/assets/web/history-frame',runScripts:'dangerously',beforeParse(window){window.__runOrder=[];window.structuredClone=structuredClone;window.ResizeObserver=class{observe(){}disconnect(){}};}});
   assert.equal(child.window.document.getElementById('result').textContent,'archived</script>provider');
   assert.equal(child.window.getComputedStyle(child.window.document.getElementById('result')).color,'rgb(0, 128, 0)');
   assert.deepEqual([...child.window.__runOrder],modern?['warm-provider','archived</script>provider','archived-editor','extension']:['warm-provider','archived</script>provider','extension']);
   if(modern)assert.equal(child.window.__editor,'archived-editor');
   assert.deepEqual(f.state,initial);assert.equal(f.writes,0);
  }finally{child?.window.close();parent.window.close();}
 }
});

test('completion auto-submits drafts and produces a frozen history accepted by the original Web viewer',async()=>{
 const f=fixture(),s=f.service;await save(s,{value:4});
 const before=await request(s,`${basePath}/summary`);assert.equal(before.answeredUnsubmittedCount,1);assert.equal(before.score,0);assert.equal(before.maxScore,4);
 const body={requestId:'finish',roundId:before.roundId,summaryVersion:before.summaryVersion};
 const result=await request(s,`${basePath}/finish`,'POST',body);
 assert.equal(result.finished,true);assert.equal(result.score,2);assert.equal(result.maxScore,4);
 const record=await request(s,`${basePath}/history/${result.historyId}`),view=createHistoryView(record);
 assert.equal(view.questions.length,2);assert.equal(view.entry('q1').payload.question.data.key,4);assert.equal(view.entry('q2').payload.question.data.key,undefined);
 assert.equal(record.summary.score,2);assert.equal(record.status,'completed');
 const writes=f.writes;assert.deepEqual(await request(f.reload(),`${basePath}/finish`,'POST',body),result);assert.equal(f.writes,writes);
});

test('exact rule reads are reused across summary and finish while changed state invalidates only its question',async()=>{
 const f=fixture({manual:true}),s=f.service;
 const reads=op=>f.calls.filter(call=>call.method==='rules.run'&&call.args.request.op===op).flatMap(call=>call.args.request.questions.map(row=>row.data.prompt));
 await request(s,`${basePath}/summary`);await request(s,`${basePath}/summary`);await request(s,basePath);
 assert.deepEqual(reads('scoreBatch'),['2+2=?','1+1=?']);
 await save(s,{purpose:'submit'});
 assert.deepEqual(reads('scoreBatch'),['2+2=?','1+1=?','2+2=?']);
 const q=await readQuestion(s),review={requestId:'memo-review',revision:q.state.revision,contentVersion:q.stamp.contentVersion,action:'review',data:{review:{score:1}}};
 await request(s,`${basePath}/questions/q1/actions`,'POST',review);
 const count=reads('scoreBatch').length;assert.equal(count,4);
 await request(s,`${basePath}/questions/q1/actions`,'POST',review);assert.equal(reads('scoreBatch').length,count);
 const submitted=await readQuestion(s);
 await request(s,`${basePath}/questions/q1/actions`,'POST',{requestId:'memo-whiteboard',revision:submitted.state.revision,contentVersion:submitted.stamp.contentVersion,action:'whiteboard',data:{draft:webDraft}});
 assert.deepEqual(reads('scoreBatch'),['2+2=?','1+1=?','2+2=?','2+2=?','2+2=?']);
 const summary=await request(s,`${basePath}/summary`);summary.questions[0].maxScore=999;
 const final=await request(s,`${basePath}/summary`);assert.equal(final.questions[0].maxScore,2);
 const before=reads('scoreBatch').length;
 const result=await request(s,`${basePath}/finish`,'POST',{requestId:'memo-finish',roundId:final.roundId,summaryVersion:final.summaryVersion});
 assert.equal(result.score,1);assert.equal(reads('scoreBatch').length,before);
 assert.deepEqual(reads('projectBatch'),['2+2=?','1+1=?','2+2=?']);
 assert.equal(f.calls.filter(call=>call.method==='rules.run'&&call.args.request.op==='review').length,1);
});

test('restart advances question versions, clears current drafts, and preserves all frozen history bytes',async()=>{
 const f=fixture(),s=f.service;await save(s,{purpose:'submit'});
 const list=await request(s,`${basePath}/history`);assert.equal(list.records[0].status,'in-progress');
 const summary=await request(s,`${basePath}/summary`),finished=await request(s,`${basePath}/finish`,'POST',{requestId:'done',roundId:summary.roundId,summaryVersion:summary.summaryVersion});
 const record=await request(s,`${basePath}/history/${finished.historyId}`),revision=(await readQuestion(s)).state.revision;
 const next={requestId:'restart',roundId:finished.roundId,summaryVersion:finished.summaryVersion};
 assert.deepEqual(await request(s,`${basePath}/restart`,'POST',next),{restarted:true});
 const current=await readQuestion(s);assert.equal(current.state.status,'unanswered');assert.ok(current.state.revision>revision);assert.equal(current.draft,null);
 const writes=f.writes;assert.deepEqual(await request(f.reload(),`${basePath}/restart`,'POST',next),{restarted:true});assert.equal(f.writes,writes);
 assert.deepEqual(await request(f.reload(),`${basePath}/history/${finished.historyId}`),record);
});

test('pending manual grading remains null and the same completion request finalizes after review',async()=>{
 const f=fixture({manual:true}),s=f.service;await save(s,{value:4});
 const current=await request(s,`${basePath}/summary`),body={requestId:'manual-finish',roundId:current.roundId,summaryVersion:current.summaryVersion};
 const pending=await request(s,`${basePath}/finish`,'POST',body);assert.equal(pending.finished,false);assert.equal(pending.pendingCount,1);assert.equal(pending.questions[0].score,null);
 const q=await readQuestion(s);assert.equal(q.capabilities.canReview,true);
 await request(s,`${basePath}/questions/q1/actions`,'POST',{requestId:'review',revision:q.state.revision,contentVersion:q.stamp.contentVersion,action:'review',data:{review:{score:1,feedback:'部分正确'}}});
 const completed=await request(s,`${basePath}/finish`,'POST',body);assert.equal(completed.finished,true);assert.equal(completed.score,1);
});

test('history-disabled practice and transient images never call native persistence',async()=>{
 const f=fixture({persistent:false}),s=f.service;await save(s,{purpose:'submit'});
 const current=await request(s,`${basePath}/summary`);await request(s,`${basePath}/finish`,'POST',{requestId:'temporary-finish',roundId:current.roundId,summaryVersion:current.summaryVersion});
 assert.equal(f.writes,0);assert.equal(f.state,null);await assert.rejects(request(s,`${basePath}/history`),e=>e.code==='FEATURE_DISABLED');
 assert.equal((await readQuestion(f.reload())).state.status,'unanswered');
 const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);bytes.set([73,72,68,82],12);const data=btoa(String.fromCharCode(...bytes));
 const resource=await request(s,'/api/resources','POST',{mime:'image/png',data},{'X-QuizForge-Transient-Resource':'true'});
 assert.equal(f.calls.some(x=>x.method==='resource.put'),false);
 assert.deepEqual(await request(s,'/api/resources/'+resource.id),{__qfBinary:true,mime:'image/png',data});
});

test('global resources find imported and uploaded bytes across independent bank roots',async()=>{
 const f=fixture(),s=f.service,data=btoa('test image bytes');
 const uploaded=await request(s,'/api/resources','POST',{mime:'image/png',data});
 const resource=f.resources.get('b1|'+uploaded.id);f.resources.delete('b1|'+uploaded.id);f.resources.set('b2|'+uploaded.id,resource);
 assert.deepEqual(await request(s,'/api/resources/'+uploaded.id),{__qfBinary:true,mime:'image/png',data});
 assert.equal(f.calls.some(x=>x.method==='resource.get'&&x.args.bankId==='b2'),true);
});

test('persistent image uploads skip temporary banks and never fall back to them',async()=>{
 const data=btoa('test image bytes'),f=fixture({listedFeatures:[{history:false},{history:true}]});
 const uploaded=await request(f.service,'/api/resources','POST',{mime:'image/png',data});
 assert.deepEqual(f.calls.filter(x=>x.method==='resource.put').map(x=>x.args.bankId),['b2']);
 assert.equal(f.resources.has('b1|'+uploaded.id),false);assert.equal(f.resources.has('b2|'+uploaded.id),true);
 const temporary=fixture({listedFeatures:[{history:false},{history:false}]});
 await assert.rejects(request(temporary.service,'/api/resources','POST',{mime:'image/png',data}),e=>e.code==='FEATURE_DISABLED'&&e.status===403);
 assert.equal(temporary.calls.some(x=>x.method==='resource.put'),false);
});

test('deleting one history record preserves live answers and independent snapshots',async()=>{
 const f=fixture(),s=f.service;await save(s,{purpose:'submit'});
 const first=(await request(s,`${basePath}/history`)).records[0],live=clone(f.state.questions);
 assert.deepEqual(await request(s,`${basePath}/history/${first.id}`,'DELETE'),{deleted:first.id});
 assert.deepEqual(f.state.questions,live);assert.deepEqual((await request(s,`${basePath}/history`)).records,[]);
 await assert.rejects(request(s,`${basePath}/history/${first.id}`),e=>e.code==='HISTORY_NOT_FOUND');
 const q=await readQuestion(s);await request(s,`${basePath}/questions/q1/actions`,'POST',{requestId:'ink-after-delete',revision:q.state.revision,contentVersion:q.stamp.contentVersion,action:'whiteboard',data:{draft:webDraft}});
 assert.deepEqual((await request(s,`${basePath}/history`)).records,[]);
 await assert.rejects(request(s,`${basePath}/history/${first.id}`,'DELETE'),e=>e.code==='HISTORY_NOT_FOUND');
});

test('unowned routes remain available to other services; unsupported editing and AI fail explicitly',async()=>{
 const f=fixture({editing:false}),s=f.service;assert.equal(await request(s,'/api/library/index'),undefined);
 await assert.rejects(request(s,`${basePath}/questions/q1/editor`),e=>e.code==='FEATURE_DISABLED');
 await assert.rejects(request(s,`${basePath}/questions/q1/ai/grade`,'POST',{}),e=>e.code==='AI_UNAVAILABLE');
 assert.deepEqual(await request(s,`${basePath}/questions/q1/ai/current`),{task:null});
});

const readEditor=s=>request(s,`${basePath}/questions/q1/editor`);
const editBody=(value,overrides={})=>({requestId:crypto.randomUUID(),revision:value.revision,contentVersion:value.contentVersion,sourceVersion:value.sourceVersion,title:'修改后的第一题',data:{prompt:'3+3=?',key:6},...overrides});

test('original editor DTO uses the same native content version as practice and the unchanged editor assets',async()=>{
 const f=fixture(),value=await readEditor(f.service),q=await readQuestion(f.service);
 assert.equal(value.contentVersion,q.stamp.contentVersion);assert.equal(value.question.data.key,4);
 assert.equal(value.editor.html,'<main>原编辑器</main>');assert.equal(value.editor.script,'/* original editor */');
 assert.equal(value.editor.rules,undefined);assert.equal(value.editor.questionSchema,undefined);assert.equal(value.editor.extension.id,'example-type');
 assert.equal((await readEditor(f.reload())).draftVersion,value.draftVersion);
 const absent=fixture({hasEditor:false});assert.equal((await readEditor(absent.service)).editor,null);
});

test('author-disabled editing blocks editor, commit and draft routes before native side effects',async()=>{
 const f=fixture({editing:false}),s=f.service;
 assert.equal((await request(s,basePath)).features.editing,false);
 for(const[path,method,body]of[[`${basePath}/questions/q1/editor`,'GET'],[`${basePath}/questions/q1/edit`,'POST',editBody({revision:0,contentVersion:'a'.repeat(64),sourceVersion:'b'.repeat(64)})],['/api/editor-drafts/b1/q1','GET'],['/api/editor-drafts/b1/q1','PUT',{contentVersion:'a'.repeat(64),changed:true,draft:{unfinished:''}}],['/api/editor-drafts/b1/q1','DELETE']])await assert.rejects(request(s,path,method,body),e=>e.code==='FEATURE_DISABLED');
 assert.equal(f.calls.some(c=>c.method.startsWith('editor')),false);
});

test('native atomic content edit clears only current question state and preserves frozen history and other questions',async()=>{
 const f=fixture(),s=f.service;
 await save(s,{purpose:'submit'});await save(s,{qid:'q2',value:2});
 const q=await readQuestion(s);await request(s,`${basePath}/questions/q1/actions`,'POST',{requestId:'editor-ink',revision:q.state.revision,contentVersion:q.stamp.contentVersion,action:'whiteboard',data:{draft:webDraft}});
 const before=f.state,history=clone(before.webHistory),other=clone(before.questions.q2),value=await readEditor(s),body=editBody(value);
 const result=await request(s,`${basePath}/questions/q1/edit`,'POST',body);
 assert.equal(result.previousSourceVersion,value.sourceVersion);assert.notEqual(result.sourceVersion,value.sourceVersion);
 assert.equal(result.payload.question.title,body.title);assert.equal(result.payload.question.data.prompt,'3+3=?');assert.equal(result.payload.question.data.key,undefined);
 assert.equal(result.payload.state.status,'unanswered');assert.equal(result.payload.state.revision,value.revision+1);
 assert.equal(f.state.webDrafts.q1,undefined);assert.deepEqual(f.state.questions.q2,other);assert.deepEqual(f.state.webHistory,history);
 assert.equal(f.bank.features.editing,true);assert.equal(f.bank.extension.path,'extensions/示例/题型');
 assert.equal((await readEditor(f.reload())).contentVersion,result.payload.stamp.contentVersion);
 const writes=f.writes,replayed=await request(f.reload(),`${basePath}/questions/q1/edit`,'POST',body);assert.equal(f.writes,writes);assert.equal(replayed.sourceVersion,result.sourceVersion);
 await assert.rejects(request(s,`${basePath}/questions/q1/edit`,'POST',{...body,title:'复用编号不同内容'}),e=>e.code==='REQUEST_ID_REUSED');
});

test('editor conflicts and failed native commit retain source, answers and unfinished drafts for retry',async()=>{
 const f=fixture(),s=f.service;await save(s);const value=await readEditor(s),draft={title:'',invalidIntermediate:{key:''}};
 await request(s,'/api/editor-drafts/b1/q1','PUT',{contentVersion:value.draftVersion,changed:true,draft});
 const sourceBefore=clone(f.bank),stateBefore=f.state;
 for(const extra of[{revision:value.revision+1},{contentVersion:'0'.repeat(64)},{sourceVersion:'0'.repeat(64)}])await assert.rejects(request(s,`${basePath}/questions/q1/edit`,'POST',editBody(value,extra)),e=>['REVISION_CONFLICT','CONTENT_CONFLICT'].includes(e.code));
 f.fail(true);const body=editBody(value);await assert.rejects(request(s,`${basePath}/questions/q1/edit`,'POST',body),e=>e.code==='IO_ERROR');
 assert.deepEqual(f.bank,sourceBefore);assert.deepEqual(f.state,stateBefore);assert.deepEqual((await request(s,'/api/editor-drafts/b1/q1')).draft,draft);
 f.fail(false);await request(s,`${basePath}/questions/q1/edit`,'POST',body);assert.equal(f.bank.questions[0].data.key,6);
 const retained=await request(s,'/api/editor-drafts/b1/q1');assert.deepEqual(retained.draft,draft);assert.notEqual(retained.contentVersion,(await readEditor(s)).draftVersion);
});

test('original unvalidated editor drafts roundtrip durably and title-only edit retains practice data',async()=>{
 const f=fixture(),s=f.service;await save(s);let value=await readEditor(s);const draft={fields:[{name:'prompt',value:''}],html:'<p>unfinished</p>'};
 const response=await request(s,'/api/editor-drafts/b1/q1','PUT',{contentVersion:value.draftVersion,changed:true,draft});assert.equal(response.memoryOnly,false);
 assert.deepEqual((await request(f.reload(),'/api/editor-drafts/b1/q1')).draft,draft);
 const answer=clone(f.state.questions.q1.answer);await request(s,`${basePath}/questions/q1/edit`,'POST',editBody(value,{title:'仅修改标题',data:clone(value.question.data)}));assert.deepEqual(f.state.questions.q1.answer,answer);assert.equal(f.state.questions.q1.status,'draft');
 await request(s,'/api/editor-drafts/b1/q1','DELETE');assert.equal((await request(s,'/api/editor-drafts/b1/q1')).draft,null);
 const temporary=fixture({persistent:false}),v=await readEditor(temporary.service);const saved=await request(temporary.service,'/api/editor-drafts/b1/q1','PUT',{contentVersion:v.draftVersion,changed:true,draft});assert.equal(saved.memoryOnly,true);assert.equal((await request(temporary.reload(),'/api/editor-drafts/b1/q1')).draft,null);assert.equal(temporary.writes,0);
});

test('exam feature remains author-controlled even when the separate Android exam service is enabled',async()=>{
 const f=fixture();const enabled=createPracticeService(f.native,{domain:f.service.domain,examEnabled:true});assert.equal((await request(enabled,basePath)).features.exam,true);
});

test('history-disabled editing validates live memory revisions and preserves new temporary input on edit replay',async()=>{
 const f=fixture({persistent:false}),s=f.service;await save(s);await save(s,{qid:'q2',value:2});
 let value=await readEditor(s);assert.equal(value.revision,(await readQuestion(s)).state.revision);assert.equal(value.revision,1);
 await assert.rejects(request(s,`${basePath}/questions/q1/edit`,'POST',editBody(value,{revision:0})),e=>e.code==='REVISION_CONFLICT');
 await request(s,`${basePath}/questions/q1/edit`,'POST',editBody(value,{title:'临时题库仅改标题',data:clone(value.question.data)}));assert.equal((await readQuestion(s)).state.answer.value,4);
 value=await readEditor(s);const body=editBody(value);await request(s,`${basePath}/questions/q1/edit`,'POST',body);assert.equal((await readQuestion(s)).state.status,'unanswered');assert.equal((await readQuestion(s,'q2')).state.answer.value,2);
 await save(s,{value:6});const current=(await readQuestion(s)).state;await request(s,`${basePath}/questions/q1/edit`,'POST',body);assert.deepEqual((await readQuestion(s)).state,current);assert.equal(f.state,null);assert.equal(f.writes,0);
});

test('resource uploads follow the actual active bank and editor images do not inherit practice persistence policy',async()=>{
 const image={mime:'image/png',data:'aW1hZ2U='},f=fixture({listedFeatures:[{history:true},{history:false,editing:true}]}),s=f.reload({resourceContext:()=>({bankId:'b2',kind:'bank',editing:true})});
 await request(s,'/api/resources','POST',{...image,bankId:'b1',editing:false});const uploaded=f.calls.find(c=>c.method==='resource.put');assert.equal(uploaded.args.bankId,'b2');assert.equal(uploaded.args.editing,true);
 const practice=f.reload({resourceContext:()=>({bankId:'b2',kind:'bank',editing:false})});await assert.rejects(request(practice,'/api/resources','POST',image),e=>e.code==='FEATURE_DISABLED');
 const missing=f.reload({resourceContext:()=>null});await assert.rejects(request(missing,'/api/resources','POST',image),e=>e.code==='ACTIVE_BANK_UNAVAILABLE');
 const disabled=fixture({listedFeatures:[{history:true},{history:true,editing:false}]}),editor=disabled.reload({resourceContext:()=>({bankId:'b2',kind:'bank',editing:true})});await assert.rejects(request(editor,'/api/resources','POST',image),e=>e.code==='FEATURE_DISABLED');
});

test('image reads resolve the active bank before earlier catalog banks without opening unrelated source or history',async()=>{
 const f=fixture(),id='a'.repeat(64),image={id,mime:'image/png',data:'YWN0aXZlLWJhbms=',size:11},attempts=[];
 f.resources.set('b2|'+id,image);
 const native=async(method,args={})=>{
  attempts.push({method,args:clone(args)});
  if(['library.readBank','state.read'].includes(method)&&args.bankId==='b1')throw Error('Unrelated b1 source/history must not be loaded to find an image');
  return f.native(method,args);
 };
 const service=createPracticeService(native,{resourceContext:()=>({bankId:'b2',kind:'bank',editing:false})});
 const result=await request(service,'/api/resources/'+id);
 assert.deepEqual(result,{__qfBinary:true,mime:image.mime,data:image.data});
 assert.deepEqual(attempts.filter(call=>call.method==='resource.get').map(call=>call.args.bankId),['b2']);
 assert.equal(attempts.some(call=>['library.readBank','state.read'].includes(call.method)&&call.args.bankId!=='b2'),false);
 assert.equal(f.writes,0);
});

test('candidate resource reads select the mounting bank while uploads retain the active authoring bank',async()=>{
 const f=fixture(),id='c'.repeat(64),image={id,mime:'image/png',data:'Y2FuZGlkYXRl',size:9},contexts=[];
 f.resources.set('b2|'+id,image);
 const service=f.reload({resourceContext:options=>{
  contexts.push(clone(options));
  return options?.reading===true?{bankId:'b2',kind:'bank',editing:false}:{bankId:'b1',kind:'bank',editing:true};
 }});
 assert.deepEqual(await request(service,'/api/resources/'+id),{__qfBinary:true,mime:image.mime,data:image.data});
 assert.deepEqual(contexts,[{reading:true}]);
 assert.deepEqual(f.calls.filter(call=>call.method==='resource.get').map(call=>call.args.bankId),['b2']);
 await request(service,'/api/resources','POST',{mime:'image/png',data:'YXV0aG9yZWQ='});
 assert.equal(contexts[1],undefined,'The read-only candidate must not become an upload owner');
 const uploaded=f.calls.find(call=>call.method==='resource.put');
 assert.equal(uploaded.args.bankId,'b1');assert.equal(uploaded.args.editing,true);
});

test('cross-bank image fallback reads only native resources and does not open unrelated bank source or full state',async()=>{
 const f=fixture(),id='b'.repeat(64),image={id,mime:'image/png',data:'ZnJvemVuLWhpc3Rvcnk=',size:14},attempts=[];
 f.resources.set('b1|'+id,image);
 const native=async(method,args={})=>{
  attempts.push({method,args:clone(args)});
  if(['library.readBank','state.read'].includes(method)&&args.bankId!=='b2')throw Error('Cross-bank resource fallback must not materialize source/history');
  return f.native(method,args);
 };
 const service=createPracticeService(native,{resourceContext:()=>({bankId:'b2',kind:'bank',editing:false})});
 const result=await request(service,'/api/resources/'+id);
 assert.deepEqual(result,{__qfBinary:true,mime:image.mime,data:image.data});
 assert.deepEqual(attempts.filter(call=>call.method==='resource.get').map(call=>call.args.bankId),['b2','b1'],'Check the active scope once, then preserve cross-bank resource lookup');
 assert.equal(attempts.some(call=>['library.readBank','state.read'].includes(call.method)&&call.args.bankId!=='b2'),false);
 assert.equal(f.writes,0);
});

test('completed-round title editing and scratch-paper saves retain frozen history and keep answer actions locked',async()=>{
 const f=fixture(),s=f.service;
 await save(s,{purpose:'submit'});
 const summary=await request(s,basePath+'/summary');
 await request(s,basePath+'/finish','POST',{requestId:'complete-before-title-edit',roundId:summary.roundId,summaryVersion:summary.summaryVersion});
 assert.equal(f.state.finished,true);
 const frozen=clone(f.state.webHistory),roundId=f.state.roundId,first=clone(f.state.questions.q1);
 const editor=await request(s,basePath+'/questions/q2/editor');
 await request(s,basePath+'/questions/q2/edit','POST',editBody(editor,{requestId:'completed-title-only',title:'已完成后仅改标题',data:clone(editor.question.data)}));
 assert.equal(f.state.finished,true);assert.equal(f.state.roundId,roundId);
 assert.deepEqual(f.state.webHistory,frozen);assert.deepEqual(f.state.questions.q1,first);

 const q=await readQuestion(s,'q2'),body={requestId:'completed-paper-layout',revision:q.state.revision,contentVersion:q.stamp.contentVersion,action:'whiteboard',data:{draft:webDraft}};
 const result=await request(s,basePath+'/questions/q2/actions','POST',body);
 assert.deepEqual(result.draft,webDraft);assert.deepEqual(f.state.webDrafts.q2,webDraft);
 assert.equal(result.state.status,'unanswered');assert.equal(result.state.answer,null);
 assert.equal(f.state.finished,true);assert.equal(f.state.roundId,roundId);
 assert.deepEqual(f.state.webHistory,frozen);assert.deepEqual(f.state.questions.q1,first);
 const writes=f.writes;
 assert.deepEqual(await request(s,basePath+'/questions/q2/actions','POST',body),result);assert.equal(f.writes,writes);
 await assert.rejects(request(s,basePath+'/questions/q2/actions','POST',{...body,requestId:'completed-blocked-review',revision:result.state.revision,action:'review',data:{review:{score:2}}}),{code:'ROUND_COMPLETED'});
 assert.equal(f.writes,writes);assert.deepEqual(f.state.webHistory,frozen);
 assert.equal((await request(s,basePath+'/summary')).finished,true);

 // Like Web: a draft still saves in the completed round, and a submit starts a new one.
 const drafted=await request(s,basePath+'/questions/q2/actions','POST',{...body,requestId:'completed-draft',revision:result.state.revision,action:'draft',data:{answer:{value:2}}});
 assert.equal(drafted.state.status,'draft');assert.equal(f.state.finished,true);assert.equal(f.state.roundId,roundId);
 await request(s,basePath+'/questions/q2/actions','POST',{...body,requestId:'completed-submit',revision:drafted.state.revision,action:'submit',data:{answer:{value:2}}});
 assert.equal(f.state.finished,false);assert.notEqual(f.state.roundId,roundId);
 assert.deepEqual(f.state.webHistory.find(row=>row.id===roundId),frozen.find(row=>row.id===roundId));
 assert.equal((await request(s,basePath+'/summary')).finished,false);
});

test('cold collection reads use declared answer-state without running unused score rules',async()=>{
 const reported={status:'draft',outlineStates:[{id:'a',status:'draft'}]},stored={schemaVersion:1,revision:1,roundId:'reported-round',questions:{q1:{status:'draft',revision:1,answer:{value:4},result:null,answerState:reported}},ink:{},history:[],finished:false};
 const f=fixture({stored});
 f.changeSource(source.replace('getScore(data,state){','getScore(data,state){throw Error("Unused cold-overview scoring must not run");'));
 const collection=await request(f.service,basePath);
 assert.deepEqual(collection.states.q1.outlineStates,reported.outlineStates);
 assert.deepEqual(collection.states.q1.answerState,reported);
 assert.equal(collection.states.q2.status,'unanswered');
 assert.deepEqual(collection.questions[0].outlineItems,[{id:'a',label:'小题'}]);
 assert.equal(f.calls.some(call=>call.method==='rules.run'&&call.args.request.op==='scoreBatch'),false);
 assert.deepEqual(f.state,stored);assert.equal(f.writes,0);
 await assert.rejects(request(f.service,basePath+'/summary'),/Unused cold-overview scoring must not run/,'Summary must still execute required scoring');
});

test('collection reads still score submitted part progress without scoring reported unsubmitted answers',async()=>{
 const stored={schemaVersion:1,revision:2,roundId:'mixed-progress',questions:{
  q1:{status:'submitted',revision:1,answer:{value:4},result:{score:2,maxScore:2,correct:true,feedback:'正确'}},
  q2:{status:'draft',revision:1,answer:{value:2},result:null,answerState:{status:'draft',outlineStates:[{id:'a',status:'draft'}]}},
 },ink:{},history:[],finished:false},f=fixture({stored});
 const collection=await request(f.service,basePath);
 assert.deepEqual(collection.states.q1.outlineStates,[{id:'a',status:'correct'}]);
 assert.deepEqual(collection.states.q2.outlineStates,[{id:'a',status:'draft'}]);
 const scored=f.calls.filter(call=>call.method==='rules.run'&&call.args.request.op==='scoreBatch').flatMap(call=>call.args.request.questions);
 assert.deepEqual(scored.map(row=>row.data.prompt),['2+2=?']);
 assert.deepEqual(f.state,stored);assert.equal(f.writes,0);
});

test('collection reads retain rule-derived unsubmitted part progress when answer-state is undeclared',async()=>{
 const stored={schemaVersion:1,revision:1,roundId:'legacy-progress',questions:{q1:{status:'draft',revision:1,answer:{value:4},result:null}},ink:{},history:[],finished:false},f=fixture({stored});
 f.manifest.requiresApi.capabilities=f.manifest.requiresApi.capabilities.filter(capability=>capability!=='answer-state');
 f.bank.questions[1].outline={level:'question',label:'第二题'};
 f.changeSource(source.replace("...(state.submitted?{outlineStates:[{id:'a',status:state.result.correct?'correct':'incorrect'}]}:{})","outlineStates:[{id:'a',status:state.submitted?(state.result.correct?'correct':'incorrect'):'draft'}]"));
 const collection=await request(f.service,basePath);
 assert.deepEqual(collection.states.q1.outlineStates,[{id:'a',status:'draft'}]);
 assert.equal(collection.states.q2.outlineStates,undefined);
 assert.equal(collection.questions[1].outlineItems,undefined);
 const scored=f.calls.filter(call=>call.method==='rules.run'&&call.args.request.op==='scoreBatch').flatMap(call=>call.args.request.questions);
 assert.deepEqual(scored.map(row=>row.data.prompt),['2+2=?'],'Rows without part outlines must not run unused score rules');
 assert.deepEqual(f.state,stored);assert.equal(f.writes,0);
});
