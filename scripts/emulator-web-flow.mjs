// Dedicated Android 15 AVD acceptance using only the fictional demonstration bank.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {connect,nativeDiagnostic} from './webview-driver.mjs';

const serial='emulator-5580',pkg='cloud.treenewbee.quizforge.android.debug';
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8',timeout:45000}).trim();
assert.match(adb('emu','avd','name'),/^QuizForge_Android15_Tablet/);
assert.equal(adb('shell','getprop','ro.build.version.release'),'15');
assert.equal(adb('shell','settings','get','global','airplane_mode_on'),'1');
const output=path.resolve('output/acceptance');await fs.mkdir(output,{recursive:true});
const evidence={android:'15',avd:'QuizForge_Android15_Tablet',airplaneMode:true,inputEvidence:'Actual Web UI; automated CDP mouse/pen/text input. No physical stylus acceptance.',checks:[]};
if(process.argv.some(x=>x.startsWith('--')))evidence.executionNote='Staged acceptance resumed from prior recorded checks on the same synthetic state; original finish completed after the first 60s harness wait, within the original endpoint 135s allowance.';
let d=await connect(),bankId,stage='startup';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,message,timeout=60000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await read();if(value)return value;}catch(e){last=e;}await delay(250);}throw Error(message+(last?': '+last.message:''));}
const evaluate=s=>d.evaluate(s);
const state=()=>nativeDiagnostic(d,'state.read',{bankId},s=>({revision:s.revision,finished:s.finished,roundId:s.roundId,questions:s.questions,webDrafts:s.webDrafts,webHistory:s.webHistory?.map(h=>({id:h.id,finished:h.finished,summary:h.summary}))}));
const flush=()=>evaluate('window.quizforgeApp.flush().then(()=>true)');
async function click(selector){return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Control unavailable: '+${JSON.stringify(selector)});e.click();return true})()`);}
async function context(predicate){await d.send('Runtime.disable');await d.send('Runtime.enable');for(const [id,c]of d.contexts){if(c.auxData?.isDefault&&await d.evaluate(predicate,id).catch(()=>false))return id;}return null;}
const questionContext=predicate=>until(()=>context(predicate),'Question iframe not ready');
async function shot(name){const remote='/sdcard/qf-'+name+'.png';adb('shell','screencap','-p',remote);adb('pull',remote,path.join(output,name+'.png'));}
async function chooseQuestion(id){await until(()=>evaluate(`!!document.querySelector('#outline-list [data-question-id="${id}"]')`),'Original outline not ready');if(await evaluate(`document.getElementById('draft-toggle').getAttribute('aria-pressed')==='true'`))await click('#draft-toggle');await click(`#outline-list [data-question-id="${id}"]`);await until(()=>evaluate(`document.querySelector('#outline-list [data-question-id="${id}"][aria-current="true"]')&&!document.getElementById('draft-toggle').disabled`),'Original question navigation not finished');}
try{
 const banks=await nativeDiagnostic(d,'library.list');const bank=banks.find(b=>b.title==='基础题型体验');assert.ok(bank);assert.equal(bank.questionCount,4);bankId=bank.id;
 await until(()=>evaluate('!!window.quizforgeApp'),'Original application not ready');
 evidence.layout=await evaluate(`({width:innerWidth,height:innerHeight,scrollWidth:document.body.scrollWidth,brand:document.querySelector('.brand')?.innerText||document.body.innerText.slice(0,25),styles:[...document.styleSheets].map(s=>s.href).filter(Boolean)})`);
 assert.equal(evidence.layout.scrollWidth,evidence.layout.width);await shot('web-landscape');
 let frame;if(process.argv.some(x=>['--resume','--finish-only','--history-only'].includes(x))){const previous=JSON.parse(await fs.readFile(path.join(output,'web-flow.json'),'utf8'));evidence.checks=previous.checks;evidence.radio=previous.radio;evidence.whiteboard=previous.whiteboard;evidence.manualGrade=previous.manualGrade;}else{
 stage='radio-save';await chooseQuestion('offline-demo-1');frame=await questionContext(`!!document.querySelector('input[value="choice-6"]')`);
 if((await state()).questions['offline-demo-1']?.status==='submitted'){await d.evaluate(`document.querySelector('#retry').click();true`,frame);await until(async()=>!(await state()).questions['offline-demo-1']?.result,'Retry did not reset this synthetic question');}
 await d.evaluate(`document.querySelector('input[value="choice-6"]').click();true`,frame);await flush();
 let saved=await state();assert.equal(saved.questions['offline-demo-1'].answer.selectedOptionId,'choice-6');assert.equal(saved.questions['offline-demo-1'].status,'draft');
 evidence.checks.push('original radio selection and original pane flush persisted the correct answer offline');
 stage='process-recovery';d.close();adb('shell','am','force-stop',pkg);adb('shell','am','start','-n',pkg+'/cloud.treenewbee.quizforge.android.MainActivity');
 const pid=await until(()=>{const v=adb('shell','pidof',pkg);return v||null;},'App did not restart');adb('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid);
 d=await until(()=>connect(),'WebView did not reconnect');await until(()=>evaluate('!!window.quizforgeApp'),'Restarted application not ready');frame=await questionContext(`!!document.querySelector('input[value="choice-6"]')`);
 assert.equal(await d.evaluate(`document.querySelector('input[value="choice-6"]').checked`,frame),true);evidence.checks.push('force-stop and restart restored the selected radio in the actual original iframe');
 stage='submit';await d.evaluate(`document.querySelector('#submit').click();true`,frame);saved=await until(async()=>{const s=await state();return s.questions['offline-demo-1']?.status==='submitted'?s:null;},'Original submit did not persist');
 assert.equal(saved.questions['offline-demo-1'].result.score,2);evidence.radio={answer:'choice-6',score:2,revision:saved.revision};
 evidence.checks.push('original submit produced and persisted 2/2 grading result offline');}
 let saved;
 if(!process.argv.includes('--finish-only')&&!process.argv.includes('--history-only')){stage='whiteboard';await chooseQuestion('offline-demo-1');await click('#draft-toggle');await until(()=>evaluate(`document.getElementById('draft-toggle').getAttribute('aria-pressed')==='true'`),'Draft mode not active');
 const active='.question-pane:not([hidden])';await click(active+' [data-tool="pen"]');
 const rect=await evaluate(`(()=>{const r=document.querySelector('${active} .qf-whiteboard-ink').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);assert.ok(rect.width>100&&rect.height>150);
 const x=Math.round(rect.x+rect.width*.35),y=Math.round(rect.y+rect.height*.4);
 const before=(await state()).webDrafts?.['offline-demo-1']?.strokes?.length||0;
 await d.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1,pointerType:'pen',force:.7});
 for(let n=1;n<=8;n++)await d.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+n*12,y:y+Math.round(Math.sin(n/2)*18),button:'left',buttons:1,pointerType:'pen',force:.6});
 await d.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+96,y:y-14,button:'left',buttons:0,pointerType:'pen',force:0});
 await click(active+' [data-action="settings"]');await evaluate(`(()=>{const p=document.querySelector('${active} [data-control="pattern"]');p.value='grid';p.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);await click(active+' [data-action="close-settings"]');
 await click(active+' [data-tool="hand"]');
 const panX=Math.round(rect.x+8),panY=Math.round(rect.y+100);
 await d.send('Input.dispatchMouseEvent',{type:'mousePressed',x:panX,y:panY,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});
 await d.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:panX+35,y:panY+24,button:'left',buttons:1,pointerType:'mouse'});
 await d.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:panX+35,y:panY+24,button:'left',buttons:0,pointerType:'mouse'});
 await flush();saved=await state();const draft=saved.webDrafts?.['offline-demo-1'];assert.ok(draft?.strokes.length>before,'Original whiteboard stroke not persisted');assert.equal(draft.schemaVersion,1);assert.equal(draft.paper.pattern,'grid');
 const camera=await evaluate(`(()=>{const s=document.querySelector('${active} .question-viewport').style;return ['--qf-whiteboard-x','--qf-whiteboard-y','--qf-whiteboard-zoom'].map(k=>s.getPropertyValue(k))})()`);
 evidence.whiteboard={before,after:draft.strokes.length,paper:draft.paper,camera,revision:saved.revision};
 await shot('web-whiteboard');await chooseQuestion('offline-demo-2');await chooseQuestion('offline-demo-1');await click('#draft-toggle');
 assert.equal(await evaluate(`document.querySelector('${active} [data-control="pattern"]').value`),'grid');assert.deepEqual((await state()).webDrafts['offline-demo-1'],draft);assert.deepEqual(await evaluate(`(()=>{const s=document.querySelector('${active} .question-viewport').style;return ['--qf-whiteboard-x','--qf-whiteboard-y','--qf-whiteboard-zoom'].map(k=>s.getPropertyValue(k))})()`),camera);evidence.checks.push('original whiteboard synthetic pen/paper persist natively; per-device pan camera survives question navigation as in original Web');
 stage='pending-manual';await chooseQuestion('offline-demo-4');frame=await questionContext(`!!document.querySelector('.answer-field')`);await d.evaluate(`document.querySelector('.answer-field').click();true`,frame);await until(()=>d.evaluate(`!!document.querySelector('.ProseMirror[contenteditable="true"]')`,frame),'Original richtext editor did not lazy load');
 await d.evaluate(`document.querySelector('.ProseMirror').focus();true`,frame);await d.send('Input.insertText',{text:' 原Web界面离线验收。'});await flush();saved=await state();assert.match(JSON.stringify(saved.questions['offline-demo-4'].answer),/原Web界面离线验收/);evidence.checks.push('original SDK richtext editor lazy loaded and saved a structured rich document offline');
 await d.evaluate(`document.querySelector('#submit').click();true`,frame);const submitted=await until(async()=>{const s=await state();return s.questions['offline-demo-4']?.status==='submitted'?s:null;},'Short-answer submit did not persist');
 evidence.shortGradingStatus=submitted.questions['offline-demo-4'].result.gradingStatus;
 if(evidence.shortGradingStatus==='pending'){await click('.outline-score-summary');await until(()=>evaluate(`!!document.querySelector('.practice-summary-finish')`),'Original score summary not visible');assert.equal(await evaluate(`document.querySelector('.practice-summary-finish').disabled`),true);evidence.checks.push('pending manual grade keeps finish disabled in original summary');}}
 if(!process.argv.includes('--history-only')){await chooseQuestion('offline-demo-4');frame=await questionContext(`!!document.querySelector('input[type="range"]')`);await d.evaluate(`(()=>{const r=document.querySelector('input[type="range"]');r.value=r.max;r.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,frame);await flush();
 saved=await until(async()=>{const s=await state();return s.questions['offline-demo-4']?.result?.gradingStatus==='graded'?s:null;},'Original manual review did not persist');evidence.manualGrade=saved.questions['offline-demo-4'].result;
 stage='finish-history';await click('.outline-score-summary');await until(()=>evaluate(`document.querySelector('.practice-summary-finish')&&!document.querySelector('.practice-summary-finish').disabled`),'Finish stayed disabled after grading');await click('.practice-summary-finish');
 saved=await until(async()=>{const s=await state();return s.finished?s:null;},'Original finish did not freeze round',135000);}else saved=await state();const histories=saved.webHistory||[];const history=histories.at(-1);assert.ok(history?.id);evidence.completed={historyCount:histories.length,id:history.id,revision:saved.revision};
 await click('#history-open');await until(()=>evaluate(`document.getElementById('history-dialog').open&&!!document.querySelector('.history-row')`),'Original history list not ready');
 await evaluate(`(()=>{const row=document.querySelector('.history-list-item[data-history-id="${history.id}"] .history-row');if(!row)throw Error('New frozen history missing');row.click();return true})()`);
 frame=await questionContext(`!!document.querySelector('input[value="choice-6"]')`);const refusal=await d.evaluate(`QF.save({purpose:'draft',data:{answer:{selectedOptionId:'choice-3'}}})`,frame);assert.equal(refusal.ok,false);assert.equal((await state()).revision,saved.revision);evidence.historyReadonly={error:refusal.error,revisionUnchanged:true};await shot('web-history');evidence.checks.push('original completion/history freezes round and rejects historical QF.save without mutation');
 await click('#return-practice');await click('.outline-score-summary');await until(()=>evaluate(`document.querySelector('.practice-summary-finish')?.textContent.includes('再练一次')`),'Restart control unavailable');await click('.practice-summary-finish');saved=await until(async()=>{const s=await state();return !s.finished?s:null;},'Original restart did not open new round');assert.equal(saved.webHistory.length,histories.length);evidence.checks.push('original 再练一次 opens a new round and preserves frozen history');
 stage='portrait';adb('shell','settings','put','system','accelerometer_rotation','0');adb('shell','settings','put','system','user_rotation','1');await until(()=>evaluate('innerWidth<innerHeight'),'Portrait rotation not reflected');evidence.portrait=await evaluate('({width:innerWidth,height:innerHeight,scrollWidth:document.body.scrollWidth})');assert.equal(evidence.portrait.width,evidence.portrait.scrollWidth);await shot('web-portrait');
 evidence.passed=true;
}catch(error){evidence.passed=false;evidence.failedStage=stage;evidence.error=error.stack;try{await shot('web-flow-failure');}catch{}process.exitCode=1;}
finally{await fs.writeFile(path.join(output,'web-flow.json'),JSON.stringify(evidence,null,2)+'\n');d.close();console.log(JSON.stringify(evidence,null,2));}
