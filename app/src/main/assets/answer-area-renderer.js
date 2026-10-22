// Host-owned renderer: no question HTML, URLs, storage, network or credentials.
import {answerAreaModel} from '/assets/web/vendor/shared/answer-area/1.4.0/model.js';
const model=answerAreaModel(),MAX_PNG=4*1024*1024;
let current=null;
const fail=(code,message)=>Object.assign(new Error(message),{code});
function close(job){if(!job)return;job.closed=true;for(const image of job.images.values())image.close();job.images.clear();if(job.canvas){job.canvas.width=0;job.canvas.height=0;}if(current===job)current=null;}
Object.defineProperty(window,'__qfDiscardAnswerRender',{value:id=>{if(current?.id===id)close(current);}});
function reply(request,value,error){
  qfAnswerRenderer.postMessage(JSON.stringify({type:'reply',requestId:request.requestId,jobId:request.jobId,ok:!error,...(error?{error:{code:error.code||'ANSWER_AREA_RENDER_FAILED',message:error.message||'答案图片生成失败，原答案仍保留'}}:{result:value})}));
}
// Match Web's legacy RGB software rasterizer, including its pixel coverage and
// budget. Canvas arcs are deliberately not substituted for old ink-only answers.
function legacy(document,budget,paint){
  const {width,height}=document,pixels=paint?new Uint8ClampedArray(width*height*4).fill(255):null;
  const disk=(x,y,radius,color)=>{
    const left=Math.max(0,Math.floor(x-radius)),right=Math.min(width-1,Math.ceil(x+radius));
    const top=Math.max(0,Math.floor(y-radius)),bottom=Math.min(height-1,Math.ceil(y+radius));
    for(let py=top;py<=bottom;py++)for(let px=left;px<=right;px++){
      if(--budget.remaining<0)throw fail('ANSWER_AREA_RENDER_LIMIT','答案笔迹绘制超过限制，原答案仍保留');
      if(!pixels)continue;
      const coverage=Math.max(0,Math.min(1,radius+.5-Math.hypot(px+.5-x,py+.5-y)));
      if(coverage){const at=(py*width+px)*4;for(let c=0;c<3;c++)pixels[at+c]=Math.round(pixels[at+c]*(1-coverage)+color[c]*coverage);}
    }
  };
  for(const stroke of document.strokes){
    const color=[1,3,5].map(index=>Number.parseInt(stroke.color.slice(index,index+2),16)),radius=p=>stroke.width*(.35+.65*p.pressure)/2;
    disk(stroke.points[0].x,stroke.points[0].y,radius(stroke.points[0]),color);
    for(let i=1;i<stroke.points.length;i++){
      const from=stroke.points[i-1],to=stroke.points[i],steps=Math.ceil(Math.hypot(to.x-from.x,to.y-from.y)/Math.max(.5,Math.min(radius(from),radius(to))*.5));
      for(let j=1;j<=steps;j++){const t=j/steps;disk(from.x+(to.x-from.x)*t,from.y+(to.y-from.y)*t,radius(from)+(radius(to)-radius(from))*t,color);}
    }
  }
  return pixels;
}
async function encode(canvas){
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(fail('ANSWER_AREA_RENDER_FAILED','答案图片无法编码，原答案仍保留')),'image/png'));
  if(blob.size>MAX_PNG)throw fail('IMAGE_SIZE_LIMIT','答案图片超过 4 MiB，原答案仍保留');
  const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
  for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return btoa(binary);
}
Object.defineProperty(window,'__qfAnswerRenderCommand',{value:async request=>{
  try{
    if(request.action==='begin'){
      const document=model.normalize(request.document,{snapshot:false});close(current);
      if(!Number.isInteger(request.remainingWork)||request.remainingWork<0||request.remainingWork>8000000)throw fail('ANSWER_AREA_RENDER_LIMIT','答案绘制预算无效');
      current={id:request.jobId,document,images:new Map(),closed:false,decodedPixels:0,remainingWork:request.remainingWork};reply(request,{confirmed:true});return;
    }
    const job=current;if(!job||job.closed||job.id!==request.jobId)throw fail('ANSWER_AREA_JOB_EXPIRED','答案图片任务已过期，请重试');
    if(request.action==='image'){
      if(!job.document.images?.some(image=>image.attrs.assetId===request.assetId))throw fail('ANSWER_IMAGE_UNAVAILABLE','图片不属于当前答题区');
      const bytes=Uint8Array.from(atob(request.data),char=>char.charCodeAt(0));
      if(typeof createImageBitmap!=='function')throw fail('ANSWER_AREA_RENDER_UNAVAILABLE','系统 WebView 缺少图片解码能力，请先更新');
      const image=await createImageBitmap(new Blob([bytes],{type:request.mime}),{imageOrientation:'from-image'});
      if(job.closed||current!==job){image.close();throw fail('ANSWER_AREA_JOB_EXPIRED','答案图片任务已过期，请重试');}
      if(!(image.width>0&&image.height>0)||job.decodedPixels+image.width*image.height>16000000){image.close();throw fail('ANSWER_IMAGE_LIMIT','答案图片总分辨率过大，原答案仍保留');}
      if(job.images.has(request.assetId)){image.close();throw fail('ANSWER_IMAGE_DUPLICATE','当前图片已经解码');}
      job.decodedPixels+=image.width*image.height;job.images.set(request.assetId,image);reply(request,{confirmed:true,width:image.width,height:image.height});return;
    }
    if(request.action!=='render')throw fail('ANSWER_AREA_RENDER_FAILED','不支持的答案图片操作');
    const doc=job.document;for(const image of doc.images||[])if(!job.images.has(image.attrs.assetId))throw fail('ANSWER_IMAGE_UNAVAILABLE','答案图片尚未完成解码，原答案仍保留');
    const mixed=!!doc.text?.trim()||doc.inkSource==='draft'||!!doc.images?.length,scale=mixed?2:1;
    const canvas=document.createElement('canvas');job.canvas=canvas;canvas.width=doc.width*scale;canvas.height=doc.height*scale;
    const context=canvas.getContext('2d',{alpha:false});if(!context)throw fail('ANSWER_AREA_RENDER_UNAVAILABLE','答案图片画布不可用，原答案仍保留');
    const budget={remaining:job.remainingWork};
    if(mixed){
      context.scale(scale,scale);
      if(model.textLayout(context,doc).height>doc.height)throw fail('ANSWER_AREA_TEXT_OVERFLOW','文字超出答题区高度，请返回检查答案；原答案仍保留');
      if(doc.inkSource==='draft'){
        budget.remaining-=doc.strokes.reduce((n,stroke)=>n+stroke.points.length,0)*16;
        if(budget.remaining<0)throw fail('ANSWER_AREA_RENDER_LIMIT','答案笔迹绘制超过限制，原答案仍保留');
        context.beginPath();context.rect(0,0,doc.width,doc.height);context.clip();
      }else legacy(doc,budget,false);
      model.paint(context,doc,{images:job.images});
    }else context.putImageData(new ImageData(legacy(doc,budget,true),doc.width,doc.height),0,0);
    const data=await encode(canvas);if(job.closed||current!==job)throw fail('ANSWER_AREA_JOB_EXPIRED','答案图片任务已过期，请重试');
    reply(request,{mime:'image/png',data,width:canvas.width,height:canvas.height,logicalWidth:doc.width,logicalHeight:doc.height,usedWork:job.remainingWork-budget.remaining});close(job);
  }catch(error){reply(request,null,error);}
}});
qfAnswerRenderer.postMessage(JSON.stringify({type:'ready'}));
