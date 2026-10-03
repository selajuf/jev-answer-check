import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capturePrompt,review,stopGuard,loadContext,redact,defaults,MODEL,ENDPOINT,hash} from '../src/runtime.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'jev-runtime-test-'));
process.env.JEV_CONFIG_DIR=path.join(root,'config');process.env.JEV_STATE_DIR=path.join(root,'state');
fs.mkdirSync(process.env.JEV_CONFIG_DIR,{recursive:true});
fs.writeFileSync(path.join(process.env.JEV_CONFIG_DIR,'config.json'),JSON.stringify({...defaults,enabled:true}));
const key='synthetic-key-'+ 'x'.repeat(32);process.env.TYPESAFE_API_KEY=key;
after(()=>fs.rmSync(root,{recursive:true,force:true}));
const cfg={...defaults,enabled:true};
function context(id,prompt='Поясни результат, не запускай тесты.') {capturePrompt('codex',{session_id:id,turn_id:'turn-1',prompt});}
function mock(values={},inspect=()=>{},usageExtra={}) {return async(url,options)=>{assert.equal(url,ENDPOINT);assert.equal(options.redirect,'error');const body=JSON.parse(options.body);inspect(body);return {ok:true,json:async()=>({model:MODEL,answers:Object.fromEntries(Object.keys(body.questions).map(k=>[k,{type:'noul',noul:values[k]??0.9}])),usage:{...usageExtra,input_tokens:100,output_tokens:8}})};};}
const args=(id,draft='Изменил настройку в файле. Тесты не запускал.')=>({session_id:id,task_summary:'Нужно сообщить результат и реальные проверки.',draft,artifacts:[],evidence:{tests_run:false}});

test('redacts known key, prefixed tokens, nested credentials and private keys',()=>{
  const token='ghp_'+ 'a'.repeat(40);
  const input={draft:`${key} Bearer ${token}`,nested:{password:'do-not-send'},pem:'-----BEGIN '+ 'PRIVATE KEY-----\nsecret\n-----END '+ 'PRIVATE KEY-----'};
  const result=JSON.stringify(redact(input,key));
  assert(!result.includes(key));assert(!result.includes(token));assert(!result.includes('do-not-send'));assert(!result.includes('\nsecret\n'));assert(result.includes('[REDACTED]'));
});
test('normalizes evidence key ordering for packet identity',()=>assert.equal(hash({a:1,b:2}),hash({b:2,a:1})));
test('checks draft once, caches duplicate and keeps real user context',async()=>{
  context('cache');let calls=0;
  const fetchFn=mock({},body=>{calls++;assert.equal(body.state.last_user_message,'Поясни результат, не запускай тесты.');});
  const first=await review('codex',args('cache'),{fetchFn,keyOverride:key,configOverride:cfg});
  const second=await review('codex',args('cache'),{fetchFn,keyOverride:key,configOverride:cfg});
  assert.equal(first.action,'keep');assert.equal(second.cached,true);assert.equal(calls,1);
});
test('changed artifact invalidates cache and third evaluation is denied',async()=>{
  context('artifact');let calls=0;const fetchFn=mock({faithful_visuals:0.1},()=>calls++);
  const packet={...args('artifact'),artifacts:[{type:'html',content:'A: 80, B: 60'}]};
  const first=await review('codex',packet,{fetchFn,keyOverride:key,configOverride:cfg});
  const second=await review('codex',{...packet,artifacts:[{type:'html',content:'A: 80, B: 40'}]},{fetchFn:mock({},()=>calls++),keyOverride:key,configOverride:cfg});
  const third=await review('codex',{...packet,draft:'Третья другая версия.'},{fetchFn,keyOverride:key,configOverride:cfg});
  assert.equal(first.action,'rewrite');assert.equal(second.action,'keep');assert.equal(calls,2);assert.equal(third.reason,'turn_limit_reached');
});
test('missing evidence is not claimed as an executed test; schema errors remain unverified',async()=>{
  context('bad-schema');const result=await review('codex',args('bad-schema'),{keyOverride:key,configOverride:cfg,fetchFn:async()=>({ok:true,json:async()=>({model:MODEL,answers:{},usage:{input_tokens:2,output_tokens:1}})})});
  assert.equal(result.checked,false);assert.equal(result.status,'unverified');assert.equal(result.reason,'invalid_provider_judgment');
});
test('API packet and receipts exclude secret and raw draft text',async()=>{
  context('secret',`Текст с ключом ${key}.`);const draft=`Не отправляй ключ ${key}; тесты не запускались.`;
  const result=await review('codex',args('secret',draft),{keyOverride:key,configOverride:cfg,fetchFn:mock({},body=>assert(!JSON.stringify(body).includes(key)),{reflected_key:key,reflected_draft:draft})});
  assert.deepEqual(result.usage,{input_tokens:100,output_tokens:8});
  const log=fs.readFileSync(path.join(process.env.JEV_STATE_DIR,'receipts.jsonl'),'utf8');
  assert(!log.includes(key));assert(!log.includes(draft));assert(!log.includes('last_user_message'));
});
test('known actual spend blocks admission even when reservation is smaller',async()=>{
  context('actual-budget');const file=path.join(process.env.JEV_STATE_DIR,'budget.json');
  const before=fs.readFileSync(file);
  try{
    fs.writeFileSync(file,JSON.stringify({day:new Date().toISOString().slice(0,10),calls:0,reservedUsd:0,actualUsd:cfg.dailyBudgetUsd}));
    const result=await review('codex',args('actual-budget'),{keyOverride:key,configOverride:cfg,fetchFn:()=>{throw new Error('must not call');}});
    assert.equal(result.reason,'daily_budget_limit');assert.equal(result.checked,false);
  }finally{fs.writeFileSync(file,before);}
});
test('budget failure does not make an API call or claim a check',async()=>{
  context('budget');let called=false;
  const result=await review('codex',args('budget'),{keyOverride:key,configOverride:{...cfg,maxRequestUsd:0.00000001},fetchFn:async()=>{called=true;}});
  assert.equal(result.reason,'request_cost_limit');assert.equal(result.checked,false);assert.equal(called,false);
});
test('Stop guard accepts checked final version and resumes only once for changed version',async()=>{
  context('guard');const packet=args('guard');await review('codex',packet,{fetchFn:mock(),keyOverride:key,configOverride:cfg});
  assert.deepEqual(stopGuard('codex',{session_id:'guard',last_assistant_message:packet.draft}),{});
  const continuation=stopGuard('codex',{session_id:'guard',last_assistant_message:'Новая непроверенная версия ответа.'});
  assert.equal(continuation.decision,'block');
  capturePrompt('codex',{session_id:'guard',turn_id:'turn-2',prompt:continuation.reason});
  assert.equal(loadContext('codex','guard').turn_id,'turn-1');
  assert.equal(loadContext('codex','guard').last_user_message,'Поясни результат, не запускай тесты.');
  assert.deepEqual(stopGuard('codex',{session_id:'guard',last_assistant_message:'Еще одна версия.'}),{});
});
test('ordinary greeting neither calls API nor blocks Stop',async()=>{
  const result=await review('codex',args('greeting','Привет!'),{keyOverride:key,configOverride:cfg,fetchFn:()=>{throw new Error('must not call');}});
  assert.equal(result.status,'not_applicable');assert.deepEqual(stopGuard('codex',{session_id:'greeting',last_assistant_message:'Привет!'}),{});
});
test('Stop requests one correction for an explicitly failed checked draft',async()=>{
  context('failed-guard');const packet=args('failed-guard');
  await review('codex',packet,{fetchFn:mock({status_precision:0.1}),keyOverride:key,configOverride:cfg});
  const event={session_id:'failed-guard',last_assistant_message:packet.draft};
  const feedback=stopGuard('codex',event);assert.equal(feedback.decision,'block');assert.match(feedback.reason,/Jev нашел/);
  assert.deepEqual(stopGuard('codex',event),{});
});
