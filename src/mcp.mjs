import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {review,capturePrompt,loadContext,hash} from './runtime.mjs';
const hostIndex=process.argv.indexOf('--host');
const host=hostIndex>=0?process.argv[hostIndex+1]:'codex';
if(!['codex','claude'].includes(host))throw new Error('invalid_host');
const server=new McpServer({name:'jev-answer-check',version:'0.1.0'});
server.registerTool('jev_check_answer',{
  title:'Проверка ответа Jev',
  description:'Проверь содержательный черновик перед финальным ответом по общей рубрике clear-report. Передай session_id из hook, краткое актуальное задание, черновик, нужные текстовые материалы и свидетельства. Jev оценивает; исправление пишет агент. Максимум две оценки одного ответа.',
  inputSchema:z.object({session_id:z.string().min(1).max(256).optional(),last_user_message:z.string().min(1).max(12000).optional(),task_summary:z.string().min(1).max(6000),draft:z.string().max(24000),artifacts:z.array(z.object({type:z.enum(['html','diagram','data','text']),content:z.string().max(24000)}).strict()).max(4).optional(),evidence:z.record(z.string(),z.unknown()).optional()}).strict()
},async args=>{
  let result;
  try{
    const session=args.session_id||(args.last_user_message?'fallback-'+hash(args.last_user_message):null);
    if(!session)result={status:'unverified',action:'uncertain',checked:false,reason:'missing_session_or_user_message'};
    else{
      const ctx=loadContext(host,session);
      if(args.last_user_message&&(!ctx||ctx.last_user_hash!==hash(args.last_user_message)))capturePrompt(host,{session_id:session,turn_id:'fallback-'+hash(args.last_user_message),prompt:args.last_user_message},{source:'mcp_fallback'});
      result=await review(host,{...args,session_id:session});
    }
  }catch{result={status:'unverified',action:'uncertain',checked:false,reason:'local_configuration_or_state_error'};}
  return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
});
await server.connect(new StdioServerTransport());
