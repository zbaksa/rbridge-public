import {
  acquireWriteLeader,activateCapture,createSendTransaction,markSendReady,persistSendIntent,prepareBinding,verifyBinding,
  type BrowserTargetObservationV1,
} from '../src/domain/rbridgeChatCore.js';
import {BrowserAuthorityStoreV1,type ChromeStorageAreaV1} from '../src/extension/browserAuthorityStore.js';
import {BrowserAuthorityRuntimeV1,type BrowserContentDriverV1,type BrowserLiveTargetReaderV1} from '../src/extension/browserAuthorityRuntime.js';

let passed=0,failed=0;
function equal<T>(actual:T,expected:T,message:string):void{if(actual!==expected)throw new Error(message+': expected='+String(expected)+' actual='+String(actual));}
async function rejects(fn:()=>unknown|Promise<unknown>,pattern:RegExp,message:string):Promise<void>{
  try{await fn();throw new Error(message+': did not reject');}
  catch(error){const value=error instanceof Error?error.message:String(error);if(value.includes('did not reject')||!pattern.test(value))throw new Error(message+': '+value);}
}
async function test(name:string,fn:()=>unknown|Promise<unknown>):Promise<void>{
  try{await fn();passed++;console.log('PASS W1_FAILURE '+name);}
  catch(error){failed++;console.error('FAIL W1_FAILURE '+name+': '+(error instanceof Error?error.stack:String(error)));}
}

const session='exta-'+'e'.repeat(32);
const generation='123e4567-e89b-42d3-a456-426614174000';
const attempt=session+':a:1';
const effect='f'.repeat(64),challenge='c'.repeat(64),at='2026-09-30T09:00:00.000Z';
const target:BrowserTargetObservationV1={
  sessionId:session,generation,browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',
  windowId:10,tabId:20,origin:'https://chatgpt.com',projectId:'g-p-'+'a'.repeat(32)+'-05-cocwin',
  conversationId:'6a819823-07fc-83eb-b324-ddf6f474ea29',conversationGeneration:1,ownerSessionId:session,
};

class MemoryStorage implements ChromeStorageAreaV1{
  data:Record<string,unknown>={};
  failOnIntent=false;
  async get(key:string):Promise<Record<string,unknown>>{return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
  async set(items:Record<string,unknown>):Promise<void>{
    Object.assign(this.data,structuredClone(items));
    const value=Object.values(items)[0] as {activeSend?:{state?:string}}|undefined;
    if(this.failOnIntent&&value?.activeSend?.state==='SEND_INTENT')throw new Error('simulated post-write disconnect');
  }
}

function driver(click:()=>Promise<{outcome:'CLICKED'}|{outcome:'FAILED_BEFORE_CLICK';reason:string}|{outcome:'UNCERTAIN';reason:string}>):BrowserContentDriverV1{
  return {
    stagePrompt:async(_tab,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).byteLength}),
    preflightSend:async()=>({status:'FOUND'}),
    clickSend:async()=>await click(),
  };
}

async function armedRuntime(
  storage:MemoryStorage,
  reader:BrowserLiveTargetReaderV1,
  content:BrowserContentDriverV1,
):Promise<BrowserAuthorityRuntimeV1>{
  const runtime=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),reader,content);
  await runtime.prepareAndVerifyBinding(target,new Date(at));
  await runtime.acquireLeader(new Date(at));
  await runtime.activateCapture(new Date(at));
  await runtime.stageSend({sessionId:session,generation,attemptId:attempt,effectId:effect,challenge,purpose:'PROMPT',text:'failure campaign prompt'},new Date(at));
  return runtime;
}

await test('extension restart before SEND resumes READY_NOT_SENT exactly once',async()=>{
  const storage=new MemoryStorage();let clicks=0;
  const reader:BrowserLiveTargetReaderV1={observe:async()=>target};
  const content=driver(async()=>{clicks++;return {outcome:'CLICKED'};});
  await armedRuntime(storage,reader,content);
  const restarted=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),reader,content);
  equal((await restarted.state())?.activeSend?.state,'READY_NOT_SENT','restart staged state');
  await restarted.sendOnce(new Date(at));
  equal(clicks,1,'one click after restart');
  await rejects(()=>restarted.sendOnce(new Date(at)),/SEND_NOT_READY/,'second click blocked');
  equal(clicks,1,'still one click');
});

await test('restart after durable SEND_INTENT never clicks blindly',async()=>{
  const storage=new MemoryStorage();let clicks=0;
  const reader:BrowserLiveTargetReaderV1={observe:async()=>target};
  const content=driver(async()=>{clicks++;return {outcome:'CLICKED'};});
  const runtime=await armedRuntime(storage,reader,content);
  storage.failOnIntent=true;
  await rejects(()=>runtime.sendOnce(new Date(at)),/WRITE_UNCERTAIN/,'intent commit outcome reported uncertain');
  equal(clicks,0,'no click when durable-intent commit acknowledgement uncertain');
  storage.failOnIntent=false;
  const restarted=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),reader,content);
  equal((await restarted.state())?.activeSend?.state,'SEND_INTENT','restart sees durable intent');
  await rejects(()=>restarted.sendOnce(new Date(at)),/SEND_NOT_READY/,'blind retry blocked');
  equal(clicks,0,'still zero click');
});

await test('manual navigation to wrong conversation blocks before intent and click',async()=>{
  const storage=new MemoryStorage();let clicks=0,observed={...target};
  const reader:BrowserLiveTargetReaderV1={observe:async()=>observed};
  const content=driver(async()=>{clicks++;return {outcome:'CLICKED'};});
  const runtime=await armedRuntime(storage,reader,content);
  observed={...target,conversationId:'00000000-0000-0000-0000-000000000000'};
  await rejects(()=>runtime.sendOnce(new Date(at)),/BROWSER_BINDING_STALE/,'wrong conversation blocked');
  equal((await runtime.state())?.activeSend?.state,'READY_NOT_SENT','intent not persisted on stale target');
  equal(clicks,0,'wrong target never clicked');
});

await test('message-channel loss after intent becomes durable UNCERTAIN across restart',async()=>{
  const storage=new MemoryStorage();let attempts=0;
  const reader:BrowserLiveTargetReaderV1={observe:async()=>target};
  const content=driver(async()=>{attempts++;throw new Error('MESSAGE_CHANNEL_CLOSED');});
  const runtime=await armedRuntime(storage,reader,content);
  await rejects(()=>runtime.sendOnce(new Date(at)),/SEND_UNCERTAIN/,'channel loss uncertain');
  equal(attempts,1,'one click attempt');
  equal((await runtime.state())?.activeSend?.state,'UNCERTAIN','uncertain persisted');
  const restarted=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),reader,content);
  await rejects(()=>restarted.sendOnce(new Date(at)),/SEND_NOT_READY/,'restart no blind click');
  equal(attempts,1,'no second click');
});

await test('domain can prove FAILED_BEFORE_CLICK only after durable intent',async()=>{
  const prepared=prepareBinding(target,new Date(at)),verified=await verifyBinding(prepared,target,new Date(at));
  const leader=acquireWriteLeader(verified.control,null,new Date(at)),capture=activateCapture(verified.control,leader,null,new Date(at));
  let tx=createSendTransaction({sessionId:session,generation,attemptId:attempt,effectId:effect,challenge,purpose:'PROMPT',payloadUtf8Bytes:1},verified.control,leader,capture,new Date(at));
  tx=persistSendIntent(markSendReady(tx),new Date(at));
  equal(tx.state,'SEND_INTENT','campaign fixture intent');
});

console.log(JSON.stringify({schema:'RBRIDGE_W1_FAILURE_CAMPAIGN_V1',status:failed===0?'PASS':'FAIL',passed,failed}));
if(failed!==0)throw new Error('W1_FAILURE_CAMPAIGN_FAILED:'+String(failed));
