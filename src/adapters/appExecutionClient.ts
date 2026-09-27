import { createConnection } from 'node:net';

export type AppExecutionAction='app-submit'|'app-status'|'app-result';
export interface AppExecutionRequest {app:string;action:AppExecutionAction;arg:string;payload:Record<string,unknown>;}
export interface AppExecutionPayload extends Record<string,unknown> {tool:'probe'|'git'|'npm'|'node'|'opencode'|'verify';cwd:string;args:string[];timeout_ms:number;max_bytes:number;}
export type AppExecutionExchange=(request:AppExecutionRequest)=>Promise<string>;
export interface AppExecutionClientOptions {
  exchange?:AppExecutionExchange;
  socketPath?:string;
  timeoutMs?:number;
  pollIntervalMs?:number;
  now?:()=>Date;
}

const APP_RE=/^[a-z][a-z0-9_-]{0,31}$/;
const JOB_RE=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOOLS=new Set(['probe','git','npm','node','opencode','verify']);
const SUBMIT_FIELDS=new Set(['tool','cwd','args','timeout_ms','max_bytes']);
const DEFAULT_SOCKET='/run/ai-tool-fabric/cocwin-control-broker.sock';
const MAX_RESPONSE_BYTES=7_000_000;

function validateIdentity(app:string,job:string):void{
  if(!APP_RE.test(app))throw new Error('APP_EXECUTION_APP_INVALID');
  if(!JOB_RE.test(job))throw new Error('APP_EXECUTION_JOB_INVALID');
}

function validateCwd(value:unknown):string{
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.length>1024||/\s|\0/.test(value))throw new Error('APP_EXECUTION_CWD_INVALID');
  const parts=value.split('/').slice(1);
  if(parts.some(part=>!part||part==='.'||part==='..'))throw new Error('APP_EXECUTION_CWD_INVALID');
  return value;
}
function integer(value:unknown,min:number,max:number,code:string):number{
  if(!Number.isInteger(value)||Number(value)<min||Number(value)>max)throw new Error(code);
  return Number(value);
}
function validatePayload(value:unknown):AppExecutionPayload{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('APP_EXECUTION_PAYLOAD_INVALID');
  const raw=value as Record<string,unknown>;
  if(Object.keys(raw).some(key=>!SUBMIT_FIELDS.has(key))||Object.keys(raw).length!==SUBMIT_FIELDS.size)throw new Error('APP_EXECUTION_PAYLOAD_FIELDS_INVALID');
  if(typeof raw.tool!=='string'||!TOOLS.has(raw.tool))throw new Error('APP_EXECUTION_TOOL_INVALID');
  const args=raw.args;
  if(!Array.isArray(args)||args.length>256||args.some((arg,index)=>typeof arg!=='string'||arg.includes('\0')||Buffer.byteLength(arg)>(raw.tool==='opencode'&&index===args.length-1?24*1024:8192))||args.reduce((sum,arg)=>sum+Buffer.byteLength(String(arg)),0)>32768)throw new Error('APP_EXECUTION_ARGS_INVALID');
  return {
    tool:raw.tool as AppExecutionPayload['tool'],cwd:validateCwd(raw.cwd),args:[...args] as string[],
    timeout_ms:integer(raw.timeout_ms,1000,1_800_000,'APP_EXECUTION_TIMEOUT_INVALID'),
    max_bytes:integer(raw.max_bytes,4096,1_048_576,'APP_EXECUTION_MAX_BYTES_INVALID'),
  };
}

function unixExchange(socketPath:string,timeoutMs:number):AppExecutionExchange{
  return async(request)=>await new Promise<string>((resolve,reject)=>{
    const socket=createConnection({path:socketPath});let data='';let settled=false;
    const finish=(error?:Error,value?:string)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve(value??'');};
    const timer=setTimeout(()=>finish(new Error('APP_EXECUTION_BROKER_TIMEOUT')),timeoutMs);
    socket.on('error',(error)=>finish(error));socket.on('end',()=>finish(new Error('APP_EXECUTION_BROKER_INCOMPLETE')));socket.on('close',()=>finish(new Error('APP_EXECUTION_BROKER_INCOMPLETE')));
    socket.on('data',(chunk:Buffer)=>{if(settled)return;data+=chunk.toString('utf8');if(Buffer.byteLength(data)>MAX_RESPONSE_BYTES)return finish(new Error('APP_EXECUTION_BROKER_RESPONSE_TOO_LARGE'));const nl=data.indexOf('\n');if(nl>=0)finish(undefined,data.slice(0,nl));});
    socket.on('connect',()=>socket.write(JSON.stringify(request)+'\n'));
  });
}

function parseOuter(raw:string):Record<string,unknown>{
  if(Buffer.byteLength(raw)>MAX_RESPONSE_BYTES)throw new Error('APP_EXECUTION_BROKER_RESPONSE_TOO_LARGE');
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error('APP_EXECUTION_BROKER_BAD_JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('APP_EXECUTION_BROKER_RESPONSE_INVALID');
  const row=value as Record<string,unknown>;
  if(row.schema!=='ATF_CONTROLLER_BROKER_RESPONSE_V1'||!['PASS','FAIL','BLOCKED'].includes(String(row.status)))throw new Error('APP_EXECUTION_BROKER_RESPONSE_INVALID');
  return row;
}
function parseInner(raw:string,app:string,job:string):Record<string,unknown>{
  let value:unknown;try{value=JSON.parse(raw.trim());}catch{throw new Error('APP_EXECUTION_RESULT_BAD_JSON');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('APP_EXECUTION_RESULT_INVALID');
  const row=value as Record<string,unknown>;
  if(row.app!==app||row.job!==job||typeof row.state!=='string')throw new Error('APP_EXECUTION_RESULT_IDENTITY_INVALID');
  return row;
}
async function delay(ms:number):Promise<void>{if(ms<=0){await Promise.resolve();return;}await new Promise(resolve=>setTimeout(resolve,ms));}

export function createAppExecutionClient(options:AppExecutionClientOptions={}){
  const timeoutMs=options.timeoutMs??30_000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000)throw new Error('APP_EXECUTION_BROKER_TIMEOUT_INVALID');
  const exchange=options.exchange??unixExchange(options.socketPath??DEFAULT_SOCKET,timeoutMs);
  const pollIntervalMs=options.pollIntervalMs??250;
  const now=options.now??(()=>new Date());
  const call=async(app:string,job:string,action:AppExecutionAction,payload:Record<string,unknown>)=>{
    validateIdentity(app,job);
    const outer=parseOuter(await exchange({app,action,arg:job,payload}));
    if(typeof outer.stdout!=='string'||!outer.stdout.trim()){
      const detail=typeof outer.error==='string'?outer.error.replace(/\s+/g,' ').trim().slice(0,256):'';
      throw new Error(detail?`APP_EXECUTION_BROKER_REJECTED:${detail}`:'APP_EXECUTION_BROKER_RESULT_MISSING');
    }
    return parseInner(outer.stdout,app,job);
  };
  // Query and monitor share a nonblocking app lock. Retry only known read
  // contention, retaining the job identity and the original run deadline.
  const readIdempotent=async(app:string,job:string,action:'app-status'|'app-result',deadline:number,attemptLimit=3)=>{
    for(let attempt=0;;attempt+=1){
      if(now().getTime()>=deadline)throw new Error('APP_EXECUTION_DEADLINE_EXCEEDED');
      try{return await call(app,job,action,{});}
      catch(error){
        const message=error instanceof Error?error.message:'';
        const contention=message==='APP_EXECUTION_BROKER_REJECTED:application job state is busy'||
          message==='APP_EXECUTION_BROKER_REJECTED:[Errno 11] Resource temporarily unavailable';
        if(!contention||attempt+1>=attemptLimit)throw error;
        const remaining=deadline-now().getTime();
        if(remaining<=0)throw new Error('APP_EXECUTION_DEADLINE_EXCEEDED');
        await delay(Math.min(pollIntervalMs,remaining));
      }
    }
  };
  const submitIdempotent=async(app:string,job:string,payload:unknown,contentionAttempts=3)=>{
    validateIdentity(app,job);
    const validated=validatePayload(payload);
    for(let attempt=0;;attempt+=1){
      try{return await call(app,job,'app-submit',validated);}
      catch(error){
        const message=error instanceof Error?error.message:'';
        const contention=
          message==='APP_EXECUTION_BROKER_REJECTED:application job state is busy'||
          message==='APP_EXECUTION_BROKER_REJECTED:[Errno 11] Resource temporarily unavailable';
        if(message.startsWith('APP_EXECUTION_BROKER_REJECTED:')&&!contention)throw error;
        const limit=contention?contentionAttempts:3;
        if(attempt+1>=limit)throw error;
        await delay(pollIntervalMs);
      }
    }
  };
  return {
    async submit(app:string,job:string,payload:unknown){return await submitIdempotent(app,job,payload);},
    async status(app:string,job:string){return await readIdempotent(app,job,'app-status',now().getTime()+timeoutMs);},
    async result(app:string,job:string){return await readIdempotent(app,job,'app-result',now().getTime()+timeoutMs);},
    async run(app:string,job:string,payload:unknown,runOptions:{deadlineMs:number}){
      const deadlineMs=integer(runOptions?.deadlineMs,1,1_920_000,'APP_EXECUTION_DEADLINE_INVALID');
      const deadline=now().getTime()+deadlineMs;
      const contentionAttempts=Math.max(3,Math.min(120,Math.ceil(deadlineMs/Math.max(1,pollIntervalMs))));
      let state=await submitIdempotent(app,job,payload,contentionAttempts);
      while(true){
        const current=String(state.state);
        if(current==='SUCCEEDED')return await readIdempotent(app,job,'app-result',deadline,contentionAttempts);
        if(current==='FAILED'){
          if(state.reason==='protected launch configuration no longer matches')throw new Error('APP_EXECUTION_LAUNCH_BLOCKED');
          if(state.timed_out===true||state.truncated===true)throw new Error('APP_EXECUTION_UNCERTAIN');
          throw new Error('APP_EXECUTION_FAILED');
        }
        if(current==='UNCERTAIN')throw new Error('APP_EXECUTION_UNCERTAIN');
        if(current!=='QUEUED'&&current!=='RUNNING')throw new Error('APP_EXECUTION_STATE_INVALID');
        if(now().getTime()>deadline)throw new Error('APP_EXECUTION_DEADLINE_EXCEEDED');
        await delay(pollIntervalMs);
        state=await readIdempotent(app,job,'app-status',deadline,contentionAttempts);
      }
    },
  };
}
