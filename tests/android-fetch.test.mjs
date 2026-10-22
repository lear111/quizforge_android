import test from 'node:test';
import assert from 'node:assert/strict';
import {installOfflineFetch} from '../web/android-fetch.js';

test('original Web API receives direct JSON, errors, binary images and static fallback',async()=>{
  const seen=[];const target={fetch:async url=>new Response('static:'+url)};
  const restore=installOfflineFetch({origin:'https://appassets.androidplatform.net',target,fetch:target.fetch,services:[{handle:async r=>{
    seen.push(r);
    if(r.path==='/api/example')return {state:{revision:2},answer:r.body};
    if(r.path==='/api/image')return {__qfBinary:true,mime:'image/png',data:'AQID'};
    if(r.path==='/api/conflict')throw Object.assign(Error('保存版本冲突'),{code:'REVISION_CONFLICT',status:409});
  }}]});
  const response=await target.fetch('/api/example',{method:'POST',headers:{'X-QuizForge-Transient-Resource':'true'},body:JSON.stringify({text:'中文'})});
  assert.deepEqual(await response.json(),{state:{revision:2},answer:{text:'中文'}});
  assert.equal(seen[0].headers['x-quizforge-transient-resource'],'true');
  const conflict=await target.fetch('/api/conflict');assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.code,'REVISION_CONFLICT');
  const image=await target.fetch('/api/image');assert.equal((await image.blob()).type,'image/png');
  assert.deepEqual([...new Uint8Array(await (await target.fetch('/api/image')).arrayBuffer())],[1,2,3]);
  assert.equal(await(await target.fetch('/shell/app.css')).text(),'static:/shell/app.css');
  assert.equal((await target.fetch('/api/unimplemented')).status,501);
  restore();
});

test('transport handles Request objects and rejects an already aborted request',async()=>{
  const target={fetch:async()=>{throw Error('No network for APIs');}};
  installOfflineFetch({origin:'https://appassets.androidplatform.net',target,fetch:target.fetch,services:[{handle:async r=>({method:r.method,body:r.body})}]});
  const response=await target.fetch(new Request('https://appassets.androidplatform.net/api/test',{method:'POST',body:'{"answer":42}'}));
  assert.deepEqual(await response.json(),{method:'POST',body:{answer:42}});
  await assert.rejects(target.fetch('/api/test',{signal:AbortSignal.abort()}),{name:'AbortError'});
});

test('aborting a wait does not cancel an accepted local write',async()=>{
  let release;let saved=false;const gate=new Promise(resolve=>{release=resolve;});
  const target={fetch:async()=>{throw Error('No network');}};
  installOfflineFetch({origin:'https://appassets.androidplatform.net',target,fetch:target.fetch,services:[{handle:async()=>{await gate;saved=true;return {revision:1};}}]});
  const controller=new AbortController();const waiting=target.fetch('/api/write',{method:'POST',signal:controller.signal});
  controller.abort();await assert.rejects(waiting,{name:'AbortError'});
  release();await gate;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(saved,true);
});
