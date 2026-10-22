import {answerAreaModel} from '../vendor/quizforge-web/core/shared/answer-area/1.4.0/model.js';

const model=answerAreaModel();
const fail=(code,message,status=422)=>Object.assign(new Error(message),{code,status});
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');

// Strip caller snapshots and enforce the exact shared Web document/answer limits.
// Rendering is a native, isolated host operation; this module never captures UI.
export async function prepareAnswerAreas(answer,{submit=false,targetIds=null,nativeCall,readResource,storeResource}={}){
  let areas=0,points=0,pixels=0,nodes=0,height=0;const ids=new Set(),documents=[];
  function walk(value,depth=0){
    if(depth>64||++nodes>100000)throw fail('ANSWER_AREA_LIMIT','手写答案结构超出限制',413);
    if(!value||typeof value!=='object')return value;
    if(!Array.isArray(value)&&value.type==='qf-answer-area'){
      let doc;try{doc=model.normalize(value,{snapshot:false});}catch(error){throw fail('INVALID_ANSWER_AREA',error.message);}
      if(doc.targetId!==undefined&&targetIds!==null&&!targetIds.includes(doc.targetId))throw fail('ANSWER_AREA_TARGET_UNKNOWN','手写答题区目标不属于当前题目的大纲小题');
      if(++areas>model.limits.areas||ids.has(doc.id)||(points+=doc.strokes.reduce((sum,stroke)=>sum+stroke.points.length,0))>40000||(pixels+=doc.width*doc.height)>8000000||(height+=doc.height)>model.limits.totalHeight)throw fail('ANSWER_AREA_LIMIT','手写答题区数量、总尺寸或笔迹超出限制',413);
      ids.add(doc.id);documents.push(doc);return doc;
    }
    if(Array.isArray(value))return value.map(child=>walk(child,depth+1));
    return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,walk(child,depth+1)]));
  }
  const normalized=walk(answer),decodedSizes=new Map();let decodedPixels=0;
  if(!submit){
    const ids=new Set(documents.flatMap(doc=>(doc.images||[]).map(image=>image.attrs.assetId)));
    // Validate references without retaining every picture's base64 bytes.
    // Submission streams images into the current bounded renderer job.
    for(const id of ids)await readResource(id);
    return normalized;
  }
  // Native per-job validation and this aggregate bound match Web's shared-ink
  // work budget. Legacy ink uses native pixel-work enforcement as well.
  if(documents.reduce((count,doc)=>count+(doc.inkSource==='draft'?doc.strokes.reduce((sum,stroke)=>sum+stroke.points.length,0)*16:0),0)>8000000)throw fail('ANSWER_AREA_RENDER_LIMIT','答案笔迹绘制超过限制，已保存答案保留',413);
  let remainingWork=8000000;
  for(const doc of documents){
    if(!doc.strokes.length&&!doc.images?.length)continue;
    let job;
    try{
      job=await nativeCall('answerArea.begin',{document:doc,remainingWork});
      if(!job||typeof job.jobId!=='string'||!job.jobId||!Array.isArray(job.imageIds))throw fail('ANSWER_AREA_RENDER_UNAVAILABLE','答案图片组件没有确认开始合成',503);
      const expected=[...new Set((doc.images||[]).map(image=>image.attrs.assetId))];
      if(job.imageIds.length!==expected.length||new Set(job.imageIds).size!==expected.length||job.imageIds.some(id=>!expected.includes(id)))throw fail('ANSWER_AREA_RENDER_UNAVAILABLE','答案图片组件请求了不属于本题的资源',503);
      for(const assetId of job.imageIds){
        const resource=await readResource(assetId);if(!resource||typeof resource.mime!=='string'||typeof resource.data!=='string')throw fail('ANSWER_IMAGE_UNAVAILABLE','答案图片尚未完成读取，原答案仍保留');
        const decoded=await nativeCall('answerArea.image',{jobId:job.jobId,assetId,mime:resource.mime,data:resource.data});
        if(!decoded||!Number.isInteger(decoded.width)||!Number.isInteger(decoded.height)||decoded.width<=0||decoded.height<=0)throw fail('ANSWER_IMAGE_INVALID','答案图片无法完整解码，原答案仍保留');
        if(!decodedSizes.has(assetId)){decodedSizes.set(assetId,decoded.width*decoded.height);decodedPixels+=decoded.width*decoded.height;if(decodedPixels>16000000)throw fail('ANSWER_IMAGE_LIMIT','答案图片总分辨率过大，请缩小图片后重试；原答案仍保留',413);}
      }
      const rendered=await nativeCall('answerArea.render',{jobId:job.jobId});
      if(!rendered||rendered.mime!=='image/png'||typeof rendered.data!=='string'||rendered.data.length>5592408)throw fail('ANSWER_AREA_RENDER_UNAVAILABLE','完整答案图片未能生成，原答案仍保留',503);
      let bytes;try{bytes=Uint8Array.from(atob(rendered.data),character=>character.charCodeAt(0));}catch{throw fail('ANSWER_AREA_RENDER_UNAVAILABLE','完整答案图片编码无效，原答案仍保留',503);}
      const scale=doc.text?.trim()||doc.inkSource==='draft'||doc.images?.length?2:1;
      if(!Number.isInteger(rendered.usedWork)||rendered.usedWork<0||rendered.usedWork>remainingWork)throw fail('ANSWER_AREA_RENDER_LIMIT','答案笔迹绘制超过限制，已保存答案保留',413);
      remainingWork-=rendered.usedWork;
      if(!bytes.length||bytes.length>4194304||bytes[0]!==137||bytes[1]!==80||bytes[2]!==78||bytes[3]!==71||rendered.width!==doc.width*scale||rendered.height!==doc.height*scale||rendered.id!==await hash(bytes)||rendered.size!==bytes.length)throw fail('ANSWER_AREA_RENDER_UNAVAILABLE','完整答案图片校验失败，原答案仍保留',503);
      const resource=await storeResource({mime:'image/png',data:rendered.data});
      if(resource?.id!==rendered.id)throw fail('RESOURCE_UNAVAILABLE','完整答案图片尚未确认保存，原答案仍保留');
      doc.snapshot={type:'image',attrs:{assetId:resource.id}};
    }finally{
      if(job?.jobId)try{await nativeCall('answerArea.discard',{jobId:job.jobId});}catch{/* Cleanup cannot hide the actual submission/storage failure. */}
    }
  }
  return normalized;
}

export function draftWithoutAnswerInk(draft,answer){
  if(!draft)return draft;const ids=new Set();
  function walk(value){if(!value||typeof value!=='object')return;if(value.type==='qf-answer-area'){if(value.inkSource==='draft')for(const stroke of value.strokes||[])ids.add(stroke.id);return;}for(const child of Object.values(value))walk(child);}
  walk(answer);return ids.size?{...draft,strokes:draft.strokes.filter(stroke=>!ids.has(stroke.id))}:draft;
}
