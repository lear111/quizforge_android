import test from 'node:test';
import assert from 'node:assert/strict';
import {InkBoard, readInkDocument} from '../web/ink-board.js';

function createBoard(options = {}) {
  globalThis.window = {devicePixelRatio: 1};
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  const context = new Proxy({}, {get: (object, key) => object[key] || (() => {}), set: (object, key, value) => (object[key] = value, true)});
  const canvas = {getContext: () => context, addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {}, getBoundingClientRect: () => ({left: 0, top: 0, width: 760, height: 500})};
  const viewport = {getBoundingClientRect: () => ({width: 760, height: 500})};
  return new InkBoard(canvas, viewport, options);
}

const event = (id, x, y, type = 'pen', extras = {}) => ({pointerId: id, clientX: x, clientY: y, pointerType: type, button: 0, buttons: 1, pressure: .7, preventDefault() {}, ...extras});
function draw(board, id = 1) {
  board.pointerDown(event(id, 20, 20));
  board.pointerMove(event(id, 30, 35));
  board.pointerUp(event(id, 30, 35));
}

test('ink rejects malformed persisted coordinates without replacing them with a blank document', () => {
  assert.equal(readInkDocument(null).width, 760);
  assert.throws(() => readInkDocument({strokes: [{color: '#000000', width: 2, points: [{x: Infinity, y: 0}]}]}), /原有内容已保留/);
  assert.throws(() => readInkDocument({height: -1, strokes: []}), /原有内容已保留/);
});

test('failed ink save keeps strokes and dirty state; explicit retry persists exact ink', async () => {
  let fail = true, saved;
  const statuses = [];
  const board = createBoard({onStatus: value => statuses.push(value), onSave: async ink => { if (fail) throw Error('storage full'); saved = ink; }});
  try {
    draw(board);
    const original = board.getDocument();
    await assert.rejects(board.flush(), /storage full/);
    assert.equal(board.hasUnsavedChanges, true);
    assert.deepEqual(board.getDocument(), original);
    assert.equal(statuses.at(-1), 'error');
    fail = false;
    await board.flush();
    assert.deepEqual(saved, original);
    assert.equal(board.hasUnsavedChanges, false);
    assert.equal(statuses.at(-1), 'saved');
  } finally { board.destroy(); }
});

test('undo, redo and whole-stroke erasing persist the intended document', async () => {
  let saved;
  const board = createBoard({onSave: async ink => { saved = ink; }});
  try {
    draw(board); await board.flush(); assert.equal(saved.strokes.length, 1);
    board.undo(); await board.flush(); assert.equal(saved.strokes.length, 0);
    board.redo(); await board.flush(); assert.equal(saved.strokes.length, 1);
    board.setTool('eraser'); board.pointerDown(event(2, 25, 28)); board.pointerUp(event(2, 25, 28)); await board.flush(); assert.equal(saved.strokes.length, 0);
    board.undo(); await board.flush(); assert.equal(saved.strokes.length, 1);
  } finally { board.destroy(); }
});

test('finger pan, pinch and readonly input do not mutate ink or write storage', async () => {
  let writes = 0;
  const board = createBoard({onSave: async () => { writes++; }});
  try {
    draw(board); await board.flush();
    const before = board.getDocument(), count = writes;
    board.lastPenAt = -Infinity;
    board.pointerDown(event(4, 100, 100, 'touch'));
    board.pointerMove(event(4, 120, 110, 'touch'));
    board.pointerDown(event(5, 300, 100, 'touch'));
    board.pointerMove(event(5, 350, 100, 'touch'));
    board.pointerUp(event(5, 350, 100, 'touch'));
    board.pointerUp(event(4, 120, 110, 'touch'));
    await board.flush();
    assert.deepEqual(board.getDocument(), before);
    assert.equal(writes, count);
    board.setReadonly(true); draw(board, 6); await board.flush();
    assert.deepEqual(board.getDocument(), before);
    assert.equal(writes, count);
  } finally { board.destroy(); }
});

test('two-finger zoom cancels an accidental finger stroke and pen activity rejects palm touches', async () => {
  let writes = 0;
  const board = createBoard({onSave: async () => { writes++; }});
  try {
    board.setFingerDrawing(true);
    board.pointerDown(event(7, 100, 100, 'touch'));
    board.pointerDown(event(8, 300, 100, 'touch'));
    board.pointerUp(event(7, 100, 100, 'touch'));
    board.pointerUp(event(8, 300, 100, 'touch'));
    await board.flush();
    assert.equal(board.document.strokes.length, 0);
    assert.equal(writes, 0);
    board.pointerDown(event(9, 20, 20, 'pen'));
    board.pointerDown(event(10, 100, 100, 'touch'));
    assert.equal(board.touches.size, 0);
    board.pointerUp(event(9, 20, 20, 'pen'));
    await board.flush();
    assert.equal(board.document.strokes.length, 1);
    assert.equal(writes, 1);
  } finally { board.destroy(); }
});
