import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import * as chromeAdapters from '../src/extension/chromeAuthorityAdapters.js';
import {BrowserAuthorityRuntimeV1,type BrowserContentDriverV1} from '../src/extension/browserAuthorityRuntime.js';
import {BrowserAuthorityStoreV1,type ChromeStorageAreaV1} from '../src/extension/browserAuthorityStore.js';
import {RbridgeEffectStoreV1} from '../src/extension/rbridgeEffectStore.js';
import {RbridgeCaptureEgressV3,installCaptureMessageBridgeV3,type CaptureAckV3,type ChromeCaptureSenderV3,type CaptureMessageApiV3} from '../src/extension/rbridgeCaptureEgress.js';
import {ChatgptDeliveryAdapterV3,type DeliveryObservationV3,type DeliverySurfaceV3} from '../src/browser/chatgptDeliveryAdapter.js';
import {canonicalDigest,sha256Hex,type RbridgeChatEventV1,type RbridgeChatEffectCommandV1,type CocwinRbridgeEffectRequestV1} from '../src/domain/rbridgeEffectProtocol.js';
import type {BrowserTargetObservationV1} from '../src/domain/rbridgeChatCore.js';
import {SITE_ASSISTANT_MARKDOWN_AVAILABLE_V3,type SiteMarkdownObservationV3} from '../src/browser/chatgptAssistantMarkdownCapture.js';
const fixture=JSON.parse(await readFile(new URL('../../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8'));
const command=fixture.vectors[1].command as RbridgeChatEffectCommandV1,request=command.request,t=request.payload.target;
const payload=request.payload as {text:string;challenge:string;purpose:'PROMPT'},extensionId='ebibbijpegoankenmggdnehpoadcophk';
const url=t.origin+'/g/'+t.projectId+'/c/'+t.conversationId,markdown='## Exact site bytes\r\n```json\n{"ok":true}\n```\n';
const sender:ChromeCaptureSenderV3={id:extensionId,tabId:t.tabId,frameId:0,url};
type ReadResult={assistantTurnId:string;observation:SiteMarkdownObservationV3};
type Matched=Extract<DeliveryObservationV3,{kind:'MATCHED'}>;
interface Reader{acquire(request:CocwinRbridgeEffectRequestV1,delivery:Matched,admit:()=>Promise<()=>void>):Promise<ReadResult>;startAcquire?:(request:CocwinRbridgeEffectRequestV1,delivery:Matched,admit:()=>Promise<()=>void>,readAdmission?:()=>void)=>{result:Promise<ReadResult>;settled:Promise<{outcome:'COMPLETED'|'FAILED';copyIssued:boolean}>}}
type ReaderConstructor=new(tabs:unknown,scripting:unknown,browserInstanceId:string,browserProfileId:string)=>Reader;
type Script={world:string;target:{tabId:number;frameIds?:number[];documentIds?:string[]};func:(input:unknown)=>unknown;args:unknown[]};
const itemBytes=new WeakMap<object,Blob>();
class ClipboardItemBoundary{constructor(blob:Blob){itemBytes.set(this,blob);}get types(){if(!itemBytes.has(this))throw TypeError('Illegal item');return ['text/plain'];}getType(){if(!itemBytes.has(this))throw TypeError('Illegal item');return Promise.resolve(itemBytes.get(this)!);}}
class Storage implements ChromeStorageAreaV1{data:Record<string,unknown>={};failOutbox=false;failActivity=false;async get(key:string){return key in this.data?{[key]:structuredClone(this.data[key])}:{};}async set(items:Record<string,unknown>){if(this.failActivity&&'rbridgeSiteCaptureActivityV1'in items)throw Error('activity quota');if(this.failOutbox&&'rbridgeCaptureOutboxV3'in items)throw Error('quota');Object.assign(this.data,structuredClone(items));}}
async function authority(){
 const storage=new Storage(),{canonicalProjectId:unused,...target}=t;void unused;
 let live:BrowserTargetObservationV1={...target,sessionId:request.sessionId,generation:request.generation,ownerSessionId:request.sessionId};
 const content:BrowserContentDriverV1={stagePrompt:async(_tab,text)=>({status:'STAGED_VERIFIED',utf8Bytes:new TextEncoder().encode(text).byteLength}),startCapture:async()=>({status:'ACTIVE'}),stopCapture:async()=>({status:'OFF'}),preflightSend:async()=>({status:'FOUND'}),clickSend:async()=>({outcome:'CLICKED'})};
 const runtime=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),{observe:async()=>structuredClone(live)},content);
 await runtime.prepareAndVerifyBinding(live);await runtime.acquireLeader();await runtime.activateCapture();await runtime.finalizeBindingReceipt();
 const effects=new RbridgeEffectStoreV1(storage);await effects.reserve(command);
 const surface:DeliverySurfaceV3={documentId:'content-document',documentUrl:url,observedAt:new Date().toISOString(),turns:[]};
 const delivery=new ChatgptDeliveryAdapterV3(storage,{scan:async()=>structuredClone(surface)});await delivery.prepareDelivery(request);
 await runtime.stageSend({...request,...payload});await runtime.persistSendIntentOnly();await runtime.executePersistedSend();await runtime.markDeliveryVerified();
 surface.observedAt=new Date().toISOString();surface.turns=[{userTurnId:'new-user',textSha256:await sha256Hex(payload.text)}];
 const state=(await runtime.state())!,token='capture:'+state.capture!.sessionId+':'+state.capture!.epoch;
 const options={storage,runtime,effects,extensionId,browserInstanceId:t.browserInstanceId,browserProfileId:t.browserProfileId,ownerAppId:request.appId,maxMessageBytes:65536,initialHistory:[],publish:async()=>{}};
 return {storage,runtime,effects,delivery,surface,token,options,changeLive:(patch:Partial<BrowserTargetObservationV1>)=>{live={...live,...patch};}};
}
async function setup(){
 const h=await authority(),page=new JSDOM('<main><section data-turn="user" data-turn-id="user-section"><div data-message-author-role="user" data-message-id="new-user"></div></section><section data-turn="assistant" data-turn-id="assistant-new" data-turn-state="complete"><div data-message-author-role="assistant">Visible DOM differs from site Markdown</div><button data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></section></main>',{url});
 const document=page.window.document,button=document.querySelector('button')!;document.querySelector('[data-message-author-role="user"]')!.textContent=payload.text;
 Object.defineProperty(button,'getClientRects',{value:()=>[{}] as unknown as DOMRectList});Object.defineProperty(page.window,'Blob',{value:Blob});Object.defineProperty(page.window,'ClipboardItem',{value:ClipboardItemBoundary});
 let siteCopies=0,forwarded=0;const clipboard={write:async(_items:unknown)=>{void _items;forwarded++;},writeText:async(_text:unknown)=>{void _text;forwarded++;}};
 Object.defineProperty(page.window.navigator,'clipboard',{value:clipboard});button.addEventListener('click',()=>{siteCopies++;void clipboard.write([new ClipboardItemBoundary(new Blob([markdown],{type:'text/plain'}))]);});
 const scripts:Script[]=[],changes:{beforeProbe?:()=>void|Promise<void>;beforeMain?:()=>void|Promise<void>;afterMain?:()=>void|Promise<void>;replyFrame?:number;replyDocument?:string;extraFrame?:boolean;tabUrl?:string;stall?:boolean;tabStall?:boolean}={};
 const scripting={executeScript:async(raw:unknown)=>{const d=raw as Script;scripts.push(d);if(changes.stall)return await new Promise<never>(()=>{});if(d.world==='MAIN')await changes.beforeMain?.();else if(scripts.length===1)await changes.beforeProbe?.();const old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});let result:unknown;try{result=await d.func(d.args[0]);}finally{if(old)Object.defineProperty(globalThis,'document',old);else Reflect.deleteProperty(globalThis,'document');}if(d.world==='MAIN')await changes.afterMain?.();const out=[{frameId:changes.replyFrame??0,documentId:changes.replyDocument??'chrome-document-1',result}];if(changes.extraFrame)out.push({frameId:2,documentId:'child-document',result});return out;}};
 const tabs={get:async()=>{if(changes.tabStall)return await new Promise<never>(()=>{});return {id:t.tabId,windowId:t.windowId,url:changes.tabUrl??url};}};
 const Constructor=(chromeAdapters as unknown as {ChromeSiteMarkdownReaderV3?:ReaderConstructor}).ChromeSiteMarkdownReaderV3;assert.equal(typeof Constructor,'function','Missing admitted Chrome site reader');
 const makeReader=()=>new Constructor!(tabs,scripting,t.browserInstanceId,t.browserProfileId),reader=makeReader();let fresh=true;const options={...h.options,siteReader:reader,delivery:h.delivery,freshSendAdmission:(candidate:CocwinRbridgeEffectRequestV1)=>{assert.equal(candidate.requestDigest,request.requestDigest);assert.equal(candidate.effectId,request.effectId);if(!fresh)throw Error('FRESH_SEND_ADMISSION_USED');fresh=false;}},egress=new RbridgeCaptureEgressV3(options);
 const acquire=async(token=h.token,source=sender)=>{const fn=(egress as unknown as {acquireSite?:(token:string,sender:ChromeCaptureSenderV3)=>Promise<CaptureAckV3>}).acquireSite;assert.equal(typeof fn,'function','Missing admitted V3 egress acquisition');return await fn!.call(egress,token,source);};
 return {...h,page,document,button,changes,reader,makeReader,egress,options,acquire,scripts,counts:()=>({siteCopies,forwarded}),close:()=>page.window.close()};
}
let passed=0,failed=0;async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_SITE_READER '+name);}catch(e){failed++;console.error('FAIL V3_SITE_READER '+name+': '+String(e));}}
await test('admitted_copy_uses_document_id_and_persists_exact_site_markdown',async()=>{
 const h=await setup(),ack=await h.acquire();assert.equal(ack.durable,true);assert.equal((await h.egress.events())[0]!.payload.assistantTurnUtf8,markdown);assert.deepEqual(h.scripts.map(s=>s.world),['ISOLATED','MAIN','ISOLATED']);assert.deepEqual(h.scripts[0]!.target,{tabId:t.tabId,frameIds:[0]});for(const script of h.scripts.slice(1))assert.deepEqual(script.target,{tabId:t.tabId,documentIds:['chrome-document-1']});assert.deepEqual(h.counts(),{siteCopies:1,forwarded:0});h.close();
});
await test('durable_replay_and_concurrent_polls_do_not_copy_twice',async()=>{
 const h=await setup(),[a,b]=await Promise.all([h.acquire(),h.acquire()]);assert.deepEqual(a,b);assert.deepEqual(await h.acquire(),a);assert.equal((await h.egress.events()).length,1);assert.equal(h.counts().siteCopies,1);h.close();
});
await test('wrong_sender_or_lease_never_reaches_chrome',async()=>{
 for(const [token,source]of [['wrong',sender],['token',{...sender,frameId:1}],['token',{...sender,id:'a'.repeat(32)}],['token',{...sender,url:url+'/other'}]] as const){const h=await setup();await assert.rejects(()=>h.acquire(token==='token'?h.token:token,source));assert.equal(h.scripts.length,0);assert.equal((await h.egress.events()).length,0);h.close();}
});
await test('missing_current_user_delivery_proof_never_copies',async()=>{
 const h=await setup();h.surface.turns=[];await assert.rejects(()=>h.acquire());assert.equal(h.scripts.length,0);h.close();
});
await test('wrong_or_multiple_chrome_frame_results_are_rejected',async()=>{
 for(const key of ['replyFrame','extraFrame'] as const){const h=await setup();if(key==='replyFrame')h.changes.replyFrame=1;else h.changes.extraFrame=true;await assert.rejects(()=>h.acquire());assert.equal(h.counts().siteCopies,0);assert.equal((await h.egress.events()).length,0);h.close();}
});
await test('document_changed_after_main_cannot_persist_capture',async()=>{
 const h=await setup();h.changes.afterMain=()=>{h.changes.replyDocument='new-document';};await assert.rejects(()=>h.acquire());assert.equal((await h.egress.events()).length,0);h.close();
});
await test('assistant_must_immediately_follow_the_exact_last_user_turn',async()=>{
 for(const change of ['wrong-user','new-user','extra-assistant','cancelled']as const){const h=await setup();if(change==='wrong-user')h.document.querySelector('[data-message-author-role="user"]')!.setAttribute('data-message-id','other');if(change==='new-user')h.document.querySelector('main')!.insertAdjacentHTML('beforeend','<section data-turn="user"><div data-message-author-role="user" data-message-id="unrelated">unrelated</div></section>');if(change==='extra-assistant')h.document.querySelector('main')!.append(h.document.querySelector('[data-turn="assistant"]')!.cloneNode(true));if(change==='cancelled')h.document.querySelector('[data-turn="assistant"]')!.setAttribute('data-turn-state','cancelled');await assert.rejects(()=>h.acquire());assert.equal(h.counts().siteCopies,0);h.close();}
});
await test('user_or_response_mutation_during_copy_rejects_observation',async()=>{
 for(const role of ['user','assistant']){const h=await setup();h.changes.afterMain=()=>{h.document.querySelector('[data-message-author-role="'+role+'"]')!.textContent='changed after copy';};await assert.rejects(()=>h.acquire());assert.equal((await h.egress.events()).length,0);h.close();}
});
await test('authority_changed_before_main_or_after_copy_yields_no_event',async()=>{
 for(const phase of ['beforeProbe','afterMain']as const){const h=await setup();h.changes[phase]=()=>h.changeLive({browserProfileId:'other-profile'});await assert.rejects(()=>h.acquire());assert.equal((await h.egress.events()).length,0);if(phase==='beforeProbe')assert.equal(h.counts().siteCopies,0);h.close();}
});
await test('tab_navigation_is_rejected_before_copy',async()=>{
 for(const tabUrl of [url+'/other',url+'?x=1',url+'#x',url+'/']){const h=await setup();h.changes.tabUrl=tabUrl;await assert.rejects(()=>h.acquire());assert.equal(h.counts().siteCopies,0);h.close();}
});
await test('storage_failure_does_not_ack_and_poison_prevents_new_copy',async()=>{
 const h=await setup();h.storage.failOutbox=true;await assert.rejects(()=>h.acquire());await assert.rejects(()=>h.acquire());assert.equal(h.storage.data.rbridgeCaptureOutboxV3,undefined);assert.equal(h.counts().siteCopies,1);h.close();
});
await test('disappearing_durable_record_never_triggers_another_copy',async()=>{
 const h=await setup();await h.acquire();delete h.storage.data.rbridgeCaptureOutboxV3;await assert.rejects(()=>h.acquire());assert.equal(h.counts().siteCopies,1);h.close();
});
await test('direct_accept_rejects_configured_owner_app_mismatch',async()=>{
 const h=await authority(),egress=new RbridgeCaptureEgressV3({...h.options,ownerAppId:'other-app'}),state=(await h.runtime.state())!;
 await assert.rejects(()=>egress.accept({schema:'RBRIDGE_CONTENT_CAPTURE_V3',captureToken:'capture-v3:'+request.requestDigest+':'+state.capture!.epoch,assistantTurnId:'assistant-new',observation:{kind:'CAPTURED',assistantTurnId:'assistant-new',markdown}},sender));assert.equal((await egress.events()).length,0);
});
await test('internal_site_request_uses_only_browser_sender_and_current_lease',async()=>{
 const h=await setup();let listener:Parameters<CaptureMessageApiV3['onMessage']['addListener']>[0]|undefined;const api:CaptureMessageApiV3={onMessage:{addListener:l=>{listener=l;}}};installCaptureMessageBridgeV3(api,h.egress);const source={id:sender.id,tab:{id:sender.tabId},frameId:0,url};
 const ack=await new Promise<unknown>((resolve,reject)=>{if(listener!({schema:'RBRIDGE_CONTENT_SITE_CAPTURE_V3',captureToken:h.token},source,resolve)!==true)reject(Error('Missing internal acquisition route'));});assert.equal((ack as CaptureAckV3).durable,true);const forged=await new Promise<unknown>(resolve=>{listener!({schema:'RBRIDGE_CONTENT_SITE_CAPTURE_V3',captureToken:h.token,assistantTurnId:'forged'},source,resolve);});assert.deepEqual(forged,{errorCode:'RBRIDGE_CAPTURE_REJECTED'});h.close();
});
await test('send_history_allows_capture_but_prior_capture_history_does_not',async()=>{
 for(const eventType of ['SEND_VERIFIED','CAPTURE_LOST']){const h=await setup();
  const body={schema:'RBRIDGE_CHAT_EVENT_V1' as const,eventId:'prior-event',sequence:1,previousEventSha256:null,eventType,sessionId:request.sessionId,generation:request.generation,attemptId:request.attemptId,effectId:request.effectId,observedAt:new Date().toISOString(),payload:eventType==='SEND_VERIFIED'?{purpose:'PROMPT',receipt:{schema:'COCWIN_RECEIPT_REF_V1',receiptId:'prior-send',receiptSchema:'RBRIDGE_CHAT_SEND_RECEIPT_V1',sha256:'a'.repeat(64)}}:{reason:'UI_PROTOCOL_CHANGED'}};
  const prior={...body,eventSha256:await canonicalDigest(body)} as RbridgeChatEventV1,egress=new RbridgeCaptureEgressV3({...h.options,initialHistory:[prior]});
  if(eventType==='SEND_VERIFIED'){assert.equal((await egress.acquireSite(h.token,sender)).durable,true);const event=(await egress.events())[0]!;assert.equal(event.sequence,2);assert.equal(event.previousEventSha256,prior.eventSha256);assert.equal(h.counts().siteCopies,1);}
  else{await assert.rejects(()=>egress.acquireSite(h.token,sender));assert.equal(h.scripts.length,0);}h.close();
 }
});
await test('two_egress_instances_share_one_acquisition_for_the_same_storage',async()=>{
 const h=await setup();let reads=0;const acquireRaw:Reader['acquire']=async(_request,_delivery,admit)=>{reads++;(await admit())();await new Promise(resolve=>setTimeout(resolve,10));return {assistantTurnId:'assistant-new',observation:{kind:'CAPTURED',assistantTurnId:'assistant-new',markdown}};};const siteReader:Reader={acquire:acquireRaw,startAcquire:(request,delivery,admit,readAdmission=()=>{})=>{const result=(async()=>{readAdmission();return await acquireRaw(request,delivery,admit);})();return {result,settled:result.then(()=>({outcome:'COMPLETED' as const,copyIssued:true}),()=>({outcome:'FAILED' as const,copyIssued:false}))};}};
 const a=new RbridgeCaptureEgressV3({...h.options,siteReader}),b=new RbridgeCaptureEgressV3({...h.options,siteReader});const results=await Promise.all([a.acquireSite(h.token,sender),b.acquireSite(h.token,sender)]);assert.deepEqual(results[0],results[1]);assert.equal(reads,1);assert.equal((await a.events()).length,1);h.close();
});
await test('unanswered_chrome_is_bounded_and_quarantines_late_copy',async()=>{
 for(const phase of ['tabs','probe','main']){const h=await setup();let release=()=>{},completed=()=>{};const done=new Promise<void>(resolve=>{completed=resolve;});
  if(phase==='tabs')h.changes.tabStall=true;else if(phase==='probe')h.changes.stall=true;else{h.changes.beforeMain=()=>new Promise<void>(resolve=>{release=resolve;});h.changes.afterMain=()=>completed();}
  let timer:ReturnType<typeof setTimeout>|undefined;const outcome=await Promise.race([h.acquire().then(()=> 'fulfilled',()=> 'rejected'),new Promise<string>(resolve=>{timer=setTimeout(()=>resolve('deadline'),5500);})]);if(timer!==undefined)clearTimeout(timer);
  assert.equal(outcome,'rejected','An unresponsive Chrome request must fail within the caller deadline');const calls=h.scripts.length;h.changes.tabStall=false;h.changes.stall=false;
  const another=new RbridgeCaptureEgressV3(h.options);await assert.rejects(()=>another.acquireSite(h.token,sender));assert.equal(h.scripts.length,calls);assert.equal(h.counts().siteCopies,0);
  if(phase==='main'){release();await done;await new Promise(resolve=>setTimeout(resolve,0));assert.equal(h.counts().siteCopies,1);await assert.rejects(()=>h.acquire());assert.equal(h.scripts.length,calls);}
  assert.equal((await h.egress.events()).length,0);h.close();
 }
});
await test('minor0_and_default_availability_stay_closed',async()=>{
 assert.equal(SITE_ASSISTANT_MARKDOWN_AVAILABLE_V3,false);let listener:Parameters<CaptureMessageApiV3['onMessage']['addListener']>[0]|undefined;installCaptureMessageBridgeV3({onMessage:{addListener:l=>{listener=l;}}},null);let response:unknown;assert.notEqual(listener!({schema:'RBRIDGE_CONTENT_SITE_CAPTURE_V3',captureToken:'capture:x:1'},{id:extensionId,tab:{id:t.tabId},frameId:0,url},value=>{response=value;}),true);if(response!==undefined)assert.deepEqual(response,{errorCode:'RBRIDGE_CAPTURE_V3_UNAVAILABLE'});}
);

type ActivityFacts={history:'ABSENT'|'PRESENT';pendingCount:number;quarantinedCount:number;copyIssuedCount:number};
async function untilCapture(predicate:()=>boolean|Promise<boolean>){const deadline=Date.now()+7000;while(!await predicate()){if(Date.now()>deadline)throw Error('CAPTURE_FIXTURE_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,5));}}
async function activityFacts(egress:RbridgeCaptureEgressV3):Promise<ActivityFacts|undefined>{const fn=(egress as unknown as {siteActivityFacts?:(scope:unknown)=>Promise<ActivityFacts>}).siteActivityFacts;return await fn?.call(egress,{appId:request.appId,baseSha:request.baseSha,sessionId:request.sessionId,generation:request.generation});}
await test('timed_out_main_raw_task_is_retained_across_fresh_adapter_reload',async()=>{
 const h=await setup();let release=()=>{},finished=()=>{},first=true;const done=new Promise<void>(resolve=>{finished=resolve;});
 try{
  h.changes.beforeMain=async()=>{if(first){first=false;await new Promise<void>(resolve=>{release=resolve;});}};h.changes.afterMain=()=>finished();
  await assert.rejects(()=>h.acquire());assert.equal(h.counts().siteCopies,0);const firstFacts=await activityFacts(h.egress);if(firstFacts){assert.equal(firstFacts.pendingCount,1);assert.equal(firstFacts.quarantinedCount,1);}
  const storage={get:(key:string)=>h.storage.get(key),set:(items:Record<string,unknown>)=>h.storage.set(items)},reader=h.makeReader(),options={...h.options,storage,siteReader:reader},resumed=new RbridgeCaptureEgressV3(options),calls=h.scripts.length;
  const retry=await resumed.acquireSite(h.token,sender).then(()=> 'fulfilled',()=> 'rejected');assert.equal(retry,'rejected','A fresh worker must retain the unresolved old MAIN task');assert.equal(h.scripts.length,calls);assert.equal(h.counts().siteCopies,0);
  release();await done;await untilCapture(async()=>{const facts=await activityFacts(resumed);return facts===undefined||facts.pendingCount===0;});
  const finalFacts=await activityFacts(resumed);if(finalFacts){assert.equal(finalFacts.quarantinedCount,1);assert.equal(finalFacts.copyIssuedCount,1);}
  assert.equal((await resumed.events()).length,0,'Late raw settlement must not manufacture a full capture receipt');await assert.rejects(()=>resumed.acquireSite(h.token,sender));assert.equal(h.counts().siteCopies,1);
 }finally{release();if(!first)await Promise.race([done,new Promise(resolve=>setTimeout(resolve,1000))]);h.close();}
});
await test('activity_storage_failure_before_chrome_never_enqueues_script',async()=>{
 const h=await setup();try{h.storage.failActivity=true;await assert.rejects(()=>h.acquire());assert.equal(h.scripts.length,0);assert.equal(h.counts().siteCopies,0);assert.equal((await h.egress.events()).length,0);}finally{h.close();}
});
await test('legacy_uncaptured_send_without_fresh_admission_never_copies',async()=>{
 const h=await setup();try{const storage={get:(key:string)=>h.storage.get(key),set:(items:Record<string,unknown>)=>h.storage.set(items)},options=Object.fromEntries(Object.entries({...h.options,storage,siteReader:h.makeReader()}).filter(([key])=>key!=='freshSendAdmission')) as unknown as typeof h.options,resumed=new RbridgeCaptureEgressV3(options);await assert.rejects(()=>resumed.acquireSite(h.token,sender));assert.equal(h.scripts.length,0);assert.equal(h.counts().siteCopies,0);}finally{h.close();}
});
await test('settled_read_only_not_ready_probe_can_poll_before_one_copy',async()=>{
 const h=await setup();try{const assistant=h.document.querySelector('[data-turn="assistant"]')!;assistant.setAttribute('data-turn-state','streaming');await assert.rejects(()=>h.acquire(),/RBRIDGE_SITE_CAPTURE_NOT_READY/);assert.equal(h.counts().siteCopies,0);assistant.setAttribute('data-turn-state','complete');assert.equal((await h.acquire()).durable,true);assert.equal(h.counts().siteCopies,1);assert.equal((await h.egress.events()).length,1);}finally{h.close();}
});

console.log(JSON.stringify({suite:'W1_V3_ADMITTED_SITE_READER',passed,failed,ownerWindows:'NOT_RUN',nativeStartup:'NOT_ACTIVATED'}));if(failed)process.exitCode=1;
