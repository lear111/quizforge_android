(()=>{
  'use strict';
  const get=id=>document.getElementById(id),unwrap=reply=>{if(!reply?.ok)throw Object.assign(new Error(reply?.error?.message||'操作失败'),{code:reply?.error?.code});return reply.data;};
  let context,components=[],queue=Promise.resolve(),lastError=null,task=null,poll=null,disposed=false;
  const status=text=>{get('status').textContent=text||'';};
  function enqueue(operation){const job=queue.catch(()=>{}).then(operation);queue=job.then(value=>{lastError=null;return value;},error=>{lastError=error;status(error.message);});return job;}
  const answer=()=>({areas:components.map(component=>component.getDocument())});
  function save(){const snapshot=answer();return enqueue(async()=>{const state=unwrap(await QF.page.reportAnswerState({status:snapshot.areas.some(area=>area.strokes.length||area.text?.trim()||area.images?.length)?'draft':'unanswered'}));unwrap(await QF.save({purpose:'draft',data:{answer:snapshot},answerStateId:state.stateId}));status(context.capabilities.canHistory?'已保存':'当前会话');});}
  async function flush(){for(const component of components)await component.flush();await queue;if(lastError)throw lastError;}
  async function busy(button,operation){button.disabled=true;try{await operation();}catch(error){status(error.message);}finally{button.disabled=false;}}
  function watch(value){
    clearTimeout(poll);task=value;
    if(!task||disposed)return;
    if(['queued','running','succeeded'].includes(task.status)){status('AI 正在评分…');poll=setTimeout(async()=>{try{watch(unwrap(await QF.ai.getTask({taskId:task.taskId})));}catch(error){status(error.message);}},1200);}
    else if(task.status==='failed')status(task.error?.message||task.message||'AI 评分失败，笔迹与提交图片已保留，可重试或人工评分。');
    else if(task.status==='confirmed')status('评分已保存');
  }
  get('submit').addEventListener('click',()=>busy(get('submit'),async()=>{await flush();unwrap(await QF.save({purpose:'submit',data:{answer:answer()}}));}));
  get('retry').addEventListener('click',()=>busy(get('retry'),async()=>{unwrap(await QF.requestAction({action:'retry'}));}));
  get('grade').addEventListener('click',()=>busy(get('grade'),async()=>{await flush();watch(unwrap(await (task?.status==='failed'?QF.ai.retry({taskId:task.taskId}):QF.ai.grade())));}));
  get('manual-save').addEventListener('click',()=>{if(!get('manual-score').reportValidity())return;void busy(get('manual-save'),async()=>{unwrap(await QF.save({purpose:'review',data:{review:{score:Number(get('manual-score').value)}}}));});});
  QF.page.register({
    onLoad(value){
      const componentVersion=QF.answerAreas?.version?.split('.').map(Number);if(!componentVersion||componentVersion[0]!==1||componentVersion[1]<4)throw Error('此示例需要答题区组件 1.4 或以上，请更新并重启宿主。');
      context=value;clearTimeout(poll);task=value.aiTask||null;
      get('title').textContent=value.question.title;get('stem').textContent=value.question.data.stem.replace('请在下面的手写答题区作答。','');get('maximum').textContent=`满分 ${value.question.data.maxScore} 分`;
      if(!components.length){components=value.question.data.areas.map(area=>{const container=document.createElement('div');get('areas').append(container);return QF.answerAreas.mount(container,{id:area.id,label:area.label,width:760,height:area.height,allowText:true,allowImages:true,sharedInk:true,onChange:()=>save()});});}
      components.forEach((component,index)=>{const config=value.question.data.areas[index],saved=value.answer?.areas?.find(area=>area.id===config.id);if(saved)component.setDocument({...saved,height:Math.max(saved.height,config.height)});else component.setDocument({type:'qf-answer-area',formatVersion:1,id:config.id,width:760,height:config.height,strokes:[]});});
      get('submit').hidden=!value.capabilities.canSubmit;get('retry').hidden=!value.capabilities.canRetry;get('grade').hidden=!value.capabilities.canAiGrade;get('manual').hidden=!value.capabilities.canReview;
      get('manual-score').max=String(value.question.data.maxScore);get('manual-score').value=String(value.result?.score??0);
      get('result').hidden=value.status!=='submitted';get('score').textContent=value.result?.gradingStatus==='pending'?'等待评分':value.result?`${value.result.score} / ${value.result.maxScore} 分`:'';
      get('feedback').textContent=value.result?.feedback||'';get('reference').textContent=value.question.data.referenceAnswer?`参考答案：${value.question.data.referenceAnswer}`:'';
      status(value.mode==='history'?'历史记录只读':value.status==='submitted'?'答案已锁定':'');if(task)watch(task);
    },
    onFlush:()=>flush(),
    onDispose(){disposed=true;clearTimeout(poll);components.forEach(component=>component.destroy());components=[];},
  }).catch(error=>status(error.message));
})();
