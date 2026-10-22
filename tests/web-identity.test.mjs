import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';

const project = new URL('../', import.meta.url);
const pinnedRoot = new URL('vendor/quizforge-web/core/web/', project);
const stagedRoot = new URL('app/src/main/assets/web/', project);
const read = url => fs.readFile(url, 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lineEndings = text => text.replaceAll('\r\n', '\n');
const overrideHref = '/assets/web/android-overrides.css';
const preloadSrc = '/assets/web/android-preload.js';

function withoutAndroidTags(value) {
  return lineEndings(value)
    .replace(/^[\t ]*<link rel="stylesheet" href="\/assets\/web\/android-overrides\.css">\n/gm, '')
    .replace(/^[\t ]*<script src="\/assets\/web\/android-preload\.js"><\/script>\n/gm, '');
}

test('Android entry retains the exact original Web HTML with only preload and override tags added', async () => {
  const original = await read(new URL('index.html', pinnedRoot));
  const android = await read(new URL('web/index.html', project));
  assert.equal(withoutAndroidTags(android), lineEndings(original), 'Android must reuse the Web document instead of recreating its layout');
  const {document} = new JSDOM(android).window;
  const preloads = [...document.scripts].filter(script => script.getAttribute('src') === preloadSrc);
  assert.equal(preloads.length, 1);
  assert.equal(preloads[0].hasAttribute('type'), false, 'Preload must be a synchronous classic IIFE');
  assert.equal(preloads[0].hasAttribute('async'), false);
  assert.equal(preloads[0].hasAttribute('defer'), false);
  const originalApp = [...document.scripts].find(script => script.getAttribute('src') === '/app.js');
  assert.ok(originalApp, 'Original app.js module entry must remain');
  assert.equal(originalApp.type, 'module');
  assert.ok(preloads[0].compareDocumentPosition(originalApp) & 4, 'Native fetch interception must be installed before the original module starts');
  assert.equal(document.querySelectorAll(`link[href="${overrideHref}"]`).length, 1);
});

test('original stylesheet order, SVG branding and original navigation remain intact', async () => {
  const original = new JSDOM(await read(new URL('index.html', pinnedRoot))).window.document;
  const android = new JSDOM(await read(new URL('web/index.html', project))).window.document;
  const originalStyles = [...original.querySelectorAll('link[rel="stylesheet"]')].map(node => node.getAttribute('href'));
  const androidStyles = [...android.querySelectorAll('link[rel="stylesheet"]')].map(node => node.getAttribute('href'));
  assert.deepEqual(androidStyles, [...originalStyles, overrideHref]);
  assert.equal(android.querySelector('.brand').outerHTML, original.querySelector('.brand').outerHTML);
  assert.equal(android.querySelector('.brand-mark').getAttribute('src'), '/assets/quizforge-icon.svg');
  for (const selector of ['.document-header', '.question-navigation', '.outline', '#history-dialog']) {
    assert.equal(android.querySelector(selector).outerHTML, original.querySelector(selector).outerHTML, `Original ${selector} must be preserved`);
  }
  assert.equal(android.querySelector('link[href*="tablet.css"],script[src*="tablet-app.js"]'), null, 'The superseded custom shell must not be loaded');
});

test('Android stylesheet changes window fit only and does not restyle the Web product', async () => {
  const overrides = await read(new URL('web/android-overrides.css', project));
  const rules = overrides.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  assert.equal(rules, '.app-shell{min-height:0}');
  assert.doesNotMatch(overrides, /--accent|font-family|\.brand|\.library|\.outline|\.question-arrow|background\s*:/);
});

test('packed runtime does not ship the withdrawn Android-only menu or backup controls', async () => {
  const preload=await read(new URL('android-preload.js',stagedRoot));
  assert.doesNotMatch(preload,/bindAndroidLibraryExtras|settings-data-tab|android-data-panel|android-account-dialog|导出完整备份|恢复完整备份|backup\.export|backup\.import/);
  await assert.rejects(fs.access(new URL('android-library-extras.js',stagedRoot)),{code:'ENOENT'});
  const entry=new JSDOM(await read(new URL('index.html',stagedRoot))).window.document;
  assert.equal(entry.querySelector('#settings-data-tab,#android-data-panel,#android-library-extras,#android-account-dialog'),null);
  assert.equal(entry.getElementById('library-download').href,'https://quizforge.treenewbee.cloud/manage/#library');
});

test('all staged original Web assets remain byte-identical to the pinned snapshot', async () => {
  const snapshot = JSON.parse(await read(new URL('vendor/snapshot.json', project)));
  const entries = snapshot.files.filter(entry => entry.path.startsWith('core/web/'));
  assert.ok(entries.length > 30, 'A complete Web runtime snapshot is required');
  for (const entry of entries) {
    const relative = entry.path.slice('core/web/'.length);
    const bytes = await fs.readFile(new URL('vendor/web/' + relative, stagedRoot));
    assert.equal(sha256(bytes), entry.sha256, `Original Web asset changed: ${relative}`);
  }
  const stagedIndex = await read(new URL('index.html', stagedRoot));
  assert.equal(withoutAndroidTags(stagedIndex), lineEndings(await read(new URL('index.html', pinnedRoot))));
});

test('Android app module consists of the exact original module followed only by the lifecycle hook', async () => {
  const original = await fs.readFile(new URL('app.js', pinnedRoot));
  const hook = await fs.readFile(new URL('web/web-host-lifecycle.js', project));
  const generated = await fs.readFile(new URL('android-app.js', stagedRoot));
  assert.ok(generated.subarray(0, original.length).equals(original), 'Original application module must not be rewritten');
  const suffix = generated.subarray(original.length);
  assert.ok(suffix.equals(hook) || suffix.equals(Buffer.concat([Buffer.from('\n'), hook])), 'Only the reviewed module-scope lifecycle hook may be appended');
});
