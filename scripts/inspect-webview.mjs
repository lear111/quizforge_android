// Local debug utility; requires an adb-forwarded debug WebView, never bundled.
import fs from 'node:fs/promises';
const endpoint=process.env.QUIZFORGE_DEBUG_ENDPOINT||'http://127.0.0.1:9223';
const targets=await (await fetch(endpoint+'/json')).json();
const target=targets.find(t=>t.url?.includes('appassets.androidplatform.net/assets/web/index.html'));
if(!target)throw new Error('No QuizForge debug WebView target');
const expression=process.argv[2]?await fs.readFile(process.argv[2],'utf8'):`JSON.stringify({title:document.title,ready:document.readyState,body:document.body.innerText.slice(0,5000),native:typeof qfNative,app:typeof quizforgeApp,rect:document.body.getBoundingClientRect().toJSON(),html:document.documentElement.outerHTML.slice(0,1000)})`;
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
const reply=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Debug evaluation timeout')),45000);socket.onmessage=event=>{const value=JSON.parse(event.data);if(value.id===1){clearTimeout(timeout);resolve(value)}};socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true,userGesture:true}}));});
console.log(JSON.stringify(reply.result,null,2));socket.close();
