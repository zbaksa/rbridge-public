import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RbridgeEventSpoolV1,REQUIRED_RBRIDGE_CAPABILITIES} from '../src/domain/rbridgeChatCore.js';
import {RbridgeChatEventStoreV1} from '../src/server/rbridgeChatEventStore.js';
import {NativeHostRelayV1} from '../src/nativeHost/nativeHostRelay.js';

export async function verifyReplayFailureFailClosed():Promise<void>{
  const root=await mkdtemp(join(tmpdir(),'rbridge-replay-check-'));
  const session='exta-'+'a'.repeat(32);
  const generation='123e4567-e89b-42d3-a456-426614174000';
  const attempt=session+':a:1';
  const effect='b'.repeat(64);
  const at='2026-09-29T17:00:00.000Z';
  const receipt={schema:'COCWIN_RECEIPT_REF_V1' as const,receiptId:'receipt-rf',receiptSchema:'RBRIDGE_TEST_RECEIPT_V1',sha256:'d'.repeat(64)};
  const hello={
    schema:'RBRIDGE_CHAT_HELLO_V1' as const,protocolMajor:1 as const,protocolMinor:3,
    releaseSha:'1'.repeat(40),maxMessageBytes:65536,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES],
    browserInstanceId:'chrome-main',browserProfileId:'profile-main',nativeHostVersion:'1.0.0',
  };
  try{
    const source=new RbridgeEventSpoolV1();
    const event=await source.append({eventId:'rf-1',eventType:'CAPTURE_ACTIVE',sessionId,generation,attemptId:attempt,effectId:effect,observedAt:at,payload:{receipt}});
    const store=new RbridgeChatEventStoreV1({root,maxEvents:10,maxBytes:65536});
    await store.append(event);
    const peer={send:async(value:{schema:string})=>{if(value.schema==='RBRIDGE_CHAT_EVENT_V1')throw new Error('TEST_REPLAY_FAILURE');}};
    const relay=new NativeHostRelayV1(store,peer);
    if(await relay.acceptBrowserMessage(hello)!=='HELLO_CACHED')throw new Error('REPLAY_TEST_HELLO_CACHE_FAILED');
    if(await relay.peerConnected()!=='HELLO_SENT')throw new Error('REPLAY_TEST_HELLO_SEND_FAILED');
    let failed=false;
    try{await relay.acceptServerMessage(hello);}catch(error){failed=error instanceof Error&&error.message==='TEST_REPLAY_FAILURE';}
    if(!failed)throw new Error('REPLAY_TEST_EXPECTED_FAILURE_MISSING');
    if(relay.protocolReady)throw new Error('REPLAY_TEST_NEGOTIATION_NOT_CLEARED');
    const second=await source.append({eventId:'rf-2',eventType:'CAPTURE_ACTIVE',sessionId,generation,attemptId:attempt,effectId:effect,observedAt:'2026-09-29T17:00:00.001Z',payload:{receipt}});
    if(await relay.acceptBrowserMessage(second)!=='EVENT_DURABLE_QUEUED')throw new Error('REPLAY_TEST_EVENT_NOT_QUEUED');
  }finally{
    await rm(root,{recursive:true,force:true});
  }
}
