import {
  REQUIRED_RBRIDGE_CAPABILITIES,RbridgeEventSpoolV1,acquireWriteLeader,activateCapture,canonicalDigest,canonicalJson,captureResponse,
  createSendTransaction,markClicked,markResponseVerified,markSendReady,markSendUncertain,markSentVerified,markWaitingResponse,stopSend,supersedeSend,
  negotiateHello,persistSendIntent,prepareBinding,projectSendReceipt,validateEventEnvelope,verifyBinding
} from '../src/domain/rbridgeChatCore.js';
import {NativeMessageDecoder,assertApprovedExtensionOrigin,encodeNativeMessage} from '../src/transport/nativeMessaging.js';
import {StdioFrameDecoder,buildSshStdioLaunch,encodeStdioFrame} from '../src/transport/sshStdio.js';
import {selectExactBrowserTarget} from '../src/domain/browserInventory.js';
import {canonicalChatgptProjectId,describeChatgptUrl,requireExactProjectConversationUrl,sameCanonicalChatgptProject} from '../src/browser/chatgptConversationIdentity.js';
import {assertSafeRolloverCheckpoint,createRolloverProof,quotaEligibleForRouting,validateQuotaObservation} from '../src/domain/browserQuotaRollover.js';
import {RbridgeChatEventStoreV1} from '../src/server/rbridgeChatEventStore.js';
import {RbridgeReceiptStoreV1} from '../src/server/rbridgeReceiptStore.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {attemptHighConfidenceSendClick,clickHighConfidenceSendButton,inspectResponseQuiescence,locateHighConfidenceSendButton,scanAssistantTurns,stageComposerText,startAssistantTurnObserver} from '../src/browser/chatgptDomAdapter.js';
import {ChatgptContentRuntimeV1} from '../src/extension/contentRuntime.js';
import {installContentMessageBridgeV1} from '../src/extension/contentMessageBridge.js';
import {ChromeContentDriverV1,ChromeLiveTargetReaderV1,type ChromeAuthorityScriptingApiV1,type ChromeAuthorityTabsApiV1} from '../src/extension/chromeAuthorityAdapters.js';
import {parseExtensionBootstrapConfigV1,startExtensionServiceWorkerV1} from '../src/extension/serviceWorkerEntry.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildNativeHostManifest} from '../src/nativeHost/nativeHostManifest.js';
import {loadNativeHostConfigV1,parseNativeHostConfigV1} from '../src/nativeHost/nativeHostConfig.js';
import {startNativeHostMainV1,type NativeHostMainIoV1} from '../src/nativeHost/nativeHostMain.js';
import {routeServerToNative} from '../src/nativeHost/nativeHostProtocol.js';
import {NativeHostRelayV1} from '../src/nativeHost/nativeHostRelay.js';
import {parseNativeHostInvocation} from '../src/nativeHost/nativeHostInvocation.js';
import {PersistentSshStdioSessionV1,type ReconnectSchedulerV1,type SshProcessFactoryV1,type SshProcessHandleV1} from '../src/nativeHost/persistentSshSession.js';
import {buildRbridgeExtensionManifest} from '../src/extension/extensionManifest.js';
import {ExtensionNativePortLinkV1,RBRIDGE_NATIVE_HOST_NAME,type ExtensionNativePortV1} from '../src/extension/nativePortServiceWorker.js';
import {BrowserAuthorityStoreV1,type ChromeStorageAreaV1} from '../src/extension/browserAuthorityStore.js';
import {BrowserAuthorityRuntimeV1,type BrowserContentDriverV1,type BrowserLiveTargetReaderV1} from '../src/extension/browserAuthorityRuntime.js';
import {ChromeTabsInventoryAdapterV1,discoverChatgptConversationTabs,selectExactDiscoveredChatgptTarget} from '../src/extension/chromeTabInventory.js';
import {verifyReplayFailureFailClosed} from './replay-failure-case.js';

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
const testReceipt={schema:'COCWIN_RECEIPT_REF_V1' as const,receiptId:'receipt-1',receiptSchema:'RBRIDGE_TEST_RECEIPT_V1',sha256:'d'.repeat(64)};
const otherReceipt={...testReceipt,receiptId:'receipt-2'};
const target={sessionId:session,generation,browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',windowId:7,tabId:11,origin:'https://chatgpt.com',projectId:'05-cocwin',conversationId:'conv-123',conversationGeneration:1,ownerSessionId:session};
const hello={schema:'RBRIDGE_CHAT_HELLO_V1' as const,protocolMajor:1 as const,protocolMinor:3,releaseSha:'1'.repeat(40),maxMessageBytes:65536,capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES],browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',nativeHostVersion:'1.0.0'};

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

await test('Chrome tabs discovery is exact and duplicate conversation tabs are ambiguous',async()=>{
  const project='g-p-'+'a'.repeat(32),conversation='6a819823-07fc-83eb-b324-ddf6f474ea29';
  const tabs=[
    {id:1,windowId:10,url:'https://chatgpt.com/g/'+project+'-05-cocwin/c/'+conversation,active:true},
    {id:2,windowId:10,url:'https://chatgpt.com/g/'+project,active:false},
    {id:3,windowId:11,url:'https://example.com/g/'+project+'/c/'+conversation,active:false},
    {id:4,windowId:11,url:'https://chatgpt.com/',active:false},
  ];
  const rows=discoverChatgptConversationTabs(tabs,'chrome-main','profile-main');
  equal(rows.length,1,'only exact conversation');equal(rows[0]!.tabId,1,'tab');equal(rows[0]!.canonicalProjectId,project,'canonical project');
  equal(selectExactDiscoveredChatgptTarget(rows,{browserInstanceId:'chrome-main',browserProfileId:'profile-main',canonicalProjectId:project,conversationId:conversation}).tabId,1,'select exact');
  const adapter=new ChromeTabsInventoryAdapterV1({query:async()=>tabs},'chrome-main','profile-main');equal((await adapter.discover()).length,1,'adapter discovery');
  const dup=discoverChatgptConversationTabs([tabs[0]!,{...tabs[0]!,id:5,windowId:12}],'chrome-main','profile-main');
  await rejects(()=>Promise.resolve(selectExactDiscoveredChatgptTarget(dup,{browserInstanceId:'chrome-main',browserProfileId:'profile-main',canonicalProjectId:project,conversationId:conversation})),/TARGET_AMBIGUOUS/,'duplicate exact conversation tabs ambiguous');
});

await test('browser inventory selects exactly one bound target and rejects ambiguity',async()=>{
  const surface={browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',windowId:7,tabId:11,origin:'https://chatgpt.com',projectId:'05-cocwin',conversationId:'conv-123',conversationGeneration:1,active:true};
  const query={browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',origin:'https://chatgpt.com',projectId:'05-cocwin',conversationId:'conv-123'};
  equal(selectExactBrowserTarget([surface],query).tabId,11,'exact target');
  await rejects(()=>Promise.resolve(selectExactBrowserTarget([{...surface,tabId:11},{...surface,tabId:12}],query)),/TARGET_AMBIGUOUS/,'ambiguous target');
  await rejects(()=>Promise.resolve(selectExactBrowserTarget([surface],{...query,conversationId:'wrong'})),/TARGET_NOT_FOUND/,'wrong conversation');
});

await test('ChatGPT donor identity parser requires exact project conversation',async()=>{
  const project='g-p-'+'a'.repeat(32),conversation='6a819823-07fc-83eb-b324-ddf6f474ea29';
  const identity=requireExactProjectConversationUrl('https://chatgpt.com/g/'+project+'-05-cocwin/c/'+conversation+'?foo=bar#ignored');
  equal(identity.kind,'CONVERSATION','kind');equal(identity.conversationId,conversation,'conversation');equal(identity.canonicalProjectId,project,'canonical project');
  assert(sameCanonicalChatgptProject(project+'-05-cocwin',project+'-renamed'),'project slug ignored for canonical identity');
  equal(canonicalChatgptProjectId(project+'-05-cocwin'),project,'canonical helper');
  equal(describeChatgptUrl('https://chatgpt.com/g/'+project).kind,'ROUTE','project home is not conversation');
  await rejects(()=>Promise.resolve(requireExactProjectConversationUrl('https://chatgpt.com/g/'+project)),/PROJECT_CONVERSATION_REQUIRED/,'project home rejected');
  await rejects(()=>Promise.resolve(describeChatgptUrl('https://example.com/g/'+project+'/c/'+conversation)),/URL_DENIED/,'foreign origin rejected');
});

await test('quota observation is fail-closed and rollover requires quiescence',async()=>{
  const receipt={schema:'COCWIN_RECEIPT_REF_V1' as const,receiptId:'quota-1',receiptSchema:'RBRIDGE_QUOTA_RECEIPT_V1',sha256:'d'.repeat(64)};
  assert(quotaEligibleForRouting({capability:'BROWSER_CHAT_STRONG',state:'AVAILABLE',resetAt:null,receipt}),'available routes');
  equal(quotaEligibleForRouting({capability:'BROWSER_CHAT_STRONG',state:'UNKNOWN',resetAt:null,receipt}),false,'unknown blocked');
  equal(validateQuotaObservation({capability:'BROWSER_WORK',state:'AVAILABLE',resetAt:'2026-10-01T00:00:00.000Z',receipt}).resetAt,'2026-10-01T00:00:00.000Z','available may retain known reset time');
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
  await rejects(()=>Promise.resolve(stopSend(tx,'OWNER_STOP')),/SEND_RESPONSE_PENDING/,'stop cannot hide verified send awaiting response');
  await rejects(()=>Promise.resolve(supersedeSend(tx,'NEW_ATTEMPT')),/SEND_RESPONSE_PENDING/,'supersede cannot hide verified send awaiting response');
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

await test('event type and payload shapes are frozen fail-closed',async()=>{
  const spool=new RbridgeEventSpoolV1();
  const base={eventId:'strict-1',sessionId:session,generation,attemptId:attempt,effectId:effect,observedAt:at};
  await rejects(()=>spool.append({...base,eventType:'UNFROZEN_EVENT',payload:{}}),/EVENT_TYPE_INVALID/,'unknown event type');
  await rejects(()=>spool.append({...base,eventType:'BINDING_VERIFIED',payload:{receipt:testReceipt,extra:true}}),/EVENT_PAYLOAD_FIELDS_INVALID/,'extra payload field');
  await rejects(()=>spool.append({...base,eventType:'SEND_VERIFIED',payload:{purpose:'OTHER',receipt:testReceipt}}),/EVENT_PURPOSE_INVALID/,'invalid purpose');
  const quota=await spool.append({...base,eventId:'strict-quota',eventType:'QUOTA_OBSERVED',payload:{capability:'BROWSER_CHAT_STRONG',state:'AVAILABLE',resetAt:'2026-10-01T00:00:00.000Z',receipt:testReceipt}});
  equal(quota.eventType,'QUOTA_OBSERVED','valid quota event');
});

await test('event replay chain and collision',async()=>{
  const spool=new RbridgeEventSpoolV1();
  const base={eventId:'evt-1',eventType:'BINDING_VERIFIED',sessionId:session,generation,attemptId:attempt,effectId:effect,observedAt:at,payload:{receipt:testReceipt}};
  const first=await spool.append(base),replay=await spool.append(base);equal(replay.eventSha256,first.eventSha256,'replay');equal(spool.size,1,'size');
  await rejects(()=>spool.append({...base,payload:{receipt:otherReceipt}}),/REQUEST_ID_COLLISION/,'collision');
  const second=await spool.append({...base,eventId:'evt-2',eventType:'CAPTURE_ACTIVE'});equal(second.sequence,2,'sequence');equal(second.previousEventSha256,first.eventSha256,'chain');
  equal((await validateEventEnvelope(second,first.eventSha256,2)).eventSha256,second.eventSha256,'validate');
});

await test('assistant capture is assistant-only and preserves distinct code blocks',()=>{
  const dom=new JSDOM('<article data-testid="conversation-turn-1"><div data-message-author-role="user"><pre><code>USER</code></pre></div></article><article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><pre><code>A</code></pre><pre><code>A</code></pre><pre><code>B</code></pre></div></article>');
  const turns=scanAssistantTurns(dom.window.document);equal(turns.length,1,'assistant only');equal(turns[0]!.assistantTurnId,'conversation-turn-2','turn id');equal(turns[0]!.codeBlocks.length,2,'dedup exact duplicate code');equal(turns[0]!.codeBlocks[1],'B','distinct code preserved');
});

await test('send locator is composer-bound, rejects voice controls and fails closed on ambiguity',()=>{
  const one=new JSDOM('<form><div id="prompt-textarea" contenteditable="true" role="textbox">hello</div><button aria-label="Voice input" type="button">mic</button><button data-testid="send-button" type="submit">Send</button></form>');
  const found=locateHighConfidenceSendButton(one.window.document);equal(found.status,'FOUND','found');equal(found.element?.getAttribute('data-testid'),'send-button','exact send');
  const two=new JSDOM('<form><div id="prompt-textarea" contenteditable="true" role="textbox">hello</div><button data-testid="send-button" type="submit">Send</button><button data-testid="send-button" type="submit">Send</button></form>');
  equal(locateHighConfidenceSendButton(two.window.document).status,'AMBIGUOUS','ambiguous');
  const none=new JSDOM('<form><div id="prompt-textarea" contenteditable="true" role="textbox">hello</div><button aria-label="Voice input" type="button">mic</button></form>');
  equal(locateHighConfidenceSendButton(none.window.document).status,'NOT_FOUND','voice not send');
});

await test('capture observer can defer initial scan and only reacts to child-list mutation',async()=>{
  const dom=new JSDOM('<main></main>',{pretendToBeVisual:true});let scans=0;
  const stop=startAssistantTurnObserver(dom.window.document,()=>{scans++;},{deferInitialScan:true,debounceMs:0});
  equal(scans,0,'deferred');
  const article=dom.window.document.createElement('article');article.setAttribute('data-testid','conversation-turn-9');article.innerHTML='<div data-message-author-role="assistant">ok</div>';
  dom.window.document.querySelector('main')!.appendChild(article);
  await new Promise(resolve=>dom.window.setTimeout(resolve,5));
  equal(scans,1,'mutation scan');stop();
});

await test('authority-store readbacks are immutable copies',async()=>{
  const eventRoot=await mkdtemp(join(tmpdir(),'rbridge-event-copy-'));
  const receiptRoot=await mkdtemp(join(tmpdir(),'rbridge-receipt-copy-'));
  try{
    const source=new RbridgeEventSpoolV1();
    const event=await source.append({eventId:'copy-event-1',eventType:'BINDING_VERIFIED',sessionId:session,generation,attemptId:attempt,effectId:effect,observedAt:at,payload:{receipt:testReceipt}});
    const eventStore=new RbridgeChatEventStoreV1({root:eventRoot,maxEvents:10,maxBytes:65536});
    const returned=await eventStore.append(event);
    (returned.payload.receipt as Record<string,unknown>).receiptId='mutated';
    const reread=await eventStore.load();
    equal(((reread[0]!.payload.receipt as Record<string,unknown>).receiptId as string),testReceipt.receiptId,'event store internal authority unchanged');

    const verified=await verifyBinding(prepareBinding(target,new Date(at)),target,new Date(at));
    const receiptStore=new RbridgeReceiptStoreV1({root:receiptRoot,maxReceipts:10,maxBytes:65536});
    await receiptStore.put(verified.receipt);
    const first=await receiptStore.get(verified.receipt.receiptId);
    assert(first!==null,'receipt returned');
    (first as {projectId?:string}).projectId='mutated';
    const second=await receiptStore.get(verified.receipt.receiptId);
    equal((second as {projectId?:string})?.projectId,verified.receipt.projectId,'receipt store internal authority unchanged');
  }finally{
    await rm(eventRoot,{recursive:true,force:true});
    await rm(receiptRoot,{recursive:true,force:true});
  }
});

await test('durable receipt store verifies digest, restart replay and ID collision',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rbridge-receipts-'));
  try{
    const verified=await verifyBinding(prepareBinding(target,new Date(at)),target,new Date(at));
    const store=new RbridgeReceiptStoreV1({root,maxReceipts:10,maxBytes:65536});
    const ref=await store.put(verified.receipt);
    equal(ref.receiptId,verified.receipt.receiptId,'receipt id');equal(ref.receiptSchema,'RBRIDGE_CHAT_BINDING_RECEIPT_V1','receipt schema');
    const reopened=new RbridgeReceiptStoreV1({root,maxReceipts:10,maxBytes:65536});
    equal((await reopened.get(ref.receiptId))?.sha256,verified.receipt.sha256,'restart receipt');
    await rejects(()=>reopened.put({...verified.receipt,projectId:'tampered-project'}),/RECEIPT_DIGEST_INVALID/,'tampered receipt');
    const body=Object.fromEntries(Object.entries(verified.receipt).filter(([key])=>key!=='sha256')) as Record<string,unknown>;
    body.observedAt='2026-09-29T17:00:00.001Z';
    const collision={...body,sha256:await canonicalDigest(body)};
    await rejects(()=>reopened.put(collision),/REQUEST_ID_COLLISION/,'same receipt id different valid digest');
    equal((await reopened.put(verified.receipt)).sha256,verified.receipt.sha256,'idempotent receipt replay');
  }finally{await rm(root,{recursive:true,force:true});}
});

await test('durable event spool survives restart and preserves replay/collision rules',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rbridge-chat-events-'));
  try{
    const source=new RbridgeEventSpoolV1();
    const base={eventId:'durable-1',eventType:'BINDING_VERIFIED',sessionId:session,generation,attemptId:attempt,effectId:effect,observedAt:at,payload:{receipt:testReceipt}};
    const first=await source.append(base);
    const second=await source.append({...base,eventId:'durable-2',eventType:'CAPTURE_ACTIVE'});
    const store=new RbridgeChatEventStoreV1({root,maxEvents:10,maxBytes:65536});
    await store.append(first);await store.append(second);
    const reopened=new RbridgeChatEventStoreV1({root,maxEvents:10,maxBytes:65536});
    const loaded=await reopened.load();equal(loaded.length,2,'restart event count');equal(loaded[1]!.previousEventSha256,first.eventSha256,'restart chain');
    equal((await reopened.append(first)).eventSha256,first.eventSha256,'durable replay');
    equal((await reopened.load()).length,2,'replay not duplicated');
    await rejects(()=>reopened.append({...first,payload:{receipt:otherReceipt}}),/EVENT_DIGEST_INVALID/,'forged same-id same-sha payload rejected');
    const other=new RbridgeEventSpoolV1(),conflict=await other.append({...base,payload:{receipt:otherReceipt}});
    await rejects(()=>reopened.append(conflict),/REQUEST_ID_COLLISION/,'durable collision');
  }finally{await rm(root,{recursive:true,force:true});}
});

await test('Chrome native framing uses platform native byte order',()=>{
  const wire=encodeNativeMessage({schema:'ENDIAN_PROBE'});
  const little=new Uint8Array(new Uint16Array([0x0102]).buffer)[0]===0x02;
  const size=new DataView(wire.buffer,wire.byteOffset,wire.byteLength).getUint32(0,little);
  equal(size,wire.byteLength-4,'native byte order length');
});

await test('MV3 extension manifest is minimal and service worker owns native port',async()=>{
  const manifest=buildRbridgeExtensionManifest('1.0.0');
  assert(manifest.permissions.includes('nativeMessaging'),'native messaging permission');
  assert(!manifest.permissions.includes('debugger' as 'tabs'),'no debugger permission');
  assert(!('content_scripts' in manifest),'no static content-script authority');
  equal(manifest.background.type,'module','module service worker');

  class FakeEvent<T>{listeners:Array<(value:T)=>void>=[];addListener(listener:(value:T)=>void){this.listeners.push(listener);}emit(value:T){for(const listener of this.listeners)listener(value);}}
  class FakePort implements ExtensionNativePortV1{
    sent:unknown[]=[];disconnected=false;onMessage=new FakeEvent<unknown>();onDisconnect=new FakeEvent<void>();
    postMessage(value:unknown){this.sent.push(value);}
    disconnect(){this.disconnected=true;this.onDisconnect.emit(undefined);}
  }
  const port=new FakePort();let requestedHost='';let helloSeen=0;const protocolErrors:string[]=[];
  const link=new ExtensionNativePortLinkV1(
    {connectNative:name=>{requestedHost=name;return port;}},
    hello,
    {onServerHello:()=>{helloSeen++;},onProtocolError:error=>{protocolErrors.push(error.message);}},
  );
  link.connect();equal(requestedHost,RBRIDGE_NATIVE_HOST_NAME,'fixed host');equal(port.sent.length,1,'hello sent');equal((port.sent[0] as {schema:string}).schema,'RBRIDGE_CHAT_HELLO_V1','hello schema');
  const eventSource=new RbridgeEventSpoolV1();
  const event=await eventSource.append({eventId:'ext-event-1',eventType:'CAPTURE_ACTIVE',sessionId:session,generation,attemptId:attempt,effectId:effect,observedAt:at,payload:{receipt:testReceipt}});
  await rejects(()=>link.sendEvent(event),/PROTOCOL_NOT_NEGOTIATED/,'event blocked before peer hello');
  port.onMessage.emit(hello);await new Promise(resolve=>setTimeout(resolve,0));equal(helloSeen,1,'server hello accepted');assert(link.protocolReady,'extension protocol ready');
  port.onMessage.emit({...hello,capabilities:hello.capabilities.slice(0,-1)});await new Promise(resolve=>setTimeout(resolve,0));assert(protocolErrors.includes('RBRIDGE_CAPABILITY_MISSING'),'missing capability fails closed');equal(link.protocolReady,false,'bad hello clears negotiation');
  port.onMessage.emit(hello);await new Promise(resolve=>setTimeout(resolve,0));assert(link.protocolReady,'protocol restored after valid hello');
  port.onMessage.emit({schema:'RBRIDGE_CHAT_SEND_COMMAND_V1'});await new Promise(resolve=>setTimeout(resolve,0));assert(protocolErrors.includes('RBRIDGE_COMMAND_CONTRACT_UNAVAILABLE'),'unknown command blocked');equal(link.protocolReady,false,'unknown server message clears negotiation');
  port.onMessage.emit(hello);await new Promise(resolve=>setTimeout(resolve,0));assert(link.protocolReady,'protocol renegotiated');
  await link.sendEvent(event);equal((port.sent.at(-1) as {eventId:string}).eventId,'ext-event-1','event sent');
  link.disconnect();assert(port.disconnected,'disconnect');
});

await test('Native Host invocation verifies exact Chrome extension origin',async()=>{
  const extensionId='a'.repeat(32),origin='chrome-extension://'+extensionId+'/';
  const parsed=parseNativeHostInvocation([origin,'--parent-window=12345'],extensionId);
  equal(parsed.origin,origin,'origin');equal(parsed.parentWindow,12345,'parent window');
  await rejects(()=>Promise.resolve(parseNativeHostInvocation(['chrome-extension://'+'b'.repeat(32)+'/'],extensionId)),/NATIVE_ORIGIN_DENIED/,'foreign extension');
  await rejects(()=>Promise.resolve(parseNativeHostInvocation([origin,'--unexpected=1'],extensionId)),/PARENT_WINDOW_INVALID/,'unexpected second arg');
});

await test('Native Host manifest and router are strict allowlists',async()=>{
  const extensionId='a'.repeat(32);
  const manifest=buildNativeHostManifest({executablePath:'/opt/rbridge/rbridge-native-host',extensionId});
  equal(manifest.allowed_origins[0],'chrome-extension://'+extensionId+'/','origin');
  await rejects(()=>Promise.resolve(buildNativeHostManifest({executablePath:'relative-host',extensionId})),/HOST_PATH_INVALID/,'absolute host path');
  equal(routeServerToNative(hello).kind,'HELLO','server hello');
  await rejects(()=>Promise.resolve(routeServerToNative({schema:'RBRIDGE_CHAT_SEND_COMMAND_V1'})),/COMMAND_CONTRACT_UNAVAILABLE/,'unknown command denied');
});

await test('Native Host persists event before forwarding and can replay after restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rbridge-native-relay-'));
  try{
    const source=new RbridgeEventSpoolV1();
    const event=await source.append({eventId:'native-evt-1',eventType:'BINDING_VERIFIED',sessionId:session,generation,attemptId:attempt,effectId:effect,observedAt:at,payload:{receipt:testReceipt}});
    const store=new RbridgeChatEventStoreV1({root,maxEvents:10,maxBytes:65536});
    let durableBeforeForward=false;const forwarded:string[]=[];
    const peer={send:async(value:{schema:string;eventId?:string})=>{
      if(value.schema==='RBRIDGE_CHAT_EVENT_V1'){
        const reopened=new RbridgeChatEventStoreV1({root,maxEvents:10,maxBytes:65536});
        durableBeforeForward=(await reopened.load()).some(x=>x.eventId===value.eventId);
      }
      forwarded.push(value.schema);
    }};
    const relay=new NativeHostRelayV1(store,peer);
    equal(await relay.acceptBrowserMessage(hello),'HELLO_CACHED','browser hello cached while ssh down');
    equal(await relay.acceptBrowserMessage(event),'EVENT_DURABLE_QUEUED','event durable queued before ssh negotiation');
    assert(!durableBeforeForward,'not forwarded before negotiation');
    equal((await store.load()).length,1,'queued event durable');
    equal(await relay.peerConnected(),'HELLO_SENT','hello first on peer connect');equal(forwarded[0],'RBRIDGE_CHAT_HELLO_V1','hello precedes event');
    const accepted=await relay.acceptServerMessage(hello);equal(accepted.replayedEvents,1,'queued event replayed after hello');assert(relay.protocolReady,'native relay protocol ready');
    assert(durableBeforeForward,'event was durable before replay forward');equal(forwarded.at(-1),'RBRIDGE_CHAT_EVENT_V1','event follows hello');
    await rejects(()=>relay.acceptServerMessage({...hello,capabilities:hello.capabilities.slice(0,-1)}),/RBRIDGE_CAPABILITY_MISSING/,'native missing capability fails closed');
    equal(relay.protocolReady,false,'bad native peer hello clears negotiation');
    await relay.acceptServerMessage(hello);assert(relay.protocolReady,'native protocol restored');
    relay.peerDisconnected();equal(relay.protocolReady,false,'disconnect invalidates negotiation');
    await rejects(()=>relay.replayDurableEvents(),/PROTOCOL_NOT_NEGOTIATED/,'replay blocked while disconnected');
    const queued=await source.append({eventId:'native-evt-2',eventType:'CAPTURE_ACTIVE',sessionId:session,generation,attemptId:attempt,effectId:effect,observedAt:'2026-09-29T17:00:00.001Z',payload:{receipt:testReceipt}});
    equal(await relay.acceptBrowserMessage(queued),'EVENT_DURABLE_QUEUED','event queues during ssh outage');
    equal(await relay.peerConnected(),'HELLO_SENT','hello replayed after reconnect');
    const acceptedAgain=await relay.acceptServerMessage(hello);equal(acceptedAgain.replayedEvents,2,'full durable chain replayed after renegotiation');
  }finally{await rm(root,{recursive:true,force:true});}
});

await test('Native Host config and process bootstrap fail closed',async()=>{
  const root=await mkdtemp(join(tmpdir(),'rbridge-native-main-'));
  try{
    const configPath=join(root,'host.json'),events=join(root,'events');
    const config={schema:'RBRIDGE_NATIVE_HOST_CONFIG_V1' as const,expectedExtensionId:'a'.repeat(32),eventStoreRoot:events,
      ssh:{sshPath:'/usr/bin/ssh',host:'aether-engine',port:22,user:'rbridge' as const,identityFile:'/home/rbridge/.ssh/id_ed25519',knownHostsFile:'/home/rbridge/.ssh/known_hosts'}};
    await import('node:fs/promises').then(fs=>fs.writeFile(configPath,JSON.stringify(config),{mode:0o600}));
    equal((await loadNativeHostConfigV1(configPath)).ssh.user,'rbridge','config load');
    await rejects(()=>Promise.resolve(parseNativeHostConfigV1({...config,unexpected:true})),/CONFIG_FIELDS_INVALID/,'unknown config field');
    class FakeHandle implements SshProcessHandleV1{
      writes:Uint8Array[]=[];dataListener:(chunk:Uint8Array)=>void=()=>{};closeListener:(code:number|null,signal:string|null)=>void=()=>{};errorListener:(error:Error)=>void=()=>{};killed=false;
      write(data:Uint8Array){this.writes.push(data);} onData(listener:(chunk:Uint8Array)=>void){this.dataListener=listener;}
      onClose(listener:(code:number|null,signal:string|null)=>void){this.closeListener=listener;} onError(listener:(error:Error)=>void){this.errorListener=listener;} kill(){this.killed=true;}
    }
    const handles:FakeHandle[]=[];const factory:SshProcessFactoryV1={launch:()=>{const h=new FakeHandle();handles.push(h);return h;}};
    let dataHandler:(chunk:Uint8Array)=>void=()=>{},endHandler:()=>void=()=>{},errorHandler:(error:Error)=>void=()=>{},exitCode=0;
    const stdout:Uint8Array[]=[],stderr:string[]=[];
    const io:NativeHostMainIoV1={
      onData:fn=>{dataHandler=fn;},onEnd:fn=>{endHandler=fn;},onError:fn=>{errorHandler=fn;},
      writeStdout:data=>stdout.push(data),writeStderr:value=>stderr.push(value),setExitCode:code=>{exitCode=code;},
    };
    const runtime=await startNativeHostMainV1(['chrome-extension://'+'a'.repeat(32)+'/'],{RBRIDGE_NATIVE_HOST_CONFIG:configPath},io,{processFactory:factory});
    equal(runtime.running,true,'runtime started');equal(handles.length,1,'ssh launched');
    dataHandler(encodeNativeMessage(hello));await new Promise(resolve=>setTimeout(resolve,0));equal(handles[0]!.writes.length,1,'browser hello forwarded');
    dataHandler(new Uint8Array([1,0,0,0,0xff]));await new Promise(resolve=>setTimeout(resolve,0));
    equal(runtime.running,false,'malformed browser frame stops runtime');equal(exitCode,70,'fatal exit code');assert(stderr.some(line=>line.includes('RBRIDGE_NATIVE_FATAL=')),'fatal stderr only');
    equal(stdout.length,0,'no stray native stdout');
    endHandler();errorHandler(new Error('late'));equal(exitCode,70,'fatal remains stable');
  }finally{await rm(root,{recursive:true,force:true});}
});

await test('dynamic content injection happens before stage/preflight but never as click recovery',async()=>{
  let injections=0;
  const scripting:ChromeAuthorityScriptingApiV1={executeScript:async details=>{injections++;equal(details.files[0],'contentScript.js','bundle path');}};
  const replies:{[key:string]:unknown}={
    STAGE_PROMPT:{status:'STAGED_VERIFIED',utf8Bytes:5},
    CAPTURE_START:{status:'ACTIVE'},
    CAPTURE_STOP:{status:'OFF'},
    SEND_PREFLIGHT:{status:'FOUND'},
    SEND_CLICK:{outcome:'CLICKED'},
  };
  const tabs:ChromeAuthorityTabsApiV1={
    get:async id=>({id,windowId:1,url:'https://chatgpt.com/'}),
    sendMessage:async(_tab,message)=>{
      const req=message as {requestId:string;action:string};
      return {schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:req.requestId,ok:true,result:replies[req.action]};
    },
  };
  const driver=new ChromeContentDriverV1(tabs,scripting);
  await driver.stagePrompt(1,'hello');equal(injections,1,'stage inject');
  await driver.preflightSend(1);equal(injections,2,'preflight inject');
  await driver.clickSend(1);equal(injections,2,'click never reinjects after intent');
});

await test('service-worker bootstrap emits frozen HELLO from strict local config',async()=>{
  const config={schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1' as const,browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',nativeHostVersion:'1.0.0'};
  equal(parseExtensionBootstrapConfigV1(config).browserProfileId,'chatgpt-primary','bootstrap parse');
  await rejects(()=>Promise.resolve(parseExtensionBootstrapConfigV1({...config,extra:true})),/BOOTSTRAP_INVALID/,'strict config');
  const posted:unknown[]=[];
  const port={
    postMessage:(value:unknown)=>posted.push(value),disconnect:()=>{},
    onMessage:{addListener:()=>{}},onDisconnect:{addListener:()=>{}},
  };
  const link=await startExtensionServiceWorkerV1(
    {runtime:{connectNative:()=>port},storage:{local:{get:async()=>({rbridgeExtensionBootstrapV1:config})}}},
    '1'.repeat(40),
  );
  equal(link.connected,true,'native link connected');equal((posted[0] as {schema:string}).schema,'RBRIDGE_CHAT_HELLO_V1','hello first');equal((posted[0] as {releaseSha:string}).releaseSha,'1'.repeat(40),'release bound');
  link.disconnect();
});

await test('content message bridge and Chrome driver preserve pre-click proof vs channel uncertainty',async()=>{
  const page=new JSDOM('<!doctype html><body><form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" type="submit">Send</button></form></body>',{url:'https://chatgpt.com/'});
  const runtime=new ChatgptContentRuntimeV1(page.window.document,{emit:()=>{}});
  let listener:((message:unknown,sender:unknown,sendResponse:(response:unknown)=>void)=>boolean|void)|null=null;
  installContentMessageBridgeV1({onMessage:{addListener:fn=>{listener=fn;}}},runtime);
  const api:ChromeAuthorityTabsApiV1={
    get:async id=>({id,windowId:1,url:'https://chatgpt.com/'}),
    sendMessage:async(_tab,message)=>await new Promise(resolve=>{listener!(message,{},resolve);}),
  };
  const driver=new ChromeContentDriverV1(api);
  equal((await driver.stagePrompt(7,'hello')).status,'STAGED_VERIFIED','driver stage');equal((await driver.preflightSend(7)).status,'FOUND','driver preflight');
  equal((await driver.clickSend(7)).outcome,'CLICKED','driver clicked');
  page.window.document.querySelector('button')!.remove();const pre=await driver.clickSend(7);equal(pre.outcome,'FAILED_BEFORE_CLICK','no button proves no click');
  const broken=new ChromeContentDriverV1({get:api.get,sendMessage:async()=>{throw new Error('port closed');}});
  await rejects(()=>broken.clickSend(7),/SEND_UNCERTAIN/,'channel failure uncertain');
});

await test('guarded DOM click reports click exception as UNCERTAIN',()=>{
  const page=new JSDOM('<!doctype html><body><form><textarea></textarea><button data-testid="send-button" type="submit">Send</button></form></body>');
  const button=page.window.document.querySelector('button') as HTMLButtonElement;
  button.click=()=>{throw new Error('simulated click exception');};
  equal(attemptHighConfidenceSendClick(page.window.document).outcome,'UNCERTAIN','click exception uncertain');
});

await test('Chrome live target reader re-observes exact project conversation before send',async()=>{
  const project='g-p-'+'a'.repeat(32)+'-05-cocwin',conversation='6a819823-07fc-83eb-b324-ddf6f474ea29';
  const liveTarget={sessionId:session,generation,browserInstanceId:'chrome-main',browserProfileId:'chatgpt-primary',windowId:9,tabId:12,origin:'https://chatgpt.com',projectId:project,conversationId:conversation,conversationGeneration:1,ownerSessionId:session};
  const prepared=prepareBinding(liveTarget,new Date(at));
  const tabs:ChromeAuthorityTabsApiV1={get:async id=>({id,windowId:9,url:'https://chatgpt.com/g/'+project+'/c/'+conversation}),sendMessage:async()=>({})};
  const reader=new ChromeLiveTargetReaderV1(tabs,'chrome-main','chatgpt-primary');
  const observed=await reader.observe(prepared);equal(observed.conversationId,conversation,'exact conversation');equal((await verifyBinding(prepared,observed,new Date(at))).control.status,'VERIFIED','live verify');
});

await test('S8 SEND_INTENT is a separately provable no-click checkpoint and S9 requires same-runtime arm',async()=>{
  class MemoryStorage implements ChromeStorageAreaV1{
    data:Record<string,unknown>={};
    async get(key:string){return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
    async set(items:Record<string,unknown>){Object.assign(this.data,structuredClone(items));}
  }
  const make=async()=>{
    const storage=new MemoryStorage();let clicks=0;
    const driver:BrowserContentDriverV1={
      startCapture:async()=>({status:'ACTIVE'}),stopCapture:async()=>({status:'OFF'}),
      stagePrompt:async(_tab,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).byteLength}),
      preflightSend:async()=>({status:'FOUND'}),
      clickSend:async()=>{clicks++;return {outcome:'CLICKED'};},
    };
    const runtime=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),{observe:async()=>target},driver);
    await runtime.prepareAndVerifyBinding(target,new Date(at));await runtime.acquireLeader(new Date(at));await runtime.activateCapture(new Date(at));
    await runtime.stageSend({sessionId:session,generation,attemptId:attempt,effectId:effect,challenge,purpose:'PROMPT',text:'s8-s9'},new Date(at));
    return {storage,runtime,driver,getClicks:()=>clicks};
  };

  const same=await make();
  const s8=await same.runtime.persistSendIntentOnly(new Date(at));
  equal(s8.activeSend?.state,'SEND_INTENT','S8 durable intent');equal(same.getClicks(),0,'S8 zero click');
  const s9=await same.runtime.executePersistedSend(new Date(at));
  equal(s9.activeSend?.state,'CLICKED_UNVERIFIED','S9 clicked');equal(same.getClicks(),1,'S9 one click');

  const restartedCase=await make();
  await restartedCase.runtime.persistSendIntentOnly(new Date(at));equal(restartedCase.getClicks(),0,'restart fixture zero click');
  const restarted=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(restartedCase.storage),{observe:async()=>target},restartedCase.driver);
  await rejects(()=>restarted.executePersistedSend(new Date(at)),/SEND_RECONCILE_REQUIRED/,'restart loses ephemeral click arm');
  equal((await restarted.state())?.activeSend?.state,'SEND_INTENT','restart preserves intent for reconcile');equal(restartedCase.getClicks(),0,'restart never clicks');
});

await test('browser authority runtime persists intent before exactly one click',async()=>{
  class MemoryStorage implements ChromeStorageAreaV1{
    data:Record<string,unknown>={};
    async get(key:string){return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
    async set(items:Record<string,unknown>){Object.assign(this.data,structuredClone(items));}
  }
  const storage=new MemoryStorage(),store=new BrowserAuthorityStoreV1(storage);
  const reader:BrowserLiveTargetReaderV1={observe:async()=>target};
  let clicks=0,intentSeenAtClick='';
  let captureStarts=0;
  const driver:BrowserContentDriverV1={
    startCapture:async()=>{captureStarts++;return {status:'ACTIVE'};},stopCapture:async()=>({status:'OFF'}),
    stagePrompt:async(_tab,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).byteLength}),
    preflightSend:async()=>({status:'FOUND'}),
    clickSend:async()=>{clicks++;const snap=await new BrowserAuthorityStoreV1(storage).load();intentSeenAtClick=snap?.activeSend?.state??'';return {outcome:'CLICKED'};},
  };
  const runtime=new BrowserAuthorityRuntimeV1(store,reader,driver);
  await runtime.prepareAndVerifyBinding(target,new Date(at));await runtime.acquireLeader(new Date(at));await runtime.activateCapture(new Date(at));equal(captureStarts,1,'capture runtime confirmed once');
  await runtime.stageSend({sessionId:session,generation,attemptId:attempt,effectId:effect,challenge,purpose:'PROMPT',text:'hello'},new Date(at));
  equal((await runtime.state())?.activeSend?.state,'READY_NOT_SENT','staged no click');equal(clicks,0,'stage zero click');
  const sent=await runtime.sendOnce(new Date(at));equal(intentSeenAtClick,'SEND_INTENT','intent durable before click');equal(sent.activeSend?.state,'CLICKED_UNVERIFIED','clicked state');equal(clicks,1,'exactly one click');
  await rejects(()=>runtime.sendOnce(new Date(at)),/SEND_NOT_READY/,'second click blocked');equal(clicks,1,'still one click');
});

await test('proven pre-click failure terminalizes intent while transport failure becomes UNCERTAIN',async()=>{
  class MemoryStorage implements ChromeStorageAreaV1{
    data:Record<string,unknown>={};
    async get(key:string){return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
    async set(items:Record<string,unknown>){Object.assign(this.data,structuredClone(items));}
  }
  const make=async(driver:BrowserContentDriverV1)=>{
    const storage=new MemoryStorage(),store=new BrowserAuthorityStoreV1(storage);
    const runtime=new BrowserAuthorityRuntimeV1(store,{observe:async()=>target},driver);
    await runtime.prepareAndVerifyBinding(target,new Date(at));await runtime.acquireLeader(new Date(at));await runtime.activateCapture(new Date(at));
    await runtime.stageSend({sessionId:session,generation,attemptId:attempt,effectId:effect,challenge,purpose:'PROMPT',text:'hello'},new Date(at));
    return runtime;
  };
  const proven=await make({startCapture:async()=>({status:'ACTIVE'}),stopCapture:async()=>({status:'OFF'}),stagePrompt:async(_t,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).byteLength}),preflightSend:async()=>({status:'FOUND'}),clickSend:async()=>({outcome:'FAILED_BEFORE_CLICK',reason:'SEND_BUTTON_NOT_FOUND'})});
  equal((await proven.sendOnce(new Date(at))).activeSend?.state,'FAILED_BEFORE_CLICK','proof terminalizes after intent');
  let uncertainClicks=0;
  const uncertain=await make({startCapture:async()=>({status:'ACTIVE'}),stopCapture:async()=>({status:'OFF'}),stagePrompt:async(_t,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).byteLength}),preflightSend:async()=>({status:'FOUND'}),clickSend:async()=>{uncertainClicks++;throw new Error('MESSAGE_CHANNEL_CLOSED');}});
  await rejects(()=>uncertain.sendOnce(new Date(at)),/SEND_UNCERTAIN/,'transport failure uncertain');
  equal((await uncertain.state())?.activeSend?.state,'UNCERTAIN','uncertain durable');await rejects(()=>uncertain.sendOnce(new Date(at)),/SEND_NOT_READY/,'uncertain never re-clicked');equal(uncertainClicks,1,'one uncertain click attempt');
});

await test('capture authority is persisted only after content runtime confirms ACTIVE',async()=>{
  class MemoryStorage implements ChromeStorageAreaV1{
    data:Record<string,unknown>={};
    async get(key:string){return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
    async set(items:Record<string,unknown>){Object.assign(this.data,structuredClone(items));}
  }
  const storage=new MemoryStorage(),store=new BrowserAuthorityStoreV1(storage);
  const driver:BrowserContentDriverV1={
    startCapture:async()=>{throw new Error('CONTENT_CHANNEL_DOWN');},stopCapture:async()=>({status:'OFF'}),
    stagePrompt:async(_t,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).byteLength}),
    preflightSend:async()=>({status:'FOUND'}),clickSend:async()=>({outcome:'CLICKED'}),
  };
  const runtime=new BrowserAuthorityRuntimeV1(store,{observe:async()=>target},driver);
  await runtime.prepareAndVerifyBinding(target,new Date(at));await runtime.acquireLeader(new Date(at));
  await rejects(()=>runtime.activateCapture(new Date(at)),/CONTENT_CHANNEL_DOWN/,'capture start must confirm');
  equal((await runtime.state())?.capture,null,'no false ACTIVE capture persisted');
});

await test('browser authority snapshot persists SEND_INTENT across restart and stale CAS fails closed',async()=>{
  class MemoryStorage implements ChromeStorageAreaV1{
    data:Record<string,unknown>={};failAfterWrite=false;
    async get(key:string){return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
    async set(items:Record<string,unknown>){Object.assign(this.data,structuredClone(items));if(this.failAfterWrite)throw new Error('simulated disconnect');}
  }
  const storage=new MemoryStorage(),store=new BrowserAuthorityStoreV1(storage);
  const verified=await verifyBinding(prepareBinding(target,new Date(at)),target,new Date(at));
  const leader=acquireWriteLeader(verified.control,null,new Date(at)),capture=activateCapture(verified.control,leader,null,new Date(at));
  let tx=createSendTransaction({sessionId:session,generation,attemptId:attempt,effectId:effect,challenge,purpose:'PROMPT',payloadUtf8Bytes:17},verified.control,leader,capture,new Date(at));
  tx=persistSendIntent(markSendReady(tx),new Date(at));
  const first=await store.commit(0,{binding:verified.control,leader,capture,activeSend:tx},new Date(at));
  equal(first.revision,1,'first revision');equal(first.activeSend?.state,'SEND_INTENT','intent durable');
  const reopened=new BrowserAuthorityStoreV1(storage),loaded=await reopened.load();equal(loaded?.activeSend?.effectId,effect,'restart effect');equal(loaded?.activeSend?.state,'SEND_INTENT','restart blocks blind resend');
  await rejects(()=>reopened.commit(0,{binding:verified.control,leader,capture,activeSend:tx},new Date(at)),/REVISION_MISMATCH/,'stale revision blocked');
});

await test('authority storage write uncertainty reconciles from durable snapshot',async()=>{
  class UncertainStorage implements ChromeStorageAreaV1{
    data:Record<string,unknown>={};fail=false;
    async get(key:string){return key in this.data?{[key]:structuredClone(this.data[key])}:{};}
    async set(items:Record<string,unknown>){Object.assign(this.data,structuredClone(items));if(this.fail)throw new Error('after write');}
  }
  const storage=new UncertainStorage(),store=new BrowserAuthorityStoreV1(storage);
  const verified=await verifyBinding(prepareBinding(target,new Date(at)),target,new Date(at));
  const leader=acquireWriteLeader(verified.control,null,new Date(at)),capture=activateCapture(verified.control,leader,null,new Date(at));
  let tx=createSendTransaction({sessionId:session,generation,attemptId:attempt,effectId:effect,challenge,purpose:'PROMPT',payloadUtf8Bytes:9},verified.control,leader,capture,new Date(at));
  tx=persistSendIntent(markSendReady(tx),new Date(at));storage.fail=true;
  await rejects(()=>store.commit(0,{binding:verified.control,leader,capture,activeSend:tx},new Date(at)),/WRITE_UNCERTAIN/,'caller sees uncertainty');
  storage.fail=false;const reconciled=await new BrowserAuthorityStoreV1(storage).load();
  equal(reconciled?.activeSend?.state,'SEND_INTENT','readback proves intent despite uncertain caller result');
});

await test('content runtime stages idempotently and guarded Send clicks exactly once',async()=>{
  const page=new JSDOM('<!doctype html><body><form><textarea id="prompt-textarea"></textarea><button type="submit" data-testid="send-button">Send</button></form></body>',{url:'https://chatgpt.com/'});
  const document=page.window.document;const button=document.querySelector('button') as HTMLButtonElement;let clicks=0;button.addEventListener('click',event=>{event.preventDefault();clicks++;});
  equal(stageComposerText(document,'hello').status,'STAGED_VERIFIED','stage');equal((document.querySelector('textarea') as HTMLTextAreaElement).value,'hello','readback');
  equal(stageComposerText(document,'hello').status,'ALREADY_PRESENT_IDEMPOTENT','idempotent stage');
  equal(locateHighConfidenceSendButton(document).status,'FOUND','send preflight');clickHighConfidenceSendButton(document);equal(clicks,1,'one click');
  const emitted:unknown[]=[];const runtime=new ChatgptContentRuntimeV1(document,{emit:frame=>{emitted.push(frame);}});
  equal((runtime.handle({schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:'p1',action:'SEND_PREFLIGHT'}) as {status:string}).status,'FOUND','runtime preflight');
  await rejects(()=>Promise.resolve(runtime.handle({schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:'p2',action:'STAGE_PROMPT',text:'different'})),/COMPOSER_NOT_EMPTY/,'manual content preserved');
});

await test('capture start baselines stale assistant history and emits only new or changed turns',async()=>{
  const page=new JSDOM('<!doctype html><body><article data-testid="conversation-turn-1"><div data-message-author-role="assistant">old</div></article><form><textarea id="prompt-textarea"></textarea><button data-testid="send-button" type="submit">Send</button></form></body>',{url:'https://chatgpt.com/'});
  const emitted:{turns:{assistantTurnId:string;text:string}[]}[]=[];
  const runtime=new ChatgptContentRuntimeV1(page.window.document,{emit:frame=>{emitted.push(frame as {turns:{assistantTurnId:string;text:string}[]});}});
  const started=runtime.handle({schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:'start1',action:'CAPTURE_START',captureToken:'capture-1'}) as {baselineTurns:number};
  equal(started.baselineTurns,1,'one stale baseline turn');equal(emitted.length,0,'baseline not emitted');
  const old=page.window.document.querySelector('[data-message-author-role="assistant"]')!;
  old.textContent='old changed';
  await new Promise(resolve=>setTimeout(resolve,300));
  equal(emitted.length,1,'changed turn emitted');equal(emitted[0]!.turns[0]!.text,'old changed','changed text');
  const article=page.window.document.createElement('article');article.setAttribute('data-testid','conversation-turn-2');
  article.innerHTML='<div data-message-author-role="assistant">new</div>';page.window.document.body.appendChild(article);
  await new Promise(resolve=>setTimeout(resolve,300));
  equal(emitted.length,2,'new turn emitted');equal(emitted[1]!.turns[0]!.assistantTurnId,'conversation-turn-2','new id');
  runtime.handle({schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:'stop1',action:'CAPTURE_STOP'});
});

await test('capture waits for terminal UI quiescence before emitting response',async()=>{
  const page=new JSDOM('<!doctype html><body><article data-testid="conversation-turn-1"><div data-message-author-role="assistant">old</div></article><form><textarea id="prompt-textarea"></textarea><button data-testid="stop-button" aria-label="Stop generating" type="button">Stop</button></form></body>',{url:'https://chatgpt.com/'});
  const emitted:unknown[]=[];const runtime=new ChatgptContentRuntimeV1(page.window.document,{emit:frame=>{emitted.push(frame);}});
  runtime.handle({schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:'qs1',action:'CAPTURE_START',captureToken:'capture-q'});
  const article=page.window.document.createElement('article');article.setAttribute('data-testid','conversation-turn-2');article.innerHTML='<div data-message-author-role="assistant">partial</div>';page.window.document.body.insertBefore(article,page.window.document.querySelector('form'));
  await new Promise(resolve=>setTimeout(resolve,300));
  equal(inspectResponseQuiescence(page.window.document).settled,false,'streaming UI not settled');equal(emitted.length,0,'partial response suppressed');
  const stop=page.window.document.querySelector('[data-testid="stop-button"]')!;const send=page.window.document.createElement('button');send.setAttribute('data-testid','send-button');send.setAttribute('type','submit');send.textContent='Send';stop.replaceWith(send);
  article.querySelector('[data-message-author-role="assistant"]')!.textContent='final';
  await new Promise(resolve=>setTimeout(resolve,300));
  equal(inspectResponseQuiescence(page.window.document).settled,true,'terminal UI settled');equal(emitted.length,1,'final response emitted');
  runtime.stop();
});

await test('composer byte ceiling cannot be raised above frozen M0 limit',async()=>{
  const page=new JSDOM('<!doctype html><body><textarea id="prompt-textarea"></textarea></body>');
  await rejects(()=>Promise.resolve(stageComposerText(page.window.document,'x'.repeat(48_001),100_000)),/SEND_PAYLOAD_TOO_LARGE/,'caller cannot raise frozen cap');
});

await test('content runtime fails closed on composer/Send ambiguity and captures assistant only',async()=>{
  const ambiguousComposer=new JSDOM('<!doctype html><body><textarea></textarea><textarea></textarea></body>',{url:'https://chatgpt.com/'});
  await rejects(()=>Promise.resolve(stageComposerText(ambiguousComposer.window.document,'x')),/COMPOSER_AMBIGUOUS/,'composer ambiguity');
  const ambiguousSend=new JSDOM('<!doctype html><body><form><textarea></textarea><button type="submit" data-testid="send-button">Send</button><button type="submit" data-testid="send-button">Send</button></form></body>',{url:'https://chatgpt.com/'});
  let clicks=0;for(const button of ambiguousSend.window.document.querySelectorAll('button'))button.addEventListener('click',event=>{event.preventDefault();clicks++;});
  equal(locateHighConfidenceSendButton(ambiguousSend.window.document).status,'AMBIGUOUS','send ambiguity');
  await rejects(()=>Promise.resolve(clickHighConfidenceSendButton(ambiguousSend.window.document)),/SEND_BUTTON_AMBIGUOUS/,'ambiguous click blocked');equal(clicks,0,'zero ambiguous clicks');
  const capture=new JSDOM('<!doctype html><body><article data-testid="conversation-turn-1"><div data-message-author-role="user">user</div></article><article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><pre><code>{"ok":true}</code></pre>assistant</div></article></body>',{url:'https://chatgpt.com/'});
  const runtime=new ChatgptContentRuntimeV1(capture.window.document,{emit:()=>{}});
  const scan=runtime.handle({schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:'scan1',action:'CAPTURE_SCAN'}) as {turns:{assistantTurnId:string}[]};
  equal(scan.turns.length,1,'assistant only');equal(scan.turns[0]!.assistantTurnId,'conversation-turn-2','stable assistant id');
});

await test('Native Messaging exact framing and extension origin',async()=>{
  const id='a'.repeat(32);assertApprovedExtensionOrigin('chrome-extension://'+id+'/',id);
  await rejects(()=>Promise.resolve(assertApprovedExtensionOrigin('chrome-extension://'+'b'.repeat(32)+'/',id)),/ORIGIN_DENIED/,'origin');
  const wire=encodeNativeMessage({schema:'X',n:1}),decoder=new NativeMessageDecoder();
  equal(decoder.push(wire.slice(0,3)).length,0,'partial');const values=decoder.push(wire.slice(3));equal(values.length,1,'frame');assert((values[0] as {n:number}).n===1,'value');
});

await test('persistent SSH session reconnects with bounded backoff and framed replay callback',async()=>{
  class FakeHandle implements SshProcessHandleV1{
    writes:Uint8Array[]=[];dataListener:(chunk:Uint8Array)=>void=()=>{};closeListener:(code:number|null,signal:string|null)=>void=()=>{};errorListener:(error:Error)=>void=()=>{};killed=false;
    write(data:Uint8Array){this.writes.push(data);}
    onData(listener:(chunk:Uint8Array)=>void){this.dataListener=listener;}
    onClose(listener:(code:number|null,signal:string|null)=>void){this.closeListener=listener;}
    onError(listener:(error:Error)=>void){this.errorListener=listener;}
    kill(){this.killed=true;}
    emitData(data:Uint8Array){this.dataListener(data);}
    close(code:number|null=0,signal:string|null=null){this.closeListener(code,signal);}
  }
  const handles:FakeHandle[]=[];
  const factory:SshProcessFactoryV1={launch:()=>{const h=new FakeHandle();handles.push(h);return h;}};
  const scheduled:{delay:number;fn:()=>void;cancelled:boolean}[]=[];
  const scheduler:ReconnectSchedulerV1={
    set:(delay,fn)=>{const row={delay,fn,cancelled:false};scheduled.push(row);return row;},
    clear:(handle)=>{(handle as {cancelled:boolean}).cancelled=true;},
  };
  const messages:unknown[]=[];let connected=0,disconnected=0,transportErrors=0;
  const session=new PersistentSshStdioSessionV1(
    {sshPath:'/usr/bin/ssh',host:'aether-engine',port:22,user:'rbridge',identityFile:'/home/rbridge/.ssh/id_ed25519',knownHostsFile:'/home/rbridge/.ssh/known_hosts'},
    {onConnected:()=>{connected++;},onMessage:value=>{messages.push(value);},onDisconnected:()=>{disconnected++;},onError:()=>{transportErrors++;}},
    factory,scheduler,
  );
  session.start();equal(session.state,'CONNECTED','connected');equal(connected,1,'connect hook');
  assert(session.send({schema:'PING'})===true,'send accepted');equal(handles[0]!.writes.length,1,'one framed write');
  handles[0]!.emitData(encodeStdioFrame({schema:'PONG'}));equal((messages[0] as {schema:string}).schema,'PONG','decoded');
  handles[0]!.emitData(new TextEncoder().encode('{bad-json}\n'));
  equal(session.state,'BACKOFF','malformed frame invalidates session');assert(handles[0]!.killed,'malformed frame kills child');
  equal(disconnected,1,'disconnect hook');equal(transportErrors,1,'transport error hook');equal(scheduled[0]!.delay,100,'first delay');
  scheduled[0]!.fn();equal(session.state,'CONNECTED','reconnected');equal(connected,2,'second connect');equal(handles.length,2,'second process');
  session.stop();equal(session.state,'STOPPED','stopped');assert(handles[1]!.killed,'active process killed');
});

await test('SSH stdio fixed command and no shell',()=>{
  const launch=buildSshStdioLaunch({sshPath:'/usr/bin/ssh',host:'aether-engine',port:22,user:'rbridge',identityFile:'/home/rbridge/.ssh/id_ed25519',knownHostsFile:'/home/rbridge/.ssh/known_hosts'});
  equal(launch.options.shell,false,'shell');assert(launch.args.includes('-oBatchMode=yes'),'batch');assert(launch.args.includes('-oStrictHostKeyChecking=yes'),'host key');equal(launch.args.at(-1),'rbridge-chat-stdio-v1','command');
  const wire=encodeStdioFrame({schema:'X',sequence:1}),decoder=new StdioFrameDecoder();equal(decoder.push(wire.slice(0,4)).length,0,'partial');equal(decoder.push(wire.slice(4)).length,1,'frame');
});

await test('reconnect replay failure clears protocol readiness',verifyReplayFailureFailClosed);

console.log('SUMMARY passed='+passed+' failed='+failed);
if(failed!==0)throw new Error('TESTS_FAILED:'+String(failed));
