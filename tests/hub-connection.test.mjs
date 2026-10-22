import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {createAiService} from '../web/ai-service.js';
import {bindHubLinks} from '../web/android-hub-links.js';
import {bindAiSettings} from '../vendor/quizforge-web/core/web/ai/ai-settings.js';
import {bindUserCenter} from '../vendor/quizforge-web/core/web/ai/user-center.js';
import {createHubLogin} from '../vendor/quizforge-web/core/web/ai/hub-login.js';

const AUTHORIZE='https://quizforge.treenewbee.cloud/connect/authorize?v=1&client=android&state=fake';
// A fake native host: the Hub account lives here, never in the page.
function fakeNative(){
  const calls=[];let connected=false,balance=12000,settings={useOfficial:false,useCustom:false,enabled:true,autoGrade:false,baseUrl:'',model:'',apiKeyConfigured:false,canManage:true,configurationVersion:'v1'};
  const summary=()=>connected?{connected:true,user:{name:'测试用户'},device:{name:'Pixel Tablet',client:'android'}}:{connected:false};
  const native=async(method,args={})=>{
    calls.push({method,args:structuredClone(args)});
    if(method==='settings.ai.get')return {...structuredClone(settings),hub:summary()};
    if(method==='settings.ai.update'){settings={...settings,...structuredClone(args.profile)};return structuredClone(settings);}
    if(method==='hub.connection.account')return connected?{...summary(),ai:{enabled:true,model:'fake',balance},manageUrl:'https://quizforge.treenewbee.cloud/manage/'}:{connected:false,manageUrl:'https://quizforge.treenewbee.cloud/manage/'};
    if(method==='hub.connection.login')return {authorizeUrl:AUTHORIZE};
    if(method==='hub.connection.logout'){connected=false;return summary();}
    if(method==='hub.connection.redeem'){if(!connected)throw Object.assign(Error('请先登录 QuizForge 账号。'),{code:'HUB_LOGIN_REQUIRED'});if(args.code!=='AI-GOOD')throw Object.assign(Error('兑换码无效、已使用或已过期。'),{code:'REDEEM_CODE_INVALID'});balance+=50000;return {added:50000,balance};}
    if(method==='hub.browse')return {opened:true};
    throw Error('unexpected '+method);
  };
  return {native,calls,get settings(){return settings;},connect(){connected=true;}};
}
// The Web page's request helper turns error JSON into thrown errors with code and message.
const requester=ai=>async(path,options={})=>{
  const body=options.body??null;
  try{const value=await ai.handle({path,method:options.method||'GET',body});if(value===undefined)throw Object.assign(Error('missing route'),{code:'NOT_FOUND',status:404});return structuredClone(value);}
  catch(error){throw Object.assign(Error(error.message),{code:error.code,status:error.status});}
};
async function page(){
  const markup=await fs.readFile(new URL('../vendor/quizforge-web/core/web/index.html',import.meta.url),'utf8');
  const dom=new JSDOM(markup,{url:'https://appassets.androidplatform.net/assets/web/index.html',pretendToBeVisual:true});
  const {document}=dom.window;
  for(const dialog of document.querySelectorAll('dialog')){dialog.showModal=function(){this.setAttribute('open','');};dialog.close=function(){this.removeAttribute('open');this.dispatchEvent(new dom.window.Event('close'));};}
  return dom;
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(check){for(let i=0;i<200;i++){if(await check())return;await settle();}throw Error('condition not reached');}

test('Hub settings REST routes reach only the native account calls and never carry a token',async()=>{
  const host=fakeNative(),ai=createAiService(host.native),request=requester(ai);
  assert.equal((await request('/api/settings/ai')).hub.connected,false);
  assert.deepEqual(await request('/api/settings/ai/hub/login',{method:'POST',body:'{}'}),{authorizeUrl:AUTHORIZE});
  host.connect();
  const account=await request('/api/settings/ai/hub');assert.equal(account.ai.balance,12000);assert.equal(account.manageUrl,'https://quizforge.treenewbee.cloud/manage/');
  assert.deepEqual(await request('/api/settings/ai/hub/redeem',{method:'POST',body:JSON.stringify({code:'AI-GOOD'})}),{added:50000,balance:62000});
  await assert.rejects(request('/api/settings/ai/hub/redeem',{method:'POST',body:JSON.stringify({code:'AI-BAD'})}),{code:'REDEEM_CODE_INVALID'});
  assert.equal((await request('/api/settings/ai/hub/logout',{method:'POST',body:'{}'})).connected,false);
  await assert.rejects(request('/api/settings/ai/hub/unknown',{method:'POST',body:'{}'}),{code:'NOT_FOUND'});
  assert.deepEqual(host.calls.filter(call=>call.method.startsWith('hub.')).map(call=>call.method),['hub.connection.login','hub.connection.account','hub.connection.redeem','hub.connection.redeem','hub.connection.logout']);
  assert.equal(JSON.stringify(host.calls).includes('qfd_'),false);
});

test('Hub pages from window.open and the login/manage links go to native Custom Tabs; other links are untouched',async()=>{
  const dom=await page(),{window}=dom,browsed=[],opened=[];
  window.open=(url)=>{opened.push(url);return null;};
  const unbind=bindHubLinks({nativeCall:async(method,args)=>{browsed.push([method,args.url]);return {opened:true};},target:window,document:window.document});
  assert.equal(window.open(AUTHORIZE,'_blank','noopener'),null);
  window.open('https://example.invalid/');
  const link=window.document.getElementById('hub-login-link');link.href=AUTHORIZE;
  const clicked=new window.MouseEvent('click',{bubbles:true,cancelable:true});link.dispatchEvent(clicked);
  assert.equal(clicked.defaultPrevented,true);
  const library=window.document.getElementById('library-download');const other=new window.MouseEvent('click',{bubbles:true,cancelable:true});library.dispatchEvent(other);
  window.open('https://quizforge.treenewbee.cloud.evil.invalid/connect');
  await settle();
  assert.deepEqual(browsed,[['hub.browse',AUTHORIZE],['hub.browse',AUTHORIZE]]);
  assert.deepEqual(opened,['https://example.invalid/','https://quizforge.treenewbee.cloud.evil.invalid/connect']);
  unbind();
});

test('reused Web AI settings: choosing the free quota logs in through Custom Tabs, then saves useOfficial',async()=>{
  const dom=await page(),{window}=dom,{document}=window,host=fakeNative(),ai=createAiService(host.native),request=requester(ai);
  bindHubLinks({nativeCall:host.native,target:window,document});
  const timers=[];const login=createHubLogin({request,document,openWindow:url=>window.open(url,'_blank','noopener'),setTimer:(fn)=>{timers.push(fn);return timers.length;},clearTimer:()=>{}});
  const settings=bindAiSettings({request,document,login});bindUserCenter({request,login,document});
  document.getElementById('network-settings-dialog').showModal();
  await settings.open();
  assert.equal(document.getElementById('ai-settings-points').textContent,'未登录');
  const official=document.getElementById('ai-settings-useOfficial');official.checked=true;official.dispatchEvent(new window.Event('change'));
  await until(()=>host.calls.some(call=>call.method==='hub.browse'));
  assert.equal(host.calls.find(call=>call.method==='hub.browse').args.url,AUTHORIZE);
  assert.ok(document.getElementById('hub-login-dialog').hasAttribute('open'));
  // The deep link lands natively; the dialog's poll then sees the account.
  host.connect();await timers.shift()();
  await until(()=>host.settings.useOfficial===true);
  await until(()=>!document.getElementById('hub-login-dialog').hasAttribute('open'));
  assert.equal(host.calls.filter(call=>call.method==='settings.ai.update').at(-1).args.profile.useOfficial,true);
  await until(()=>document.getElementById('ai-settings-points').textContent==='剩余 ¥1.20');
});

test('reused Web user center shows balance, redeems and logs out through the native account',async()=>{
  const dom=await page(),{window}=dom,{document}=window,host=fakeNative(),ai=createAiService(host.native),request=requester(ai);host.connect();
  const login=createHubLogin({request,document,openWindow:()=>null,setTimer:()=>0,clearTimer:()=>{}});
  const center=bindUserCenter({request,login,document});
  document.getElementById('network-settings-dialog').showModal();
  await center.open();
  assert.equal(document.getElementById('user-center-name').textContent,'测试用户');
  assert.equal(document.getElementById('user-center-points').textContent,'¥1.20');
  document.getElementById('user-center-code').value='AI-GOOD';
  document.getElementById('user-center-redeem').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await until(()=>document.getElementById('user-center-points').textContent==='¥6.20');
  document.getElementById('user-center-logout').click();
  await until(()=>!document.getElementById('user-center-guest').hidden);
  assert.equal(host.calls.at(-1).method,'hub.connection.logout');
});

