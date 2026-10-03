import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {ROOT} from '../src/runtime.mjs';
test('secret scanner detects a removed credential in Git history without printing its value',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jev-secret-test-'));
  const fake='ghp_'+ 'a'.repeat(40);
  const git=(...args)=>execFileSync('git',args,{cwd:dir,stdio:'pipe'});
  try{
    git('init','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(dir,'old.txt'),fake);git('add','old.txt');git('commit','-m','fixture');
    fs.unlinkSync(path.join(dir,'old.txt'));git('add','-u');git('commit','-m','remove fixture');
    const result=spawnSync(process.execPath,[path.join(ROOT,'scripts/scan-secrets.mjs'),'--root',dir],{encoding:'utf8',env:{...process.env,JEV_CONFIG_DIR:path.join(dir,'unused-config'),TYPESAFE_API_KEY:''}});
    assert.equal(result.status,1);assert(result.stderr.includes('history:old.txt'));assert(!result.stderr.includes(fake));assert(!result.stdout.includes(fake));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
