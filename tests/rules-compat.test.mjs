import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, readdir, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRule } from '../rules/runtime.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const web = path.resolve(root, '..', 'quizforge_web');
const runner = path.join(web, 'core', 'server', 'rules-runner.cjs');
const exists = await readFile(runner, 'utf8').then(() => true, () => false);
const json = file => readFile(file, 'utf8').then(JSON.parse);
let child, outputLines, scratch;
const awaiting = [];

before(async () => {
  if (!exists) return;
  child = spawn(process.execPath, [runner, '--serve'], { cwd: path.join(web, 'core'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  outputLines = createInterface({ input: child.stdout });
  outputLines.on('line', value => {
    const next = awaiting.shift();
    if (next) { try { next.resolve(JSON.parse(value)); } catch (error) { next.reject(error); } }
  });
  child.on('error', error => { for (const next of awaiting.splice(0)) next.reject(error); });
  child.on('close', code => { for (const next of awaiting.splice(0)) next.reject(new Error(`Web rule runner exited with ${code}`)); });
  const base = path.join(root, '.temp');
  await mkdir(base, { recursive: true });
  scratch = await mkdtemp(path.join(base, 'rule-contract-'));
});

after(async () => {
  child?.stdin.end();
  outputLines?.close();
  child?.kill();
  if (scratch) {
    const base = path.resolve(root, '.temp');
    assert.equal(path.dirname(path.resolve(scratch)), base);
    assert.ok(path.basename(scratch).startsWith('rule-contract-'));
    await rm(scratch, { recursive: true, force: true });
  }
});

function webRun(request) {
  return new Promise((resolve, reject) => {
    awaiting.push({ resolve, reject });
    child.stdin.write(JSON.stringify(request) + '\n');
  });
}

async function compare(base, operation) {
  const request = { ...base, ...operation };
  const expected = await webRun(request);
  const actual = runRule({ ...request, rules: await readFile(base.rules, 'utf8'),
    questionSchema: await json(base.questionSchema), answerSchema: await json(base.answerSchema) });
  assert.deepEqual(actual, expected, `${operation.op} differs from QuizForge Web`);
  return actual;
}

async function fixtures() {
  const result = [], extensions = path.join(web, 'extensions');
  for (const group of await readdir(extensions, { withFileTypes: true })) {
    if (!group.isDirectory() || group.name.startsWith('.')) continue;
    for (const entry of await readdir(path.join(extensions, group.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(extensions, group.name, entry.name);
      const manifest = await json(path.join(directory, 'manifest.json')).catch(() => null);
      if (!manifest) continue;
      const bank = await json(path.join(directory, manifest.examples));
      result.push({ label: `${group.name}/${entry.name}`, directory, manifest, bank });
    }
  }
  return result;
}

function emptyAnswer(schema) {
  const values = { selectedOptionId: null, selectedOptionIds: [], value: null, responses: {},
    formatVersion: 1, document: { type: 'doc', content: [{ type: 'paragraph', content: [] }] } };
  return Object.fromEntries((schema.required || []).map(key => [key, values[key] ?? (key === 'value' || key === 'selectedOptionId' ? null : {})]));
}

test('existing local extension rules match the Web runner for practice, grading and review', { skip: !exists, timeout: 180000 }, async t => {
  const examples = await fixtures();
  assert.ok(examples.length >= 4, 'Expected the four distributable base question types');
  for (const { label, directory, manifest, bank } of examples) {
    await t.test(label, async () => {
      const base = { rules: path.join(directory, manifest.rules), questionSchema: path.join(directory, manifest.questionSchema),
        answerSchema: path.join(directory, manifest.answerSchema), apiVersion: { major: 1, minor: 5 },
        outlineItemsDeclared: manifest.requiresApi?.capabilities?.includes('outline-items') === true,
        answerStateDeclared: manifest.requiresApi?.capabilities?.includes('answer-state') === true };
      const data = bank.questions[0].data;
      const answer = emptyAnswer(await json(base.answerSchema));
      const caps = await compare(base, { op: 'capabilities' });
      assert.equal(caps.ok, true);
      assert.equal((await compare(base, { op: 'validateBank', questions: bank.questions.slice(0, 3).map(value => value.data) })).ok, true);
      assert.equal((await compare(base, { op: 'project', data, state: { submitted: false, result: null }, withCapabilities: true })).ok, true);
      assert.equal((await compare(base, { op: 'projectBatch', questions: [{ data, state: { submitted: false, result: null } }] })).ok, true);
      await compare(base, { op: 'scoreBatch', questions: [{ data, state: { status: 'unanswered', answer: null, result: null, revision: 0 } }] });
      if (base.outlineItemsDeclared) assert.equal((await compare(base, { op: 'outlineBatch', questions: [data] })).ok, true);
      await compare(base, { op: 'validateAnswer', data, answer, projectAfterValidation: true, outlineAfterValidation: true, outlineRevision: 1 });
      const submitted = await compare(base, { op: 'submit', data, answer, withCapabilities: true });
      if (submitted.ok) {
        const state = { submitted: true, status: 'submitted', answer, result: submitted.data.result, revision: 1 };
        await compare(base, { op: 'scoreBatch', questions: [{ data, state }] });
        await compare(base, { op: 'project', data, state });
        if (caps.data.canAiGrade) {
          await compare(base, { op: 'prepareAiGrading', data, answer, state, automatic: true });
          await compare(base, { op: 'review', data, answer, state, review: { score: 0, feedback: 'Compatibility test' } });
        }
      }
      const invalid = await compare(base, { op: 'validateAnswer', data, answer: { unexpected: true } });
      assert.equal(invalid.ok, false);
    });
  }
});

async function synthetic(source, questionSchema = true, answerSchema = true) {
  const index = synthetic.index = (synthetic.index || 0) + 1;
  const files = { rules: path.join(scratch, `rules-${index}.js`),
    questionSchema: path.join(scratch, `question-${index}.json`), answerSchema: path.join(scratch, `answer-${index}.json`) };
  await Promise.all([writeFile(files.rules, source), writeFile(files.questionSchema, JSON.stringify(questionSchema)),
    writeFile(files.answerSchema, JSON.stringify(answerSchema))]);
  return { ...files, apiVersion: { major: 1, minor: 5 } };
}

test('public projection hides answers, strict schemas reject unknown fields, and review preserves pending semantics', { skip: !exists }, async () => {
  const base = await synthetic(`QF.defineType({
    project(data,state){return {stem:data.stem,...(state.submitted?{key:data.key}:{})};},
    grade(data,answer){return answer.pending?{gradingStatus:'pending',score:null,maxScore:2,correct:null,feedback:null}:{score:answer.value===data.key?2:0,maxScore:2,correct:answer.value===data.key,feedback:'done'};},
    getScore(data,state){return {score:state.submitted?state.result.score:0,maxScore:2};},
    review(data,answer,review,context){return {gradingStatus:'graded',score:review.score,maxScore:2,correct:review.score===2,feedback:context.state.result.feedback};},
    prepareAiGrading(data,answer,context){return {referenceAnswer:data.key,targetId:context.targetId||null};}
  });`, { type: 'object', properties: { stem: { type: 'string' }, key: { type: 'string' } }, required: ['stem', 'key'], additionalProperties: false },
  { type: 'object', properties: { value: { type: 'string' }, pending: { type: 'boolean' } }, additionalProperties: false });
  const data = { stem: 'Question', key: 'secret' }, answer = { pending: true };
  const projected = await compare(base, { op: 'project', data, state: { submitted: false, result: null } });
  assert.deepEqual(projected.data.projected, { stem: 'Question' });
  const result = (await compare(base, { op: 'submit', data, answer })).data.result;
  assert.equal(result.score, null);
  const state = { status: 'submitted', submitted: true, answer, result };
  await compare(base, { op: 'scoreBatch', questions: [{ data, state }] });
  await compare(base, { op: 'prepareAiGrading', data, answer, state, targetId: 'part-a' });
  assert.equal((await compare(base, { op: 'review', data, answer, state, review: { score: 1 } })).data.result.score, 1);
  assert.equal((await compare(base, { op: 'submit', data, answer: { unknown: true } })).ok, false);
});

test('API requirements, outline validation and VM reset boundaries match Web', { skip: !exists }, async () => {
  const base = await synthetic(`globalThis.counter=0;QF.defineType({
    validateQuestion(){globalThis.counter++;},
    project(){return {counter:globalThis.counter};},
    grade(){return {score:1,maxScore:1,correct:true,feedback:null};},
    getOutlineItems(){return [{id:'child',label:'Child'}];}
  });`);
  await compare(base, { op: 'capabilities', outlineItemsDeclared: true, apiVersion: { major: 1, minor: 4 } });
  const undeclared = await compare(base, { op: 'capabilities' });
  assert.equal(undeclared.code, 'INVALID_OUTLINE_ITEMS');
  assert.equal((await compare(base, { op: 'capabilities', outlineItemsDeclared: true, apiVersion: { major: 2, minor: 0 } })).code, 'UNSUPPORTED_API_VERSION');
  assert.equal((await compare(base, { op: 'capabilities', outlineItemsDeclared: true, apiVersion: { major: 1, minor: -1 } })).code, 'INVALID_API_VERSION');
  await compare(base, { op: 'validateBank', outlineItemsDeclared: true, questions: [{}, {}, {}], contextResetOffsets: [1] });
  const reset = await compare(base, { op: 'validateAnswer', outlineItemsDeclared: true, data: {}, answer: {}, projectAfterValidation: true });
  assert.equal(reset.data.projected.counter, 1);
  await compare(base, { op: 'outlineBatch', outlineItemsDeclared: true, questions: [{}, {}], contextResetOffsets: [1] });
  const duplicate = await synthetic(`QF.defineType({project(){return {};},grade(){return {score:0,maxScore:1,correct:false,feedback:null};},getOutlineItems(){return [{id:'x',label:'X'},{id:'x',label:'Again'}];}});`);
  assert.equal((await compare(duplicate, { op: 'outlineBatch', outlineItemsDeclared: true, questions: [{}] })).code, 'INVALID_OUTLINE_ITEMS');
});

test('invalid grade output, child states and score/result mismatch are rejected', { skip: !exists }, async () => {
  const malformed = await synthetic(`QF.defineType({project(){return {};},grade(){return {score:1,maxScore:1,correct:true};}});`);
  assert.equal((await compare(malformed, { op: 'submit', data: {}, answer: {} })).ok, false);
  const mismatch = await synthetic(`QF.defineType({project(){return {};},grade(){return {score:1,maxScore:1,correct:true,feedback:null};},review(){return {score:1,maxScore:1,correct:true,feedback:null};},getScore(){return {score:0,maxScore:1};},prepareAiGrading(){return {};}});`);
  assert.equal((await compare(mismatch, { op: 'review', data: {}, answer: {}, state: {}, review: { score: 1 } })).code, 'SCORE_UNAVAILABLE');
  const states = await synthetic(`QF.defineType({project(){return {};},grade(){return {score:0,maxScore:1,correct:false,feedback:null};},getScore(){return {score:0,maxScore:1,outlineStates:[{id:'x',status:'correct'}]};}});`);
  assert.equal((await compare(states, { op: 'scoreBatch', data: {}, questions: [{ data: {}, state: { status: 'draft', answer: {}, result: null } }] })).code, 'INVALID_OUTLINE_STATES');
});
