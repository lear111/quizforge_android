// Explicit acceptance checks on this task's dedicated emulator and fictional demo bank.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {connect} from './webview-driver.mjs';

const serial = 'emulator-5580';
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], {encoding: 'utf8', timeout: 45000}).trim();
assert.match(adb('emu', 'avd', 'name'), /^QuizForge_Android15_Tablet/);
assert.equal(adb('shell', 'getprop', 'ro.build.version.release'), '15');
assert.equal(adb('shell', 'settings', 'get', 'global', 'airplane_mode_on'), '1');
const output = path.resolve('output', 'acceptance');
await fs.mkdir(output, {recursive: true});
const results = {android: '15', avd: 'QuizForge_Android15_Tablet', airplaneMode: true, inputEvidence: 'CDP pen injection and CDP text insertion; synthetic, not a real stylus or IME device test', checks: []};
const driver = await connect();
async function until(read, message, timeout = 60000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error(message + (last ? ': ' + last.message : ''));
}
const evaluate = expression => driver.evaluate(expression);
const stateRead = () => evaluate(`(async()=>{const {nativeCall}=await import('./native.js');const banks=await nativeCall('library.list');const bank=banks.find(x=>x.title==='基础题型体验')||banks[0];return {bank,state:await nativeCall('state.read',{bankId:bank.id})}})()`);
async function click(id) { await evaluate(`(()=>{const button=document.getElementById(${JSON.stringify(id)});if(!button||button.disabled||button.hidden)throw Error('Control unavailable: '+${JSON.stringify(id)});button.click();return true})()`); }
async function waitIdle() { await until(() => evaluate(`!document.getElementById('question-pane').inert && !document.getElementById('finish-button').disabled`), 'UI did not finish navigation'); }
async function frameContext(predicate) {
  await driver.send('Runtime.disable');
  await driver.send('Runtime.enable');
  for (const [id, context] of driver.contexts) {
    if (context.auxData?.isDefault && await driver.evaluate(predicate, id).catch(() => false)) return id;
  }
  return null;
}
async function screenshot(name) {
  const remote = '/sdcard/qf-acceptance-' + name + '.png';
  adb('shell', 'screencap', '-p', remote);
  adb('pull', remote, path.join(output, name + '.png'));
}
try {
  const initial = await stateRead();
  assert.equal(initial.bank.questionCount, 4, 'This flow requires the fictional four-type demonstration bank');
  assert.equal(initial.state.questions['offline-demo-1'].status, 'submitted');
  assert.equal(initial.state.finished, false);
  await waitIdle();
  if (await evaluate(`document.getElementById('ink-panel').hidden`)) await click('ink-toggle');
  const beforeStrokes = initial.state.ink['offline-demo-1']?.strokes.length || 0;
  await evaluate(`document.getElementById('ink-canvas').scrollIntoView({block:'center'});true`);
  const rect = await until(() => evaluate(`(()=>{const r=document.getElementById('ink-canvas').getBoundingClientRect();return r.width>100&&r.top<innerHeight-140&&r.bottom>180?{x:r.left,y:r.top,width:r.width,height:r.height,viewportHeight:innerHeight}:null})()`), 'Draft canvas was not visible');
  const x = Math.round(rect.x + Math.min(150, rect.width * .3));
  const y = Math.round(Math.max(140, rect.y + 110));
  assert.ok(y < rect.viewportHeight - 110, 'Synthetic pen coordinate is hidden behind the footer');
  await driver.send('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: .7});
  for (let step = 1; step <= 7; step++) await driver.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: x + step * 13, y: y + Math.round(Math.sin(step / 2) * 25), button: 'left', buttons: 1, pointerType: 'pen', force: .5 + step * .04});
  await driver.send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: x + 91, y: y - 9, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen', force: 0});
  await evaluate(`window.quizforgeApp.flush().then(()=>true)`);
  const inkSaved = await stateRead();
  const savedInk = inkSaved.state.ink['offline-demo-1'];
  assert.ok(savedInk?.strokes.length > beforeStrokes, 'Injected pen stroke was not durably saved');
  const stroke = savedInk.strokes.at(-1);
  assert.ok(stroke.points.length >= 2);
  assert.ok(stroke.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.pressure > 0));
  results.ink = {beforeStrokes, afterStrokes: savedInk.strokes.length, lastStrokePoints: stroke.points.length, width: savedInk.width, revision: inkSaved.state.revision};
  results.checks.push('actual draft toggle plus synthetic CDP pen stroke saved in native state');
  await screenshot('landscape-ink');

  await click('finish-button');
  await until(() => evaluate(`document.getElementById('confirm-dialog').open`), 'Finish confirmation did not open');
  await click('confirm-accept');
  await until(() => evaluate(`document.getElementById('finish-button').textContent==='开始新一轮'&&!document.getElementById('finish-button').disabled`), 'Round did not finish');
  const completed = await stateRead();
  assert.equal(completed.state.finished, true);
  const history = completed.state.history.at(-1);
  assert.ok(history?.id);
  assert.equal(history.questions[0].ink.strokes.length, savedInk.strokes.length);
  results.completed = {score: history.score, maxScore: history.maxScore, historyCount: completed.state.history.length, revision: completed.state.revision};
  results.checks.push('actual finish confirmation freezes the submitted answer and ink in history');
  await click('history-button');
  await until(() => evaluate(`document.getElementById('history-dialog').open&&!!document.querySelector('.history-record')`), 'History list did not open');
  await evaluate(`document.querySelector('.history-record').click();true`);
  await until(() => evaluate(`!document.getElementById('leave-history').hidden&&!document.getElementById('question-pane').inert`), 'Readonly history view did not open');
  const historyContext = await until(() => frameContext(`!!document.querySelector('input[type=radio]')`), 'Historical original question iframe not found');
  const refusal = await driver.evaluate(`QF.save({purpose:'draft',data:{answer:{selectedOptionId:'choice-3'}}})`, historyContext);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error.code, 'READ_ONLY');
  const afterHistoryProbe = await stateRead();
  assert.equal(afterHistoryProbe.state.revision, completed.state.revision, 'Historical save probe mutated native state');
  results.checks.push('actual historical iframe QF.save is rejected READ_ONLY without changing native revision');
  await screenshot('history-readonly');
  await click('leave-history');
  await waitIdle();
  await click('finish-button');
  await until(() => evaluate(`document.getElementById('confirm-dialog').open`), 'New-round confirmation did not open');
  await click('confirm-accept');
  await until(() => evaluate(`document.getElementById('finish-button').textContent==='结束练习'&&!document.getElementById('finish-button').disabled`), 'New round did not open');
  const restarted = await stateRead();
  assert.equal(restarted.state.finished, false);
  assert.equal(Object.keys(restarted.state.questions).length, 0);
  assert.equal(Object.keys(restarted.state.ink).length, 0);
  assert.equal(restarted.state.history.length, completed.state.history.length);
  results.checks.push('actual new-round confirmation clears current work while preserving frozen history');

  await evaluate(`document.querySelectorAll('.outline-item')[3].click();true`);
  await until(() => evaluate(`document.getElementById('question-title').textContent.includes('简答')&&!document.getElementById('question-pane').inert`), 'Fourth short-answer page did not open');
  const shortContext = await until(() => frameContext(`!!document.querySelector('.answer-field')`), 'Original short-answer iframe not found');
  const editorBefore = await driver.evaluate(`({loaded:!!document.querySelector('.ProseMirror'),placeholder:document.querySelector('.answer-field')?.textContent})`, shortContext);
  await driver.evaluate(`document.querySelector('.answer-field').click();true`, shortContext);
  await until(() => driver.evaluate(`!!document.querySelector('.ProseMirror[contenteditable=true]')`, shortContext), 'Richtext editor did not load lazily');
  const text = '安卓离线验收：这是一条合成的简答题作答。';
  await driver.evaluate(`document.querySelector('.ProseMirror[contenteditable=true]').focus();true`, shortContext);
  await driver.send('Input.insertText', {text});
  await evaluate(`window.quizforgeApp.flush().then(()=>true)`);
  const textSaved = await stateRead();
  const answer = textSaved.state.questions['offline-demo-4'];
  assert.equal(answer.status, 'draft');
  assert.ok(JSON.stringify(answer.answer.responses).includes(text), 'Original editor text was not persisted as a rich-text document');
  const editorAfter = await driver.evaluate(`({loaded:!!document.querySelector('.ProseMirror[contenteditable=true]'),error:document.getElementById('error')?.hidden===false})`, shortContext);
  assert.equal(editorAfter.loaded, true);
  assert.equal(editorAfter.error, false);
  results.richtext = {editorBefore, editorAfter, responseIds: Object.keys(answer.answer.responses), documentTypes: Object.values(answer.answer.responses).map(doc => doc.type), text, revision: textSaved.state.revision};
  results.checks.push('original short-answer editor loads lazily and CDP-inserted synthetic text persists as richdoc');
  await screenshot('short-answer-editor');
  results.status = 'passed';
} catch (error) {
  results.status = 'failed';
  results.error = error.stack || String(error);
  throw error;
} finally {
  await fs.writeFile(path.join(output, 'extra-flow.json'), JSON.stringify(results, null, 2) + '\n');
  driver.close();
  console.log(JSON.stringify(results, null, 2));
}
