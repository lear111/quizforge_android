import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createEditorSession} from '../vendor/quizforge-web/core/web/editor/editor-session.js';
import {checkEditorExit,shouldWarnBeforeUnload} from '../vendor/quizforge-web/core/web/editor/editor-navigation.js';

const hook=await fs.readFile(new URL('../web/web-host-lifecycle.js',import.meta.url),'utf8');
function host({persist=()=>{throw Error('author drafts must not be persisted');},panes,flush=async()=>true,prepare=async()=>true}={}){
  const context={window:{},document:{dispatchEvent(){}},Event:class{},collections:new Map(panes.map((pane,i)=>[i,pane])),libraryTransfer:{},
    transitionTo:fn=>Promise.resolve().then(fn),flushPane:flush,persistEditorDraft:persist,prepareLibraryChange:prepare,active:()=>panes[0]};
  vm.runInNewContext(hook,context);return context.window.quizforgeApp;
}
test('native lifecycle does not persist or inspect unfinished author edits, including broken editors',async()=>{
  const pane={view:'edit',input:'unfinished',plugin:{flush(){throw Error('broken editor');}}},flushed=[];
  const app=host({panes:[pane],flush:async value=>{flushed.push(value);await value.plugin?.flush();}});
  assert.equal(await app.flush(),true);assert.deepEqual(flushed,[]);assert.equal(pane.input,'unfinished');
  assert.equal(app.resourceContext().editing,true);
});

test('native lifecycle confirmation still waits for normal answer and whiteboard writes',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve),events=[],editor={view:'edit'},practice={view:'practice'};
  const app=host({panes:[editor,practice],flush:async value=>{assert.equal(value,practice);events.push('practice-flush');await pending;events.push('written');return true;}});
  let confirmed=false;const flush=app.flush().then(()=>confirmed=true);await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(confirmed,false);assert.deepEqual(events,['practice-flush']);release();await flush;assert.deepEqual(events,['practice-flush','written']);assert.equal(confirmed,true);
});

test('failed practice persistence rejects lifecycle confirmation and leaves normal input alive',async()=>{
  const pane={view:'practice',input:'unfinished answer'};
  const app=host({panes:[pane],flush:async()=>{throw Error('disk full');}});
  await assert.rejects(app.flush(),/disk full/);assert.equal(pane.input,'unfinished answer');
});

test('unconfirmed normal input prevents native close even when a dirty author editor is also open',async()=>{
  const app=host({panes:[{view:'edit'},{view:'practice'}],flush:async()=>false});
  await assert.rejects(app.flush(),error=>error.code==='SAVE_FAILED');
});

test('in-app native navigation delegates to the Web editor guard instead of the lifecycle flush',async()=>{
  const pane={view:'edit',input:'unsaved author edit'},calls=[],blocked=Object.assign(Error('请先保存或取消当前题目的修改'),{code:'UNSAVED_EDITOR_CHANGES'});
  const app=host({panes:[pane],prepare:async()=>{calls.push('web-guard');throw blocked;},flush:async()=>{calls.push('practice-flush');return true;}});
  await assert.rejects(app.prepareNavigation(),error=>error===blocked);assert.deepEqual(calls,['web-guard']);assert.equal(pane.input,'unsaved author edit');
  await app.flush();assert.deepEqual(calls,['web-guard']);
});

test('clean or reverted native navigation completes the existing Web preparation',async()=>{
  let prepared=false;
  const app=host({panes:[{view:'edit'}],prepare:async()=>{prepared=true;return 'web-prepared';}});
  assert.equal(await app.prepareNavigation(),'web-prepared');assert.equal(prepared,true);
});

const preload=await fs.readFile(new URL('../web/android-preload.js',import.meta.url),'utf8');
function nativeNavigation(prepare){
  const handlers={},calls=[],errors=[],context={window:{quizforgeApp:{prepareNavigation:prepare,flush:()=>{throw Error('navigation used lifecycle flush');},openImportedBank:async id=>calls.push(['open',id])}},
    document:{getElementById:id=>({addEventListener:(_type,handler)=>{handlers[id]=handler;}})},importing:false,
    nativeCall:async method=>{calls.push(method);return {cancelled:false,banks:[{id:'imported-bank'}]};},notice:error=>errors.push(error)};
  for(const[id,end]of [['library-download','async function acceptNativeImport()'],['library-import','// Keep the original settings']]){
    const start=preload.indexOf(`document.getElementById('${id}').addEventListener`),stop=preload.indexOf(end,start);
    assert.ok(start>=0&&stop>start);vm.runInNewContext(preload.slice(start,stop),context);
  }
  return {calls,errors,click:id=>handlers[id]({preventDefault(){},stopImmediatePropagation(){}})};
}

test('native import picker and Hub entry both reject dirty editors before opening another surface',async()=>{
  const blocked=Object.assign(Error('请先保存或取消当前题目的修改'),{code:'UNSAVED_EDITOR_CHANGES'});
  const navigation=nativeNavigation(async()=>{throw blocked;});
  await navigation.click('library-import');await navigation.click('library-download');
  assert.deepEqual(navigation.calls,[]);assert.deepEqual(navigation.errors,[blocked,blocked]);
});

test('native import and Hub entry prepare clean navigation before using their system integrations',async()=>{
  const events=[],navigation=nativeNavigation(async()=>{events.push('prepared');});
  await navigation.click('library-import');await navigation.click('library-download');
  assert.deepEqual(events,['prepared','prepared']);assert.deepEqual(navigation.calls,['import.pick',['open','imported-bank'],'hub.open']);assert.deepEqual(navigation.errors,[]);
});

function pinnedEditor(){
  const form={changed:false,invalid:false,broken:false},events=[],session=createEditorSession(),plugin={
    get isDirty(){return form.changed;},
    async flush(){events.push('editor-flush');if(form.broken)throw Error('broken editor');},
    async getDocument({checkOnly=false}={}){events.push(checkOnly?'check':'validate');if(!checkOnly&&form.invalid)throw Error('incomplete question');return {changed:form.changed,document:{title:'当前题目',data:{stem:'已保存题干'}}};},
    destroy(){events.push('destroy');}
  };
  session.add('q1',{plugin,value:{}});
  return {form,events,session,pane:{view:'edit',plugin,editorSession:session}};
}

test('pinned single-question editor permits clean or undone navigation and blocks dirty invalid forms',async()=>{
  const f=pinnedEditor();f.form.invalid=true;
  const app=host({panes:[f.pane],prepare:()=>checkEditorExit(f.pane)});
  assert.equal(await app.prepareNavigation(),true);f.form.changed=true;
  await assert.rejects(app.prepareNavigation(),error=>error.code==='UNSAVED_EDITOR_CHANGES');
  assert.equal(f.session.values().length,1);assert.equal(f.events.includes('validate'),false);
  f.form.changed=false;assert.equal(await app.prepareNavigation(),true);
});

test('pinned explicit save is the author write boundary and a failed editor remains cancellable',async()=>{
  const f=pinnedEditor();f.form.changed=true;let writes=0;
  const app=host({panes:[f.pane],prepare:()=>checkEditorExit(f.pane)});
  await app.flush();assert.deepEqual(f.events,[]);assert.equal(writes,0);
  assert.equal(await f.session.saveCurrent(async change=>{assert.equal(change.id,'q1');writes++;return {saved:true};},async(_change,result)=>{assert.equal(result.saved,true);f.form.changed=false;}),true);
  assert.equal(writes,1);assert.equal(await app.prepareNavigation(),true);
  f.form.changed=true;f.form.broken=true;
  await assert.rejects(app.prepareNavigation(),error=>error.code==='UNSAVED_EDITOR_CHANGES');
  assert.equal(await checkEditorExit(f.pane,{discard:true,confirmDiscard:()=>false}),false);
  assert.equal(await checkEditorExit(f.pane,{discard:true,confirmDiscard:()=>true}),true);
  f.session.destroy();assert.equal(f.session.values().length,0);assert.equal(writes,1);
});

test('pinned reload discards author edits while normal autosave protection and legacy draft files stay separate',async()=>{
  const f=pinnedEditor();f.form.changed=true;f.pane.plugin.hasUnsavedInput=true;
  const app=host({panes:[f.pane]});await app.flush();
  assert.equal(shouldWarnBeforeUnload([f.pane],0),false);
  assert.equal(shouldWarnBeforeUnload([f.pane,{view:'practice',ink:{pending:true}}],0),true);
  assert.equal(shouldWarnBeforeUnload([f.pane],1),true);
  f.session.destroy();assert.deepEqual(createEditorSession().values(),[]);
  const source=await fs.readFile(new URL('../vendor/quizforge-web/core/web/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/editor-drafts|persistEditorDraft|exportDraft/,'new app must not revive or delete legacy unfinished author drafts');
});

test('candidate image reads follow the mounting pane while uploads retain the previously active pane',()=>{
  let candidate=false;
  const old={id:'old-exam',kind:'exam',view:'practice'},context={window:{},document:{dispatchEvent(){},querySelector(selector){assert.equal(selector,'#panes .collection-candidate');return candidate?{}:null;}},Event:class{},libraryTransfer:{},
    active:()=>old,pendingLibraryKey:'bank:new-bank'};
  vm.runInNewContext(hook,context);const app=context.window.quizforgeApp;
  const selected=options=>JSON.parse(JSON.stringify(app.resourceContext(options)));
  assert.deepEqual(selected({reading:true}),{bankId:'old-exam',kind:'exam',editing:false},'Before the candidate exists, flushing still belongs to the old pane');
  candidate=true;
  assert.deepEqual(selected({reading:true}),{bankId:'new-bank',kind:'bank',editing:false});
  assert.deepEqual(selected(),{bankId:'old-exam',kind:'exam',editing:false},'Upload routing must not adopt the candidate');
  assert.deepEqual(selected({reading:1}),{bankId:'old-exam',kind:'exam',editing:false});
  candidate=false;
  assert.deepEqual(selected({reading:true}),{bankId:'old-exam',kind:'exam',editing:false},'A removed or failed candidate must fall back immediately');
  old.kind='bank';old.id='old-bank';old.view='edit';candidate=true;
  assert.deepEqual(selected(),{bankId:'old-bank',kind:'bank',editing:true});
  assert.deepEqual(selected({reading:true}),{bankId:'new-bank',kind:'bank',editing:false});
});

test('malformed pending candidate keys never override the active resource owner',()=>{
  const old={id:'old-bank',kind:'bank',view:'edit'},context={window:{},document:{dispatchEvent(){},querySelector(){return {};}}
    ,Event:class{},libraryTransfer:{},active:()=>old,pendingLibraryKey:null};
  vm.runInNewContext(hook,context);
  for(const key of [null,{},'',':b2','bank:','unknown:b2','bank:b2:extra','bank:../b2','bank: b2','bank:b2\n','bank:'+'a'.repeat(129)]){
    context.pendingLibraryKey=key;
    assert.deepEqual(JSON.parse(JSON.stringify(context.window.quizforgeApp.resourceContext({reading:true}))),{bankId:'old-bank',kind:'bank',editing:true},'Invalid key '+JSON.stringify(key));
  }
});

test('the actual Android preload forwards read options to both resource owners without changing upload context',()=>{
  const services={},received=[],context={window:{quizforgeApp:{resourceContext:options=>{received.push(options);return options?.reading?{kind:'bank',bankId:'new-bank'}:{kind:'exam',bankId:'old-exam'};}}},
    document:{documentElement:{dataset:{}},head:{append(){}},createElement(){return {dataset:{}};},getElementById(){return {addEventListener(){}};},addEventListener(){}},
    nativeCall(){},createAiService:()=>({}),createPracticeService:(_native,options)=>{services.practice=options;return {domain:{host:{}}};},
    createExamService:(_native,options)=>{services.exam=options;return {};},createLibraryService:()=>({}),installOfflineFetch(){},bindAndroidLayoutNotifications(){},ANDROID_UNAVAILABLE_SELECTORS:[]};
  vm.runInNewContext(preload.replace(/^import .*;\r?\n/gm,''),context);
  for(const service of Object.values(services)){
    const read={reading:true};
    assert.deepEqual(service.resourceContext(read),{kind:'bank',bankId:'new-bank'});
    assert.equal(received.at(-1),read,'Forward the actual reading option through the preload boundary');
    assert.deepEqual(service.resourceContext(),{kind:'exam',bankId:'old-exam'});
    assert.equal(received.at(-1),undefined,'No reading flag may be invented for uploads');
  }
});
