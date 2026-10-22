// Debug-only Android WebView driver. Run after an adb localabstract forward.
export async function connect(endpoint='http://127.0.0.1:9223'){
 const pages=await(await fetch(endpoint+'/json')).json(),page=pages.find(p=>p.url?.includes('appassets.androidplatform.net/assets/web/index.html'));
 if(!page)throw new Error('QuizForge WebView has not started');
 const socket=new WebSocket(page.webSocketDebuggerUrl),pending=new Map(),contexts=new Map();let id=0;
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 socket.onmessage=event=>{const item=JSON.parse(event.data);if(item.method==='Runtime.executionContextCreated')contexts.set(item.params.context.id,item.params.context);if(item.method==='Runtime.executionContextDestroyed')contexts.delete(item.params.executionContextId);if(item.id&&pending.has(item.id)){const record=pending.get(item.id);pending.delete(item.id);clearTimeout(record.timeout);item.error?record.reject(new Error(item.error.message)):record.resolve(item.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timeout=setTimeout(()=>{pending.delete(key);reject(new Error('Debug request timed out: '+method));},60000);pending.set(key,{resolve,reject,timeout});socket.send(JSON.stringify({id:key,method,params}));});
 await send('Runtime.enable');
 const evaluate=async(expression,contextId)=>{const result=await send('Runtime.evaluate',{expression,contextId,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
 return {send,evaluate,contexts,close:()=>socket.close()};
}

// Diagnostics share the already-installed native client instead of importing a
// second client and replacing its reply handler. Use only on the dedicated AVD.
export async function nativeDiagnostic(driver,method,args={},project=value=>value){
 return driver.evaluate(`new Promise((resolve,reject)=>{
  const bridge=globalThis.qfNative;if(!bridge){reject(Error('Native bridge unavailable'));return;}
  const id='acceptance-'+crypto.randomUUID(),previous=bridge.onmessage;
  const restore=()=>{if(bridge.onmessage===listener)bridge.onmessage=previous;};
  const listener=event=>{
   let value;try{value=typeof event.data==='string'?JSON.parse(event.data):event.data;}catch{previous?.call(bridge,event);return;}
   if(value?.id!==id){previous?.call(bridge,event);return;}
   clearTimeout(timer);restore();
   if(value.ok){try{resolve((${project.toString()})(value.data));}catch(error){reject(error);}}else reject(Object.assign(Error(value.error?.message||'Native diagnostic failed'),{code:value.error?.code}));
  };
  const timer=setTimeout(()=>{restore();reject(Error('Native diagnostic timeout'));},60000);
  bridge.onmessage=listener;
  try{bridge.postMessage(JSON.stringify({id,method:${JSON.stringify(method)},args:${JSON.stringify(args)}}));}catch(error){clearTimeout(timer);restore();reject(error);}
 })`);
}

if(process.argv[1]?.endsWith('webview-driver.mjs')){
 const driver=await connect();const records=[];
 for(const [id,context] of driver.contexts){try{records.push({id,frame:context.auxData?.frameId,origin:context.origin,description:await driver.evaluate(`JSON.stringify({body:document.body?.innerText?.slice(0,2000),buttons:[...document.querySelectorAll('button')].map(x=>({id:x.id,text:x.innerText,action:x.dataset.qfAction})),radios:[...document.querySelectorAll('input[type=radio]')].map(x=>({value:x.value,checked:x.checked})),frames:document.querySelectorAll('iframe').length})`,id)})}catch(e){records.push({id,error:e.message})}}
 console.log(JSON.stringify(records,null,2));driver.close();
}
