// Hub login UI, AI settings and free-quota grading on the dedicated AVD.
// No real Hub account, password, authorization code or device token is used:
// deep links carry forged or denied results, and grading runs without a login.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {connect,nativeDiagnostic} from './webview-driver.mjs';
const serial='emulator-5580',pkg='cloud.treenewbee.quizforge.android.debug',activity=pkg+'/cloud.treenewbee.quizforge.android.MainActivity';
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8',timeout:120000}).trim();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,label,timeout=90000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await read();if(value)return value;}catch(error){last=error;}await delay(250);}throw Error(label+(last?': '+last.message:''));}
assert.match(adb('emu','avd','name'),/^QuizForge_Android15_Tablet/);
const apk=path.resolve('output/QuizForge-Android-0.1.0-preview.apk'),apkSha256=createHash('sha256').update(await fs.readFile(apk)).digest('hex');
const output=path.resolve('output/acceptance/hub-ai-20261022');await fs.mkdir(output,{recursive:true});
const result={apkSha256,avd:'QuizForge_Android15_Tablet',android:'15',evidence:'emulator; original Web controls driven through CDP clicks, deep links through adb am start; no real Hub account, code or token',checks:[]};
let stage='install',d;
async function shot(name){await delay(700);const remote='/sdcard/qf-'+name+'.png';adb('shell','screencap','-p',remote);adb('pull',remote,path.join(output,name+'.png'));}
function top(){return adb('shell','dumpsys','activity','activities').split('\n').find(line=>/topResumedActivity|mResumedActivity|ResumedActivity:/.test(line))||'';}
const deepLink=url=>adb('shell',`am start -W -a android.intent.action.VIEW -d '${url}' ${pkg}`);
const hubFile=()=>{try{return adb('shell','run-as',pkg,'ls','files').split(/\s+/).includes('hub-connection.enc');}catch{return false;}};
try{
 result.install=adb('install','-r',apk);
 adb('shell','am','force-stop',pkg);adb('shell','am','start','-n',activity);
 const pid=await until(()=>adb('shell','pidof',pkg),'App process unavailable');adb('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid);
 d=await until(()=>connect(),'WebView unavailable');
 const evaluate=value=>d.evaluate(value),native=(method,args,project)=>nativeDiagnostic(d,method,args,project);
 const click=selector=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw Error('Unavailable: '+${JSON.stringify(selector)});node.click();return true})()`);
 const visible=selector=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});return !!node&&!node.hidden&&getComputedStyle(node).display!=='none'&&node.getClientRects().length>0})()`);
 const text=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent??null`);
 const put=body=>evaluate(`fetch('/api/settings/ai',{method:'PUT',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(r=>r.json())`);
 await until(()=>evaluate('!!window.quizforgeApp'),'App page unavailable');
 const original=await native('settings.ai.get',{});result.originalSettings={enabled:original.enabled,useOfficial:original.useOfficial,useCustom:original.useCustom,apiKeyConfigured:original.apiKeyConfigured,hub:original.hub};
 assert.equal(original.hub.connected,false,'Run on an AVD that is not logged in');assert.equal(hubFile(),false);
 if(!original.enabled)await put({enabled:true});

 stage='settings';
 await click('#network-settings-open');await until(()=>evaluate(`document.getElementById('network-settings-dialog').open`),'Settings dialog');
 assert.equal(await visible('#settings-ai-tab'),true);assert.equal(await visible('#settings-user-tab'),true);assert.equal(await visible('#settings-network-tab'),false);
 await click('#settings-ai-tab');await until(async()=>!(await text('#ai-settings-status')).includes('正在读取'),'AI settings load');
 assert.equal(await text('#ai-settings-points'),'未登录');assert.equal(await visible('#ai-settings-options'),true);
 for(const id of ['useOfficial','useCustom'])assert.equal(await visible('#ai-settings-'+id),true);
 await shot('settings-ai');result.checks.push('reused Web AI settings show the switch, 使用免费 AI 额度 (未登录) and 使用自定义模型 sources; network tab stays hidden');

 stage='login-dialog';
 await click('#ai-settings-useOfficial');
 await until(()=>evaluate(`document.getElementById('hub-login-dialog').open`),'Login dialog');
 const authorize=new URL(await until(()=>evaluate(`document.getElementById('hub-login-link').href||null`),'Authorize URL'));
 assert.equal(authorize.origin,'https://quizforge.treenewbee.cloud');assert.equal(authorize.pathname,'/connect/authorize');
 assert.equal(authorize.searchParams.get('client'),'android');assert.equal(authorize.searchParams.get('redirect_uri'),'quizforge://hub/connect');assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
 const browser=await until(()=>{const line=top();return line&&!line.includes(pkg)?line:null;},'Custom Tab did not open',30000);
 result.customTab=browser.trim();await shot('custom-tab');
 result.checks.push('choosing 使用免费 AI 额度 opens the Web login dialog and a system browser tab (not the app WebView) at the fixed authorize URL with client=android, the fixed redirect and S256');

 stage='forged-callback';
 deepLink('quizforge://hub/connect?code='+'c'.repeat(43)+'&state=forged-state');
 await until(()=>top().includes(pkg),'App did not return for the callback');await delay(1500);
 assert.equal((await native('settings.ai.get',{})).hub.connected,false);assert.equal(hubFile(),false);
 assert.equal(await evaluate(`document.getElementById('hub-login-dialog').open`),true);await shot('forged-callback');
 result.checks.push('a callback with a forged state returns to the app and saves nothing; the login dialog keeps waiting');

 stage='denied-callback';
 deepLink('quizforge://hub/connect?error=access_denied&state='+authorize.searchParams.get('state'));
 await delay(1500);assert.equal((await native('settings.ai.get',{})).hub.connected,false);assert.equal(hubFile(),false);
 result.checks.push('a denied callback with the real state is consumed without a token exchange or saved login');
 await click('#hub-login-cancel');
 await until(()=>evaluate(`!document.getElementById('hub-login-dialog').open&&!document.getElementById('ai-settings-useOfficial').checked`),'Cancel did not withdraw the choice');
 assert.equal(await text('#ai-settings-status'),'没有登录，未开启免费 AI 额度。');assert.equal((await native('settings.ai.get',{})).useOfficial,original.useOfficial);
 await shot('login-cancelled');result.checks.push('cancelling the login dialog withdraws 使用免费 AI 额度 and leaves the saved settings unchanged');

 stage='user-center';
 await click('#settings-user-tab');await until(()=>visible('#user-center-guest'),'User center guest view');
 assert.equal(await visible('#user-center-login'),true);await shot('user-center-guest');
 result.checks.push('用户中心 tab shows the logged-out explanation and login button');
 await evaluate(`document.getElementById('network-settings-dialog').close();true`);

 stage='grading';
 const input={protocolVersion:1,maxScore:5,scoreStep:0.5,question:[{type:'text',text:'fictional question'}],answer:[{type:'text',text:'fictional answer'}],referenceAnswer:[{type:'text',text:'fictional reference'}]};
 const bankId=(await native('library.list',{},value=>value.map(bank=>bank.id)))[0];
 const saved=await put({enabled:true,useOfficial:true});assert.equal(saved.useOfficial,true);
 // CDP keeps only the rejection message, so the native code is identified by its fixed text.
 const loginFailure=await native('ai.request',{bankId,input}).then(()=>null,error=>({message:error.message}));
 assert.match(loginFailure?.message||'',/免费 AI 额度需要登录/);result.freeQuotaOnly=loginFailure;
 result.checks.push('grading with only the free quota and no login stops natively with AI_OFFICIAL_LOGIN before any model request');
 if(!original.apiKeyConfigured&&!original.baseUrl){
  await put({useCustom:true,baseUrl:'https://model.invalid/v1',model:'fictional-model',clearApiKey:true});
  const fallback=await native('ai.request',{bankId,input}).then(()=>null,error=>({message:error.message}));
  assert.match(fallback?.message||'',/无法完成模型请求/);result.bothSourcesWithoutLogin=fallback;
  result.checks.push('with both sources on and no login, grading skips the free quota and goes to the custom model (an unreachable fictional host, so AI_NETWORK)');
 }
 stage='restore';
 await put({enabled:original.enabled,useOfficial:original.useOfficial,useCustom:original.useCustom,baseUrl:original.baseUrl,model:original.model,autoGrade:original.autoGrade,...(original.apiKeyConfigured?{}:{clearApiKey:true})});
 const restored=await native('settings.ai.get',{});for(const key of ['enabled','useOfficial','useCustom','baseUrl','model','autoGrade'])assert.equal(restored[key],original[key],key);
 result.checks.push('AI settings restored to their values before the flow');
 result.passed=true;
}catch(error){result.passed=false;result.stage=stage;result.error=error.stack;try{await shot('failure');}catch{}process.exitCode=1;}
finally{await fs.writeFile(path.join(output,'emulator-hub-ai-flow.json'),JSON.stringify(result,null,2)+'\n');d?.close();console.log(JSON.stringify(result,null,2));}
