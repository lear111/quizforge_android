import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {build} from 'esbuild';

const project = new URL('../', import.meta.url);
const assets = new URL('app/src/main/assets/', project);
const activity = new URL('app/src/main/java/cloud/treenewbee/quizforge/android/MainActivity.java', project);
const origin = 'https://appassets.androidplatform.net';

// Evaluate the native method's actual routing expression instead of maintaining
// a second routing table that could pass while MainActivity serves the wrong file.
async function nativeRoute() {
  const source = await fs.readFile(activity, 'utf8');
  const method = source.slice(source.indexOf('private WebResourceResponse bundledWebAsset('));
  const expression = method.match(/String asset = ([\s\S]*?);/);
  assert.ok(expression, 'Review this test when the native static route changes shape');
  const javascript = expression[1].replace(/path\.equals\(("[^"]*")\)/g, '(path === $1)');
  return new Function('path', `return (${javascript});`);
}

test('native static routes distinguish Web shared modules from versioned shared SDK assets', async () => {
  const route = await nativeRoute();
  for (const name of ['api.js', 'write-queue.js', 'answer-area-channel.js']) {
    const path = `shared/${name}`;
    assert.equal(route(path), `web/vendor/web/${path}`, `Web module /${path} must remain reachable`);
    await fs.access(new URL(route(path), assets));
  }

  const snapshot = JSON.parse(await fs.readFile(new URL('vendor/snapshot.json', project), 'utf8'));
  const shared = snapshot.files.filter(entry => entry.path.startsWith('core/shared/'));
  for (const folder of ['answer-area', 'ink', 'richtext']) {
    assert.ok(shared.some(entry => entry.path.startsWith(`core/shared/${folder}/`)), `Missing ${folder} fixture coverage`);
  }
  for (const entry of shared) {
    const path = entry.path.slice('core/'.length);
    assert.equal(route(path), `web/vendor/${path}`, `Shared SDK /${path} must use the pinned public assets`);
    const packed = await fs.readFile(new URL(route(path), assets));
    const pinned = await fs.readFile(new URL(`vendor/quizforge-web/${entry.path}`, project));
    assert.ok(packed.equals(pinned), `Native route /${path} must serve its actual pinned bytes`);
  }
});

test('every relative import in the APK app.js module graph resolves through the actual native route', async () => {
  const route = await nativeRoute();
  const loaded = new Set();
  await build({
    entryPoints: [`${origin}/app.js`],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    logLevel: 'silent',
    plugins: [{
      name: 'native-asset-routing',
      setup(builder) {
        builder.onResolve({filter: /.*/}, args => {
          assert.ok(args.kind === 'entry-point' || /^[./]/.test(args.path), `Unexpected external import ${args.path}`);
          const url = new URL(args.path, args.importer || origin);
          assert.equal(url.origin, origin, `APK imports must remain local: ${url}`);
          return {path: url.href, namespace: 'native-assets'};
        });
        builder.onLoad({filter: /.*/, namespace: 'native-assets'}, async args => {
          const pathname = decodeURIComponent(new URL(args.path).pathname.slice(1));
          const asset = route(pathname);
          let contents;
          try { contents = await fs.readFile(new URL(asset, assets), 'utf8'); }
          catch (cause) { throw new Error(`Native URL /${pathname} maps to missing APK asset ${asset}`, {cause}); }
          loaded.add(pathname);
          return {contents, loader: 'js'};
        });
      },
    }],
  });
  for (const path of ['app.js', 'shared/api.js', 'shared/write-queue.js', 'shared/answer-area-channel.js',
    'shared/answer-area/1.4.0/model.js', 'shared/ink/1.0.0/renderer.js']) {
    assert.ok(loaded.has(path), `The real entry graph must exercise /${path}`);
  }
  assert.ok(loaded.size > 30, 'The full entry module graph must be checked');
});
