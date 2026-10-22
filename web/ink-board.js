const WIDTH = 760;
const DEFAULT_HEIGHT = 1100;
const MAX_STROKES = 2000;
const MAX_POINTS = 100000;
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function readInkDocument(value) {
  if (value == null) return {formatVersion: 1, width: WIDTH, height: DEFAULT_HEIGHT, strokes: []};
  if (typeof value !== 'object' || !Array.isArray(value.strokes) || value.strokes.length > MAX_STROKES) throw new Error('草稿格式无法读取，原有内容已保留。');
  const height = finite(value.height) ? value.height : DEFAULT_HEIGHT;
  if (height < 100 || height > 20000) throw new Error('草稿尺寸无效，原有内容已保留。');
  let pointCount = 0;
  const strokes = value.strokes.map((stroke, index) => {
    if (!stroke || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 10000 || !/^#[0-9a-f]{6}$/i.test(stroke.color) || !finite(stroke.width) || stroke.width < .5 || stroke.width > 32) throw new Error('草稿笔迹无法读取，原有内容已保留。');
    const points = stroke.points.map(point => {
      if (!point || !finite(point.x) || !finite(point.y) || Math.abs(point.x) > 1000000 || Math.abs(point.y) > 1000000 || point.pressure != null && (!finite(point.pressure) || point.pressure < 0 || point.pressure > 1)) throw new Error('草稿坐标无效，原有内容已保留。');
      if (++pointCount > MAX_POINTS) throw new Error('草稿笔迹过多，原有内容已保留。');
      return {x: point.x, y: point.y, pressure: point.pressure ?? .5};
    });
    return {id: typeof stroke.id === 'string' ? stroke.id : `stroke-${index}`, color: stroke.color, width: stroke.width, points};
  });
  return {formatVersion: 1, width: finite(value.width) && value.width > 0 ? value.width : WIDTH, height, strokes};
}

function segmentDistance(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, size = dx * dx + dy * dy;
  const t = size ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / size, 0, 1) : 0;
  return Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t);
}

export class InkBoard {
  constructor(canvas, viewport, {document = null, readonly = false, onSave = async () => {}, onStatus = () => {}, onError = () => {}, onTools = () => {}} = {}) {
    this.canvas = canvas;
    this.viewport = viewport;
    this.ctx = canvas.getContext('2d', {alpha: false});
    if (!this.ctx) throw new Error('当前设备无法创建草稿画布。');
    this.document = readInkDocument(document);
    this.readonly = readonly;
    this.onSave = onSave;
    this.onStatus = onStatus;
    this.onError = onError;
    this.onTools = onTools;
    this.tool = 'pen';
    this.color = '#25324a';
    this.penWidth = 3;
    this.fingerDrawing = false;
    this.view = {scale: 1, x: 0, y: 0};
    this.undoStack = [];
    this.redoStack = [];
    this.touches = new Map();
    this.lastPenAt = -Infinity;
    this.active = null;
    this.version = 0;
    this.savedVersion = 0;
    this.saveTail = Promise.resolve();
    this.destroyed = false;
    this.listeners = [];
    for (const [name, callback] of [
      ['pointerdown', event => this.pointerDown(event)],
      ['pointermove', event => this.pointerMove(event)],
      ['pointerup', event => this.pointerUp(event)],
      ['pointercancel', event => this.pointerUp(event)],
      ['lostpointercapture', event => { if (this.active?.pointerId === event.pointerId) this.finishStroke(); }],
      ['contextmenu', event => event.preventDefault()]
    ]) {
      canvas.addEventListener(name, callback, {passive: false});
      this.listeners.push([name, callback]);
    }
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(viewport);
    this.resize();
    this.updateTools();
  }

  get hasUnsavedChanges() { return this.savedVersion !== this.version || !!this.active; }
  getDocument() { return clone(this.document); }
  get pointCount() { return this.document.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0); }

  setReadonly(value) {
    if (value && this.active) this.finishStroke();
    this.readonly = !!value;
    this.updateTools();
  }

  setTool(value) { this.tool = value === 'eraser' ? 'eraser' : 'pen'; this.updateTools(); }
  setColor(value) { if (/^#[0-9a-f]{6}$/i.test(value)) this.color = value; this.setTool('pen'); }
  setWidth(value) { this.penWidth = clamp(Number(value) || 3, .5, 32); }
  setFingerDrawing(value) { this.fingerDrawing = !!value; this.updateTools(); }

  updateTools() {
    this.onTools({tool: this.tool, color: this.color, fingerDrawing: this.fingerDrawing, canUndo: !this.readonly && !!this.undoStack.length, canRedo: !this.readonly && !!this.redoStack.length, readonly: this.readonly});
  }

  pushUndo() {
    this.undoStack.push(clone(this.document.strokes));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (this.readonly || !this.undoStack.length) return;
    this.finishStroke();
    this.redoStack.push(clone(this.document.strokes));
    this.document.strokes = this.undoStack.pop();
    this.changed();
    this.requestRender();
  }

  redo() {
    if (this.readonly || !this.redoStack.length) return;
    this.finishStroke();
    this.undoStack.push(clone(this.document.strokes));
    this.document.strokes = this.redoStack.pop();
    this.changed();
    this.requestRender();
  }

  clear() {
    if (this.readonly || !this.document.strokes.length) return;
    this.finishStroke();
    this.pushUndo();
    this.document.strokes = [];
    this.changed();
    this.requestRender();
  }

  resetView() { this.view = {scale: 1, x: 0, y: 0}; this.render(); }

  requestRender() {
    if (this.paintFrame != null || this.destroyed) return;
    this.paintFrame = requestAnimationFrame(() => { this.paintFrame = null; this.render(); });
  }

  resize() {
    const rect = this.viewport.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.requestRender();
  }

  screenPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {x: event.clientX - rect.left, y: event.clientY - rect.top};
  }

  toWorld(screen) {
    const base = this.width / this.document.width;
    return {x: (screen.x / base - this.view.x) / this.view.scale, y: (screen.y / base - this.view.y) / this.view.scale};
  }

  pointerDown(event) {
    if (this.destroyed) return;
    event.preventDefault();
    const isPen = event.pointerType === 'pen';
    const isTouch = event.pointerType === 'touch';
    if (isPen) this.lastPenAt = performance.now();
    if (isTouch && (this.active?.type === 'pen' || performance.now() - this.lastPenAt < 1100)) return;
    try { this.canvas.setPointerCapture(event.pointerId); } catch {}
    const screen = this.screenPoint(event);
    if (isTouch) {
      this.touches.set(event.pointerId, screen);
      if (this.touches.size >= 2) {
        if (this.active?.type === 'touch') this.cancelStroke();
        this.beginGesture();
        return;
      }
      if (!this.fingerDrawing || this.readonly) { this.panStart = {point: screen, view: {...this.view}}; return; }
    }
    if (this.readonly || this.active || !isPen && !isTouch && event.button !== 0) return;
    if (this.document.strokes.length >= MAX_STROKES || this.pointCount >= MAX_POINTS) { this.onError(new Error('草稿已达到笔迹上限，请先整理已有笔迹。')); return; }
    this.pushUndo();
    this.active = {pointerId: event.pointerId, type: event.pointerType, erased: false, stroke: null};
    if (this.tool === 'eraser' || isPen && (event.button === 5 || (event.buttons & 32))) {
      this.active.erasing = true;
      this.eraseAt(this.toWorld(screen));
    } else {
      const stroke = {id: crypto.randomUUID?.() || `stroke-${Date.now()}-${Math.random().toString(36).slice(2)}`, color: this.color, width: this.penWidth, points: []};
      this.active.stroke = stroke;
      this.document.strokes.push(stroke);
      this.appendPoint(event);
    }
    this.onStatus('dirty');
    this.updateTools();
    this.render();
  }

  beginGesture() {
    const points = [...this.touches.values()].slice(0, 2);
    const midpoint = {x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2};
    this.gesture = {distance: Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)), world: this.toWorld(midpoint), scale: this.view.scale};
    this.panStart = null;
  }

  pointerMove(event) {
    if (this.destroyed) return;
    event.preventDefault();
    const screen = this.screenPoint(event);
    if (this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, screen);
      if (this.gesture && this.touches.size >= 2) {
        const points = [...this.touches.values()].slice(0, 2);
        const midpoint = {x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2};
        const scale = clamp(this.gesture.scale * Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / this.gesture.distance, .7, 4);
        const base = this.width / this.document.width;
        this.view = {scale, x: midpoint.x / base - this.gesture.world.x * scale, y: midpoint.y / base - this.gesture.world.y * scale};
        this.clampView();
        this.requestRender();
        return;
      }
      if (this.panStart && !this.active) {
        const base = this.width / this.document.width;
        this.view.x = this.panStart.view.x + (screen.x - this.panStart.point.x) / base;
        this.view.y = this.panStart.view.y + (screen.y - this.panStart.point.y) / base;
        this.clampView();
        this.requestRender();
        return;
      }
    }
    if (this.active?.pointerId !== event.pointerId) return;
    if (event.pointerType === 'pen') this.lastPenAt = performance.now();
    if (this.active.erasing) this.eraseAt(this.toWorld(screen));
    else {
      const samples = event.getCoalescedEvents?.() || [event];
      for (const sample of samples.length ? samples : [event]) this.appendPoint(sample);
    }
    this.requestRender();
  }

  appendPoint(event) {
    const stroke = this.active?.stroke;
    if (!stroke || stroke.points.length >= 10000 || this.pointCount >= MAX_POINTS) return;
    const world = this.toWorld(this.screenPoint(event));
    const point = {x: clamp(world.x, 0, this.document.width), y: clamp(world.y, 0, this.document.height), pressure: event.pointerType === 'pen' ? clamp(event.pressure || .35, .05, 1) : .5};
    const previous = stroke.points.at(-1);
    if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) >= .25) stroke.points.push(point);
  }

  eraseAt(point) {
    const radius = 14 / this.view.scale;
    const before = this.document.strokes.length;
    this.document.strokes = this.document.strokes.filter(stroke => !stroke.points.some((sample, index) => index ? segmentDistance(point, stroke.points[index - 1], sample) <= radius + stroke.width : Math.hypot(point.x - sample.x, point.y - sample.y) <= radius + stroke.width));
    if (before !== this.document.strokes.length) this.active.erased = true;
  }

  pointerUp(event) {
    if (this.destroyed) return;
    event.preventDefault();
    if (this.active?.pointerId === event.pointerId) this.finishStroke();
    this.touches.delete(event.pointerId);
    if (this.touches.size < 2) this.gesture = null;
    if (this.touches.size === 1) this.panStart = {point: [...this.touches.values()][0], view: {...this.view}};
    else if (!this.touches.size) this.panStart = null;
    try { this.canvas.releasePointerCapture(event.pointerId); } catch {}
  }

  cancelStroke() {
    if (!this.active) return;
    this.document.strokes = this.undoStack.pop() || [];
    this.active = null;
    this.updateTools();
    this.render();
    this.onStatus(this.savedVersion === this.version ? 'saved' : 'dirty');
  }

  finishStroke() {
    if (!this.active) return;
    const changed = this.active.erasing ? this.active.erased : !!this.active.stroke?.points.length;
    if (!changed) this.undoStack.pop();
    this.active = null;
    if (changed) this.changed();
    else this.updateTools();
  }

  clampView() {
    const base = this.width / this.document.width;
    this.view.x = clamp(this.view.x, -this.document.width * this.view.scale + this.document.width * .3, this.document.width * .7);
    this.view.y = clamp(this.view.y, -this.document.height * this.view.scale + this.height / base * .3, this.height / base * .7);
  }

  changed() {
    this.version++;
    this.onStatus('dirty');
    this.updateTools();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch(this.onError), 180);
  }

  save() {
    clearTimeout(this.saveTimer);
    const work = async () => {
      if (this.savedVersion === this.version) return;
      const version = this.version;
      const document = this.getDocument();
      this.onStatus('saving');
      try {
        await this.onSave(document);
        this.savedVersion = Math.max(this.savedVersion, version);
        this.onStatus(this.savedVersion === this.version ? 'saved' : 'dirty');
      } catch (error) { this.onStatus('error'); throw error; }
    };
    const job = this.saveTail.then(work, work);
    this.saveTail = job.catch(() => {});
    return job;
  }

  async flush() {
    this.finishStroke();
    clearTimeout(this.saveTimer);
    await this.saveTail;
    while (this.savedVersion !== this.version) await this.save();
  }

  render() {
    if (!this.width || !this.height || this.destroyed) return;
    const ctx = this.ctx, base = this.width / this.document.width;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#f8faff';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.translate(this.view.x * base, this.view.y * base);
    ctx.scale(base * this.view.scale, base * this.view.scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, this.document.width, this.document.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.document.width, this.document.height);
    ctx.clip();
    ctx.fillStyle = '#dfe6f1';
    for (let y = 24; y < this.document.height; y += 24) for (let x = 24; x < this.document.width; x += 24) ctx.fillRect(x, y, .9, .9);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of this.document.strokes) {
      const points = stroke.points;
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      if (points.length === 1) {
        const point = points[0];
        ctx.beginPath();
        ctx.arc(point.x, point.y, stroke.width * (.4 + point.pressure) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let index = 1; index < points.length; index++) {
        const before = points[index - 1], point = points[index];
        ctx.lineWidth = stroke.width * (.4 + (before.pressure + point.pressure) / 2);
        ctx.beginPath();
        ctx.moveTo(before.x, before.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  destroy() {
    clearTimeout(this.saveTimer);
    if (this.paintFrame != null) cancelAnimationFrame(this.paintFrame);
    this.resizeObserver.disconnect();
    for (const [name, callback] of this.listeners) this.canvas.removeEventListener(name, callback);
    this.destroyed = true;
  }
}
