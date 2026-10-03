import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {ROOT,loadKey} from '../src/runtime.mjs';
const rootIndex=process.argv.indexOf('--root');
const root=rootIndex>=0?path.resolve(process.argv[rootIndex+1]):ROOT;
let key='';try{key=loadKey();}catch{}
const source=process.env.JEV_SCAN_KEY_FILE;
if(source)key=fs.readFileSync(source,'utf8').trim();
const known=[key,...(process.env.JEV_SCAN_SECRETS?JSON.parse(process.env.JEV_SCAN_SECRETS):[])].filter(Boolean);
const patterns=[/\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16})\b/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
const findings=[];
function check(name,bytes){const text=bytes.toString('utf8');if(known.some(secret=>text.includes(secret))||patterns.some(p=>p.test(text)))findings.push(name);}
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','.git','__pycache__'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile())check(path.relative(root,p),fs.readFileSync(p));else findings.push('symlink:'+path.relative(root,p));}}
walk(root);
try{
  const objects=execFileSync('git',['rev-list','--objects','--all'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\n').filter(Boolean);
  for(const line of objects){const [id,...name]=line.split(' ');const type=execFileSync('git',['cat-file','-t',id],{cwd:root,encoding:'utf8'}).trim();if(type==='blob')check('history:'+name.join(' '),execFileSync('git',['cat-file','blob',id],{cwd:root}));}
}catch(error){if(fs.existsSync(path.join(root,'.git'))){console.error('Cannot scan Git history');process.exit(2);}}
if(findings.length){console.error(JSON.stringify({secret_scan:'failed',files:[...new Set(findings)]}));process.exit(1);}
console.log(JSON.stringify({secret_scan:'passed',exact_local_key_checked:known.length>0,history_checked:fs.existsSync(path.join(root,'.git'))}));
