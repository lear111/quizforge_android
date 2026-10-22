import {createDomain} from './domain.js';
import {nativeCall} from './native.js';
import {mountExtension} from './vendor/web/bridge/frame.js';
import {InkBoard} from './ink-board.js';

const $ = id => document.getElementById(id);
const domain = createDomain(nativeCall);
const state = {banks: [], bank: null, questions: [], questionStates: {}, index: 0, historyId: null, completed: false, frame: null, ink: null, inkVisible: false, loading: false, busy: false, activeData: null};
let retryAction = null;
let toastTimer;
let confirmResolver;
let nativeFlushTail = Promise.resolve();

function readableError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return String(message || '操作未完成，请重试。').slice(0, 1200);
}

function showError(error, retry = null) {
  $('error-text').textContent = readableError(error);
  $('error-banner').hidden = false;
  retryAction = retry;
  $('error-retry').hidden = !retry;
  setSaveStatus('error');
}

function clearError() { $('error-banner').hidden = true; retryAction = null; }

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600);
}

function setSaveStatus(value, persisted = state.bank?.features?.history !== false) {
  const element = $('save-status');
  element.classList.toggle('is-pending', ['dirty', 'saving'].includes(value));
  element.classList.toggle('is-error', value === 'error');
  const labels = persisted
    ? {ready: '本机自动保存', dirty: '正在记录输入', saving: '正在保存…', saved: '已保存到本机', error: '保存状态需检查', history: '历史记录 · 只读'}
    : {ready: '本次会话 · 不保留记录', dirty: '本次会话有新输入', saving: '正在更新…', saved: '本次会话已更新', error: '保存状态需检查', history: '历史记录 · 只读'};
  element.textContent = labels[value] || value;
}

function setBusy(value) {
  state.busy = value;
  document.body.classList.toggle('is-busy', value);
  $('question-pane').inert = value;
  $('ink-panel').inert = value;
  $('question-pane').setAttribute('aria-busy', String(value));
  if (value) {
    state.busyInk = state.ink;
    state.busyInkReadonly = state.ink?.readonly;
    state.ink?.setReadonly(true);
  } else {
    if (state.ink && state.ink === state.busyInk) state.ink.setReadonly(state.busyInkReadonly);
    state.busyInk = null;
  }
  for (const id of ['import-bank', 'welcome-import', 'previous-question', 'next-question', 'history-button', 'finish-button', 'leave-history']) $(id).disabled = value;
  for (const element of document.querySelectorAll('.bank-card,.outline-item')) element.disabled = value;
  updateNavigation();
}

async function runNavigation(action, retry = action) {
  if (state.busy) return;
  setBusy(true);
  try { await action(); }
  catch (error) { showError(error, () => runNavigation(retry)); }
  finally { setBusy(false); }
}

function updateNavigation() {
  $('previous-question').disabled = state.busy || state.index <= 0;
  $('next-question').disabled = state.busy || state.index >= state.questions.length - 1;
  $('finish-button').disabled = state.busy || !state.bank;
}

function makeText(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function bankFeatures(bank) { return bank?.features || {}; }
function questionState(id) { return Object.hasOwn(state.questionStates, id) ? state.questionStates[id] : undefined; }
function recordQuestionState(id, value) { Object.defineProperty(state.questionStates, id, {value, enumerable: true, configurable: true, writable: true}); }

function renderBanks() {
  $('bank-count').textContent = String(state.banks.length);
  const list = $('bank-list');
  list.replaceChildren();
  if (!state.banks.length) { list.append(makeText('div', 'list-placeholder', '还没有题库。\n点击上方按钮，导入一份 .qbank 文件。')); return; }
  for (const bank of state.banks) {
    const button = makeText('button', `bank-card${state.bank?.id === bank.id ? ' is-active' : ''}`, '');
    button.type = 'button';
    button.setAttribute('role', 'listitem');
    button.setAttribute('aria-current', state.bank?.id === bank.id ? 'true' : 'false');
    const icon = makeText('span', 'bank-icon', '▤');
    icon.setAttribute('aria-hidden', 'true');
    const copy = makeText('span', 'bank-copy', '');
    copy.append(makeText('span', 'bank-name', bank.title || '未命名题库'), makeText('span', 'bank-meta', `${Number(bank.questionCount) || 0} 道题目 · 本机题库`));
    button.append(icon, copy);
    button.addEventListener('click', () => runNavigation(() => selectBank(bank.id)));
    list.append(button);
  }
}

function renderOutline() {
  $('outline-count').textContent = `${state.questions.length} 题`;
  const container = $('question-outline');
  container.replaceChildren();
  state.questions.forEach((question, index) => {
    const value = questionState(question.id);
    const status = typeof value === 'string' ? value : value?.status;
    const button = makeText('button', `outline-item${index === state.index ? ' is-active' : ''}${status === 'submitted' ? ' is-submitted' : status === 'draft' ? ' is-draft' : ''}`, String(index + 1).padStart(2, '0'));
    button.type = 'button';
    button.title = question.title || `第 ${index + 1} 题`;
    button.setAttribute('aria-label', `第 ${index + 1} 题：${question.title || ''}${status === 'submitted' ? '，已提交' : status === 'draft' ? '，已作答' : ''}`);
    if (index === state.index) button.setAttribute('aria-current', 'step');
    button.addEventListener('click', () => runNavigation(async () => { await changeQuestion(index); closeOutline(); }));
    container.append(button);
  });
}

function updateQuestionHead(data) {
  const context = data.context;
  const total = data.total ?? state.questions.length;
  $('question-number').textContent = String(state.index + 1).padStart(2, '0');
  $('question-title').textContent = context.question?.title || state.questions[state.index]?.title || `第 ${state.index + 1} 题`;
  $('question-position').textContent = `第 ${state.index + 1} / ${total} 题`;
  $('footer-position').textContent = `${state.index + 1} / ${total}`;
  const status = context.status;
  const statusElement = $('question-state');
  statusElement.textContent = status === 'submitted' ? context.result?.gradingStatus === 'pending' ? '待评分' : '已提交' : status === 'draft' ? '已作答' : '待作答';
  statusElement.className = `question-state${status === 'submitted' ? ' is-submitted' : status === 'draft' ? ' is-draft' : ''}`;
  if (context.question?.id) recordQuestionState(context.question.id, status);
  renderOutline();
  const children = $('subquestion-links');
  children.replaceChildren();
  const items = data.outlineItems || [];
  children.hidden = !items.length;
  for (const item of items) {
    const button = makeText('button', '', item.label || item.id);
    button.addEventListener('click', async () => {
      try { await state.frame?.navigateOutline(item.id); }
      catch (error) { showError(error); }
    });
    children.append(button);
  }
  updateNavigation();
}

function updateStudyHead() {
  const history = !!state.historyId;
  $('header-bank').textContent = state.bank?.title || '选择题库，开始学习';
  $('bank-title').textContent = state.bank?.title || '';
  $('study-mode').textContent = history ? '练习记录 · 只读回看' : state.completed ? '已完成本轮练习' : '自由练习';
  $('finish-button').hidden = history;
  $('finish-button').textContent = state.completed ? '开始新一轮' : '结束练习';
  $('leave-history').hidden = !history;
  $('history-button').hidden = bankFeatures(state.bank).history === false;
  $('ink-toggle').hidden = bankFeatures(state.bank).whiteboard === false;
  $('footer-hint').textContent = history ? '这里保留了当时的题目、作答和草稿。' : bankFeatures(state.bank).history === false ? '此题库关闭记录，关闭页面后作答将不保留。' : '按照自己的节奏，认真做好每一题。';
  $('welcome').hidden = !!state.bank;
  $('study-space').hidden = !state.bank;
  setSaveStatus(history ? 'history' : 'ready');
}

async function refreshLibrary({preferId = null, autoOpen = false} = {}) {
  state.banks = await domain.listBanks();
  renderBanks();
  if (autoOpen && state.banks.length && !state.bank) {
    let remembered;
    try { remembered = localStorage.getItem('quizforge-last-bank'); } catch {}
    const bank = state.banks.find(value => value.id === preferId || value.id === remembered) || state.banks[0];
    await selectBank(bank.id);
  }
}

async function flushCurrent() {
  if (!state.bank || state.historyId) return;
  if (state.frame?.hasUnsavedInput || state.ink?.hasUnsavedChanges) setSaveStatus('saving');
  await state.frame?.flush();
  await state.ink?.flush();
}

async function selectBank(id, {historyId = null, initialIndex = null, alreadyFlushed = false} = {}) {
  if (!alreadyFlushed) await flushCurrent();
  const opened = await domain.openBank(id, historyId ? {historyId} : undefined);
  const bank = {...state.banks.find(value => value.id === id), ...opened.bank, id};
  const questions = opened.questions || [];
  if (!questions.length) throw new Error('这份题库没有可读取的题目。');
  const index = Math.max(0, Math.min(questions.length - 1, initialIndex ?? opened.currentIndex ?? 0));
  await mountQuestion(id, index, historyId, {bank, questions, questionStates: opened.questionStates || {}, completed: !!opened.finished});
  updateStudyHead();
  renderBanks();
  closeLibrary();
  clearError();
  if (!historyId) try { localStorage.setItem('quizforge-last-bank', id); } catch {}
}

async function changeQuestion(index) {
  if (!state.bank || index < 0 || index >= state.questions.length || index === state.index) return;
  await flushCurrent();
  await mountQuestion(state.bank.id, index, state.historyId);
  clearError();
}

async function refreshContext(boundBankId, boundQuestionId, boundFrame) {
  if (state.frame !== boundFrame || state.bank?.id !== boundBankId) return;
  const latest = await domain.openQuestion(boundBankId, state.index, state.historyId ? {historyId: state.historyId} : undefined);
  if (state.frame !== boundFrame || latest.context.question?.id !== boundQuestionId) return;
  state.activeData = latest;
  boundFrame.update(latest.context);
  updateQuestionHead(latest);
}

async function mountQuestion(bankId, index, historyId, replacement = null) {
  $('question-loading').hidden = false;
  let candidate;
  let candidateMount;
  try {
    const data = await domain.openQuestion(bankId, index, historyId ? {historyId} : undefined);
    const boundQuestionId = data.context.question.id;
    const oldMount = $('extension-mount');
    candidateMount = document.createElement('div');
    candidateMount.className = 'extension-mount';
    candidateMount.hidden = true;
    oldMount.after(candidateMount);
    candidate = mountExtension(candidateMount, data.assets, data.context, {
      onRequest: async (method, args) => {
        try {
          if (historyId && !['resource-get', 'sdk-editor', 'ai-task'].includes(method)) {
            return {ok: false, error: {code: 'READ_ONLY', message: '历史记录为只读，不能修改原有作答和草稿。'}};
          }
          const reply = await domain.handleRequest(bankId, boundQuestionId, method, args);
          if (reply?.ok && (method === 'action' && args?.action === 'retry' || method === 'save' && args?.purpose !== 'draft')) {
            setTimeout(() => refreshContext(bankId, boundQuestionId, candidate).catch(showError), 0);
          }
          return reply;
        } catch (error) {
          showError(error, () => runNavigation(flushCurrent));
          return {ok: false, error: {code: error.code || 'HOST_ERROR', message: readableError(error)}};
        }
      },
      onError: message => { if (state.frame === candidate || state.loading) showError(message, () => runNavigation(() => mountQuestion(bankId, index, historyId))); },
      onDirty: dirty => { if (dirty && state.frame === candidate) setSaveStatus('dirty'); },
      onLayout: ({expanded}) => $('question-pane').classList.toggle('extension-expanded', expanded)
    });
    await candidate.ready;
    // Validate ink before retiring the current view so malformed data never drops the visible work.
    const {readInkDocument} = await import('./ink-board.js');
    readInkDocument(data.ink);
    state.frame?.destroy();
    state.ink?.destroy();
    oldMount.remove();
    candidateMount.id = 'extension-mount';
    candidateMount.hidden = false;
    if (replacement) {
      state.bank = replacement.bank;
      state.questions = replacement.questions;
      state.questionStates = replacement.questionStates;
      state.completed = replacement.completed;
    }
    if (historyId && Array.isArray(data.questions)) state.questions = data.questions;
    state.index = index;
    state.historyId = historyId;
    state.frame = candidate;
    state.activeData = data;
    state.ink = createInkBoard(data, bankId, boundQuestionId);
    state.frame.setActive(true);
    updateQuestionHead(data);
    updateInkVisibility();
    $('main-content').scrollTop = 0;
    $('question-pane').classList.remove('extension-expanded');
    setSaveStatus(historyId ? 'history' : 'ready');
  } catch (error) {
    if (candidate && candidate !== state.frame) candidate.destroy();
    if (candidateMount && candidateMount.id !== 'extension-mount') candidateMount.remove();
    throw error;
  } finally { $('question-loading').hidden = true; }
}

function createInkBoard(data, bankId, questionId) {
  const readonly = !!state.historyId || data.context.capabilities?.canWhiteboard === false || state.completed;
  let board;
  board = new InkBoard($('ink-canvas'), $('ink-viewport'), {
    document: data.ink,
    readonly,
    onSave: ink => domain.saveInk(bankId, questionId, ink),
    onStatus: status => {
      if (state.ink && state.ink !== board) return;
      $('ink-save-status').textContent = status === 'saving' ? '正在保存…' : status === 'error' ? '保存失败，内容仍在' : status === 'dirty' ? '等待保存' : bankFeatures(state.bank).history === false ? '仅本次会话' : '已保存';
      if (!state.historyId) setSaveStatus(status);
    },
    onError: error => showError(error, () => runNavigation(flushCurrent)),
    onTools: values => updateInkTools(values)
  });
  $('ink-panel').classList.toggle('is-readonly', readonly);
  $('ink-help').textContent = readonly ? '历史草稿只读 · 手指移动 · 双指缩放' : '触控笔书写 · 手指移动 · 双指缩放';
  $('ink-save-status').textContent = readonly ? '只读' : bankFeatures(state.bank).history === false ? '仅本次会话' : '跟随题目保存';
  return board;
}

function updateInkTools(values) {
  for (const [id, active] of [['ink-pen', values.tool === 'pen'], ['ink-eraser', values.tool === 'eraser'], ['ink-finger', values.fingerDrawing]]) {
    $(id).classList.toggle('is-active', active);
    $(id).setAttribute('aria-pressed', String(active));
  }
  $('ink-undo').disabled = !values.canUndo;
  $('ink-redo').disabled = !values.canRedo;
  for (const element of document.querySelectorAll('[data-ink-color]')) {
    const active = element.dataset.inkColor === values.color;
    element.classList.toggle('is-active', active);
    element.setAttribute('aria-pressed', String(active));
  }
}

function updateInkVisibility() {
  const visible = state.inkVisible && bankFeatures(state.bank).whiteboard !== false;
  $('ink-panel').hidden = !visible;
  $('ink-toggle').setAttribute('aria-pressed', String(visible));
  $('question-and-ink').classList.toggle('has-ink', visible);
  if (visible) requestAnimationFrame(() => state.ink?.resize());
}

async function importBank() {
  await flushCurrent();
  setSaveStatus('saving');
  const result = await nativeCall('import.pick', {});
  if (result?.cancelled || result == null) { setSaveStatus('ready'); return; }
  await refreshLibrary();
  const first = result.banks?.[0]?.id || result.bankIds?.[0] || result.bankId;
  if (first) await selectBank(first);
  else if (state.banks.length && !state.bank) await selectBank(state.banks[0].id);
  toast('题库已导入，可离线使用。');
  clearError();
}

function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '已保存的练习' : new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'}).format(date);
}

function formatScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

async function showHistory() {
  await flushCurrent();
  const records = await domain.listHistory(state.bank.id);
  const list = $('history-list');
  list.replaceChildren();
  if (!records.length) list.append(makeText('div', 'list-placeholder', '还没有已结束的练习。完成一轮练习后，会在这里留下记录。'));
  for (const record of [...records].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))) {
    const button = makeText('button', 'history-record', '');
    const title = makeText('div', '', '');
    title.append(makeText('strong', '', dateText(record.createdAt)), makeText('small', '', `${record.questionCount || state.questions.length} 道题目 · 题目与草稿快照`));
    button.append(title, makeText('span', '', `${formatScore(record.score)} / ${formatScore(record.maxScore)}`));
    button.addEventListener('click', () => runNavigation(async () => {
      await selectBank(state.bank.id, {historyId: record.id, initialIndex: 0});
      $('history-dialog').close();
    }));
    list.append(button);
  }
  $('history-dialog').showModal();
}

function confirmChoice(title, description, accept = '确认') {
  if (confirmResolver) confirmResolver(false);
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  $('confirm-accept').textContent = accept;
  $('confirm-dialog').showModal();
  return new Promise(resolve => { confirmResolver = resolve; });
}

function resolveConfirmation(value) {
  const resolve = confirmResolver;
  confirmResolver = null;
  $('confirm-dialog').close();
  resolve?.(value);
}

async function finishRound() {
  if (state.completed) {
    const confirmed = await confirmChoice('开始新一轮练习？', '上一轮的记录会继续保留。新一轮从空白作答和草稿开始。', '开始新一轮');
    if (!confirmed) return;
    await flushCurrent();
    await domain.startNewRound(state.bank.id);
    await selectBank(state.bank.id, {initialIndex: 0, alreadyFlushed: true});
    toast('新一轮练习已开始。');
    return;
  }
  const description = bankFeatures(state.bank).history === false
    ? '结束前会保存当前会话输入，并提交已作答题目。此题库关闭了记录，关闭页面后不会保留作答和草稿。'
    : '结束前会保存当前作答，并提交已作答题目。完成后可以在练习记录中回看题目、答案和草稿。';
  if (!await confirmChoice('结束本轮练习？', description, '保存并结束')) return;
  await flushCurrent();
  const result = await domain.finish(state.bank.id);
  if (!result.finished) {
    await refreshContext(state.bank.id, state.activeData.context.question.id, state.frame);
    toast(result.pendingCount ? `仍有 ${result.pendingCount} 道题待评分，请完成评分后再次结束。` : '部分题目尚未完成，当前作答已保留。');
    return;
  }
  state.completed = true;
  updateStudyHead();
  await refreshContext(state.bank.id, state.activeData.context.question.id, state.frame);
  state.ink?.setReadonly(true);
  toast(`本轮练习已完成：${formatScore(result.score)} / ${formatScore(result.maxScore)} 分。`);
  setSaveStatus('saved');
}

function openLibrary() { $('library-panel').classList.add('is-open'); $('drawer-scrim').hidden = false; closeOutline(); }
function closeLibrary() { $('library-panel').classList.remove('is-open'); $('drawer-scrim').hidden = true; }
function closeOutline() { $('outline-panel').classList.remove('is-open'); }

$('open-library').addEventListener('click', openLibrary);
$('close-library').addEventListener('click', closeLibrary);
$('drawer-scrim').addEventListener('click', closeLibrary);
$('open-outline').addEventListener('click', () => $('outline-panel').classList.toggle('is-open'));
$('close-outline').addEventListener('click', closeOutline);
$('dismiss-error').addEventListener('click', clearError);
$('error-retry').addEventListener('click', () => retryAction?.());
$('import-bank').addEventListener('click', () => runNavigation(importBank));
$('welcome-import').addEventListener('click', () => runNavigation(importBank));
$('previous-question').addEventListener('click', () => runNavigation(() => changeQuestion(state.index - 1)));
$('next-question').addEventListener('click', () => runNavigation(() => changeQuestion(state.index + 1)));
$('history-button').addEventListener('click', () => runNavigation(showHistory));
$('finish-button').addEventListener('click', () => runNavigation(finishRound));
$('leave-history').addEventListener('click', () => runNavigation(() => selectBank(state.bank.id)));
$('close-history-dialog').addEventListener('click', () => $('history-dialog').close());
$('ink-toggle').addEventListener('click', () => { state.inkVisible = !state.inkVisible; updateInkVisibility(); });
$('ink-pen').addEventListener('click', () => state.ink?.setTool('pen'));
$('ink-eraser').addEventListener('click', () => state.ink?.setTool('eraser'));
$('ink-finger').addEventListener('click', () => state.ink?.setFingerDrawing(!state.ink.fingerDrawing));
$('ink-width').addEventListener('change', event => state.ink?.setWidth(event.target.value));
$('ink-undo').addEventListener('click', () => state.ink?.undo());
$('ink-redo').addEventListener('click', () => state.ink?.redo());
$('ink-reset-view').addEventListener('click', () => state.ink?.resetView());
$('ink-more').addEventListener('click', async () => {
  if (!state.ink || state.ink.readonly) return;
  if (await confirmChoice('清空这道题的草稿？', '清空后仍可使用撤销恢复，直到离开当前题目。', '清空草稿')) state.ink.clear();
});
for (const element of document.querySelectorAll('[data-ink-color]')) element.addEventListener('click', () => state.ink?.setColor(element.dataset.inkColor));
$('confirm-cancel').addEventListener('click', () => resolveConfirmation(false));
$('confirm-accept').addEventListener('click', () => resolveConfirmation(true));
$('confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); resolveConfirmation(false); });

domain.onChanged = event => {
  if (event.bankId !== state.bank?.id || state.historyId) return;
  if (event.questionId && event.type === 'submitted') recordQuestionState(event.questionId, 'submitted');
  else if (event.questionId && event.type === 'saved') recordQuestionState(event.questionId, 'draft');
  setSaveStatus('saved', event.persisted !== false);
  if (event.type === 'finished') { state.completed = true; updateStudyHead(); }
  renderOutline();
};
domain.onNavigate = event => {
  if (event.bankId === state.bank?.id && !state.historyId) runNavigation(() => changeQuestion(event.index));
};

window.addEventListener('message', event => {
  if (event.source !== state.frame?.frame.contentWindow || event.data?.channel !== 'quizforge-extension') return;
  if (event.data.kind === 'input-dirty' && event.data.changed && !state.historyId) setSaveStatus('dirty');
});

function flushForLifecycle() {
  const job = nativeFlushTail.then(flushCurrent, flushCurrent);
  nativeFlushTail = job.catch(() => {});
  return job;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { state.frame?.setActive(true); return; }
  const frame = state.frame;
  // The extension SDK refuses saves once inactive. Finish flushing before pausing it.
  flushForLifecycle().then(() => {
    if (document.hidden && state.frame === frame) frame?.setActive(false);
  }).catch(error => showError(error, () => runNavigation(flushCurrent)));
});
window.addEventListener('pagehide', () => flushForLifecycle().catch(error => showError(error)));
window.addEventListener('beforeunload', event => {
  if (state.frame?.hasUnsavedInput || state.ink?.hasUnsavedChanges) { event.preventDefault(); event.returnValue = ''; }
});

function updateViewport() {
  const viewport = window.visualViewport;
  document.documentElement.style.setProperty('--visual-height', `${Math.round(viewport?.height || window.innerHeight)}px`);
  document.body.classList.toggle('keyboard-visible', !!viewport && window.innerHeight - viewport.height > 160);
}
window.visualViewport?.addEventListener('resize', updateViewport);
window.addEventListener('resize', updateViewport);
updateViewport();

window.quizforgeApp = {
  flush: flushForLifecycle,
  refreshLibrary: options => refreshLibrary(options),
  onImported: async result => { await flushCurrent(); await refreshLibrary(); if (result?.banks?.[0]?.id) await selectBank(result.banks[0].id); },
  handleBack() {
    if ($('confirm-dialog').open) { resolveConfirmation(false); return true; }
    if ($('history-dialog').open) { $('history-dialog').close(); return true; }
    if ($('outline-panel').classList.contains('is-open')) { closeOutline(); return true; }
    if ($('library-panel').classList.contains('is-open')) { closeLibrary(); return true; }
    return false;
  }
};

runNavigation(async () => {
  await refreshLibrary({autoOpen: true});
  $('welcome-description').textContent = state.banks.length ? '从左侧选择题库，继续自己的学习。' : '导入一份题库，就能在这里答题、写草稿、查看记录。\n题库和练习都保存在这台设备上。';
});
