(function () {
  'use strict';
  const $ = id => document.getElementById(id), content=QF.content;
  const copy=value=>JSON.parse(JSON.stringify(value)), empty=()=>copy(content.EMPTY_DOCUMENT);
  const views=new Map(),hosts=new Map(),scoreTexts=new Map(),heightTexts=new Map();
  let originalTitle='';
  let draft,baseline='',active=null,editor=null,switching=Promise.resolve(),disposed=false,editable=false;
  const resize=()=>{if(!disposed)QF.ui.resize();};
  function showError(error){if(disposed)return;$('error').hidden=false;$('error').textContent=error.message||String(error);resize();}
  function field(key){if(key==='material')return {object:draft,name:'material'};const [kind,id]=key.split(':');return {object:draft.parts.find(part=>part.id===id),name:kind==='stem'?'stem':'answerAndExplanation'};}
  function getDoc(key){const value=field(key);return value.object?.[value.name];}
  function setDoc(key,doc){const value=field(key);if(value.object)value.object[value.name]=copy(doc);}
  function capture(){root.querySelectorAll('input[data-height]').forEach(input=>heightTexts.set(input.dataset.height,input.value));if(editor&&active)setDoc(active,editor.getDocument());return {data:copy(draft),scoreTexts:Object.fromEntries(scoreTexts),heightTexts:Object.fromEntries(heightTexts)};}
  function validScore(text){const value=Number(text);return text.trim()!==''&&Number.isFinite(value)&&value>0&&value<=100000&&Number.isInteger(value*2);}
  function updateScores(){
    root.querySelectorAll('input[data-score]').forEach(input=>{
      const raw=scoreTexts.get(input.dataset.score)||'',valid=validScore(raw);
      input.setCustomValidity(valid?'':'满分须大于 0，最多 100000，以 0.5 分递增');input.setAttribute('aria-invalid',String(!valid));
      input.style.width=`${Math.max(1.5,Math.min(11,raw.length+.5))}ch`;
      if(valid)draft.parts.find(part=>part.id===input.dataset.score).maxScore=Number(raw);
    });
    if(draft.parts.length>1){const valid=draft.parts.every(part=>validScore(scoreTexts.get(part.id)||'')),total=draft.parts.reduce((sum,part)=>sum+part.maxScore,0);$('total-score').textContent=valid&&total<=100000?`${total} 分`:'— 分';}
  }
  function scoreInput(part,label){const wrapper=document.createElement('span');wrapper.className='editable-score question-score';const input=document.createElement('input');input.type='text';input.inputMode='decimal';input.maxLength=12;input.dataset.score=part.id;input.value=scoreTexts.get(part.id)||'';input.disabled=!editable;input.setAttribute('aria-label',label);const unit=document.createElement('span');unit.textContent='分';wrapper.append(input,unit);return wrapper;}
  function updateHeight(input){
    const value=Number(input.value),valid=input.value.trim()!==''&&Number.isInteger(value)&&value>=120&&value<=3200;
    input.setCustomValidity(valid?'':'答题区高度须为120–3200的整数');input.setAttribute('aria-invalid',String(!valid));
    const plane=[...root.querySelectorAll('[data-height-preview]')].find(node=>node.dataset.heightPreview===input.dataset.height);
    if(valid&&plane){plane.style.aspectRatio=`760 / ${value}`;plane.setAttribute('aria-label',`答题区尺寸预览：760 × ${value} 逻辑像素`);}
    resize();
  }
  function answerSizePreview(part,index,multiple){
    const block=document.createElement('section');block.className='answer-size-setting';
    const size=document.createElement('label');size.className='answer-height-setting';size.append(document.createTextNode('答题区高度 '));
    const input=document.createElement('input');input.type='number';input.min='120';input.max='3200';input.step='1';input.value=heightTexts.get(part.id)??String(part.answerHeight??480);input.dataset.height=part.id;input.disabled=!editable;input.setAttribute('aria-label',multiple?`第${index+1}问答题区高度`:'答题区高度');size.append(input,document.createTextNode(' px'));
    const preview=document.createElement('div');preview.className='answer-size-preview';
    const heading=document.createElement('div');heading.className='answer-size-heading';heading.textContent='答题区预览';
    const plane=document.createElement('div');plane.className='answer-size-plane';plane.dataset.heightPreview=part.id;plane.style.aspectRatio=`760 / ${part.answerHeight??480}`;plane.setAttribute('role','img');plane.setAttribute('aria-label',`答题区尺寸预览：760 × ${part.answerHeight??480} 逻辑像素`);
    preview.append(heading,plane);block.append(size,preview);return block;
  }
  function preview(key){
    const host=hosts.get(key);if(!host)return;views.get(key)?.destroy();views.delete(key);
    host.classList.remove('is-editing');host.setAttribute('role',editable?'button':'region');host.tabIndex=editable?0:-1;
    const doc=getDoc(key);
    if(!doc||content.isEmpty(doc)){host.replaceChildren();const hint=document.createElement('div');hint.className='empty-field';hint.textContent='点击填写';host.append(hint);}
    else{const view=content.render(host,doc);views.set(key,view);view.ready.then(resize).catch(showError);}resize();
  }
  async function closeEditor(){if(!editor)return;await editor.flush();capture();const previous=active;editor.destroy();editor=null;active=null;preview(previous);}
  async function activate(key){
    if(!editable||disposed||key===active||!hosts.has(key))return;await closeEditor();if(disposed||!hosts.has(key))return;
    const host=hosts.get(key);views.get(key)?.destroy();views.delete(key);host.classList.add('is-editing');host.removeAttribute('role');host.tabIndex=-1;active=key;
    const candidate=content.createEditor(host,{doc:getDoc(key)||empty(),placeholder:'',resources:{get:id=>QF.resources.get(id),put:file=>QF.resources.put(file)},onChange(doc){if(!disposed&&active===key){setDoc(key,doc);resize();}}});
    editor=candidate;await candidate.ready;if(disposed||editor!==candidate){candidate.destroy();return;}candidate.focus();resize();
  }
  function schedule(operation){switching=switching.catch(()=>{}).then(operation);switching.catch(showError);}
  function build(){
    views.forEach(view=>view.destroy());views.clear();hosts.clear();$('part-editors').replaceChildren();$('total-score').replaceChildren();
    const multiple=draft.parts.length>1;
    if(!multiple)$('total-score').append(scoreInput(draft.parts[0],'满分'));
    $('material-section').hidden=draft.material===null;$('add-material').hidden=draft.material!==null;$('add-material').disabled=!editable;$('remove-material').disabled=!editable;
    if(draft.material!==null){const host=$('edit-material');host.dataset.field='material';hosts.set('material',host);preview('material');}else $('edit-material').replaceChildren();
    draft.parts.forEach((part,index)=>{
      const section=document.createElement('section');section.className='part';section.dataset.id=part.id;
      if(multiple){const heading=document.createElement('div');heading.className='part-header';const number=document.createElement('span');number.className='part-number';number.textContent=`（${index+1}）`;const tools=document.createElement('div');tools.className='part-heading-tools';const remove=document.createElement('button');remove.type='button';remove.className='remove-item';remove.textContent='×';remove.dataset.remove=part.id;remove.disabled=!editable;remove.setAttribute('aria-label',`删除第${index+1}问`);tools.append(scoreInput(part,`第${index+1}问满分`),remove);heading.append(number,tools);section.append(heading);}
      for(const [kind,label]of[['stem','题干'],['assessment','答案与解析']]){const block=document.createElement('section');block.className='edit-section';const caption=document.createElement('div');caption.className='section-label';caption.textContent=label;const host=document.createElement('div');host.className='editable-field';const key=`${kind}:${part.id}`;host.dataset.field=key;host.setAttribute('aria-label',multiple?`编辑第${index+1}问${label}`:`编辑${label}`);block.append(caption,host);section.append(block);hosts.set(key,host);if(kind==='stem')section.append(answerSizePreview(part,index,multiple));}
      $('part-editors').append(section);preview('stem:'+part.id);preview('assessment:'+part.id);
    });
    $('add-part').disabled=!editable||draft.parts.length>=16;updateScores();root.querySelectorAll('input[data-height]').forEach(updateHeight);resize();
  }
  function requestEdit(event){if(event.type==='keydown'&&!['Enter',' '].includes(event.key))return;const host=event.target.closest('.editable-field');if(!host||host.classList.contains('is-editing'))return;if(event.type==='keydown')event.preventDefault();schedule(()=>activate(host.dataset.field));}
  function scoreChanged(event){if(editable&&event.target.matches('input[data-height]')){heightTexts.set(event.target.dataset.height,event.target.value);updateHeight(event.target);return;}if(!editable||!event.target.matches('input[data-score]'))return;scoreTexts.set(event.target.dataset.score,event.target.value);updateScores();}
  function addPart(){if(!editable||draft.parts.length>=16)return;schedule(async()=>{await closeEditor();if(disposed||draft.parts.length>=16)return;let number=1;while(draft.parts.some(part=>part.id===`part${number}`))number++;const id=`part${number}`;draft.parts.push({id,stem:empty(),answerAndExplanation:empty(),maxScore:5});scoreTexts.set(id,'5');build();await activate('stem:'+id);});}
  function removePart(event){const button=event.target.closest('button[data-remove]');if(!editable||!button||draft.parts.length<=1)return;const id=button.dataset.remove;schedule(async()=>{await closeEditor();if(disposed||draft.parts.length<=1||!draft.parts.some(part=>part.id===id))return;draft.parts=draft.parts.filter(part=>part.id!==id);scoreTexts.delete(id);heightTexts.delete(id);build();});}
  function addMaterial(){if(!editable||draft.material!==null)return;schedule(async()=>{await closeEditor();if(disposed||draft.material!==null)return;draft.material=empty();build();await activate('material');});}
  function removeMaterial(){if(!editable||draft.material===null)return;schedule(async()=>{await closeEditor();if(disposed)return;draft.material=null;build();});}
  const root=document.querySelector('.authoring');root.addEventListener('click',requestEdit);root.addEventListener('keydown',requestEdit);root.addEventListener('input',scoreChanged);
  $('part-editors').addEventListener('click',removePart);$('add-part').addEventListener('click',addPart);$('add-material').addEventListener('click',addMaterial);$('remove-material').addEventListener('click',removeMaterial);
  QF.editor.register({
    async onLoad(context){originalTitle=context.question.title;await switching;editor?.destroy();editor=null;active=null;draft=copy(context.question.data);editable=context.capabilities?.canEdit===true;scoreTexts.clear();heightTexts.clear();draft.parts.forEach(part=>scoreTexts.set(part.id,String(part.maxScore)));$('error').hidden=true;build();baseline=JSON.stringify(capture());await Promise.all([...views.values()].map(view=>view.ready));resize();},
    hasChanges(){return Boolean(draft)&&JSON.stringify(capture())!==baseline;},
    async getDocument(){await switching;await editor?.flush();capture();for(const part of draft.parts){if(!validScore(scoreTexts.get(part.id)||''))throw new Error('请填写有效的分值');part.maxScore=Number(scoreTexts.get(part.id));const raw=heightTexts.get(part.id)??String(part.answerHeight??480),height=Number(raw);if(!raw.trim()||!Number.isInteger(height)||height<120||height>3200)throw new Error('答题区高度须为120–3200的整数');if(height!==480||part.answerHeight!==undefined)part.answerHeight=height;}if(draft.parts.reduce((sum,part)=>sum+(part.answerHeight??480),0)>12000||draft.parts.reduce((sum,part)=>sum+760*(part.answerHeight??480),0)>8000000)throw new Error('本题答题区总大小超出限制，请减小高度');if(draft.parts.reduce((sum,part)=>sum+part.maxScore,0)>100000)throw new Error('总分最多为100000');for(const part of draft.parts){if(!content.validateDocument(part.stem)||content.isEmpty(part.stem))throw new Error('请填写完整的题干');if(!content.validateDocument(part.answerAndExplanation))throw new Error('答案与解析格式无效');}if(draft.material!==null&&!content.validateDocument(draft.material))throw new Error('材料格式无效');return {title:originalTitle,data:copy(draft)};},
    async exportDraft(){await switching;await editor?.flush();return {schemaVersion:1,form:capture()};},async importDraft(value){if(!value||value.schemaVersion!==1||!value.form)throw new Error('编辑草稿无效');await switching;editor?.destroy();editor=null;active=null;draft=copy(value.form.data);if(!Array.isArray(draft.parts)||!draft.parts.length)throw new Error('编辑草稿无效');scoreTexts.clear();heightTexts.clear();for(const [id,text] of Object.entries(value.form.heightTexts||{}))heightTexts.set(id,text);for(const part of draft.parts)scoreTexts.set(part.id,String(value.form.scoreTexts?.[part.id]??part.maxScore));build();await Promise.all([...views.values()].map(view=>view.ready));resize();},
    async onFlush(){await switching;await editor?.flush();},
    async onOutlineNavigate(id){const host=hosts.get('stem:'+id);if(!host)return false;await switching;await Promise.all([...views.values()].map(view=>view.ready));host.scrollIntoView({block:'center',behavior:'auto'});host.focus({preventScroll:true});return true;},
    onDispose(){disposed=true;editor?.destroy();editor=null;views.forEach(view=>view.destroy());views.clear();hosts.clear();root.removeEventListener('click',requestEdit);root.removeEventListener('keydown',requestEdit);root.removeEventListener('input',scoreChanged);$('part-editors').removeEventListener('click',removePart);$('add-part').removeEventListener('click',addPart);$('add-material').removeEventListener('click',addMaterial);$('remove-material').removeEventListener('click',removeMaterial);}
  }).catch(showError);
})();
