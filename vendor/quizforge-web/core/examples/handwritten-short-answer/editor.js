(()=>{
  'use strict';
  const get=id=>document.getElementById(id),copy=value=>JSON.parse(JSON.stringify(value));
  let original=null,baseline='',heights=[],editable=false;
  function capture(){return {title:get('title').value,stem:get('stem').value,referenceAnswer:get('reference').value,maxScore:get('maximum').value,heights:heights.map(input=>input.value)};}
  function update(){
    heights.forEach(input=>{const height=Number(input.value),valid=Number.isInteger(height)&&height>=120&&height<=3200;input.setCustomValidity(valid?'':'高度须为 120–3200 的整数');if(valid)input.closest('.area-setting').querySelector('.area-preview').style.aspectRatio=`760 / ${height}`;});QF.ui.resize();
  }
  function restore(form){
    get('title').value=form.title;get('stem').value=form.stem;get('reference').value=form.referenceAnswer;get('maximum').value=form.maxScore;
    heights.forEach((input,index)=>{input.value=String(form.heights[index]??original.data.areas[index].height);});update();
  }
  QF.editor.register({
    onLoad(context){
      original=copy(context.question);editable=context.capabilities.canEdit===true;get('area-settings').replaceChildren();heights=[];
      for(const area of original.data.areas){const section=document.createElement('div');section.className='area-setting';const label=document.createElement('label');label.textContent=`${area.label||'答题区'}默认高度`;const input=document.createElement('input');input.type='number';input.min='120';input.max='3200';input.step='1';input.required=true;input.setAttribute('aria-label',`${area.label||'答题区'}默认高度`);label.append(input,document.createTextNode('px'));const preview=document.createElement('div');preview.className='area-preview';const caption=document.createElement('span');caption.textContent='正式答题区预览';preview.append(caption);section.append(label,preview);get('area-settings').append(section);heights.push(input);}
      restore({title:original.title,...original.data,heights:original.data.areas.map(area=>area.height)});document.querySelectorAll('input,textarea').forEach(input=>input.disabled=!editable);baseline=JSON.stringify(capture());
    },
    hasChanges:()=>original!==null&&JSON.stringify(capture())!==baseline,
    getDocument(){
      if(!editable)throw Error('当前题目不可编辑');update();const form=capture();
      if(!form.title.trim()||!form.stem.trim()||!form.referenceAnswer.trim())throw Error('请填写题目名称、题干和参考答案');
      const score=Number(form.maxScore);if(!form.maxScore.trim()||!Number.isFinite(score)||score<=0||score>100||!Number.isInteger(score*2))throw Error('满分须为 0.5–100，按半分递增');
      for(const input of heights)if(!input.checkValidity())throw Error('答题区高度须为 120–3200 的整数');
      if(form.heights.reduce((sum,height)=>sum+Number(height),0)>Math.floor(8000000/760))throw Error('多个答题区的总高度超出本题容量，请缩小部分区域');
      return {title:form.title,data:{...copy(original.data),stem:form.stem,referenceAnswer:form.referenceAnswer,maxScore:score,areas:original.data.areas.map((area,index)=>({...area,height:Number(form.heights[index])}))}};
    },
    exportDraft:()=>({schemaVersion:1,form:capture()}),
    importDraft(value){if(value?.schemaVersion!==1||!value.form||!Array.isArray(value.form.heights))throw Error('编辑草稿无效');restore(value.form);},
    onFlush(){},onDispose(){document.removeEventListener('input',update);}
  }).catch(error=>{get('error').textContent=error.message;});
  document.addEventListener('input',update);
})();
