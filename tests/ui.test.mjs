import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

const projectRoot = new URL('../', import.meta.url);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../web/tablet-app.js', import.meta.url))],
  bundle: true, format: 'iife', write: false,
  plugins: [{name: 'isolated-ui-host', setup(builder) {
    builder.onResolve({filter: /\/domain\.js$|\/native\.js$|vendor\/web\/bridge\/frame\.js$/}, args => ({path: args.path, namespace: 'isolated-ui-host'}));
    builder.onLoad({filter: /.*/, namespace: 'isolated-ui-host'}, args => ({loader: 'js', contents: args.path.includes('domain')
      ? 'export const createDomain = () => globalThis.__fakeDomain;'
      : args.path.includes('native') ? 'export const nativeCall = async () => ({cancelled:true});'
        : 'export const mountExtension = (...args) => globalThis.__fakeMount(...args);'}));
  }}]
});
// Retired prototype regression only; production identity is web-identity.test.mjs.
const markup = await fs.readFile(new URL('prototypes/early-tablet-shell.html', projectRoot), 'utf8');
async function until(condition, label) {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error(`UI did not settle: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture({history = true, questionIds = ['q1', 'q2']} = {}) {
  const dom = new JSDOM(markup, {url: 'https://appassets.androidplatform.net/assets/index.html', runScripts: 'outside-only', pretendToBeVisual: true});
  const window = dom.window;
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {get: () => () => {}, set: () => true});
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const flags = {failFlush: false, finished: false, reset: false, flushAfterReset: 0, handlerCalls: 0, openQuestionGate: null, lifecycleEvents: []};
  const bank = {id: 'bank-1', title: '离线平板测试', questionCount: 2, features: {history, whiteboard: true}};
  const questions = [{id: questionIds[0], title: '第一道题'}, {id: questionIds[1], title: '第二道题'}];
  const domain = {
    listBanks: async () => [bank],
    openBank: async () => ({bank, questions, finished: flags.finished, questionStates: {}}),
    openQuestion: async (id, index, options) => {
      if (flags.openQuestionGate) await flags.openQuestionGate;
      return {assets: {}, context: {question: questions[index], status: 'unanswered', capabilities: {canWhiteboard: !options?.historyId}}, ink: null, index, total: 2};
    },
    handleRequest: async () => { flags.handlerCalls++; return {ok: true}; },
    saveInk: async () => {},
    listHistory: async () => [{id: 'history-1', createdAt: '2026-10-20T12:00:00Z', score: 2, maxScore: 2}],
    finish: async () => { flags.finished = true; return {finished: true, score: 2, maxScore: 2}; },
    startNewRound: async () => { flags.finished = false; flags.reset = true; }
  };
  window.__fakeDomain = domain;
  window.__fakeMount = (container, assets, context, options) => {
    flags.mountOptions = options;
    const frame = window.document.createElement('iframe');
    container.append(frame);
    return {frame, ready: Promise.resolve(), hasUnsavedInput: false,
      flush: async () => { flags.lifecycleEvents.push('flush'); if (flags.reset) flags.flushAfterReset++; if (flags.failFlush) throw Error('保存失败测试'); },
      setActive(active) { flags.lifecycleEvents.push(active ? 'active' : 'inactive'); }, update() {}, destroy() { frame.remove(); }};
  };
  window.eval(bundle.outputFiles[0].text);
  const $ = id => window.document.getElementById(id);
  await until(() => $('question-title').textContent === '第一道题' && !$('next-question').disabled, 'initial question');
  return {dom, window, $, flags, domain, bank};
}

test('tablet UI mounts the bank and blocks navigation when the previous view cannot save', async () => {
  const {dom, $, flags} = await fixture();
  try {
    assert.equal($('bank-title').textContent, '离线平板测试');
    assert.equal(dom.window.document.querySelectorAll('.outline-item').length, 2);
    flags.failFlush = true;
    $('next-question').click();
    await until(() => !$('error-banner').hidden && !$('next-question').disabled, 'failed save');
    assert.equal($('question-title').textContent, '第一道题');
    flags.failFlush = false;
    $('error-retry').click();
    await until(() => $('question-title').textContent === '第二道题', 'retry navigation');
    assert.equal($('error-banner').hidden, true);
  } finally { dom.window.close(); }
});

test('starting a fresh round never flushes old iframe answers after the domain reset', async () => {
  const {dom, $, flags} = await fixture();
  try {
    $('finish-button').click();
    await until(() => $('confirm-dialog').open, 'finish confirmation');
    $('confirm-accept').click();
    await until(() => $('finish-button').textContent === '开始新一轮' && !$('finish-button').disabled, 'completed round');
    $('finish-button').click();
    await until(() => $('confirm-dialog').open, 'new round confirmation');
    $('confirm-accept').click();
    await until(() => $('finish-button').textContent === '结束练习' && !$('finish-button').disabled, 'new round');
    assert.equal(flags.flushAfterReset, 0);
    assert.equal($('question-title').textContent, '第一道题');
  } finally { dom.window.close(); }
});

test('question and ink interaction stay blocked while navigation waits for new assets', async () => {
  const {dom, $, flags} = await fixture();
  try {
    let release;
    flags.openQuestionGate = new Promise(resolve => { release = resolve; });
    $('next-question').click();
    await until(() => $('question-pane').inert === true, 'navigation interaction lock');
    assert.equal($('ink-panel').inert, true);
    assert.equal($('question-title').textContent, '第一道题');
    release();
    flags.openQuestionGate = null;
    await until(() => $('question-title').textContent === '第二道题' && $('question-pane').inert === false, 'navigation unlock');
    assert.equal($('ink-panel').inert, false);
  } finally { dom.window.close(); }
});

test('history host refuses mutating iframe messages even when the iframe forges a save', async () => {
  const {dom, $, flags} = await fixture();
  try {
    $('history-button').click();
    await until(() => $('history-dialog').open, 'history list');
    dom.window.document.querySelector('.history-record').click();
    await until(() => !$('leave-history').hidden, 'history view');
    const reply = await flags.mountOptions.onRequest('save', {purpose: 'draft', data: {answer: {}}});
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'READ_ONLY');
    assert.equal(flags.handlerCalls, 0);
  } finally { dom.window.close(); }
});

test('history-disabled banks clearly label temporary state and hide the history control', async () => {
  const {dom, $, domain} = await fixture({history: false});
  try {
    assert.equal($('history-button').hidden, true);
    assert.match($('save-status').textContent, /本次会话/);
    domain.onChanged({bankId: 'bank-1', questionId: 'q1', type: 'saved', persisted: false});
    assert.match($('save-status').textContent, /本次会话已更新/);
    assert.doesNotMatch($('save-status').textContent, /已保存到本机/);
  } finally { dom.window.close(); }
});

test('outline status handles question IDs that match Object prototype property names', async () => {
  const {dom, domain} = await fixture({questionIds: ['__proto__', 'constructor']});
  try {
    domain.onChanged({bankId: 'bank-1', questionId: '__proto__', type: 'submitted', persisted: true});
    domain.onChanged({bankId: 'bank-1', questionId: 'constructor', type: 'saved', persisted: true});
    const items = dom.window.document.querySelectorAll('.outline-item');
    assert.equal(items[0].classList.contains('is-submitted'), true);
    assert.equal(items[1].classList.contains('is-draft'), true);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  } finally { dom.window.close(); }
});

test('background transition flushes the extension before making its save bridge inactive', async () => {
  const {dom, window, flags} = await fixture();
  try {
    flags.lifecycleEvents.length = 0;
    Object.defineProperty(window.document, 'hidden', {value: true, configurable: true});
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await until(() => flags.lifecycleEvents.includes('inactive'), 'background flush');
    assert.deepEqual(flags.lifecycleEvents, ['flush', 'inactive']);
    Object.defineProperty(window.document, 'hidden', {value: false, configurable: true});
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(flags.lifecycleEvents.at(-1), 'active');
  } finally { dom.window.close(); }
});
