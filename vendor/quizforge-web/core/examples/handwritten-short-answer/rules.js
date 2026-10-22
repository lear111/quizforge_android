(function(){
  'use strict';
  const answered=answer=>answer.areas.some(area=>area.strokes.length>0||area.text?.trim()||area.images?.length);
  function valid(answer,data){return answer&&Array.isArray(answer.areas)&&answer.areas.length===data.areas.length&&answer.areas.every((area,index)=>area.type==='qf-answer-area'&&area.id===data.areas[index].id&&area.width===760&&area.height>=data.areas[index].height&&Array.isArray(area.strokes));}
  QF.defineType({
    validateQuestion(data){return Number.isInteger(data.maxScore*2)&&new Set(data.areas.map(area=>area.id)).size===data.areas.length&&data.areas.reduce((sum,area)=>sum+area.height,0)<=Math.floor(8000000/760);},
    validateAnswer:valid,
    project(data,state){return {stem:data.stem,maxScore:data.maxScore,areas:data.areas,...(state.submitted?{referenceAnswer:data.referenceAnswer}:{})};},
    grade(data,answer){return answered(answer)?{gradingStatus:'pending',score:null,maxScore:data.maxScore,correct:null,feedback:'答案已提交，等待 AI 或人工评分。'}:{gradingStatus:'graded',score:0,maxScore:data.maxScore,correct:false,feedback:'未作答'};},
    getScore(data,state){if(!state.submitted)return {score:0,maxScore:data.maxScore};return {score:state.result.score,maxScore:data.maxScore,gradingStatus:state.result.gradingStatus};},
    review(data,answer,review){if(!answered(answer)||!Number.isFinite(review.score)||review.score<0||review.score>data.maxScore||!Number.isInteger(review.score*2))throw Error('请输入有效的半分制分数');return {gradingStatus:'graded',score:review.score,maxScore:data.maxScore,correct:review.score===data.maxScore,feedback:typeof review.feedback==='string'?review.feedback.slice(0,10000):null};},
    prepareAiGrading(data,answer){
      const blocks=[];
      for(const area of answer.areas){const label=data.areas.find(item=>item.id===area.id).label;if(area.strokes.length||area.images?.length){if(!area.snapshot?.attrs?.assetId)throw Error('答案尚未生成提交图片');blocks.push({type:'image',assetId:area.snapshot.attrs.assetId,alt:`${label}：框内文字、图片与手写组成的完整答案`});}else if(area.text?.trim())blocks.push({type:'text',text:`${label}：${area.text}`});}
      if(!blocks.length)throw Error('没有答案');
      return {protocolVersion:1,question:[{type:'text',text:data.stem}],answer:blocks,referenceAnswer:[{type:'text',text:data.referenceAnswer}],maxScore:data.maxScore,scoreStep:.5};
    }
  });
})();
