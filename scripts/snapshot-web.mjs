import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(root,'..','quizforge_web');
const target=path.join(root,'vendor','quizforge-web');
const groups=['core/web','core/shared/richtext/1.0.0','core/shared/richtext/1.1.3','core/shared/richtext/service.json','core/shared/answer-area','core/shared/ink','core/server/host/extensions/answer-area-component.js','core/examples/handwritten-short-answer','extensions/基础题型','LICENSE'];
await fs.mkdir(path.join(root,'.temp'),{recursive:true});
const work=await fs.mkdtemp(path.join(root,'.temp','web-snapshot-')),staged=path.join(work,'quizforge-web');
const inside=value=>{const resolved=path.resolve(value);if(!resolved.startsWith(root+path.sep))throw Error('Snapshot target outside Android workspace');return resolved;};
inside(target);inside(work);inside(staged);
const sourceRevision=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
// A snapshot of a clean checkout is exactly that commit; record any local edits otherwise.
const includesWorkingTreeChanges=execFileSync('git',['-C',source,'status','--porcelain','--',...groups],{encoding:'utf8'}).trim()!=='';
const files=[];
async function copy(relative){
  const from=path.join(source,relative), stat=await fs.lstat(from);
  if(stat.isSymbolicLink())throw new Error('Snapshot cannot contain symbolic links');
  if(stat.isDirectory()){for(const name of (await fs.readdir(from)).sort())await copy(path.join(relative,name));return;}
  if(!stat.isFile())return;
  const bytes=await fs.readFile(from),to=path.join(staged,relative);
  await fs.mkdir(path.dirname(to),{recursive:true});await fs.writeFile(to,bytes);
  files.push({path:relative.replaceAll('\\','/'),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
for(const group of groups)await copy(group);
for(const entry of files){
  const actual=createHash('sha256').update(await fs.readFile(path.join(source,entry.path))).digest('hex');
  if(actual!==entry.sha256)throw Error('Web source changed during snapshot: '+entry.path);
}
const manifest=path.join(root,'vendor','snapshot.json'),previous=path.join(work,'previous');
await fs.mkdir(path.dirname(target),{recursive:true});
try{await fs.copyFile(manifest,path.join(work,'snapshot.previous.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
try{await fs.rename(target,inside(previous));}catch(error){if(error.code!=='ENOENT')throw error;}
await fs.rename(staged,target);
await fs.writeFile(manifest,JSON.stringify({schemaVersion:1,source:includesWorkingTreeChanges?'quizforge_web working tree':'quizforge_web commit',sourceRevision,includesWorkingTreeChanges,capturedAt:new Date().toISOString(),files},null,2)+'\n');
console.log(`Captured ${files.length} code and public base-example files; no personal banks or practice state included.`);
console.log('Previous code snapshot retained in '+work);
