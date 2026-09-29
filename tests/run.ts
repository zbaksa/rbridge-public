import {
  REQUIRED_RBRIDGE_CAPABILITIES,RbridgeEventSpoolV1,acquireWriteLeader,activateCapture,canonicalDigest,canonicalJson,captureResponse,
  createSendTransaction,markClicked,markResponseVerified,markSendReady,markSendUncertain,markSentVerified,markWaitingResponse,
  negotiateHello,persistSendIntent,prepareBinding,projectSendReceipt,validateEventEnvelope,verifyBinding
} from '../src/domain/rbridgeChatCore.js';
import {NativeMessageDecoder,assertApprovedExtensionOrigin,encodeNativeMessage} from '../src/transport/nativeMessaging.js';
import {StdioFrameDecoder,buildSshStdioLaunch,encodeStdioFrame} from '../src/transport/sshStdio.js';
import {selectExactBrowserTarget} from '../src/domain/browserInventory.js';
import {assertSafeRolloverCheckpoint,createRolloverProof,quotaEligibleForRouting,validateQuotaObservation} from '../src/domain/browserQuotaRollover.js';

let passed=0,failed=0;
function assert(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message);}
function equal<T>(actual:T,expected:T,message:string){if(actual!==expected)throw new Error(message+': expected='+String(expected)+' actual='+String(actual));}
async function rejects(fn:()=>unknown|Promise<unknown>,pattern:RegExp,message:string){
  try{await fn();throw new Error(message+': did not reject');}
  catch(error){const value=error instanceof Error?error.message:String(error);if(value.includes('did not reject')||!pattern.test(value))throw new Error(message+': '+value);}
}
async function test(name:string,fn:()=>unknown|Promise<unknown>){
  try{await fn();passed++;console.log('PASS '+name);}
  catch(error){failed++;console.error('FAIL '+name+': '+(error instanceof Error?error.stack:String(error)));}
}

const session='exta-'+'a'.repeat(32),generation='123e4567-e89b-42d3-a456-426614174000',attempt=session+':a:1';
const effect='b'.repeat(64),challenge='c'.repeat(64),at='2026-09-29T17:00:00.000Z';
const target={sessionId:session,generation,browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',windowId:7,tabId:11,origin:'https://chatgpt.com',projectId:'05-cocwin',conversationId:'conv-123',conversationGeneration:1,ownerSessionId:session};
const hello={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1 as const,protocolMinor:3,releaseSha:'1'.repeat(40),maxMessageBytes:65536,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES],browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',nativeHostVersion:'1.0.0'};

await test('canonical JSON and digest',async()=>{
  equal(canonicalJson({z:1,a:{y:2,x:3}}),'{"a":{"x":3,"y":2},"z":1}','canonical ordering');
  equal((await canonicalDigest({a:1})).length,64,'sha length');
  await rejects(()=>Promise.resolve(canonicalJson({x:1.5})),/NUMBER_INVALID/,'float rejected');
});

await test('HELLO required capabilities and negotiated limits',async()=>{
  const peer={...hello,protocolMinor:1,maxMessageBytes:32768,releaseSha:'2'.repeat(40)};
  const out=negotiateHello(hello,peer);equal(out.protocolMinor,1,'minor');equal(out.maxMessageBytes,32768,'bytes');
  await rejects(()=>Promise.resolve(negotiateHello(hello,{...peer,capabilities:peer.capabilities.slice(0,-1)})),/RBRIDGE_CAPABILITY_MISSING/,'cap missing');
});

await test('browser inventory selects exactly one bound target and rejects ambiguity',async()=>{
  const surface={browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',windowId:7,tabId:11,origin:'https://chatgpt.com',projectId:'05-cocwin',conversationId:'conv-123',conversationGeneration:1,active:true};
  const query={browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',origin:'https://chatgpt.com',projectId:'05-cocwin',conversationId:'conv-123'};
  equal(selectExactBrowserTarget([surface],query).tabId,11,'exact target');
  await rejects(()=>Promise.resolve(selectExactBrowserTarget([{...surface,tabId:11},{...surface,tabId:12}],query)),/TARGET_AMBIGUOUS/,'ambiguous target');
  await rejects(()=>Promise.resolve(selectExactBrowserTarget([surface],{...query,conversationId:'wrong'})),/TARGET_NOT_FOUND/,'wrong conversation');
});

await test('quota observation is fail-closed and rollover requires quiescence',async()=>{
  const receipt={schema:'COCWIN_RECEIPT_REF_V1' as const,receiptId:'quota-1',receiptSchema:'RBRIDGE_QUOTA_RECEIPT_V1',sha256:'d'.repeat(64)};
  assert(quotaEligibleForRouting({capability:'BROWSER_CHAT_STRONG',state:'AVAILABLE',resetAt:null,receipt}),'available routes');
  equal(quotaEligibleForRouting({capability:'BROWSER_CHAT_STRONG',state:'UNKNOWN',resetAt:null,receipt}),false,'unknown blocked');
  await rejects(()=>Promise.resolve(validateQuotaObservation({capability:'BROWSER_WORK',state:'AVAILABLE',resetAt:'2026-10-01T00:00:00.000Z',receipt})),/AVAILABLE_RESET_INVALID/,'available reset rejected');
  assertSafeRolloverCheckpoint({durableSessionState:true,streamedResponseActive:false,currentSend:null});
  await rejects(()=>Promise.resolve(assertSafeRolloverCheckpoint({durableSessionState:false,streamedResponseActive:false,currentSend:null})),/SESSION_NOT_DURABLE/,'durability required');
  const proof=createRolloverProof({previousConversationId:'conv-123',newConversationId:'conv-124',bindingReceipt:receipt},{durableSessionState:true,streamedResponseActive:false,currentSend:null});
  equal(proof.newConversationId,'conv-124','rollover proof');
});

await test('binding gates leader and capture',async()=>{
  const prepared=prepareBinding(target,new Date(at));
  await rejects(()=>Promise.resolve(acquireWriteLeader(prepared,null,new Date(at))),/BROWSER_BINDING_STALE/,'leader pre-verify');
  await rejects(()=>verifyBinding(prepared,{...target,tabId:12},new Date(at)),/BROWSER_BINDING_STALE/,'wrong tab');
  const verified=await verifyBinding(prepared,target,new Date(at));equal(verified.control.status,'VERIFIED','binding');
  const leader=acquireWriteLeader(verified.control,null,new Date(at));equal(leader.epoch,1,'leader epoch');
  const capture=activateCapture(verified.control,leader,null,new Date(at));equal(capture.epoch,1,'capture epoch');
});

await test('SEND intent-before-click and uncertainty reconciliation',async()=>{
  const verified=await verifyBinding(prepareBinding(target,new Date(at)),target,new Date(at));
  const leader=acquireWriteLeader(verified.control,null,new Date(at)),capture=activateCapture(verified.control,leader,null,new Date(at));
  let tx=createSendTransaction({sessionId:session,generation,attemptId:attempt,effectId:effect,challenge,purpose:'PROMPT',payloadUtf8Bytes:1024},verified.control,leader,capture,new Date(at));
  await rejects(()=>Promise.resolve(markClicked(tx,new Date(at))),/SEND_STATE_INVALID/,'click pre-intent');
  tx=markSendReady(tx);tx=persistSendIntent(tx,new Date(at));tx=markClicked(tx,new Date(at));tx=markSendUncertain(tx);
  await rejects(()=>Promise.resolve(persistSendIntent(tx,new Date(at))),/SEND_STATE_INVALID/,'blind resend');
  tx=markSentVerified(tx,new Date(at));equal((await projectSendReceipt(tx,new Date(at))).transactionState,'SENT_VERIFIED','send receipt');
  tx=markWaitingResponse(tx);
  const captured=await captureResponse({assistantTurnId:'turn-1',responseText:'ok',machineBlockUtf8:null},tx,capture,new Date(at));
  equal(captured.receipt.responseUtf8Bytes,2,'capture bytes');
  equal(markResponseVerified(tx,new Date(at)).state,'RESPONSE_VERIFIED','response verified');
});

await test('frozen assistant output budget',async()=>{
  const verified=await verifyBinding(prepareBinding(target,new Date(at)),target,new Date(at));
  const leader=acquireWriteLeader(verified.control,null,new Date(at)),capture=activateCapture(verified.control,leader,null,new Date(at));
  let tx=createSendTransaction({sessionId:session,generation,attemptId:attempt,effectId:effect,challenge,purpose:'PROMPT',payloadUtf8Bytes:1},verified.control,leader,capture,new Date(at));
  tx=markSentVerified(markClicked(persistSendIntent(markSendReady(tx),new Date(at)),new Date(at)),new Date(at));
  await rejects(()=>captureResponse({assistantTurnId:'turn-big',responseText:'x'.repeat(16385),machineBlockUtf8:null},tx,capture,new Date(at)),/OUTPUT_BUDGET_EXCEEDED/,'output cap');
});

await test('event replay chain and collision',async()=>{
  const spool=new RbridgeEventSpoolV1();
  const base={eventId:'evt-1',eventType:'BINDING_VERIFIED',sessionId:session,generation,attemptId:attempt,effectId:effect,observedAt:at,payload:{status:'ok'}};
  const first=await spool.append(base),replay=await spool.append(base);equal(replay.eventSha256,first.eventSha256,'replay');equal(spool.size,1,'size');
  await rejects(()=>spool.append({...base,payload:{status:'different'}}),/REQUEST_ID_COLLISION/,'collision');
  const second=await spool.append({...base,eventId:'evt-2',eventType:'CAPTURE_ACTIVE'});equal(second.sequence,2,'sequence');equal(second.previousEventSha256,first.eventSha256,'chain');
  equal((await validateEventEnvelope(second,first.eventSha256,2)).eventSha256,second.eventSha256,'validate');
});

await test('Native Messaging exact framing and extension origin',async()=>{
  const id='a'.repeat(32);assertApprovedExtensionOrigin('chrome-extension://'+id+'/',id);
  await rejects(()=>Promise.resolve(assertApprovedExtensionOrigin('chrome-extension://'+'b'.repeat(32)+'/',id)),/ORIGIN_DENIED/,'origin');
  const wire=encodeNativeMessage({schema:'X',n:1}),decoder=new NativeMessageDecoder();
  equal(decoder.push(wire.slice(0,3)).length,0,'partial');const values=decoder.push(wire.slice(3));equal(values.length,1,'frame');assert((values[0] as {n:number}).n===1,'value');
});

await test('SSH stdio fixed command and no shell',()=>{
  const launch=buildSshStdioLaunch({sshPath:'/usr/bin/ssh',host:'aether-engine',port:22,user:'rbridge',identityFile:'/home/rbridge/.ssh/id_ed25519',knownHostsFile:'/home/rbridge/.ssh/known_hosts'});
  equal(launch.options.shell,false,'shell');assert(launch.args.includes('-oBatchMode=yes'),'batch');assert(launch.args.includes('-oStrictHostKeyChecking=yes'),'host key');equal(launch.args.at(-1),'rbridge-chat-stdio-v1','command');
  const wire=encodeStdioFrame({schema:'X',sequence:1}),decoder=new StdioFrameDecoder();equal(decoder.push(wire.slice(0,4)).length,0,'partial');equal(decoder.push(wire.slice(4)).length,1,'frame');
});

console.log('SUMMARY passed='+passed+' failed='+failed);
if(failed!==0)throw new Error('TESTS_FAILED:'+String(failed));
