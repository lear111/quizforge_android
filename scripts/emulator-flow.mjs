// Explicit acceptance flow against the task's dedicated synthetic-data emulator.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {connect} from './webview-driver.mjs';
const serial='emulator-5580',pkg='cloud.treenewbee.quizforge.android.debug';
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8',timeout:45000}).trim();
if(!adb('emu','avd','name').startsWith('QuizForge_Android15_Tablet'))throw new Error('This flow requires the dedicated QuizForge test AVD.');
const output=path.resolve('output','acceptance');await fs.mkdir(output,{recursive:true});
const check=(condition,message)=>{if(!condition)throw new Error(message);};
async function until(fn,message,timeout=60000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){last=e;}await new Promise(r=>setTimeout(r,400));}throw new Error(message+(last?': '+last.message:''));}
async function attach(){
 const pid=await until(()=>{try{return adb('shell','pidof',pkg).split(' ')[0]||null;}catch{return null;}},'App process did not start');adb('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid);
 return until(async()=>{const d=await connect();try{if(await d.evaluate(`typeof window.quizforgeApp==='object' && !!document.querySelector('.question-frame')`))return d;}catch{}d.close();},'App did not load a question');
}
async function iframeContext(d){await d.send('Runtime.disable');await d.send('Runtime.enable');for(const [id,ctx] of d.contexts){if(ctx.auxData?.isDefault&&await d.evaluate(`!!document.querySelector('input[type=radio]')`,id).catch(()=>false))return id;}throw new Error('No single-choice iframe');}
async function image(name){const remote='/sdcard/qf-acceptance-'+name+'.png';adb('shell','screencap','-p',remote);adb('pull',remote,path.join(output,name+'.png'));}
const results={android:adb('shell','getprop','ro.build.version.release'),avd:'QuizForge_Android15_Tablet',checks:[]};
adb('shell','cmd','connectivity','airplane-mode','enable');check(adb('shell','settings','get','global','airplane_mode_on')==='1','Airplane mode not enabled');
adb('shell','am','start','-n',pkg+'/cloud.treenewbee.quizforge.android.MainActivity');
let d=await attach();
const main=await d.evaluate(`JSON.stringify({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,error:document.getElementById('error-banner')?.hidden===false,frame:document.querySelector('iframe')?.sandbox.toString()})`);
check(!JSON.parse(main).overflow,'Landscape overflow');check(!JSON.parse(main).error,'Startup error banner');
results.landscape=JSON.parse(main);await image('landscape');
const ctx=await until(()=>iframeContext(d),'No ready single-choice iframe');
const before=await d.evaluate(`JSON.stringify({radios:[...document.querySelectorAll('input[type=radio]')].map(x=>({value:x.value,checked:x.checked})),buttons:[...document.querySelectorAll('button')].map(x=>({id:x.id,text:x.textContent}))})`,ctx);
results.question=JSON.parse(before);check(results.question.radios.length>=2,'Expected original choice controls');
await d.evaluate(`document.querySelectorAll('input[type=radio]')[1].click(); 'selected'`,ctx);
await d.evaluate(`window.quizforgeApp.flush().then(()=>true)`);
let persisted=await d.evaluate(`(async()=>{const {nativeCall}=await import('./native.js');const banks=await nativeCall('library.list');const state=await nativeCall('state.read',{bankId:banks[0].id});return JSON.stringify(state)})()`);
let saved=JSON.parse(persisted);check(saved.questions['offline-demo-1']?.answer?.selectedOptionId===results.question.radios[1].value,'Selected answer was not durably saved');
results.checks.push('airplane-mode answering and confirmed native save');
d.close();adb('shell','am','force-stop',pkg);adb('shell','am','start','-n',pkg+'/cloud.treenewbee.quizforge.android.MainActivity');
d=await attach();const restoredContext=await until(()=>iframeContext(d),'No restored single-choice iframe');
check(await d.evaluate(`document.querySelectorAll('input[type=radio]')[1].checked`,restoredContext),'Selected answer did not recover after process restart');
results.checks.push('force-stop/restart answer recovery');
await d.evaluate(`(async()=>{const {nativeCall}=await import('./native.js');const banks=await nativeCall('library.list');return (await nativeCall('state.read',{bankId:banks[0].id})).revision})()`);
const submit=await d.evaluate(`JSON.stringify([...document.querySelectorAll('button')].map(x=>({id:x.id,text:x.textContent})))`,restoredContext);results.submitControls=JSON.parse(submit);
await d.evaluate(`(()=>{const button=[...document.querySelectorAll('button')].find(x=>/提交/.test(x.textContent));if(!button)throw Error('Submit not found');button.click();return true})()`,restoredContext);
await until(async()=>{const value=JSON.parse(await d.evaluate(`(async()=>{const {nativeCall}=await import('./native.js');const banks=await nativeCall('library.list');return JSON.stringify(await nativeCall('state.read',{bankId:banks[0].id}))})()`));return value.questions['offline-demo-1']?.status==='submitted'?value:null;},'Submit was not persisted');
results.checks.push('original extension submit and local grading');
await d.evaluate(`window.quizforgeApp.flush().then(()=>true)`);await image('landscape-submitted');
adb('shell','settings','put','system','accelerometer_rotation','0');adb('shell','settings','put','system','user_rotation','1');
await until(async()=>await d.evaluate(`innerWidth<innerHeight`),'Portrait rotation did not resize the app');
check(!await d.evaluate(`document.documentElement.scrollWidth>innerWidth`),'Portrait overflow');
results.portrait=await d.evaluate(`({width:innerWidth,height:innerHeight})`);await image('portrait');results.checks.push('portrait resize without horizontal overflow');
adb('shell','settings','put','system','user_rotation','0');d.close();
await fs.writeFile(path.join(output,'emulator-flow.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
