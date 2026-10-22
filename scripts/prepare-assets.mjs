import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {generateWebEntry} from './generate-web-entry.mjs';
import './build-demo.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const assets=path.join(root,'app','src','main','assets');
const snapshot=JSON.parse(await fs.readFile(path.join(root,'vendor','snapshot.json'),'utf8'));
for(const entry of snapshot.files){
  const actual=createHash('sha256').update(await fs.readFile(path.join(root,'vendor','quizforge-web',entry.path))).digest('hex');
  if(actual!==entry.sha256)throw new Error(`Pinned source changed: ${entry.path}. Review and explicitly refresh the snapshot.`);
}
await fs.mkdir(path.join(assets,'web'),{recursive:true});
await generateWebEntry();
// Retired prototypes and the unapproved Android-only data menu remain as source
// history. The APK launches only the original Web interface and whiteboard.
const retired=new Set(['tablet-app.js','tablet.css','ink-board.js','android-library-extras.js']);
for(const entry of await fs.readdir(path.join(root,'web'))){
  if(!retired.has(entry))await fs.cp(path.join(root,'web',entry),path.join(assets,'web',entry),{recursive:true});
}
for(const entry of retired)await fs.rm(path.join(assets,'web',entry),{force:true});
const vendorAssets=path.resolve(assets,'web','vendor');
if(vendorAssets!==path.resolve(root,'app/src/main/assets/web/vendor')||!vendorAssets.startsWith(root+path.sep))throw Error('Unsafe generated vendor directory');
// This is a generated directory. Recreate it from the manifest so retired Web
// modules such as manual draft capture cannot remain in the next APK.
await fs.rm(vendorAssets,{recursive:true,force:true});
for(const entry of snapshot.files){
  let relative;if(entry.path.startsWith('core/web/'))relative='web/'+entry.path.slice('core/web/'.length);
  else if(entry.path.startsWith('core/shared/'))relative='shared/'+entry.path.slice('core/shared/'.length);
  else continue;
  const to=path.resolve(vendorAssets,relative);if(!to.startsWith(vendorAssets+path.sep))throw Error('Invalid snapshot path');
  await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(path.join(root,'vendor/quizforge-web',entry.path),to);
}
const originalApp=await fs.readFile(path.join(root,'vendor/quizforge-web/core/web/app.js'));
const hostLifecycle=await fs.readFile(path.join(root,'web/web-host-lifecycle.js'));
await fs.writeFile(path.join(assets,'web/android-app.js'),Buffer.concat([originalApp,Buffer.from('\n'),hostLifecycle]));
await build({entryPoints:[path.join(root,'web/android-preload.js')],outfile:path.join(assets,'web/android-preload.js'),bundle:true,format:'iife',platform:'browser',target:'es2020',legalComments:'eof',
  define:{'import.meta.url':JSON.stringify('https://appassets.androidplatform.net/assets/web/domain.js')},
  plugins:[{name:'pinned-web-imports',setup(builder){
    builder.onResolve({filter:/^\.\/vendor\/web\//},args=>({path:path.join(root,'vendor/quizforge-web/core/web',args.path.slice('./vendor/web/'.length))}));
  }}],
});
await fs.mkdir(path.join(assets,'rules'),{recursive:true});
await build({entryPoints:[path.join(root,'rules','runtime.js')],outfile:path.join(assets,'rules','runtime.js'),bundle:true,format:'iife',globalName:'QFAndroidRules',platform:'browser',target:'es2020',minify:true,legalComments:'eof'});
const notices=path.join(assets,'licenses');await fs.mkdir(notices,{recursive:true});
for(const name of ['ajv','fast-uri','fast-deep-equal','json-schema-traverse','require-from-string']){
  const folder=path.join(root,'node_modules',name),filename=(await fs.readdir(folder)).find(file=>/^licen[cs]e(?:\.|$)/i.test(file));
  if(!filename)throw new Error(`Missing distribution license for ${name}`);
  await fs.copyFile(path.join(folder,filename),path.join(notices,name+'.txt'));
}
await fs.copyFile(path.join(root,'LICENSE'),path.join(notices,'QuizForge.txt'));
await fs.copyFile(path.join(root,'vendor','snapshot.json'),path.join(assets,'source-snapshot.json'));
console.log('Prepared offline UI, pinned extension SDKs and isolated rule runtime.');
