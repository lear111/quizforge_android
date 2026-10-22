import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import yazl from 'yazl';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'vendor','quizforge-web');
const group='离线体验',questions=[];
const archive=new yazl.ZipFile();
const add=(name,value)=>archive.addBuffer(Buffer.from(JSON.stringify(value,null,2)+'\n'),name);
async function copy(directory,relative){
  for(const name of (await fs.readdir(directory)).sort()){
    const full=path.join(directory,name),next=relative+'/'+name,stat=await fs.lstat(full);
    if(stat.isSymbolicLink())throw new Error('No symbolic links in demonstration package');
    if(stat.isDirectory())await copy(full,next);else if(!next.endsWith('/examples/bank.json'))archive.addFile(full,next);
  }
}
for(const [index,name] of ['单选题','多选题','判断题','简答题'].entries()){
  const extensionPath=`extensions/${group}/${name}`,folder=path.join(source,'extensions','基础题型',name);
  const example=JSON.parse(await fs.readFile(path.join(folder,'examples','bank.json'),'utf8'));
  const sample=structuredClone(example.questions[0]);sample.id=`offline-demo-${index+1}`;sample.title=`${name}体验`;
  sample.extension={path:extensionPath};questions.push(sample);
  await copy(folder,extensionPath);
  example.extension={path:extensionPath};add(extensionPath+'/examples/bank.json',example);
}
add('quizforge-package.json',{format:'quizforge-bank-group',formatVersion:3,group,scope:'bank'});
add(`question-banks/${group}/离线刷题体验/bank.json`,{formatVersion:1,id:'offline-demo',title:'离线刷题体验',description:'随应用提供的四种基础题型示例，可断网作答、书写、纠错与考试。',features:{editing:true,whiteboard:true,history:true,exam:true},questions});
const target=path.join(root,'app','src','main','assets','demo.qbank');
await fs.mkdir(path.dirname(target),{recursive:true});
const {createWriteStream}=await import('node:fs');
await new Promise((resolve,reject)=>{const output=createWriteStream(target);archive.outputStream.on('error',reject).pipe(output).on('error',reject).on('close',resolve);archive.end();});
console.log('Built public base-type offline demonstration package.');
