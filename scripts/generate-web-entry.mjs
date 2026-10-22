import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function androidEntry(source){
  if(!source.includes('</head>')||!source.includes('  <script type="module" src="/app.js"></script>'))throw Error('Web entry changed; review Android integration.');
  return source.replace('</head>','  <link rel="stylesheet" href="/assets/web/android-overrides.css">\n</head>')
    .replace('  <script type="module" src="/app.js"></script>','  <script src="/assets/web/android-preload.js"></script>\n  <script type="module" src="/app.js"></script>');
}
export async function generateWebEntry(){
  const source=await fs.readFile(path.join(root,'vendor/quizforge-web/core/web/index.html'),'utf8');
  const generated=androidEntry(source);
  await fs.writeFile(path.join(root,'web/index.html'),generated);
  return generated;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await generateWebEntry();
