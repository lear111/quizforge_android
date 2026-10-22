import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {answerAreaModel} from '../vendor/quizforge-web/core/shared/answer-area/1.4.0/model.js';

// Execute the exact packaged renderer with a canvas adapter. This checks actual
// pixels but is not Android WebView/font/camera/device acceptance.
const webRequire=createRequire(new URL('../../quizforge_web/core/package.json',import.meta.url));
let canvasLibrary;
try{canvasLibrary=webRequire('@napi-rs/canvas');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
const {createCanvas,loadImage,ImageData}=canvasLibrary||{};
const optionalWebOracle={skip:canvasLibrary?false:'The optional Web canvas pixel oracle is unavailable; run native renderer acceptance separately.'};
async function fixture(){
 const pending=new Map();let sequence=0;
 const context=vm.createContext({answerAreaModel,Blob,Uint8Array,Uint8ClampedArray,ImageData,atob,btoa,console,
  document:{createElement(tag){assert.equal(tag,'canvas');const canvas=createCanvas(1,1);canvas.toBlob=callback=>callback(new Blob([canvas.toBuffer('image/png')],{type:'image/png'}));return canvas;}},
  createImageBitmap:async blob=>{const image=await loadImage(Buffer.from(await blob.arrayBuffer()));image.close=()=>{};return image;},
  qfAnswerRenderer:{postMessage(raw){const reply=JSON.parse(raw);if(reply.type==='ready')return;const value=pending.get(reply.requestId);assert.ok(value);pending.delete(reply.requestId);reply.ok?value.resolve(reply.result):value.reject(Object.assign(Error(reply.error.message),{code:reply.error.code}));}},
 });context.window=context;
 const source=await fs.readFile(new URL('../app/src/main/assets/answer-area-renderer.js',import.meta.url),'utf8');
 assert.ok(source.includes("import {answerAreaModel} from '/assets/web/vendor/shared/answer-area/1.4.0/model.js';"));
 new vm.Script(source.replace(/^import .+;\r?\n/m,'')).runInContext(context);
 const command=(jobId,action,extra={})=>new Promise((resolve,reject)=>{const requestId=String(++sequence);pending.set(requestId,{resolve,reject});context.__qfAnswerRenderCommand({jobId,action,requestId,...extra});});
 return {command,discard:id=>context.__qfDiscardAnswerRender(id)};
}
const stroke={id:'s1',color:'#123456',width:8,points:[{x:80,y:1600,pressure:1}]};
const doc=extra=>({type:'qf-answer-area',formatVersion:1,id:'response',width:160,height:1800,strokes:[structuredClone(stroke)],...extra});
async function render(f,document,remainingWork=8000000){const job=crypto.randomUUID();await f.command(job,'begin',{document,remainingWork});return f.command(job,'render');}
async function pixels(result){const image=await loadImage(Buffer.from(result.data,'base64')),canvas=createCanvas(result.width,result.height),context=canvas.getContext('2d');context.drawImage(image,0,0);return context.getImageData(0,0,canvas.width,canvas.height).data;}

test('packed shared-ink renderer covers offscreen ink, white background and identical Web model pixels',optionalWebOracle,async()=>{
 const f=await fixture(),document=doc({inkSource:'draft'}),result=await render(f,document),actual=await pixels(result);
 assert.equal(result.width,320);assert.equal(result.height,3600);assert.equal(result.usedWork,16);
 const canvas=createCanvas(320,3600),context=canvas.getContext('2d');context.scale(2,2);answerAreaModel().paint(context,document);
 assert.deepEqual(actual,context.getImageData(0,0,320,3600).data);assert.deepEqual([...actual.subarray((3200*320+160)*4,(3200*320+160)*4+4)],[18,52,86,255]);
});
test('legacy ink remains pixel-identical to the original Web software rasterizer',optionalWebOracle,async()=>{
 const {renderAnswerArea}=await import('../../quizforge_web/core/server/host/practice/answer-areas.js');
 const f=await fixture(),document=doc();document.strokes[0].points.unshift({x:25,y:1530,pressure:.2},{x:60,y:1570,pressure:.7});
 const result=await render(f,document),expected=renderAnswerArea(document);
 assert.equal(result.width,160);assert.equal(result.height,1800);
 assert.deepEqual(await pixels(result),await pixels({data:expected.toString('base64'),width:160,height:1800}));
});
test('legacy text plus ink is rendered at two-times scale with the shared text layout',optionalWebOracle,async()=>{
 const f=await fixture(),document=doc({text:'中文 typed answer'}),result=await render(f,document);
 assert.equal(result.width,320);assert.equal(result.height,3600);const actual=await pixels(result),canvas=createCanvas(320,3600),context=canvas.getContext('2d');context.scale(2,2);answerAreaModel().paint(context,document);
 assert.deepEqual(actual,context.getImageData(0,0,320,3600).data);
});
test('offscreen pictures decode completely and are below text and shared answer ink',optionalWebOracle,async()=>{
 const f=await fixture(),source=createCanvas(20,10),context=source.getContext('2d');context.fillStyle='#ff0000';context.fillRect(0,0,20,10);
 const id='a'.repeat(64),job='image',document=doc({inkSource:'draft',images:[{type:'image',id:'photo',attrs:{assetId:id},x:20,y:1400,width:100,height:50}]});
 await f.command(job,'begin',{document,remainingWork:8000000});const size=await f.command(job,'image',{assetId:id,mime:'image/png',data:source.toBuffer('image/png').toString('base64')});assert.equal(size.width,20);assert.equal(size.height,10);
 const result=await f.command(job,'render'),actual=await pixels(result),at=(2850*320+100)*4;assert.deepEqual([...actual.subarray(at,at+4)],[255,0,0,255]);
});
test('overflow, render limits, corrupted/missing images and discarded jobs reject rather than return partial output',optionalWebOracle,async()=>{
 const f=await fixture();await assert.rejects(render(f,doc({text:'line\n'.repeat(40),height:120,strokes:[]})),{code:'ANSWER_AREA_TEXT_OVERFLOW'});
 await assert.rejects(render(f,doc({inkSource:'draft'}),0),{code:'ANSWER_AREA_RENDER_LIMIT'});
 const id='a'.repeat(64),document=doc({images:[{type:'image',id:'broken',attrs:{assetId:id},x:0,y:0,width:100,height:100}]});
 await f.command('bad','begin',{document,remainingWork:8000000});await assert.rejects(f.command('bad','render'),{code:'ANSWER_IMAGE_UNAVAILABLE'});
 await assert.rejects(f.command('bad','image',{assetId:id,mime:'image/png',data:btoa('broken image')}));f.discard('bad');await assert.rejects(f.command('bad','render'),{code:'ANSWER_AREA_JOB_EXPIRED'});
 assert.equal((await render(f,doc({inkSource:'draft'}))).mime,'image/png');
});
