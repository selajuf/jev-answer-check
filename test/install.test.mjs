import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {ROOT} from '../src/runtime.mjs';

test('installer preserves other MCP/hooks, is idempotent, and stores credentials outside repository',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'jev-install-test-'));
  try{
    fs.mkdirSync(path.join(home,'.codex'),{recursive:true});fs.mkdirSync(path.join(home,'.claude'),{recursive:true});
    fs.writeFileSync(path.join(home,'.codex/config.toml'),'model = "existing-model"\n[mcp_servers.other]\ncommand = "other-server"\n');
    fs.writeFileSync(path.join(home,'.codex/hooks.json'),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'existing-hook'}]}]}}));
    fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({mcpServers:{other:{command:'other'}},preserve:true}));
    fs.writeFileSync(path.join(home,'.claude/settings.json'),JSON.stringify({permissions:{allow:['existing-permission']},hooks:{Stop:[{hooks:[{type:'command',command:'existing-stop'}]}]}}));
    const keyFile=path.join(home,'source-key');fs.writeFileSync(keyFile,'synthetic-install-'+ 'x'.repeat(30));
    const run=()=>JSON.parse(execFileSync('python3',[path.join(ROOT,'scripts/install.py'),'--home',home,'--repo',ROOT,'--node',process.execPath,'--key-source',keyFile,'--enable'],{encoding:'utf8'}));
    const first=run();
    const promptPaths=['.codex/AGENTS.md','.claude/CLAUDE.md'].map(p=>path.join(home,p));
    const prompts=promptPaths.map(p=>fs.readFileSync(p,'utf8'));
    const second=run();assert(first.enabled&&second.enabled);
    promptPaths.forEach((p,i)=>assert.equal(fs.readFileSync(p,'utf8'),prompts[i]));
    const toml=fs.readFileSync(path.join(home,'.codex/config.toml'),'utf8');assert(toml.includes('existing-model'));assert(toml.includes('[mcp_servers.other]'));assert.equal(toml.match(/^\[mcp_servers.jev_answer_check\]$/gm).length,1);
    const codex=JSON.parse(fs.readFileSync(path.join(home,'.codex/hooks.json')));assert.equal(codex.hooks.UserPromptSubmit.length,2);assert.equal(codex.hooks.UserPromptSubmit[0].hooks[0].command,'existing-hook');
    const claude=JSON.parse(fs.readFileSync(path.join(home,'.claude.json')));assert(claude.preserve&&claude.mcpServers.other&&claude.mcpServers.jev_answer_check);
    const settings=JSON.parse(fs.readFileSync(path.join(home,'.claude/settings.json')));assert(settings.permissions.allow.includes('existing-permission'));assert.equal(settings.hooks.Stop[0].hooks[0].command,'existing-stop');assert.equal(settings.hooks.Stop.length,2);
    const key=path.join(home,'.config/jev-answer-check/api-key');assert.equal(fs.statSync(key).mode&0o777,0o600);assert.equal(fs.readFileSync(key,'utf8'),fs.readFileSync(keyFile,'utf8'));
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
