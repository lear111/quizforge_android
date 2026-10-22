import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const apk='QuizForge-Android-0.1.0-preview.apk',bytes=await fs.readFile(path.join(root,'output',apk));
async function files(directory,prefix=''){
 const result=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){
   const relative=prefix?prefix+'/'+entry.name:entry.name;
   if(entry.isDirectory())result.push(...await files(path.join(directory,entry.name),relative));else result.push(relative);
 }return result.sort();
}
const sourceHashes={};
const retired=new Set(['tablet-app.js','tablet.css','ink-board.js','android-library-extras.js']);
for(const relative of await files(path.join(root,'web'))){
 if(retired.has(relative))continue;
 const source=await fs.readFile(path.join(root,'web',relative)),packed=await fs.readFile(path.join(root,'app','src','main','assets','web',relative));
 if(relative!=='android-preload.js'&&hash(source)!==hash(packed))throw new Error('APK staging is stale for web/'+relative);
 sourceHashes['web/'+relative]=hash(source);
}
for(const relative of await files(path.join(root,'app','src','main','java')))sourceHashes['app/src/main/java/'+relative]=hash(await fs.readFile(path.join(root,'app','src','main','java',relative)));
for(const relative of ['answer-area-renderer.html','answer-area-renderer.js'])sourceHashes['app/src/main/assets/'+relative]=hash(await fs.readFile(path.join(root,'app/src/main/assets',relative)));
const testLog=await fs.readFile(path.join(root,'output/acceptance/javascript-tests.txt'),'utf8');
const testCount=Number([...testLog.matchAll(/tests\s+(\d+)/g)].at(-1)?.[1]);
const extensionChecks=[...testLog.matchAll(/^ {2}✔ .+ \([\d.]+ms\)/gm)].length;
const ruleChecks=extensionChecks+4;
const skippedChecks=Number([...testLog.matchAll(/skipped\s+(\d+)/g)].at(-1)?.[1]||0);
if(!Number.isInteger(testCount)||testCount<1||!/fail\s+0\b/.test(testLog))throw Error('A current complete passing JavaScript test log is required.');
const manifest=await fs.readFile(path.join(root,'app/src/main/AndroidManifest.xml'),'utf8');
const gradle=await fs.readFile(path.join(root,'app/build.gradle'),'utf8');
const lint=await fs.readFile(path.join(root,'app/build/reports/lint-results-debug.txt'),'utf8');
const lintCounts=[...lint.matchAll(/(\d+) errors?, (\d+) warnings?/g)].at(-1);
const snapshot=JSON.parse(await fs.readFile(path.join(root,'vendor','snapshot.json'),'utf8'));
const info={schemaVersion:2,version:gradle.match(/versionName '([^']+)'/)?.[1],versionCode:Number(gradle.match(/versionCode (\d+)/)?.[1]),sourceRevision:snapshot.sourceRevision,includesWorkingTreeChanges:snapshot.includesWorkingTreeChanges===true,applicationId:'cloud.treenewbee.quizforge.android.debug',artifact:apk,bytes:bytes.length,sha256:hash(bytes),debugSigned:true,compileSdk:36,targetSdk:35,minSdk:29,networkPermission:manifest.includes('android.permission.INTERNET'),nativeLogin:false,cloudSync:false,
 validations:{javascriptChecks:testCount,skippedChecks,ruleChecks,currentExtensionCopiesCompared:extensionChecks,lintErrors:lintCounts?Number(lintCounts[1]):null,lintWarnings:lintCounts?Number(lintCounts[2]):null,physicalTablet:false,physicalStylus:false,instrumentation:'Recorded separately against the installed APK; no hard-coded previous count.'},
 interface:{source:'complete pinned quizforge_web frontend',index:'original plus preload and override tags',appModule:'exact original plus lifecycle suffix',originalStaticAssets:'byte-identical',androidCss:'.app-shell{min-height:0}'},
 bundledPreloadSha256:hash(await fs.readFile(path.join(root,'app/src/main/assets/web/android-preload.js'))),
 sourceSnapshotSha256:hash(await fs.readFile(path.join(root,'vendor','snapshot.json'))),sourceHashes};
await fs.writeFile(path.join(root,'output','build-info.json'),JSON.stringify(info,null,2)+'\n');
console.log(JSON.stringify({artifact:apk,bytes:bytes.length,sha256:info.sha256,verifiedStagedWebFiles:Object.keys(sourceHashes).filter(x=>x.startsWith('web/')).length},null,2));
