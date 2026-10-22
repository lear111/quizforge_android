// A question edit lives only in its mounted page until an explicit save.
// Never retain another question or persist an unfinished authoring draft.
export function createEditorSession() {
  let current=null;
  return {
    get:id=>current?.id===id?current:undefined,
    values:()=>current?[current]:[],
    add(id,entry){
      if(current)throw new Error('请先保存或取消当前题目的修改');
      current={...entry,id};return current;
    },
    remove(id){if(current?.id!==id)return;const previous=current;current=null;previous.plugin?.destroy();previous.container?.remove();},
    get isDirty(){return !!current?.plugin?.isDirty;},
    async hasChanges(){
      if(!current?.plugin)throw new Error('当前编辑页面尚未就绪');
      return !!(await current.plugin.getDocument({checkOnly:true})).changed;
    },
    async saveCurrent(persist,onSaved=()=>{}){
      const entry=current;
      if(!entry?.plugin)throw new Error('当前编辑页面尚未就绪');
      if(!(await entry.plugin.getDocument({checkOnly:true})).changed)return false;
      const {document}=await entry.plugin.getDocument();
      if(!document||typeof document.title!=='string'||!document.data||typeof document.data!=='object')throw new Error('编辑器没有返回有效题目');
      const change={id:entry.id,entry,document},value=await persist(change);
      await onSaved(change,value);return true;
    },
    destroy(){if(current)this.remove(current.id);}
  };
}
