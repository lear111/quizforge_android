// Smoke check after final APK reinstall; keep all prior synthetic practice/history.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {connect,nativeDiagnostic} from './webview-driver.mjs';
const serial='emulator-5580',adb=(...a)=>execFileSync('adb',['-s',serial,...a],{encoding:'utf8',timeout:45000}).trim();
assert.match(adb('emu','avd','name'),/^QuizForge_Android15_Tablet/);
assert.equal(adb('shell','settings','get','global','airplane_mode_on'),'1');
const output=path.resolve('output/acceptance');let d=await connect(),bankId;
const result={android:'15',airplaneMode:true,inputEvidence:'Actual original Web controls with synthetic CDP text; no physical stylus test',checks:[]};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,label,timeout=60000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{let x=await read();if(x)return x;}catch(e){last=e;}await delay(300);}throw Error(label+(last?': '+last.message:''));}
const evaluate=s=>d.evaluate(s),flush=()=>evaluate('window.quizforgeApp.flush().then(()=>true)');
async function click(s){await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(s)});if(!b||b.disabled)throw Error('Unavailable: '+${JSON.stringify(s)});b.click();return true})()`);}
async function choose(id){await click(`#outline-list [data-question-id="${id}"]`);await flush();await until(()=>evaluate(`!!document.querySelector('#outline-list [data-question-id="${id}"][aria-current="true"]')&&!document.querySelector('.question-pane:not([hidden])').inert`),'Original question navigation incomplete');}
async function frame(predicate){await d.send('Runtime.disable');await d.send('Runtime.enable');for(let[id,c]of d.contexts)if(c.auxData?.isDefault&&await d.evaluate(predicate,id).catch(()=>false))return id;return null;}
const state=()=>nativeDiagnostic(d,'state.read',{bankId},s=>({revision:s.revision,finished:s.finished,questions:s.questions,webHistory:s.webHistory?.map(h=>({id:h.id,summary:h.summary}))}));
async function shot(name){const remote='/sdcard/qf-'+name+'.png';adb('shell','screencap','-p',remote);adb('pull',remote,path.join(output,name+'.png'));}
try{
 bankId=(await nativeDiagnostic(d,'library.list')).find(b=>b.title==='基础题型体验').id;
 await until(()=>evaluate(`!!window.quizforgeApp&&!!document.querySelector('#outline-list [data-question-id="offline-demo-4"]')`),'App not loaded');
 if(await evaluate(`document.getElementById('draft-toggle').getAttribute('aria-pressed')==='true'`))await click('#draft-toggle');await choose('offline-demo-4');
 let id=await until(()=>frame(`!!document.querySelector('.answer-field')`),'Original q4 iframe unavailable');
 if((await state()).questions['offline-demo-4']?.status==='submitted'){await d.evaluate(`document.querySelector('#retry').click();true`,id);await flush();}
 await d.evaluate(`document.querySelector('.answer-field').click();true`,id);await until(()=>d.evaluate(`!!document.querySelector('.ProseMirror[contenteditable=true]')`,id),'Original richtext editor unavailable');await d.evaluate(`document.querySelector('.ProseMirror').focus();true`,id);await d.send('Input.insertText',{text:' 最终APK离线历史验收。'});await flush();await d.evaluate(`document.querySelector('#submit').click();true`,id);await flush();
 await until(async()=>{const s=await state();return s.questions['offline-demo-4']?.status==='submitted';},'Submit did not persist');
 await click('.outline-score-summary');await flush();await until(()=>evaluate(`document.querySelector('.practice-summary-finish')&&!document.querySelector('.practice-summary-finish').disabled`),'Original finish unavailable');
 const start=Date.now();await click('.practice-summary-finish');await until(()=>evaluate(`document.querySelector('.practice-summary-finish')?.textContent.includes('再练一次')&&!document.querySelector('.practice-summary-finish').disabled`),'Original UI finish did not complete',135000);result.finishUiElapsedMs=Date.now()-start;
 const completed=await state();assert.equal(completed.finished,true);const record=completed.webHistory.at(-1);assert.ok(record.id);result.completed={id:record.id,summary:record.summary,revision:completed.revision};result.checks.push('final APK actual original finish completed and persisted frozen history');
 await click('#history-open');await until(()=>evaluate(`document.getElementById('history-dialog').open&&!!document.querySelector('.history-row')`),'History dialog unavailable');await click(`.history-list-item[data-history-id="${record.id}"] .history-row`);await flush();await choose('offline-demo-4');id=await until(()=>frame(`document.body.innerText.includes('最终APK离线历史验收')`),'Frozen richtext SDK did not render its archived content');
 const reply=await d.evaluate(`QF.save({purpose:'draft',data:{answer:{responses:{cache:null}}}})`,id);assert.equal(reply.ok,false);assert.equal(reply.error.code,'READ_ONLY');assert.equal((await state()).revision,completed.revision);assert.equal(await evaluate(`!!document.querySelector('.question-error')`),false);result.checks.push('final APK frozen history renders archived richtext and rejects mutations without changing native revision');await shot('web-final-history');
 await click('#return-practice');await flush();await click('.outline-score-summary');await flush();await click('.practice-summary-finish');await flush();await until(async()=>!(await state()).finished,'New round unavailable');result.checks.push('original new-round control preserves the completed history');result.passed=true;
}catch(e){result.passed=false;result.error=e.stack;try{await shot('web-final-smoke-failure');}catch{}process.exitCode=1;}
finally{await fs.writeFile(path.join(output,'web-final-smoke.json'),JSON.stringify(result,null,2)+'\n');d.close();console.log(JSON.stringify(result,null,2));}
