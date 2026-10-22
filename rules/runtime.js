import Ajv from 'ajv';

// This runner belongs in a fresh, native JavaScriptSandbox isolate per request.
// The function wrapper is a compatibility adapter, not a hostile-code sandbox.
// No Android object, filesystem, networking or DOM API may be bound to the isolate.
// The native owner must enforce the wall-clock deadline and memory budget.
const INPUT_LIMIT = 8 * 1024 * 1024;
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const RULE_LIMIT = 1024 * 1024;
const CAPABILITIES = Object.freeze([
  'practice', 'editor', 'editor-drafts', 'score', 'manual-review', 'ai-grading',
  'resources', 'richtext', 'navigation', 'lifecycle', 'outline-items',
  'answer-state', 'appearance', 'answer-areas',
]);
const PUBLIC_ERRORS = new Set([
  'SCORE_UNAVAILABLE', 'INVALID_API_VERSION', 'UNSUPPORTED_API_VERSION',
  'INVALID_OUTLINE_ITEMS', 'INVALID_OUTLINE_STATES',
]);

// JavaScriptSandbox does not promise browser globals such as TextEncoder.
function byteLength(value) {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length
      && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4; i++;
    } else bytes += 3;
  }
  return bytes;
}
const clone = value => JSON.parse(JSON.stringify(value));
const codedError = (message, code) => Object.assign(new Error(message), { code });

function selectRuleApi(value) {
  if (value === undefined) value = { major: 1, minor: 0 };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isInteger(value.major) || value.major < 1 || value.major > 2147483647
    || !Number.isInteger(value.minor) || value.minor < 0 || value.minor > 2147483647) {
    throw codedError('Invalid rule API version', 'INVALID_API_VERSION');
  }
  if (value.major !== 1 || value.minor > 5) {
    throw codedError('Unsupported rule API version; this runner supports v1.5, v1.4, v1.3, v1.2, v1.1 and v1.0', 'UNSUPPORTED_API_VERSION');
  }
  return value;
}

function loadType(source, development) {
  let type = null;
  const QF = Object.freeze({
    api: Object.freeze({ major: 1, minor: 5, capabilities: CAPABILITIES }),
    defineType(value) {
      if (type || !value || typeof value !== 'object' || Array.isArray(value)
        || (!development && (typeof value.project !== 'function' || typeof value.grade !== 'function'))) {
        throw new Error('Invalid rule registration');
      }
      for (const name of ['project', 'grade', 'validateQuestion', 'validateAnswer', 'getScore', 'review', 'prepareAiGrading']) {
        if (value[name] != null && typeof value[name] !== 'function') throw new Error('Invalid validator');
      }
      if (value.getOutlineItems != null && typeof value.getOutlineItems !== 'function') {
        throw codedError('Invalid outline hook', 'INVALID_OUTLINE_ITEMS');
      }
      type = value;
    },
  });
  // Rebuild explicit globalThis state at the same boundaries as the Web VM.
  // Common ECMAScript intrinsics remain available to standards-compliant rules.
  const scope = Object.create(null);
  for (const name of [
    'Object', 'Array', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'Math',
    'JSON', 'Reflect', 'RegExp', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'ArrayBuffer', 'DataView', 'Uint8Array', 'Uint8ClampedArray', 'Int8Array',
    'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
    'Float64Array', 'Promise', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
    'ReferenceError', 'URIError', 'EvalError', 'parseInt', 'parseFloat',
    'isFinite', 'isNaN', 'encodeURI', 'decodeURI', 'encodeURIComponent',
    'decodeURIComponent', 'Infinity', 'NaN', 'undefined',
  ]) {
    if (name in globalThis) scope[name] = globalThis[name];
  }
  scope.QF = QF;
  scope.globalThis = scope;
  scope.self = scope;
  // Native sandbox isolation is essential: Function itself cannot contain
  // hostile JS. Parameters merely prevent accidental desktop dependencies.
  const execute = new Function('QF', 'globalThis', 'self', 'window', 'document',
    'fetch', 'XMLHttpRequest', 'require', 'process', 'Buffer', 'WebAssembly', source);
  execute(QF, scope, scope);
  if (!type) throw new Error('Missing rule registration');
  return type;
}

function validateResult(result, allowPending = true) {
  const status = result?.gradingStatus ?? 'graded';
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || (Object.hasOwn(result, 'gradingStatus') && typeof result.gradingStatus !== 'string')
    || !['pending', 'graded'].includes(status) || !Number.isFinite(result.maxScore)
    || result.maxScore < 0 || !Object.hasOwn(result, 'feedback')) throw new Error('Invalid grade result');
  if (status === 'pending') {
    if (!allowPending || result.score !== null || result.correct !== null) throw new Error('Invalid pending grade result');
  } else if (!Number.isFinite(result.score) || typeof result.correct !== 'boolean') throw new Error('Invalid grade result');
  return status;
}

function validateOutlineStates(items, submitted) {
  const invalid = () => { throw codedError('Invalid outlineStates returned by getScore', 'INVALID_OUTLINE_STATES'); };
  if (!Array.isArray(items) || items.length > 100) invalid();
  const ids = new Set(), statuses = new Set(['unanswered', 'draft', 'correct', 'incorrect']);
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2
      || !Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'status')
      || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 128
      || item.id !== item.id.trim() || /[\u0000-\u001f\u007f-\u009f<>]/u.test(item.id)
      || ids.has(item.id) || !statuses.has(item.status)
      || (!submitted && !['unanswered', 'draft'].includes(item.status))
      || (submitted && item.status === 'draft')) invalid();
    ids.add(item.id);
  }
  return items;
}

function validateAiScore(score, result) {
  if (!score || typeof score !== 'object' || Array.isArray(score)
    || score.score !== result.score || score.maxScore !== result.maxScore
    || (Object.hasOwn(score, 'gradingStatus') && score.gradingStatus !== (result.gradingStatus ?? 'graded'))) {
    throw codedError('AI grading getScore must match the submitted result', 'SCORE_UNAVAILABLE');
  }
  if (Object.hasOwn(score, 'outlineStates')) validateOutlineStates(score.outlineStates, true);
}

/** Run one Web-compatible rule request, returning the Web runner wire envelope. */
export function runRule(input) {
  let development = false;
  try {
    const encodedInput = typeof input === 'string' ? input : JSON.stringify(input);
    if (typeof encodedInput !== 'string' || byteLength(encodedInput) > INPUT_LIMIT) throw new Error('Input limit exceeded');
    const request = JSON.parse(encodedInput);
    development = request.development === true;
    const api = selectRuleApi(request.apiVersion);
    const requestedMinor = api.minor;
    if (typeof request.rules !== 'string' || byteLength(request.rules) > RULE_LIMIT) throw new Error('Rule asset exceeds limit');
    const ajv = new Ajv({ allErrors: false, strict: true, validateFormats: false });
    const validQuestion = ajv.compile(development && !request.questionSchema ? true : request.questionSchema);
    const validAnswer = ajv.compile(development && !request.answerSchema ? true : request.answerSchema);
    let type;
    const resetContext = () => { type = loadType(request.rules, development); };
    resetContext();
    const canOutlineItems = typeof type.getOutlineItems === 'function';
    const outlineError = () => { throw codedError('Invalid outline items or undeclared outline-items capability', 'INVALID_OUTLINE_ITEMS'); };
    if (canOutlineItems && (request.outlineItemsDeclared !== true || requestedMinor < 1)) outlineError();
    const notImplemented = name => { throw codedError(`Development extension has not implemented ${name}`, 'DEVELOPMENT_NOT_IMPLEMENTED'); };
    const requireHook = name => { if (development && typeof type[name] !== 'function') notImplemented(name); };
    const call = (name, ...values) => clone(type[name](...values.map(value => value === undefined ? undefined : clone(value))));
    const project = (data, state) => development && typeof type.project !== 'function' ? clone(data) : call('project', data, state);
    const validateQ = data => {
      if (!validQuestion(data)) throw new Error('Question schema validation failed');
      if (type.validateQuestion && type.validateQuestion(clone(data)) === false) throw new Error('Question validation failed');
    };
    const resetOffsets = maximum => {
      const offsets = request.contextResetOffsets ?? [];
      if (!Array.isArray(offsets) || offsets.length > maximum
        || offsets.some((offset, index) => !Number.isInteger(offset) || offset <= 0
          || offset >= maximum || (index > 0 && offset <= offsets[index - 1]))) {
        throw new Error(request.op === 'outlineBatch' ? 'Invalid outline boundaries' : 'Invalid validation boundaries');
      }
      return offsets;
    };
    const scoreValue = (data, state) => typeof type.getScore === 'function'
      ? call('getScore', data, state)
      : state.submitted ? { score: state.result?.score, maxScore: state.result?.maxScore }
        : { score: 0, maxScore: project(data, { submitted: false, result: null })?.maxScore };
    const validateScore = (score, gradingStatus) => {
      if (!score || typeof score !== 'object' || Array.isArray(score)
        || !Number.isFinite(score.maxScore) || score.maxScore < 0
        || (gradingStatus === 'pending' ? score.score !== null : !Number.isFinite(score.score))) {
        if (development && typeof type.getScore !== 'function') notImplemented('getScore');
        throw codedError('Extension must provide finite score and maxScore through getScore', 'SCORE_UNAVAILABLE');
      }
    };
    let output;
    if (request.op === 'capabilities') {
      output = { canAiGrade: typeof type.prepareAiGrading === 'function' && typeof type.review === 'function', canOutlineItems };
    } else if (request.op === 'validateBank') {
      if (!Array.isArray(request.questions) || request.questions.length > 10000) throw new Error('Invalid question list');
      const offsets = resetOffsets(request.questions.length); let nextReset = 0;
      for (let index = 0; index < request.questions.length; index++) {
        if (index === offsets[nextReset]) { resetContext(); nextReset++; }
        validateQ(request.questions[index]);
      }
      output = { valid: true };
    } else if (request.op === 'outlineBatch') {
      if (requestedMinor < 1 || request.outlineItemsDeclared !== true) outlineError();
      if (!Array.isArray(request.questions) || request.questions.length > 10000) outlineError();
      const offsets = resetOffsets(request.questions.length); let nextReset = 0;
      const outlineItems = [];
      const plain = (value, maximum) => typeof value === 'string' && value.length > 0
        && value.length <= maximum && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f<>]/u.test(value);
      for (let index = 0; index < request.questions.length; index++) {
        if (index === offsets[nextReset]) { resetContext(); nextReset++; }
        const question = request.questions[index]; validateQ(question);
        let items;
        try { items = canOutlineItems ? call('getOutlineItems', question) : []; } catch { outlineError(); }
        if (!Array.isArray(items) || items.length > 100) outlineError();
        const ids = new Set();
        for (const item of items) {
          if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2
            || !plain(item.id, 128) || !plain(item.label, 80) || ids.has(item.id)) outlineError();
          ids.add(item.id);
        }
        outlineItems.push(items);
      }
      output = { outlineItems };
    } else if (request.op === 'scoreBatch') {
      if (!Array.isArray(request.questions) || request.questions.length > 10000) throw new Error('Invalid scoring list');
      const scores = [];
      for (const question of request.questions) {
        if (!question || !question.state || !['unanswered', 'draft', 'submitted'].includes(question.state.status)) throw new Error('Invalid scoring state');
        validateQ(question.data);
        const state = { ...question.state, submitted: question.state.status === 'submitted' };
        const gradingStatus = state.submitted ? validateResult(state.result) : 'unsubmitted';
        const score = scoreValue(question.data, state); validateScore(score, gradingStatus);
        const value = { score: score.score, maxScore: score.maxScore, gradingStatus };
        if (Object.hasOwn(score, 'outlineStates') && (state.submitted || request.answerStateDeclared !== true)) {
          value.outlineStates = validateOutlineStates(score.outlineStates, state.submitted);
        }
        scores.push(value);
      }
      output = { scores };
    } else if (request.op === 'projectBatch') {
      if (!Array.isArray(request.questions) || request.questions.length > 10000) throw new Error('Invalid projection list');
      const projected = []; let bytes = 64;
      for (const question of request.questions) {
        if (!question || !question.state || typeof question.state.submitted !== 'boolean') throw new Error('Invalid projection state');
        validateQ(question.data);
        const value = project(question.data, question.state);
        bytes += byteLength(JSON.stringify(value)) + 1;
        if (bytes > OUTPUT_LIMIT) throw new Error('Output limit exceeded');
        projected.push(value);
      }
      output = { projected };
    } else {
      validateQ(request.data);
      if (['submit', 'validateAnswer', 'review', 'prepareAiGrading'].includes(request.op)) {
        if (development && !request.answerSchema) notImplemented('answer schema');
        if (request.op === 'submit') requireHook('grade');
        if (request.op === 'review') requireHook('review');
        if (request.op === 'prepareAiGrading') requireHook('prepareAiGrading');
        if (!validAnswer(request.answer)) throw new Error('Answer schema validation failed');
        if (type.validateAnswer && type.validateAnswer(clone(request.answer), clone(request.data)) === false) throw new Error('Answer validation failed');
      }
      if (request.op === 'prepareAiGrading') {
        if (typeof type.prepareAiGrading !== 'function' || typeof type.review !== 'function') throw new Error('AI grading is unavailable');
        validateResult(request.state?.result);
        const context = { state: request.state,
          ...(request.targetId == null ? {} : { targetId: request.targetId }),
          ...(request.automatic === true ? { automatic: true } : {}) };
        output = { gradingInput: call('prepareAiGrading', request.data, request.answer, context) };
      } else if (request.op === 'submit' || request.op === 'review') {
        if (request.op === 'review' && (!request.review || typeof request.review !== 'object'
          || Array.isArray(request.review) || !Number.isFinite(request.review.score)
          || typeof type.review !== 'function')) throw new Error('Invalid review request');
        const result = request.op === 'review'
          ? call('review', request.data, request.answer, request.review, { state: request.state })
          : call('grade', request.data, request.answer);
        validateResult(result, request.op !== 'review');
        const state = { submitted: true, result };
        if (request.op === 'review' && typeof type.prepareAiGrading === 'function') {
          validateAiScore(typeof type.getScore === 'function' ? call('getScore', request.data, state) : result, result);
        }
        output = { result, projected: project(request.data, state) };
      } else if (request.op === 'project') {
        output = { projected: project(request.data, request.state) };
      } else if (request.op === 'validateAnswer') {
        output = { valid: true };
        if (request.projectAfterValidation === true) {
          resetContext(); validateQ(request.data);
          output.projected = project(request.data, { submitted: false, result: null });
        }
        if (request.outlineAfterValidation === true && request.answerStateDeclared !== true) {
          try {
            resetContext(); validateQ(request.data);
            const state = { status: 'draft', submitted: false,
              ...(request.outlineRevision === undefined ? {} : { revision: request.outlineRevision }),
              answer: request.answer, result: null };
            const score = scoreValue(request.data, state); validateScore(score, 'unsubmitted');
            output.outlineScore = { score: score.score, maxScore: score.maxScore, gradingStatus: 'unsubmitted' };
            if (Object.hasOwn(score, 'outlineStates')) output.outlineScore.outlineStates = validateOutlineStates(score.outlineStates, false);
          } catch (error) {
            if (!development || error.code !== 'DEVELOPMENT_NOT_IMPLEMENTED') throw error;
          }
        }
      } else throw new Error('Unknown rule operation');
    }
    if (request.withCapabilities === true) output.capabilities = {
      canAiGrade: typeof type.prepareAiGrading === 'function' && typeof type.review === 'function', canOutlineItems,
    };
    const result = { ok: true, data: output }, encoded = JSON.stringify(result);
    if (byteLength(encoded) > OUTPUT_LIMIT) throw new Error('Output limit exceeded');
    return JSON.parse(encoded);
  } catch (error) {
    return {
      ok: false,
      ...(PUBLIC_ERRORS.has(error.code) || (development && error.code === 'DEVELOPMENT_NOT_IMPLEMENTED') ? { code: error.code } : {}),
      error: String(error.message || error).slice(0, 200),
    };
  }
}
