// Read-only completion check for the already-confirmed SAF restore. Preserve
// backup-flow.json, including its early readiness race; never repeat a restore.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {connect,nativeDiagnostic} from './webview-driver.mjs';
const serial='emulator-5580',pkg='cloud.treenewbee.quizforge.android.debug';
const adb=(...args)=>execFileSync('adb',['-s',serial,...args],{encoding:'utf8',timeout:45000}).trim();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,label,timeout=180000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await read();if(value)return value;}catch(error){last=error;}await delay(1000);}throw Error(label+(last?': '+last.message:''));}
assert.match(adb('emu','avd','name'),/^QuizForge_Android15_Tablet/);
const output=path.resolve('output/acceptance'),prior=JSON.parse(await fs.readFile(path.join(output,'backup-flow.json'),'utf8'));
assert.ok(prior.baseline?.banks?.length);assert.equal(prior.stage,'restore-reload');
assert.equal(prior.passed,false);assert.ok(prior.error.includes('正在恢复本地备份'));
assert.ok(!prior.fixtureTitleRolledBack);
const pid=adb('shell','pidof',pkg);assert.ok(pid);adb('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid);
const d=await connect(),native=(method,args,project)=>nativeDiagnostic(d,method,args,project);
function fingerprint(value){function canonical(item){if(Array.isArray(item))return item.map(canonical);if(item&&typeof item==='object')return Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])]));return item;}return crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value)))).then(bytes=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join(''));}
const catalog=()=>native('library.list',{},rows=>rows.map(row=>({id:row.id,title:row.title,group:row.group,questionCount:row.questionCount,features:row.features})).sort((a,b)=>a.id.localeCompare(b.id)));
function aiProjection(value){const {configurationVersion,...stable}=value;function canonical(item){if(Array.isArray(item))return item.map(canonical);if(item&&typeof item==='object')return Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])]));return item;}return crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(stable)))).then(bytes=>({enabled:value.enabled,autoGrade:value.autoGrade,apiKeyConfigured:value.apiKeyConfigured,provider:value.provider,vision:value.vision,outputMode:value.outputMode,maxOutputTokens:value.maxOutputTokens,timeoutSeconds:value.timeoutSeconds,httpsOnly:value.httpsOnly,canManage:value.canManage,redactedConfigurationSha256:Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('')}));}
const result={bankId:prior.bankId,filename:prior.filename,backupBytes:prior.backupBytes,inputEvidence:prior.inputEvidence,continuationOf:'backup-flow.json',harnessNote:'The initial readiness predicate matched stale DOM before native restore completed. This separate read-only pass waits for the native storage gate and verifies the existing restore; it does not repeat export, rename or restore.',checks:[]};
try{
 const banks=await until(async()=>{const rows=await catalog();const fixture=rows.find(bank=>bank.id===prior.bankId),before=prior.baseline.banks.find(bank=>bank.id===prior.bankId);return fixture?.title===before?.title&&rows;},'Confirmed restore has not completed');
 await until(()=>d.evaluate('!!window.quizforgeApp&&!!document.querySelector("#settings-data-tab")'),'Reloaded UI unavailable');
 const restored={banks,states:[]};for(const bank of banks)restored.states.push({id:bank.id,sourceHash:await native('library.readBank',{bankId:bank.id},fingerprint),stateHash:await native('state.read',{bankId:bank.id},fingerprint)});
 assert.deepEqual(restored,prior.baseline);result.restored=restored;
 const aiAfter=await native('settings.ai.get',{},aiProjection);assert.deepEqual(aiAfter,prior.aiStatusBefore);result.aiStatusAfter=aiAfter;
 result.checks.push('Already-confirmed restore completed: every baseline bank ID, title, group, source hash and complete practice/history hash matches (50 banks).');
 result.checks.push('Redacted AI configuration flags and stable configuration hash match the pre-restore baseline; no credential is read or printed.');
 const ui=await d.evaluate('({notice:document.getElementById("notice").innerText,error:document.querySelector(".question-error")?.innerText||null})');assert.equal(ui.error,null);result.ui=ui;
 await d.evaluate('(()=>{document.getElementById("network-settings-open").click();document.getElementById("settings-data-tab").click();return true})()');await delay(800);
 adb('shell','screencap','-p','/sdcard/qf-backup-restored-more.png');adb('pull','/sdcard/qf-backup-restored-more.png',path.join(output,'backup-restored-more.png'));
 result.passed=true;result.apkSha256=createHash('sha256').update(await fs.readFile('output/QuizForge-Android-0.1.0-preview.apk')).digest('hex');
}catch(error){result.passed=false;result.error=error.stack;process.exitCode=1;}
finally{d.close();await fs.writeFile(path.join(output,'backup-restore-verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:result.passed,banks:result.restored?.banks.length,checks:result.checks,error:result.error}));}
