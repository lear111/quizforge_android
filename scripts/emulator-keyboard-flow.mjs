// Actual Android15 IME layout check on the dedicated fictional-data emulator.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {connect} from './webview-driver.mjs';
const serial = 'emulator-5580', pkg = 'cloud.treenewbee.quizforge.android.debug';
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], {encoding: 'utf8', timeout: 45000}).trim();
assert.match(adb('emu', 'avd', 'name'), /^QuizForge_Android15_Tablet/);
assert.equal(adb('shell', 'getprop', 'ro.build.version.release'), '15');
const output = path.resolve('output', 'acceptance');
await fs.mkdir(output, {recursive: true});
const results = {android: '15', avd: 'QuizForge_Android15_Tablet', inputEvidence: 'Original richtext editor focused with CDP; Android software IME visible; text input injected synthetically using CDP', checks: []};
let driver;
async function until(read, label, timeout = 60000) {
  let last;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error(label + (last ? ': ' + last.message : ''));
}
async function attach() {
  const pid = await until(() => { try { return adb('shell', 'pidof', pkg).split(' ')[0]; } catch { return null; } }, 'App process did not start');
  adb('forward', 'tcp:9223', 'localabstract:webview_devtools_remote_' + pid);
  return until(async () => {
    const value = await connect();
    try { if (await value.evaluate(`typeof window.quizforgeApp==='object'&&!!document.querySelector('iframe')`)) return value; } catch {}
    value.close();
    return null;
  }, 'WebView did not load');
}
async function context() {
  await driver.send('Runtime.disable');
  await driver.send('Runtime.enable');
  for (const [id, value] of driver.contexts) if (value.auxData?.isDefault && await driver.evaluate(`!!document.querySelector('.answer-field')`, id).catch(() => false)) return id;
  return null;
}
function nativeInsets() {
  const dump = adb('shell', 'dumpsys', 'window');
  const ime = dump.split('\n').find(line => /type=ime frame=/.test(line) && /visible=true/.test(line));
  const match = ime?.match(/frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  const bar = dump.split('\n').find(line => /type=statusBars frame=/.test(line) && /visible=true/.test(line));
  const status = bar?.match(/frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  return {ime: match ? {left: +match[1], top: +match[2], right: +match[3], bottom: +match[4]} : null, statusBarBottom: status ? +status[4] : 0};
}
async function capture(name) {
  const remote = '/sdcard/qf-acceptance-' + name + '.png';
  adb('shell', 'screencap', '-p', remote);
  adb('pull', remote, path.join(output, name + '.png'));
}
async function metrics(id) {
  const main = await driver.evaluate(`(()=>{const f=document.querySelector('iframe').getBoundingClientRect();return {innerWidth,innerHeight,visualHeight:visualViewport.height,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth,mainScroll:document.getElementById('main-content').scrollTop,iframe:{left:f.left,top:f.top,bottom:f.bottom,height:f.height}}})()`);
  const editor = await driver.evaluate(`(()=>{const e=document.querySelector('.ProseMirror[contenteditable=true]');if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,top:r.top,bottom:r.bottom,width:r.width,height:r.height,focused:document.activeElement===e,text:e.textContent}})()`, id);
  const insets = nativeInsets();
  return {main, editor, nativeInsets: insets, editorInMain: editor ? {top: main.iframe.top + editor.top, bottom: main.iframe.top + editor.bottom} : null,
    keyboardTopInMain: insets?.ime ? (insets.ime.top - insets.statusBarBottom) / main.dpr : null};
}
async function focusAndType(label, text) {
  const id = await until(context, 'Short-answer iframe not found');
  if (!await driver.evaluate(`!!document.querySelector('.ProseMirror[contenteditable=true]')`, id)) await driver.evaluate(`document.querySelector('.answer-field').click();true`, id);
  await until(() => driver.evaluate(`!!document.querySelector('.ProseMirror[contenteditable=true]')`, id), 'Richtext editor did not load');
  await driver.evaluate(`document.querySelector('.ProseMirror[contenteditable=true]').focus();true`, id);
  if (!nativeInsets()?.ime) {
    const before = await metrics(id);
    const x = Math.round((before.main.iframe.left + before.editor.left + Math.min(35, before.editor.width / 2)) * before.main.dpr);
    const y = Math.round((before.main.iframe.top + before.editor.top + 25) * before.main.dpr + before.nativeInsets.statusBarBottom);
    adb('shell', 'input', 'tap', String(x), String(y));
  }
  await until(() => nativeInsets()?.ime, 'Android software keyboard did not show');
  await driver.send('Input.insertText', {text});
  await driver.evaluate(`window.quizforgeApp.flush().then(()=>true)`);
  await new Promise(resolve => setTimeout(resolve, 500));
  const value = await metrics(id);
  assert.equal(value.main.overflow, false, label + ': horizontal overflow');
  assert.ok(value.main.innerHeight <= value.keyboardTopInMain + 2, label + ': WebView still extends behind the keyboard');
  assert.ok(value.editorInMain.top >= 0 && value.editorInMain.bottom <= value.main.innerHeight + 2, label + ': focused editor is outside the visible WebView');
  assert.ok(value.editor.text.includes(text), label + ': inserted text not visible in editor');
  const persisted = await driver.evaluate(`(async()=>{const{nativeCall}=await import('./native.js');const banks=await nativeCall('library.list');const bank=banks.find(x=>x.title==='基础题型体验')||banks[0];const state=await nativeCall('state.read',{bankId:bank.id});return {revision:state.revision,answer:state.questions['offline-demo-4']?.answer}})()`);
  assert.ok(JSON.stringify(persisted.answer).includes(text), label + ': text not saved natively');
  value.persistedRevision = persisted.revision;
  results[label] = value;
  await capture(label + '-keyboard-corrected');
  results.checks.push(label + ' IME bounds, focused editor visibility, no horizontal overflow and persisted richdoc');
}
try {
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
  adb('shell', 'am', 'start', '-n', pkg + '/cloud.treenewbee.quizforge.android.MainActivity');
  driver = await attach();
  await until(() => driver.evaluate(`!document.getElementById('question-pane').inert&&!document.getElementById('finish-button').disabled`), 'App not idle');
  await driver.evaluate(`document.querySelectorAll('.outline-item')[3].click();true`);
  await until(() => driver.evaluate(`document.getElementById('question-title').textContent.includes('简答')&&!document.getElementById('question-pane').inert`), 'Short-answer view not open');
  await focusAndType('landscape', ' 横屏键盘验收。');
  adb('shell', 'input', 'keyevent', '111');
  adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');
  await until(() => driver.evaluate(`innerWidth<innerHeight`), 'Portrait resize did not occur');
  await focusAndType('portrait', ' 竖屏键盘验收。');
  results.status = 'passed';
} catch (error) {
  results.status = 'failed';
  results.error = error.stack || String(error);
  try {
    const id = await context();
    results.failureMetrics = await metrics(id);
    await capture('keyboard-failure');
  } catch {}
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'keyboard-flow.json'), JSON.stringify(results, null, 2) + '\n');
  driver?.close();
  console.log(JSON.stringify(results, null, 2));
}
