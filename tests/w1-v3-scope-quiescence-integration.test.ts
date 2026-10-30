import {afterEach,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {JSDOM} from 'jsdom';
import {startQualifiedExtensionServiceWorkerV3} from '../src/extension/serviceWorkerCompositionV3.js';
import {ChromeSiteMarkdownReaderV3} from '../src/extension/chromeAuthorityAdapters.js';
import {ChatgptContentRuntimeV1} from '../src/extension/contentRuntime.js';
import type {ChromeStorageAreaV1} from '../src/extension/browserAuthorityStore.js';
import type {ExtensionNativePortV1,NativePortEventV1} from '../src/extension/nativePortServiceWorker.js';
import {NativeHostRuntimeV1} from '../src/nativeHost/nativeHostRuntime.js';
import type {SshProcessHandleV1} from '../src/nativeHost/persistentSshSession.js';
import {RbridgeEffectResultStoreV3} from '../src/nativeHost/rbridgeEffectResultStore.js';
import {RbridgeChatEventStoreV1} from '../src/server/rbridgeChatEventStore.js';
import {RbridgeChatPeerStoreV3} from '../src/server/rbridgeChatPeerStore.js';
import {executeRbridgeChatPeerCli} from '../src/server/rbridgeChatPeerCli.js';
import {runRbridgeChatStdio} from '../src/server/rbridgeChatStdio.js';
import {RbridgeEventSpoolV1} from '../src/domain/rbridgeChatCore.js';
import {canonicalJson,sha256Hex,V3_CAPABILITIES,type RbridgeChatEffectCommandV1,type RbridgeChatEffectResultV1,type VerifiedPeerV3} from '../src/domain/rbridgeEffectProtocol.js';
import {RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY,buildScopeStopRequest,type RbridgeScopeQuiescenceRecordV1} from '../src/domain/rbridgeScopeQuiescence.js';
import {NativeMessageDecoder,encodeNativeMessage} from '../src/transport/nativeMessaging.js';

// Source qualification with external Chrome and SSH replaced; this is not live acceptance.
const vectors=JSON.parse(readFileSync(new URL('./fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')) as {vectors:{command:RbridgeChatEffectCommandV1}[]};
const bind=vectors.vectors[0]!.command,send=vectors.vectors[1]!.command,target=send.request.payload.target;
const scope={appId:send.request.appId,baseSha:send.request.baseSha,sessionId:send.request.sessionId,generation:send.request.generation};
const pins:VerifiedPeerV3={peerId:'integration-fixed-peer',releaseSha:'1'.repeat(40),browserInstanceId:target.browserInstanceId,browserProfileId:target.browserProfileId,protocolMinor:1,maxMessageBytes:65536,capabilities:[...V3_CAPABILITIES,RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY]};
const markdown='Complete original markdown — čćž\n\n**Full response.**\n';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function until(predicate:()=>boolean|Promise<boolean>,label:string,timeout=8000){const end=performance.now()+timeout;while(!await predicate()){if(performance.now()>=end)throw Error('INTEGRATION_TIMEOUT_'+label);await new Promise(resolve=>setTimeout(resolve,5));}}
class Event<T> implements NativePortEventV1<T>{private listeners:((value:T)=>void)[]=[];addListener(fn:(value:T)=>void){this.listeners.push(fn);}emit(value:T){for(const fn of this.listeners)fn(value);}}
class Storage implements ChromeStorageAreaV1{data:Record<string,unknown>={};async get(key:string){return key in this.data?{[key]:structuredClone(this.data[key])}:{};}async set(values:Record<string,unknown>){Object.assign(this.data,structuredClone(values));}}
class Port implements ExtensionNativePortV1{out:unknown[]=[];onMessage=new Event<unknown>();onDisconnect=new Event<void>();constructor(private readonly post:(value:unknown)=>void){}postMessage(value:unknown){this.out.push(structuredClone(value));this.post(value);}receive(value:unknown){this.onMessage.emit(structuredClone(value));}disconnect(){this.onDisconnect.emit();}}
class SshBoundary implements SshProcessHandleV1{
 private data:(bytes:Uint8Array)=>void=()=>{};
 constructor(private readonly input:PassThrough,output:PassThrough){output.on('data',(bytes:Buffer)=>this.data(bytes));}
 write(bytes:Uint8Array){this.input.write(bytes);}onData(fn:(bytes:Uint8Array)=>void){this.data=fn;}
 onClose(fn:(code:number|null,signal:string|null)=>void){this.input.on('finish',()=>fn(0,null));}onError(fn:(error:Error)=>void){this.input.on('error',fn);}kill(){this.input.end();}
}
interface StopObservation{status:'PASS'|'BLOCKED';reason:string|null;record:RbridgeScopeQuiescenceRecordV1|null}

async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'rbridge-quiescence-integration-'))),nativeRoot=join(root,'native'),linuxRoot=join(root,'linux');
 const {mkdir}=await import('node:fs/promises');await mkdir(nativeRoot,{mode:0o700});await mkdir(linuxRoot,{mode:0o700});
 await writeFile(join(linuxRoot,'v3-peer-config.json'),canonicalJson({schema:'RBRIDGE_CHAT_PEER_CONFIG_V3',scope,peerPins:pins,initialHistory:{sequence:0,eventSha256:null}})+'\n',{mode:0o600});
 const linux=new RbridgeChatPeerStoreV3(linuxRoot),input=new PassThrough(),output=new PassThrough(),ssh=new SshBoundary(input,output),errors:string[]=[],posts=new Set<Promise<void>>();
 const linuxRun=runRbridgeChatStdio(input,output,linux);void linuxRun.catch(error=>{errors.push('LINUX_STDIO:'+String(error));});
 const url=target.origin+'/g/'+target.projectId+'/c/'+target.conversationId;
 const page=new JSDOM('<main><div id="turns"></div><form><div class="ProseMirror" contenteditable="true" role="textbox"></div><button type="button" data-testid="send-button" aria-label="Send">Send</button></form></main>',{url}),document=page.window.document;
 const content=new ChatgptContentRuntimeV1(document,{emit:async()=>{}}),storage=new Storage();let clicks=0,copies=0,captureStops=0;
 document.querySelector('button')!.addEventListener('click',()=>{clicks++;const user=document.createElement('div');user.setAttribute('data-message-author-role','user');user.setAttribute('data-message-id','integration-user-'+clicks);user.textContent=document.querySelector('.ProseMirror')!.textContent;document.querySelector('#turns')!.append(user);document.querySelector('.ProseMirror')!.textContent='';});
 const tabs={get:async()=>({id:target.tabId,windowId:target.windowId,url}),query:async()=>[{id:target.tabId,windowId:target.windowId,url,title:'Integration fixture'}],sendMessage:async(_tab:number,value:unknown)=>{const request=value as {requestId:string;action:string};try{const result=await content.handle(value);if(request.action==='CAPTURE_STOP'&&(result as {status?:string}).status==='OFF')captureStops++;return {schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:request.requestId,ok:true,result};}catch(error){return {schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:request.requestId,ok:false,errorCode:error instanceof Error?error.message:String(error)};}}};
 const bodySha256=await sha256Hex('<p>stable integration assistant body</p>');
 const scripting={executeScript:async(value:unknown)=>{const row=value as {world?:string;args?:[{documentUrl:string;userTurnId?:string}]};if(!row.world)return [];const assistantTurnId='integration-assistant-'+clicks,result=row.world==='MAIN'?(copies++,{kind:'CAPTURED',assistantTurnId,markdown}):{kind:'READY',documentUrl:row.args![0].documentUrl,userTurnId:row.args![0].userTurnId,assistantTurnId,bodySha256};return [{frameId:0,documentId:'integration-document',result}];}};
 const port=new Port(value=>{const work=host.acceptNativeChunk(encodeNativeMessage(value));posts.add(work);void work.catch(error=>{errors.push('NATIVE_INPUT:'+String(error));}).finally(()=>posts.delete(work));});
 const decoder=new NativeMessageDecoder(),nativeOutput:unknown[]=[];
 const host=new NativeHostRuntimeV1({expectedExtensionId:'ebibbijpegoankenmggdnehpoadcophk',eventStoreRoot:nativeRoot,ssh:{sshPath:join(root,'ssh'),host:'aether-engine',port:22,user:'rbridge',identityFile:join(root,'id'),knownHostsFile:join(root,'known-hosts')},v3:{scope,peerPins:pins,initialHistory:{sequence:0,eventSha256:null}}},{write:bytes=>{for(const value of decoder.push(bytes)){nativeOutput.push(value);port.receive(value);}}},{onProtocolError:error=>{errors.push('NATIVE_PROTOCOL:'+error.message);},onTransportError:error=>{errors.push('NATIVE_TRANSPORT:'+error.message);}},{processFactory:{launch:()=>ssh},scheduler:{set:()=>null,clear:()=>{}}});
 let worker:Awaited<ReturnType<typeof startQualifiedExtensionServiceWorkerV3>>|null=null;
 cleanups.push(async()=>{worker?.link.disconnect();host.stop();input.end();await Promise.allSettled([...posts]);await linuxRun.catch(()=>{});output.destroy();content.stop();page.window.close();await rm(root,{recursive:true,force:true});});
 host.start(['chrome-extension://ebibbijpegoankenmggdnehpoadcophk/']);
 const api={runtime:{id:'ebibbijpegoankenmggdnehpoadcophk',connectNative:()=>port,onMessage:{addListener:()=>{}}},storage:{local:storage},tabs,scripting};
 worker=await startQualifiedExtensionServiceWorkerV3(api,pins.releaseSha,{bootstrap:{schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1',browserInstanceId:target.browserInstanceId,browserProfileId:target.browserProfileId,nativeHostVersion:'integration-native'},scope,peer:pins,initialHistory:[],siteReader:new ChromeSiteMarkdownReaderV3(tabs,scripting,target.browserInstanceId,target.browserProfileId),captureTimeoutMs:1000,capturePollMs:5});
 await until(()=>worker!.ready||errors.length>0,'QUALIFIED_HELLO');expect(errors).toEqual([]);expect(worker.ready).toBe(true);
 const encode=(value:unknown)=>Buffer.from(canonicalJson(value)).toString('base64');
 const cli=async(operation:string,value:unknown)=>(await executeRbridgeChatPeerCli(new RbridgeChatPeerStoreV3(linuxRoot),[operation,encode(value)])).value;
 const stage=async(command:RbridgeChatEffectCommandV1)=>{const bytes=Buffer.from(canonicalJson(command)),commit={schema:'RBRIDGE_CHAT_COMMAND_COMMIT_V1',commandId:command.commandId,commandSha256:command.commandSha256,requestDigest:command.request.requestDigest,transferSha256:await sha256Hex(bytes),totalBytes:bytes.length,chunkCount:Math.ceil(bytes.length/3072)};for(let index=0;index<commit.chunkCount;index++){const offset=index*3072;await cli('stage-chunk',{...commit,schema:'RBRIDGE_CHAT_COMMAND_CHUNK_V1',index,offset,dataBase64:bytes.subarray(offset,offset+3072).toString('base64')});}await cli('commit-command',commit);let result:RbridgeChatEffectResultV1|null=null;await until(async()=>{result=await cli('read-result',{commandId:command.commandId,scope}) as RbridgeChatEffectResultV1|null;return result!==null||errors.length>0;},command.request.effectKind);expect(errors).toEqual([]);expect(result).toMatchObject({state:'VERIFIED'});};
 return {root,nativeRoot,linuxRoot,linux,worker,port,storage,errors,nativeOutput,posts,cli,stage,counts:()=>({clicks,copies,captureStops})};
}
async function completedCycle(){
 const h=await fixture();await h.stage(bind);await h.stage(send);
 await until(()=>h.worker.lastCapture?.state==='CAPTURED'||h.errors.length>0,'FULL_CAPTURE');expect(h.errors).toEqual([]);expect(h.worker.lastCapture?.state).toBe('CAPTURED');
 const nativeEvents=()=>new RbridgeChatEventStoreV1({root:h.nativeRoot}).load(),linuxEvents=()=>new RbridgeChatEventStoreV1({root:h.linuxRoot}).load();
 await until(async()=>{const events=await linuxEvents();return events.some(event=>event.eventType==='ASSISTANT_TURN_CAPTURED_V2');},'LINUX_DURABLE_CAPTURE');
 const beforeEvents=await nativeEvents();expect(await linuxEvents()).toEqual(beforeEvents);const captured=beforeEvents.find(event=>event.eventType==='ASSISTANT_TURN_CAPTURED_V2')!;
 expect(captured.payload.assistantTurnUtf8).toBe(markdown);expect(captured.payload.captureReceipt).toMatchObject({captureEncoding:'SITE_ASSISTANT_MARKDOWN_V1',responseUtf8Bytes:new TextEncoder().encode(markdown).byteLength,assistantTurnSha256:await sha256Hex(markdown)});
 await until(()=>h.posts.size===0,'NATIVE_INPUT_DRAIN');
 const priorAuthority=h.storage.data.rbridgeBrowserAuthorityV1 as {activeSend:unknown;binding:unknown},priorSend=canonicalJson(priorAuthority.activeSend),priorBinding=canonicalJson(priorAuthority.binding);expect(h.counts()).toEqual({clicks:1,copies:1,captureStops:0});
 const browserLedger=canonicalJson(h.storage.data.rbridgeEffectLedgerV1),browserOutbox=canonicalJson(h.storage.data.rbridgeCaptureOutboxV3),nativeResults=await readFile(join(h.nativeRoot,'v3-results','journal.json')),linuxResults=await readFile(join(h.linuxRoot,'v3-results','journal.json'));
 const request=await buildScopeStopRequest({requestId:'integration-stop',scope,challenge:'c'.repeat(64),issuedAt:new Date().toISOString()}),queryId='integration-query',queryNonce='d'.repeat(64);
 const submitted=await h.cli('request-scope-stop',{request,queryId,queryNonce}) as {status:string};expect(submitted.status).toBe('BLOCKED');
 const input={scope,requestId:request.requestId,requestDigest:request.requestDigest,queryId,queryNonce},read=async()=>await h.cli('read-scope-stop',input) as StopObservation;let observation:StopObservation|null=null;
 await until(async()=>{observation=await read();return observation.record?.state==='COMPLETE'||h.errors.length>0;},'DURABLE_STOP_REPORT');expect(h.errors).toEqual([]);
 observation=await read();expect(observation.status,observation.reason??'complete drain proof').toBe('PASS');
 const report=observation.record!.nativeReport!;expect(report.worker).toMatchObject({sealed:true,captureStopped:true,pendingHandlers:0,pendingReaders:0,pendingEgress:0,unresolvedCaptureCount:0});
 const state=h.storage.data.rbridgeBrowserAuthorityV1 as {capture:{status:string};leader:{status:string};activeSend:{state:string}};expect(state.capture.status).toBe('LOST');expect(state.leader.status).toBe('RELEASED');expect(state.activeSend.state).toBe('RESPONSE_VERIFIED');expect(canonicalJson(state.activeSend)).toBe(priorSend);expect(canonicalJson((h.storage.data.rbridgeBrowserAuthorityV1 as {binding:unknown}).binding)).toBe(priorBinding);
 expect(h.counts()).toEqual({clicks:1,copies:1,captureStops:1});expect(canonicalJson(h.storage.data.rbridgeEffectLedgerV1)).toBe(browserLedger);expect(canonicalJson(h.storage.data.rbridgeCaptureOutboxV3)).toBe(browserOutbox);
 expect(await readFile(join(h.nativeRoot,'v3-results','journal.json'))).toEqual(nativeResults);expect(await readFile(join(h.linuxRoot,'v3-results','journal.json'))).toEqual(linuxResults);expect(await nativeEvents()).toEqual(beforeEvents);expect(await linuxEvents()).toEqual(beforeEvents);
 const last=beforeEvents.at(-1)!,head={sequence:last.sequence,eventSha256:last.eventSha256};expect(report.eventHead).toEqual(head);expect(report.worker.eventHead).toEqual(head);expect(report.worker.resultInventory).toEqual(report.resultInventory);
 const retained=await new RbridgeEffectResultStoreV3({eventStoreRoot:h.linuxRoot,scope,maxMessageBytes:65536,crossProcess:true}).readScopeInventory(scope);expect(report.resultInventory).toMatchObject({entryCount:retained.entryCount,unresolvedCount:retained.unresolvedCount,entriesSha256:retained.entriesSha256});
 expect(h.nativeOutput.filter(value=>(value as {schema?:string}).schema==='RBRIDGE_SCOPE_QUIESCENCE_QUERY_V1')).toHaveLength(1);expect(h.port.out.filter(value=>(value as {schema?:string}).schema==='RBRIDGE_SCOPE_QUIESCENCE_WORKER_V1')).toHaveLength(1);
 return {h,read,observation,beforeEvents,nativeEvents,linuxEvents};
}
describe('scope quiescence through actual Worker Native and Linux source',()=>{
 it('stages one original SEND through fixed CLI and proves full capture then durable STOP',async()=>{await completedCycle();},20000);
 it('blocks a fresh CLI proof after a late Linux tail while retaining the original report',async()=>{
  const {h,read,observation,beforeEvents,nativeEvents,linuxEvents}=await completedCycle(),spool=new RbridgeEventSpoolV1();
  for(const event of beforeEvents)expect(await spool.append(event)).toEqual(event);
  const late=await spool.append({eventId:'integration-late-linux-tail',eventType:'BINDING_LOST',sessionId:scope.sessionId,generation:scope.generation,attemptId:null,effectId:null,observedAt:new Date().toISOString(),payload:{reason:'TAB_CLOSED'}});
  await h.linux.recordIncoming(late,pins);const changed=await read();expect(changed.status).toBe('BLOCKED');expect(changed.reason).toBe('RBRIDGE_SCOPE_QUIESCENCE_EVENT_HEAD_MISMATCH');expect(changed.record).toEqual(observation.record);expect(await nativeEvents()).toEqual(beforeEvents);expect(await linuxEvents()).toEqual([...beforeEvents,late]);expect(h.counts()).toEqual({clicks:1,copies:1,captureStops:1});expect(h.errors).toEqual([]);
 },20000);
});
