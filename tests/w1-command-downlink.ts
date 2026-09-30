import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {REQUIRED_RBRIDGE_CAPABILITIES,type RbridgeChatHelloV1} from '../src/domain/rbridgeChatCore.js';
import {parseRbridgeChatCommandV1,type RbridgeChatCommandV1,type RbridgeChatCommandResultV1} from '../src/domain/rbridgeChatCommand.js';
import {startExtensionServiceWorkerV1} from '../src/extension/serviceWorkerEntry.js';
import {NativeHostRelayV1} from '../src/nativeHost/nativeHostRelay.js';
import {RbridgeChatEventStoreV1} from '../src/server/rbridgeChatEventStore.js';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function equal<T>(actual:T,expected:T,message:string){if(actual!==expected)throw new Error(message+': expected='+String(expected)+' actual='+String(actual));}
async function rejects(fn:()=>unknown|Promise<unknown>,pattern:RegExp,message:string){
  try{await fn();throw new Error(message+': did not reject');}
  catch(error){const value=error instanceof Error?error.message:String(error);if(value.includes('did not reject')||!pattern.test(value))throw new Error(message+': '+value);}
}
const drain=async()=>{await new Promise(resolve=>setTimeout(resolve,0));};

const session='exta-'+'1'.repeat(32);
const generation='11111111-1111-4111-8111-111111111111';
const attempt=session+':a:1';
const effect='2'.repeat(64);
const challenge='3'.repeat(64);
const issuedAt='2026-09-30T12:00:00.000Z';
const project='g-p-'+'a'.repeat(32)+'-05-cocwin';
const canonicalProject='g-p-'+'a'.repeat(32);
const conversation='6a819823-07fc-83eb-b324-ddf6f474ea29';

function command(
  commandId:string,
  action:RbridgeChatCommandV1['action'],
  payload:Record<string,unknown>,
  correlated=false,
):RbridgeChatCommandV1{
  return parseRbridgeChatCommandV1({
    schema:'RBRIDGE_CHAT_COMMAND_V1',commandId,action,sessionId:session,generation,
    attemptId:correlated?attempt:null,effectId:correlated?effect:null,
    requestDigest:createHash('sha256').update(commandId).digest('hex'),issuedAt,payload,
  });
}

class Event<T>{
  listeners:Array<(value:T)=>void>=[];
  addListener(listener:(value:T)=>void){this.listeners.push(listener);}
  emit(value:T){for(const listener of this.listeners)listener(value);}
}

const posted:unknown[]=[];
const inbound=new Event<unknown>(),disconnected=new Event<void>();
let clicks=0;
const storageData:Record<string,unknown>={
  rbridgeExtensionBootstrapV1:{schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1',browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',nativeHostVersion:'1.0.0'},
};
const port={
  postMessage:(value:unknown)=>posted.push(structuredClone(value)),
  disconnect:()=>{},
  onMessage:inbound,onDisconnect:disconnected,
};
const tabs={
  query:async()=>[{id:20,windowId:10,url:'https://chatgpt.com/g/'+project+'/c/'+conversation,active:true}],
  get:async(id:number)=>({id,windowId:10,url:'https://chatgpt.com/g/'+project+'/c/'+conversation,active:true}),
  sendMessage:async(_tabId:number,message:unknown)=>{
    const row=message as {schema:string;requestId:string;action:string;text?:string};
    let result:unknown;
    if(row.action==='CAPTURE_START')result={status:'ACTIVE'};
    else if(row.action==='CAPTURE_STOP')result={status:'OFF'};
    else if(row.action==='STAGE_PROMPT')result={status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(row.text??'').byteLength};
    else if(row.action==='SEND_PREFLIGHT')result={status:'FOUND'};
    else if(row.action==='SEND_CLICK'){clicks++;result={outcome:'CLICKED'};}
    else throw new Error('TEST_CONTENT_ACTION_UNEXPECTED');
    return {schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:row.requestId,ok:true,result};
  },
};
const scripting={executeScript:async()=>[]};
const api={
  runtime:{connectNative:()=>port},
  storage:{local:{
    get:async(key:string)=>key in storageData?{[key]:structuredClone(storageData[key])}:{},
    set:async(items:Record<string,unknown>)=>{Object.assign(storageData,structuredClone(items));},
  }},
  tabs,scripting,
};

const link=await startExtensionServiceWorkerV1(api,'4'.repeat(40));
assert(link.connected,'native link should connect');
const localHello=posted[0] as RbridgeChatHelloV1;
equal(localHello.schema,'RBRIDGE_CHAT_HELLO_V1','local hello first');

const serverHello:RbridgeChatHelloV1={
  ...localHello,releaseSha:'5'.repeat(40),capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES],
};
inbound.emit(serverHello);await drain();
assert(link.protocolReady,'HELLO must negotiate before commands');

async function send(commandValue:RbridgeChatCommandV1):Promise<RbridgeChatCommandResultV1>{
  inbound.emit(commandValue);await drain();
  const value=posted.at(-1) as RbridgeChatCommandResultV1;
  equal(value.schema,'RBRIDGE_CHAT_COMMAND_RESULT_V1','command result schema');
  equal(value.commandId,commandValue.commandId,'command correlation');
  equal(value.requestDigest,commandValue.requestDigest,'request digest correlation');
  return value;
}

const discovered=await send(command('cmd-discover','DISCOVER_TARGET',{canonicalProjectId:canonicalProject,conversationId:conversation}));
assert(discovered.ok,'discovery must pass');

const bound=await send(command('cmd-bind','BIND_TARGET',{
  windowId:10,tabId:20,origin:'https://chatgpt.com',projectId:project,conversationId:conversation,conversationGeneration:1,
}));
assert(bound.ok,'bind must pass');

assert((await send(command('cmd-leader','ACQUIRE_WRITE_LEADER',{}))).ok,'leader must pass');
assert((await send(command('cmd-capture','ACTIVATE_CAPTURE',{}))).ok,'capture must pass');

assert((await send(command('cmd-stage','STAGE_PROMPT',{challenge,purpose:'PROMPT',text:'bounded prompt'},true))).ok,'stage must pass');
equal(clicks,0,'stage must not click');

const intent=command('cmd-intent','PERSIST_SEND_INTENT',{},true);
assert((await send(intent)).ok,'intent must pass');
equal(clicks,0,'durable intent must precede click');

const execute=command('cmd-execute','EXECUTE_PERSISTED_SEND',{},true);
assert((await send(execute)).ok,'execute must pass');
equal(clicks,1,'execute clicks exactly once');

assert((await send(execute)).ok,'same command replay returns cached result');
equal(clicks,1,'duplicate command must never click twice');

await rejects(
  ()=>Promise.resolve(parseRbridgeChatCommandV1({
    schema:'RBRIDGE_CHAT_COMMAND_V1',commandId:'bad',action:'EVAL_JS',sessionId:session,generation,
    attemptId:null,effectId:null,requestDigest:'f'.repeat(64),issuedAt,payload:{code:'alert(1)'},
  })),
  /RBRIDGE_COMMAND_INVALID/,
  'arbitrary browser command rejected',
);

const root=await mkdtemp(join(tmpdir(),'rbridge-command-relay-'));
try{
  const forwarded:unknown[]=[];
  const relay=new NativeHostRelayV1(new RbridgeChatEventStoreV1({root,maxEvents:10,maxBytes:65536}),{send:async value=>{forwarded.push(value);}});
  equal(await relay.acceptBrowserMessage(localHello),'HELLO_CACHED','browser hello cached');
  equal(await relay.peerConnected(),'HELLO_SENT','hello sent to server');
  await relay.acceptServerMessage(serverHello);
  const serverCommand=command('cmd-relay','READ_STATE',{});
  const accepted=await relay.acceptServerMessage(serverCommand);
  equal(accepted.message.kind,'COMMAND','server command accepted after HELLO');
  const result: RbridgeChatCommandResultV1={
    schema:'RBRIDGE_CHAT_COMMAND_RESULT_V1',commandId:serverCommand.commandId,action:serverCommand.action,sessionId:serverCommand.sessionId,generation:serverCommand.generation,
    attemptId:null,effectId:null,requestDigest:serverCommand.requestDigest,completedAt:issuedAt,ok:true,result:null,errorCode:null,
  };
  equal(await relay.acceptBrowserMessage(result),'COMMAND_RESULT_FORWARDED','browser result forwarded to server');
  equal((forwarded.at(-1) as RbridgeChatCommandResultV1).commandId,'cmd-relay','result correlation preserved');
}finally{await rm(root,{recursive:true,force:true});}

console.log('W1_COMMAND_DOWNLINK_ACCEPTANCE=PASS');
