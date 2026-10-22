// Withdrawn preview experiment. Not loaded or packaged; await Web-owned design.
// Local data tools live inside the original Web settings. The library footer
// keeps the same Settings and Get banks entries as Web.
export function bindAndroidLibraryExtras({document=globalThis.document,nativeCall,getApp=()=>globalThis.quizforgeApp,onError=()=>{}}={}){
  if(typeof nativeCall!=='function')throw new TypeError('nativeCall must be a function');
  const existing=document.getElementById('settings-data-tab');
  if(existing)return {entry:existing,destroy(){}};
  const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const button=(text,handler)=>{const node=element('button','history-row',text);node.type='button';node.addEventListener('click',handler);return node;};
  const errorText=error=>String(error?.message||error||'操作未完成，请保留当前内容后重试');
  function dialog(id,title){
    const node=element('dialog','history-dialog');node.id=id;node.setAttribute('aria-labelledby',id+'-title');
    const heading=element('div','dialog-heading'),name=element('h2','',title),close=element('button','icon-button','×');name.id=id+'-title';close.type='button';close.setAttribute('aria-label','关闭'+title);heading.append(name,close);
    const error=element('p','history-error');error.hidden=true;error.setAttribute('role','alert');
    const content=element('div','history-list');node.append(heading,error,content);document.body.append(node);
    close.addEventListener('click',()=>{if(!node.matches('[aria-busy=true]'))node.close();});node.addEventListener('cancel',event=>{if(node.matches('[aria-busy=true]'))event.preventDefault();});
    return {node,content,error,close};
  }
  const settings=document.getElementById('network-settings-dialog'),tabs=settings?.querySelector('.settings-tabs');
  if(!settings||!tabs)throw Error('Original Web settings unavailable');
  const entry=element('button','','本机数据');entry.type='button';entry.id='settings-data-tab';entry.setAttribute('role','tab');entry.setAttribute('aria-selected','false');entry.setAttribute('aria-controls','android-data-panel');tabs.append(entry);
  const panel=element('section');panel.id='android-data-panel';panel.hidden=true;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',entry.id);
  const dataError=element('p','history-error');dataError.hidden=true;dataError.setAttribute('role','alert');
  const content=element('div','history-list');panel.append(dataError,content);settings.append(panel);
  const data={node:settings,content,error:dataError},trash=dialog('android-trash-dialog','本机回收站');
  const status=element('p','library-manage-hint','题库、作答与历史保存在本机。');status.setAttribute('role','status');
  const showTrash=button('本机回收站',openTrash);
  const backupHint=element('p','history-hint','题库包（.qbank）用于分享题目，不包含个人作答和历史。完整备份用于迁移本机题库、作答、草稿及历史记录，不包含 AI 密钥。恢复会在系统确认后替换本机数据，并先保留原数据副本。');
  const exportBackup=button('导出完整备份',()=>backup('export')),importBackup=button('恢复完整备份',()=>backup('import'));
  data.content.append(status,showTrash,backupHint,exportBackup,importBackup);
  const trashHint=element('p','history-hint','已移入回收站的题库和分组在这里恢复。原有作答、草稿和历史记录保留；名称冲突时恢复为新名称。');trash.node.insertBefore(trashHint,trash.content);
  let dataBusy=false,trashBusy=false,disposed=false,loadGeneration=0;
  const setError=(view,message)=>{view.error.textContent=message;view.error.hidden=!message;};
  function busy(view,value){
    view.node.setAttribute('aria-busy',String(value));
    if(value){view.locked??=[...view.node.querySelectorAll('button')].map(control=>[control,control.disabled]);for(const [control] of view.locked)control.disabled=true;}
    else{for(const [control,disabled] of view.locked||[])control.disabled=disabled;view.locked=null;}
  }
  async function flush(){const app=getApp();if(typeof app?.flush!=='function')throw Error('页面正在打开，请稍候重试');if(await app.flush()===false)throw Error('当前输入尚未保存，请先返回题目重试保存');return app;}
  async function backup(action){
    if(dataBusy)return;dataBusy=true;busy(data,true);setError(data,'');
    try{
      await flush();const value=await nativeCall('backup.'+action,{});
      if(value?.cancelled){status.textContent='已取消'+(action==='export'?'备份导出':'恢复备份')+'。本机内容保持原样。';return;}
      if(action==='export'&&value?.exported===true)status.textContent='完整备份已写入所选文件。请妥善保存，其中包含个人作答与历史。';
      else if(action==='import'&&value?.restored===true)status.textContent='完整备份已恢复，正在重新打开本机题库。';
      else throw Error(action==='export'?'备份尚未确认写入，请重试。':'恢复尚未确认完成，请保留当前数据后重试。');
    }catch(error){setError(data,errorText(error));onError(error);}finally{dataBusy=false;busy(data,false);}
  }
  function hideData(){panel.hidden=true;entry.setAttribute('aria-selected','false');}
  function showData(){
    if(disposed||dataBusy)return;setError(data,'');if(!settings.open)settings.showModal();
    for(const id of ['network-settings-form','ai-settings-panel','development-settings-panel','appearance-settings-panel']){const node=document.getElementById(id);if(node)node.hidden=true;}
    for(const tab of tabs.querySelectorAll('[role="tab"]'))tab.setAttribute('aria-selected',String(tab===entry));
    panel.hidden=false;
  }
  const otherTabs=[...tabs.querySelectorAll('[role="tab"]')].filter(tab=>tab!==entry);
  for(const tab of otherTabs)tab.addEventListener('click',hideData);
  const preventBusyClose=event=>{if(dataBusy)event.preventDefault();};settings.addEventListener('cancel',preventBusyClose);
  settings.addEventListener('close',hideData);
  async function loadTrash(){
    const generation=++loadGeneration;trashBusy=true;busy(trash,true);setError(trash,'');trash.content.replaceChildren(element('p','list-empty','正在读取回收站…'));
    try{
      const value=await nativeCall('library.trash',{}),rows=Array.isArray(value)?value:value?.records;
      if(!Array.isArray(rows)||rows.some(row=>!row||typeof row.id!=='string'||!row.id||typeof row.name!=='string'||!['item','group'].includes(row.target)))throw Error('回收站记录无法读取，原文件已保留');
      if(disposed||generation!==loadGeneration)return;trash.content.replaceChildren();
      if(!rows.length)trash.content.append(element('p','list-empty','回收站为空。'));
      for(const row of rows){
        const container=element('div','history-list-item'),restore=element('button','history-row'),body=element('span','history-row-body'),name=element('strong','',row.name),detail=element('small');restore.type='button';restore.dataset.trashId=row.id;
        detail.textContent=[row.target==='group'?'分组':'题库',Number.isSafeInteger(row.bankCount)?`${row.bankCount} 本题库`:null,row.group||null].filter(Boolean).join(' · ');body.append(name,detail);restore.append(body,element('span','history-score','恢复'));restore.addEventListener('click',()=>restoreRow(row));container.append(restore);trash.content.append(container);
      }
    }catch(error){if(!disposed&&generation===loadGeneration){trash.content.replaceChildren();setError(trash,errorText(error));trash.content.append(button('重新读取',loadTrash));}}
    finally{if(generation===loadGeneration){trashBusy=false;busy(trash,false);}}
  }
  async function openTrash(){if(dataBusy||trashBusy||disposed)return;if(settings.open)settings.close();if(!trash.node.open)trash.node.showModal();await loadTrash();}
  async function restoreRow(row){
    if(trashBusy||disposed)return;trashBusy=true;busy(trash,true);setError(trash,'');
    try{const app=await flush(),value=await nativeCall('library.restore',{trashId:row.id});if(!Array.isArray(value?.restored)||!value.restored.length)throw Error('恢复尚未确认完成，请重新读取回收站');
      await app.refreshLibrary?.();await loadTrash();setError(trash,'');trashHint.textContent=`已恢复「${row.name}」。原有作答、草稿和历史记录保留。`;
    }catch(error){setError(trash,errorText(error));onError(error);}finally{trashBusy=false;busy(trash,false);}
  }
  entry.addEventListener('click',showData);
  return {entry,showData,openTrash,destroy(){disposed=true;loadGeneration++;entry.removeEventListener('click',showData);for(const tab of otherTabs)tab.removeEventListener('click',hideData);settings.removeEventListener('cancel',preventBusyClose);settings.removeEventListener('close',hideData);entry.remove();panel.remove();trash.node.remove();}};
}
