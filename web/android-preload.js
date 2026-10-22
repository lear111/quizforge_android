import {nativeCall} from './native.js';
import {installOfflineFetch} from './android-fetch.js';
import {createPracticeService} from './web-practice-service.js';
import {createLibraryService,ANDROID_UNAVAILABLE_SELECTORS} from './web-library-service.js';
import {bindAndroidLayoutNotifications} from './android-layout-events.js';
import {createExamService} from './exam-service.js';
import {createAiService} from './ai-service.js';
import {bindHubLinks} from './android-hub-links.js';

const loadText=async path=>{
  const response=await fetch('/assets/web/'+path);
  if(!response.ok)throw Error('离线题型组件不完整，请重新安装应用');
  return response.text();
};
const ai=createAiService(nativeCall);
const practice=createPracticeService(nativeCall,{loadText,examEnabled:true,aiService:ai,resourceContext:options=>window.quizforgeApp?.resourceContext(options)});
const exams=createExamService(nativeCall,{practice,loadText,resourceContext:options=>window.quizforgeApp?.resourceContext(options)});
installOfflineFetch({services:[ai,createLibraryService(nativeCall,{host:practice.domain.host,examEnabled:true,aiEnabled:true,networkEnabled:true}),exams,practice]});
bindAndroidLayoutNotifications();
document.documentElement.dataset.platform='android';

const notice=error=>{
  const node=document.getElementById('notice');
  if(node){node.textContent=error.message||String(error);node.hidden=false;}
};
let importing=false;
bindHubLinks({nativeCall,notice});

document.getElementById('library-download').addEventListener('click',async event=>{
  event.preventDefault();event.stopImmediatePropagation();
  try{
    const app=window.quizforgeApp;if(!app)throw Error('页面正在打开，请稍候再获取题库');
    await app.prepareNavigation();
    await nativeCall('hub.open');
  }catch(error){notice(error);}
},true);

async function acceptNativeImport(){
  const pending=window.quizforgeAndroidImported;
  if(!pending||!window.quizforgeApp)return;
  delete window.quizforgeAndroidImported;
  try{await window.quizforgeApp.openImportedBank(pending.id);notice({message:`已从题库广场导入「${pending.title||'题库'}」，可离线使用。`});}
  catch(error){notice(error);}
}
const acceptNativeNotice=()=>{if(window.quizforgeAndroidNotice){notice({message:window.quizforgeAndroidNotice});delete window.quizforgeAndroidNotice;}};
document.addEventListener('quizforge-android-imported',acceptNativeImport);
document.addEventListener('quizforge-android-notice',acceptNativeNotice);
document.addEventListener('quizforge-android-ready',()=>{acceptNativeImport();acceptNativeNotice();});
document.getElementById('library-import').addEventListener('click',async event=>{
  event.preventDefault();event.stopImmediatePropagation();
  if(importing)return;
  importing=true;
  try{
    if(!window.quizforgeApp)throw Error('页面正在打开，请稍候再导入');
    await window.quizforgeApp.prepareNavigation();
    const result=await nativeCall('import.pick');
    if(result.cancelled||!result.banks?.length)return;
    await window.quizforgeApp.openImportedBank(result.banks[0].id);
  }catch(error){notice(error);}finally{importing=false;}
},true);

// Keep the original settings button and appearance panel; host/network settings
// have no meaning in a self-contained offline Android app.
document.getElementById('network-settings-open').addEventListener('click',event=>{
  event.preventDefault();event.stopImmediatePropagation();
  const dialog=document.getElementById('network-settings-dialog');
  if(!dialog.open)dialog.showModal();
  document.getElementById('settings-appearance-tab').click();
},true);
const capabilities=document.createElement('style');
capabilities.dataset.androidCapabilities='';
capabilities.textContent=ANDROID_UNAVAILABLE_SELECTORS.filter(selector=>!['#exam-start','#exam-submit','#exam-status','#exam-return','#settings-ai-tab','#ai-settings-panel'].includes(selector)).join(',')+'{display:none!important}';
document.head.append(capabilities);

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden')window.quizforgeApp?.flush().catch(notice);
});
