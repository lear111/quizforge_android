// Chromium can report this nonfatal layout notification when the Android IME
// or rotation resizes a richtext iframe. Keep genuine extension errors visible.
export function bindAndroidLayoutNotifications(target=window){
  const notification='ResizeObserver loop completed with undelivered notifications.';
  const listener=event=>{
    const value=event.data;
    if(value?.channel!=='quizforge-extension'||value.kind!=='error'||value.message!==notification)return;
    const current=[...target.document.querySelectorAll('iframe.question-frame')].some(frame=>frame.contentWindow===event.source);
    if(current)event.stopImmediatePropagation();
  };
  target.addEventListener('message',listener,true);
  return ()=>target.removeEventListener('message',listener,true);
}
