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
import {locateHighConfidenceSendButton,scanAssistantTurns,startAssistantTurnObserver} from '../src/browser/chatgptDomAdapter.js';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildNativeHostManifest} from '../src/nativeHost/nativeHostManifest.js';
import {routeServerToNative} from '../src/nativeHost/nativeHostProtocol.js';
import {NativeHostRelayV1} from '../src/nativeHost/nativeHostRelay.js';
import {parseNativeHostInvocation} from '../src/nativeHost/nativeHostInvocation.js';
import {PersistentSshStdioSessionV1,type ReconnectSchedulerV1,type SshProcessFactoryV1,type SshProcessHandleV1} from '../src/nativeHost/persistentSshSession.js';
import {buildRbridgeExtensionManifest} from '../src/extension/extensionManifest.js';
import {ExtensionNativePortLinkV1,RBRIDGE_NATIVE_HOST_NAME,type ExtensionNativePortV1} from '../src/extension/nativePortServiceWorker.js';
import {ChromeTabsInventoryAdapterV1,discoverChatgptConversationTabs,selectExactDiscoveredChatgptTarget} from '../src/extension/chromeTabInventory.js';

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
  port.onMessage.emit(hello);await new Promise(resolve=>setTimeout(resolve,0));equal(helloSeen,1,'server hello accepted');
  port.onMessage.emit({schema:'RBRIDGE_CHAT_SEND_COMMAND_V1'});await new Promise(resolve=>setTimeout(resolve,0));assert(protocolErrors.includes('RBRIDGE_COMMAND_CONTRACT_UNAVAILABLE'),'unknown command blocked');
  const eventSource=new RbridgeEventSpoolV1();
  const event=await eventSource.append({eventId:'ext-event-1',eventType:'CAPTURE_ACTIVE',sessionId:session,generation,attemptId:attempt,effectId:effect,observedAt:at,payload:{receipt:testReceipt}});
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
    equal(await relay.acceptBrowserMessage(event),'EVENT_DURABLE_FORWARDED','event result');
    assert(durableBeforeForward,'durable before forward');
    equal(forwarded.length,1,'one forward');
    const replayPeer={sent:0,send:async()=>{replayPeer.sent++;}};
    const replayRelay=new NativeHostRelayV1(new RbridgeChatEventStoreV1({root,maxEvents:10,maxBytes:65536}),replayPeer);
    equal(await replayRelay.replayDurableEvents(),1,'replay count');equal(replayPeer.sent,1,'replay sent');
  }finally{await rm(root,{recursive:true,force:true});}
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
  const messages:unknown[]=[];let connected=0;
  const session=new PersistentSshStdioSessionV1(
    {sshPath:'/usr/bin/ssh',host:'aether-engine',port:22,user:'rbridge',identityFile:'/home/rbridge/.ssh/id_ed25519',knownHostsFile:'/home/rbridge/.ssh/known_hosts'},
    {onConnected:()=>{connected++;},onMessage:value=>{messages.push(value);}},
    factory,scheduler,
  );
  session.start();equal(session.state,'CONNECTED','connected');equal(connected,1,'connect hook');
  assert(session.send({schema:'PING'})===true,'send accepted');equal(handles[0]!.writes.length,1,'one framed write');
  handles[0]!.emitData(encodeStdioFrame({schema:'PONG'}));equal((messages[0] as {schema:string}).schema,'PONG','decoded');
  handles[0]!.close(255,null);equal(session.state,'BACKOFF','backoff');equal(scheduled[0]!.delay,100,'first delay');
  scheduled[0]!.fn();equal(session.state,'CONNECTED','reconnected');equal(connected,2,'second connect');equal(handles.length,2,'second process');
  session.stop();equal(session.state,'STOPPED','stopped');assert(handles[1]!.killed,'active process killed');
});

await test('SSH stdio fixed command and no shell',()=>{
  const launch=buildSshStdioLaunch({sshPath:'/usr/bin/ssh',host:'aether-engine',port:22,user:'rbridge',identityFile:'/home/rbridge/.ssh/id_ed25519',knownHostsFile:'/home/rbridge/.ssh/known_hosts'});
  equal(launch.options.shell,false,'shell');assert(launch.args.includes('-oBatchMode=yes'),'batch');assert(launch.args.includes('-oStrictHostKeyChecking=yes'),'host key');equal(launch.args.at(-1),'rbridge-chat-stdio-v1','command');
  const wire=encodeStdioFrame({schema:'X',sequence:1}),decoder=new StdioFrameDecoder();equal(decoder.push(wire.slice(0,4)).length,0,'partial');equal(decoder.push(wire.slice(4)).length,1,'frame');
});

console.log('SUMMARY passed='+passed+' failed='+failed);
if(failed!==0)throw new Error('TESTS_FAILED:'+String(failed));
