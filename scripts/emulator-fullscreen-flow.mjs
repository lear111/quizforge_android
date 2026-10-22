// Draft fullscreen acceptance on the task's dedicated Android 15 AVD only.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {connect} from './webview-driver.mjs';
const serial='emulator-5580',pkg='cloud.treenewbee.quizforge.android.debug';
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8',timeout:45000}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,label,timeout=60000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await read();if(value)return value;}catch(e){last=e;}await delay(300);}throw Error(label+(last?': '+last.message:''));}
assert.match(adb('emu','avd','name'),/^QuizForge_Android15_Tablet/);
await until(()=>adb('shell','getprop','sys.boot_completed')==='1','Dedicated AVD did not boot',120000);
assert.equal(adb('shell','getprop','ro.build.version.release'),'15');
adb('shell','am','start','-n',pkg+'/cloud.treenewbee.quizforge.android.MainActivity');
const pid=await until(()=>adb('shell','pidof',pkg),'App process unavailable');adb('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid);
let d=await until(()=>connect(),'WebView unavailable');
const evaluate=s=>d.evaluate(s),output=path.resolve('output/acceptance');await fs.mkdir(output,{recursive:true});
const before=process.argv.includes('--before'),name=before?'fullscreen-before':'fullscreen-flow';
const result={android:'15',avd:'QuizForge_Android15_Tablet',checks:[]};
function bars(){const lines=adb('shell','dumpsys','window').split('\n');const parse=type=>{const l=lines.find(l=>l.includes('type='+type+' frame='));return l?{visible:/visible=true/.test(l),frame:l.match(/frame=(\[[^ ]+)/)?.[1]}:null;};return {status:parse('statusBars'),navigation:parse('navigationBars')};}
const metrics=()=>evaluate(`(()=>{const b=document.querySelector('.question-pane:not([hidden]) [data-action="fullscreen"]');return {supported:document.fullscreenEnabled,requestFullscreen:typeof document.documentElement.requestFullscreen,exitFullscreen:typeof document.exitFullscreen,active:document.fullscreenElement===document.documentElement,width:innerWidth,height:innerHeight,visualHeight:visualViewport.height,scrollWidth:document.body.scrollWidth,draft:document.getElementById('draft-toggle').getAttribute('aria-pressed'),button:b?{hidden:b.hidden,display:getComputedStyle(b).display,label:b.getAttribute('aria-label'),pressed:b.getAttribute('aria-pressed')}:null,error:document.querySelector('.question-error')?.innerText||null,notice:document.getElementById('notice')?.hidden?null:document.getElementById('notice')?.innerText||null}})()`);
async function click(selector){await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled||b.hidden)throw Error('Control unavailable: '+${JSON.stringify(selector)});b.click();return true})()`);}
async function shot(n){await delay(700);const remote='/sdcard/qf-'+n+'.png';adb('shell','screencap','-p',remote);adb('pull',remote,path.join(output,n+'.png'));}
async function waitMode(active){await until(async()=>{const m=await metrics();return m.active===active&&m.button?.pressed===String(active)?m:null;},'Original fullscreen state did not become '+active);await delay(400);}
try{
 await until(()=>evaluate(`!!window.quizforgeApp&&!!document.querySelector('#library-list .library-item')`),'Original library not ready');
 if(!await evaluate(`!!document.querySelector('#outline-list [data-question-id="offline-demo-1"]')`))await click('#library-list .library-item');
 await until(()=>evaluate(`!!window.quizforgeApp&&!!document.querySelector('#outline-list [data-question-id="offline-demo-1"]')`),'Original Web UI not ready',180000);
 if(await evaluate(`document.getElementById('draft-toggle').getAttribute('aria-pressed')!=='true'`)){await click('#draft-toggle');await evaluate('window.quizforgeApp.flush().then(()=>true)');}
 await until(()=>evaluate(`!document.getElementById('draft-toggle').disabled`),'Draft not ready');
 if(!before&&await evaluate(`!!document.fullscreenElement`)){await click('.question-pane:not([hidden]) [data-action="fullscreen"]');await waitMode(false);}
 result.initial={...await metrics(),nativeBars:bars()};
 if(before){await shot(name);result.diagnosed=true;}
 else{
  assert.equal(result.initial.supported,true);assert.equal(result.initial.button?.hidden,false);assert.notEqual(result.initial.button?.display,'none');
  const selector='.question-pane:not([hidden]) [data-action="fullscreen"]';
  await click(selector);await waitMode(true);result.enter={...await metrics(),nativeBars:bars()};assert.ok(result.enter.height>result.initial.height,'Fullscreen did not expand the Web viewport');assert.equal(result.enter.nativeBars.status.visible,false);assert.equal(result.enter.nativeBars.navigation.visible,false);assert.equal(result.enter.width,result.enter.scrollWidth);await shot('fullscreen-enter');result.checks.push('original whiteboard fullscreen button is visible and enters HTML fullscreen with immersive system bars');
  await click(selector);await waitMode(false);result.toolbarExit={...await metrics(),nativeBars:bars()};assert.equal(result.toolbarExit.nativeBars.status.visible,true);assert.equal(result.toolbarExit.nativeBars.navigation.visible,true);result.checks.push('same original toolbar control exits fullscreen and restores system bars');
  await click(selector);await waitMode(true);adb('shell','input','keyevent','4');await waitMode(false);assert.equal(adb('shell','pidof',pkg),pid);const windowFocus=adb('shell','dumpsys','window').split('\n').find(l=>l.includes('mCurrentFocus='));assert.ok(windowFocus?.includes(pkg),'Android Back left the QuizForge activity');result.hardwareBack={...await metrics(),nativeBars:bars(),sameProcess:true,windowFocus:windowFocus.trim()};result.checks.push('Android hardware Back exits fullscreen while keeping the same app process, visible activity and page open');
  await click(selector);await waitMode(true);await click('#draft-toggle');await until(()=>evaluate(`!document.fullscreenElement&&document.getElementById('draft-toggle').getAttribute('aria-pressed')==='false'`),'Leaving draft did not exit fullscreen');result.leaveDraft={...await metrics(),nativeBars:bars()};assert.equal(result.leaveDraft.nativeBars.status.visible,true);assert.equal(result.leaveDraft.nativeBars.navigation.visible,true);assert.equal(result.leaveDraft.error,null);await shot('fullscreen-exit');result.checks.push('leaving original draft mode restores normal page and system bars');
  result.apkSha256=createHash('sha256').update(await fs.readFile('output/QuizForge-Android-0.1.0-preview.apk')).digest('hex');result.passed=true;
 }
}catch(error){result.passed=false;result.error=error.stack;try{result.failure=await metrics();await shot(name+'-failure');}catch{}process.exitCode=1;}
finally{await fs.writeFile(path.join(output,name+'.json'),JSON.stringify(result,null,2)+'\n');d.close();console.log(JSON.stringify(result,null,2));}
