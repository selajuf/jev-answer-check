import {capturePrompt,stopGuard} from './runtime.mjs';
const host=process.argv[process.argv.indexOf('--host')+1];
let input='';for await(const chunk of process.stdin)input+=chunk;
let output={};try{const event=JSON.parse(input);if(event.hook_event_name==='UserPromptSubmit')output=capturePrompt(host,event);else if(event.hook_event_name==='Stop')output=stopGuard(host,event);}catch{}
process.stdout.write(JSON.stringify(output)+'\n');
