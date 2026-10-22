const pending = new Map();
let sequence = 0;

function receive(event) {
  let value;
  try { value = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
  const entry = pending.get(value.id);
  if (!entry) return;
  pending.delete(value.id);
  clearTimeout(entry.timer);
  if (value.ok) entry.resolve(value.data);
  else entry.reject(Object.assign(new Error(value.error?.message || '操作失败，当前输入仍保留'), {code:value.error?.code || 'NATIVE_ERROR'}));
}

if (globalThis.qfNative) globalThis.qfNative.onmessage = receive;

export function nativeCall(method, args = {}) {
  if (!globalThis.qfNative) return Promise.reject(Object.assign(new Error('请在 QuizForge 安卓应用中打开'), {code:'NATIVE_UNAVAILABLE'}));
  const id = String(++sequence);
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error('操作尚未确认完成，请保留当前页面后重试'), {code:'NATIVE_TIMEOUT'}));
    }, ['import.pick','library.export'].includes(method) ? 600000 : ['ai.request','settings.ai.test'].includes(method) ? 300000 : 120000);
    pending.set(id,{resolve,reject,timer});
    globalThis.qfNative.postMessage(JSON.stringify({id,method,args}));
  });
}
