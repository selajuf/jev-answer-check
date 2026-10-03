import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ROOT} from '../src/runtime.mjs';

test('official SDK handshake and typed tool call use local stdio without API',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jev-mcp-test-'));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'src/mcp.mjs')],env:{...process.env,JEV_CONFIG_DIR:path.join(dir,'config'),JEV_STATE_DIR:path.join(dir,'state'),TYPESAFE_API_KEY:''}});
  const client=new Client({name:'test-client',version:'1.0.0'});
  try{
    await client.connect(transport);
    const tools=await client.listTools();assert.equal(tools.tools.length,1);assert.equal(tools.tools[0].name,'jev_check_answer');
    const result=await client.callTool({name:'jev_check_answer',arguments:{session_id:'sdk-test',task_summary:'Synthetic',draft:'Проверяемый ответ.'}});
    assert.equal(result.structuredContent.status,'unverified');assert.equal(result.structuredContent.reason,'disabled');
    const invalid=await client.callTool({name:'jev_check_answer',arguments:{session_id:'sdk-test',task_summary:'Synthetic',draft:'x',url:'https://unapproved.example'}}).catch(e=>e);
    assert(invalid.isError||invalid instanceof Error);
  }finally{await client.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('MCP fallback refreshes the current user message in the same session without API',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jev-fallback-test-'));
  const config=path.join(dir,'config');fs.mkdirSync(config);
  fs.writeFileSync(path.join(config,'config.json'),JSON.stringify({enabled:true,maxRequestUsd:0.000000001}));
  const env={...process.env,JEV_CONFIG_DIR:config,JEV_STATE_DIR:path.join(dir,'state'),TYPESAFE_API_KEY:'synthetic-test-key'};
  const client=new Client({name:'fallback-test',version:'1.0.0'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'src/mcp.mjs')],env}));
    const input={session_id:'same-session',task_summary:'Объясни результат',draft:'Результат сохранен.'};
    for(const message of ['Первое задание','Новое задание']){
      const result=await client.callTool({name:'jev_check_answer',arguments:{...input,last_user_message:message}});
      assert.equal(result.structuredContent.reason,'request_cost_limit');
      const sessions=path.join(dir,'state/sessions/codex');
      const ctx=JSON.parse(fs.readFileSync(path.join(sessions,fs.readdirSync(sessions)[0]),'utf8'));
      assert.equal(ctx.last_user_message,message);assert.equal(ctx.source,'mcp_fallback');
      ctx.source='hook';ctx.receipts=[{packet_hash:'first'},{packet_hash:'second'}];
      fs.writeFileSync(path.join(sessions,fs.readdirSync(sessions)[0]),JSON.stringify(ctx));
      const sameTurn=await client.callTool({name:'jev_check_answer',arguments:{...input,last_user_message:message,task_summary:'Другое краткое описание того же запроса'}});
      assert.equal(sameTurn.structuredContent.reason,'turn_limit_reached');
    }
    const fallback={task_summary:'Первое описание',last_user_message:'Запрос без session_id',draft:'Результат сохранен.'};
    await client.callTool({name:'jev_check_answer',arguments:fallback});
    const sessions=path.join(dir,'state/sessions/codex');
    const file=fs.readdirSync(sessions).map(p=>path.join(sessions,p)).find(p=>JSON.parse(fs.readFileSync(p,'utf8')).last_user_message===fallback.last_user_message);
    const ctx=JSON.parse(fs.readFileSync(file,'utf8'));ctx.receipts=[{packet_hash:'first'},{packet_hash:'second'}];fs.writeFileSync(file,JSON.stringify(ctx));
    const changedSummary=await client.callTool({name:'jev_check_answer',arguments:{...fallback,task_summary:'Уточненное описание'}});
    assert.equal(changedSummary.structuredContent.reason,'turn_limit_reached');
  }finally{await client.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('both hook executables emit valid context and block an unchecked final only once',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jev-hooks-test-'));
  const config=path.join(dir,'config');fs.mkdirSync(config);
  fs.writeFileSync(path.join(config,'config.json'),JSON.stringify({enabled:true}));
  const env={...process.env,JEV_CONFIG_DIR:config,JEV_STATE_DIR:path.join(dir,'state'),TYPESAFE_API_KEY:'synthetic-test-key'};
  try{
    for(const host of ['codex','claude']){
      const run=event=>JSON.parse(execFileSync(process.execPath,[path.join(ROOT,'src/hook.mjs'),'--host',host],{env,input:JSON.stringify(event),encoding:'utf8'}));
      const common={session_id:'hook-session'};
      const prompt=run({...common,hook_event_name:'UserPromptSubmit',prompt:'Объясни, что получилось.'});
      assert.equal(prompt.hookSpecificOutput.hookEventName,'UserPromptSubmit');
      assert.match(prompt.hookSpecificOutput.additionalContext,/session_id=hook-session/);
      const event={...common,hook_event_name:'Stop',last_assistant_message:'Сохранен итог работы.'};
      assert.equal(run(event).decision,'block');assert.deepEqual(run(event),{});
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
