import { answerAreaModel } from '../../../shared/answer-area/1.4.0/model.js';
import { createAnswerAreaService, ANSWER_AREA_STYLE } from '../../../shared/answer-area/1.2.0/component.js';
import {createSharedAnswerAreaService,ANSWER_AREA_STYLE as SHARED_STYLE} from '../../../shared/answer-area/1.4.1/component.js';
import {paintInkStroke} from '../../../shared/ink/1.0.0/renderer.js';

export function answerAreaComponent(){
  return {version:'1.4.1',style:ANSWER_AREA_STYLE+'\n'+SHARED_STYLE,script:`globalThis.__qfAnswerAreaProvider=Object.freeze({version:'1.4.1',model:(${answerAreaModel.toString()})(${paintInkStroke.toString()}),create:options=>{const legacy=(${createAnswerAreaService.toString()})(options),shared=(${createSharedAnswerAreaService.toString()})(options);return {api:Object.freeze({version:'1.4.1',formatVersion:1,mount:(container,config)=>config?.sharedInk===true?shared.api.mount(container,config):legacy.api.mount(container,config)}),setInk:value=>shared.setInk(value),setTools:value=>legacy.setTools(value),command:value=>['select-image','deactivate-image'].includes(value?.action)?shared.command(value):legacy.command(value),async flush(){await shared.flush();await legacy.flush();},refresh(){shared.refresh();legacy.refresh();},setActive(value){shared.setActive(value);legacy.setActive(value);},destroy(){shared.destroy();legacy.destroy();}};}});`};
}
