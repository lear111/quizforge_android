const PATH='/api/settings/ai';

export function bindAiSettings({request,document=globalThis.document}) {
  const get=id=>document.getElementById(`ai-settings-${id}`);
  const dialog=document.getElementById('network-settings-dialog'),network=document.getElementById('network-settings-form');
  const panel=get('panel'),form=get('form'),status=get('status'),error=get('error'),report=get('report');
  const tabs=[document.getElementById('settings-network-tab'),document.getElementById('settings-ai-tab')];
  const developmentTab=document.getElementById('settings-development-tab'),developmentPanel=document.getElementById('development-settings-panel');
  const names=['enabled','autoGrade','baseUrl','model','apiKey'];
  const fields=Object.fromEntries(names.map(name=>[name,get(name)]));
  const save=get('save'),test=get('test'),close=get('close'),keyHint=get('keyHint');
  let current=null,busy=false,testing=false,epoch=0;
  const listeners=[];
  const listen=(node,event,handler)=>{node.addEventListener(event,handler);listeners.push(()=>node.removeEventListener(event,handler));};
  function lock(){
    const disabled=busy||!current||current.canManage===false;
    for(const node of Object.values(fields))node.disabled=disabled;
    save.disabled=disabled;test.disabled=disabled||!fields.baseUrl.value.trim()||!fields.model.value.trim();
    save.textContent=busy&&!testing?'正在保存…':'保存 AI 设置';test.textContent=testing?'正在测试…':'测试模型';form.setAttribute('aria-busy',String(busy));
  }
  function showError(cause){
    const messages={AI_HOST_RESTART_REQUIRED:'后端文件已更新，请保存作答并重启应用服务，再保存 AI 设置。',AI_SETTINGS_SAVE_FAILED:'AI 设置未能保存，请重启应用服务后重试。',INTERNAL_ERROR:'AI 操作发生内部错误，请保存作答并重启应用服务后重试。'};
    error.textContent=cause?.status===404||cause?.code==='NOT_FOUND'?'当前服务未提供新版 AI 设置接口。请保存作答，关闭原启动窗口后重新启动。':messages[cause?.code]||cause?.message||'AI 设置操作失败，请重试';error.hidden=false;
  }
  function renderReport(value){
    report.replaceChildren();report.hidden=!value;if(!value)return;
    const node=(tag,className,text)=>{const result=document.createElement(tag);if(className)result.className=className;result.textContent=text;return result;};
    report.append(node('h3','', '模型测试报告'),node('p',`ai-report-summary ${value.status||''}`,value.summary||'测试已完成。'));
    const labels={passed:'通过',failed:'未通过',unknown:'无法判断',skipped:'未测试'};
    const list=document.createElement('ul');
    for(const check of value.checks||[]){
      const row=document.createElement('li');row.append(node('span','ai-report-label',check.label||''),node('span',`ai-report-badge ${check.status}`,labels[check.status]||'未知'),node('p','',check.message||''));list.append(row);
    }
    report.append(list);
    const date=new Date(value.testedAt),time=Number.isNaN(date.getTime())?'':date.toLocaleString();
    report.append(node('small','ai-report-meta',`模型：${value.model||current?.model||''} · ${time} · 用时 ${(Number(value.elapsedMs||0)/1000).toFixed(1)} 秒 · ${value.calls||0} 次请求`));
    if(value.note)report.append(node('p','ai-report-note',value.note));
  }
  function render(value,key=''){
    current=value;
    for(const name of ['enabled','autoGrade'])fields[name].checked=Boolean(value[name]);
    for(const name of ['baseUrl','model'])fields[name].value=String(value[name]??'');
    fields.apiKey.value=value.canManage===false?'':key;
    keyHint.textContent=value.canManage===false?'API Key 由主机保存，仅主机可修改。':value.apiKeyConfigured?'API Key 已保存并隐藏。可直接删除或输入新值，保存后生效。':'本地模型可以不填 API Key。';
    status.textContent=value.canManage===false?'请在运行 QuizForge 的电脑上配置 AI。其他设备可使用已开启的评分服务。':value.enabled?value.autoGrade?'AI 评分已开启，提交答案后自动评分，结果自动保存。':'AI 评分已开启，可在题卡点击评分，结果自动保存。':'AI 评分未开启，仍可人工评分。';
    renderReport(value.testReport);lock();
  }
  function reset(){epoch++;fields.apiKey.value='';network.hidden=false;panel.hidden=true;tabs[0].setAttribute('aria-selected','true');tabs[1].setAttribute('aria-selected','false');}
  async function open(){
    const token=++epoch;network.hidden=true;panel.hidden=false;if(developmentPanel)developmentPanel.hidden=true;developmentTab?.setAttribute('aria-selected','false');tabs[0].setAttribute('aria-selected','false');tabs[1].setAttribute('aria-selected','true');
    error.hidden=true;renderReport(null);current=null;busy=true;testing=false;fields.apiKey.value='';status.textContent='正在读取 AI 设置…';lock();
    try{
      const value=await request(PATH);if(token!==epoch||!dialog.open)return;
      const credential=value.canManage===false?null:await request(`${PATH}/credential`);if(token!==epoch||!dialog.open)return;
      render(value,credential?.apiKey||'');
    }
    catch(cause){if(token===epoch&&dialog.open)showError(cause);}
    finally{if(token===epoch){busy=false;lock();}}
  }
  async function saveCurrent(token){
    const key=fields.apiKey.value;
    const body={enabled:fields.enabled.checked,autoGrade:fields.autoGrade.checked,baseUrl:fields.baseUrl.value.trim(),model:fields.model.value.trim()};
    if(key)body.apiKey=key;else body.clearApiKey=true;
    const value=await request(PATH,{method:'PUT',body:JSON.stringify(body)});
    if(token===epoch&&dialog.open)render(value,key);return value;
  }
  async function submit(event){
    event.preventDefault();if(busy||!current||current.canManage===false)return;
    error.hidden=true;const token=epoch;busy=true;status.textContent='正在保存 AI 设置…';lock();
    try{await saveCurrent(token);if(token===epoch&&dialog.open)status.textContent='AI 设置已保存。';}
    catch(cause){if(token===epoch&&dialog.open){status.textContent='AI 设置未保存，当前修改保留，请重试。';showError(cause);}}
    finally{if(token===epoch){busy=false;lock();}}
  }
  async function check(){
    if(busy||!current||current.canManage===false||!fields.baseUrl.value.trim()||!fields.model.value.trim())return;
    const token=epoch;let saved=false;busy=true;testing=true;error.hidden=true;renderReport(null);status.textContent='正在保存当前配置…';lock();
    try{
      await saveCurrent(token);saved=true;if(token!==epoch||!dialog.open)return;
      status.textContent='正在测试文字响应、评分输出和图片识别…';renderReport(null);
      const value=await request(`${PATH}/test`,{method:'POST',body:'{}',timeoutMs:135000});
      if(token===epoch&&dialog.open){if(value.settings)render({...value.settings,canManage:true},fields.apiKey.value);renderReport(value);status.textContent='模型测试已完成，结果见下方报告。';}
    }
    catch(cause){if(token===epoch&&dialog.open){status.textContent=saved?'配置已保存，但模型测试未完成。':'AI 设置未保存，模型测试未执行。';showError(cause);}}
    finally{if(token===epoch){busy=false;testing=false;lock();}}
  }
  listen(tabs[0],'click',()=>{if(busy)return;reset();});listen(tabs[1],'click',()=>{if(!busy)open();});
  if(developmentTab)listen(developmentTab,'click',()=>{epoch++;fields.apiKey.value='';busy=false;testing=false;});
  listen(dialog,'close',()=>{busy=false;testing=false;reset();});listen(dialog,'cancel',()=>{busy=false;testing=false;reset();});
  for(const name of ['baseUrl','model','apiKey'])listen(fields[name],'input',()=>{renderReport(null);status.textContent='配置有修改，测试后更新检测结果。';lock();});
  listen(form,'submit',submit);listen(test,'click',check);listen(close,'click',()=>dialog.close());
  return {open,destroy(){epoch++;listeners.forEach(remove=>remove());fields.apiKey.value='';}};
}
