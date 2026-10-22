
// Android integration suffix. Everything above is the exact pinned Web app.js.
// A module-scope hook lets native lifecycle events flush the Web-owned queues.
// Android saves exported packages through the system document picker. Reuse
// the original library dialog while replacing its browser blob download edge.
let androidExportBusy=false;
async function exportAndroidPackage(row,single,{throwOnError=false}={}){
  if(androidExportBusy||listMode!=='bank'||!catalog.canManage)return false;
  androidExportBusy=true;
  try{
    await prepareLibraryChange();notice('请选择题库包的保存位置…');
    const result=await request('/api/library/export',{method:'POST',body:JSON.stringify(single?{bank:row.path}:{group:row.path}),timeoutMs:600000});
    if(result.cancelled)throw Object.assign(new Error('已取消导出，题库仍保存在本机。'),{code:'EXPORT_CANCELLED'});
    if(result.exported!==true)throw new Error('导出尚未确认完成，请重试。');
    notice(single?'题库已导出。':'题库分组已导出。');return true;
  }catch(error){if(throwOnError)throw error;notice(error.message);return false;}
  finally{androidExportBusy=false;}
}
libraryTransfer.exportBank=(row,options)=>exportAndroidPackage(row,true,options);
libraryTransfer.exportGroup=(row,options)=>exportAndroidPackage(row,false,options);
window.quizforgeApp=Object.freeze({
  resourceContext:(options={})=>{
    // The candidate iframe can request its saved images before Web commits it
    // as active. Only reads may use this target; uploads retain the active pane.
    if(options.reading===true&&document.querySelector('#panes .collection-candidate')){
      const target=typeof pendingLibraryKey==='string'&&/^(bank|exam):([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(pendingLibraryKey);
      if(target&&target[0]===pendingLibraryKey)return {bankId:target[2],kind:target[1],editing:false};
    }
    return {bankId:active()?.id,kind:active()?.kind,editing:active()?.view==='edit'};
  },
  prepareNavigation:()=>prepareLibraryChange(),
  flush:()=>transitionTo(async()=>{
    for(const pane of collections.values()){
      // Closing or reloading discards an unfinished author edit, just like Web.
      // Do not ask a broken editor to flush or turn its form into a saved draft.
      if(pane.view==='edit')continue;
      if(await flushPane(pane)===false)throw Object.assign(new Error('当前输入尚未确认保存，请重试保存'),{code:'SAVE_FAILED'});
    }
    return true;
  }),
  refreshLibrary:()=>document.getElementById('refresh').click(),
  openImportedBank:id=>transitionTo(async()=>{
    await refreshCatalog();
    await openCollection('bank',id);
  }),
});
document.dispatchEvent(new Event('quizforge-android-ready'));
