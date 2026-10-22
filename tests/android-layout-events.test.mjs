import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {bindAndroidLayoutNotifications} from '../web/android-layout-events.js';

test('only the exact Chromium resize notification from a current question iframe is consumed',()=>{
  const dom=new JSDOM('<iframe class="question-frame"></iframe><iframe></iframe>');
  const {window}=dom,frames=window.document.querySelectorAll('iframe'),seen=[];
  const dispose=bindAndroidLayoutNotifications(window);
  window.addEventListener('message',event=>seen.push(event.data));
  const error=message=>({channel:'quizforge-extension',kind:'error',message});
  const send=(data,source)=>window.dispatchEvent(new window.MessageEvent('message',{data,source}));
  const known=error('ResizeObserver loop completed with undelivered notifications.');
  send(known,frames[0].contentWindow);assert.equal(seen.length,0);
  send(error('题型执行失败'),frames[0].contentWindow);assert.equal(seen.length,1);
  send(known,frames[1].contentWindow);assert.equal(seen.length,2);
  send({...known,kind:'registered'},frames[0].contentWindow);assert.equal(seen.length,3);
  send({...known,channel:'another-channel'},frames[0].contentWindow);assert.equal(seen.length,4);
  const stale=frames[0].contentWindow;frames[0].remove();send(known,stale);assert.equal(seen.length,5);
  dispose();dom.window.close();
});
