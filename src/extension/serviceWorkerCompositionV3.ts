import {canonicalJson,parseV3Scope,requireV3Peer,V3_CAPABILITIES,type CocwinRbridgeEffectRequestV1,type RbridgeChatEventV1,type V3Scope,type VerifiedPeerV3} from '../domain/rbridgeEffectProtocol.js';
import type {NegotiatedHelloV1,RbridgeChatHelloV1} from '../domain/rbridgeChatCore.js';
import {buildCommandResultV1,type RbridgeChatCommandV1} from '../domain/rbridgeChatCommand.js';
import {ChatgptDeliveryAdapterV3} from '../browser/chatgptDeliveryAdapter.js';
import {ChatgptRolloverAdapterV3,UnavailableChatgptRolloverDriverV3} from '../browser/chatgptRolloverAdapter.js';
import {BrowserAuthorityRuntimeV1} from './browserAuthorityRuntime.js';
import {BrowserAuthorityStoreV1,type ChromeStorageAreaV1} from './browserAuthorityStore.js';
import {ChromeContentDriverV1,ChromeDeliverySurfaceReaderV3,ChromeLiveTargetReaderV1,type ChromeAuthorityScriptingApiV1,type ChromeAuthorityTabsApiV1,type SiteMarkdownReaderV3} from './chromeAuthorityAdapters.js';
import {ChromeTabsInventoryAdapterV1,type ChromeTabsReadApiV1} from './chromeTabInventory.js';
import {ExtensionNativePortLinkV1,type ExtensionRuntimeNativeApiV1} from './nativePortServiceWorker.js';
import {RbridgeChatCommandDispatcherV1} from './rbridgeCommandDispatcher.js';
import {RbridgeEffectDispatcherV1} from './rbridgeEffectDispatcher.js';
import {BrowserEffectExecutorV3} from './rbridgeEffectExecutor.js';
import {RbridgeEffectStoreV1,snapshotEffectData} from './rbridgeEffectStore.js';
import {RbridgeScopeStopStoreV1,type RbridgeScopeStopFenceV1} from './rbridgeScopeStopStore.js';
import {RbridgeCaptureEgressV3,installCaptureMessageBridgeV3,type CaptureMessageApiV3} from './rbridgeCaptureEgress.js';
import type {ExtensionBootstrapConfigV1} from './serviceWorkerEntry.js';

export interface QualifiedV3WorkerChromeApi{
  runtime:{id:string;connectNative:ExtensionRuntimeNativeApiV1['connectNative'];onMessage?:CaptureMessageApiV3['onMessage']};
  storage:{local:ChromeStorageAreaV1};tabs:ChromeAuthorityTabsApiV1&ChromeTabsReadApiV1;scripting:ChromeAuthorityScriptingApiV1;
}
export interface QualifiedV3WorkerOptions{
  bootstrap:ExtensionBootstrapConfigV1;scope:V3Scope;peer:VerifiedPeerV3;initialHistory:readonly RbridgeChatEventV1[];
  /** Caller supplies an independently qualified representation, never a content-message claim. */
  siteReader:SiteMarkdownReaderV3;captureTimeoutMs?:number;capturePollMs?:number;
}
export interface WorkerCaptureStatusV3{
  requestDigest:string;state:'WAITING'|'CAPTURED'|'TERMINAL'|'TIMED_OUT'|'PEER_CHANGED'|'BLOCKED';reason?:string;
}
export interface QualifiedV3WorkerComposition{
  link:ExtensionNativePortLinkV1;readonly ready:boolean;readonly lastCapture:WorkerCaptureStatusV3|null;
  readonly stopped:boolean;requestScopeStop(input:unknown):Promise<RbridgeScopeStopFenceV1>;
}
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/,SHA1=/^[a-f0-9]{40}$/;
function fail(code:string):never{throw Error(code);}
function code(error:unknown):string{const value=error instanceof Error?error.message:'';return /^[A-Z][A-Z0-9_:-]{0,127}$/.test(value)?value:'RBRIDGE_WORKER_CAPTURE_BLOCKED';}
function exact(input:object,keys:string[]):void{if(Object.keys(input).length!==keys.length||Object.keys(input).some(key=>!keys.includes(key)))fail('RBRIDGE_WORKER_CONFIGURATION_INVALID');}

// This explicit entry is not the released minor0 auto-entry. Its caller owns
// authenticated pin/scope/history provisioning and actual site qualification.
export async function startQualifiedExtensionServiceWorkerV3(api:QualifiedV3WorkerChromeApi,releaseSha:string,options:QualifiedV3WorkerOptions):Promise<QualifiedV3WorkerComposition>{
  const reader=options?.siteReader;
  if(!reader||typeof reader.acquire!=='function'||!SHA1.test(releaseSha)||!api?.runtime||!/^[a-p]{32}$/.test(api.runtime.id)||typeof api.runtime.connectNative!=='function'||typeof api.storage?.local?.get!=='function'||typeof api.storage.local.set!=='function'||typeof api.tabs?.get!=='function'||typeof api.tabs.sendMessage!=='function'||typeof api.tabs.query!=='function'||typeof api.scripting?.executeScript!=='function')fail('RBRIDGE_WORKER_CONFIGURATION_INVALID');
  const data=snapshotEffectData({bootstrap:options.bootstrap,scope:options.scope,peer:options.peer,initialHistory:options.initialHistory,captureTimeoutMs:options.captureTimeoutMs??120000,capturePollMs:options.capturePollMs??250});
  const {bootstrap,peer,initialHistory,captureTimeoutMs,capturePollMs}=data,scope=parseV3Scope(data.scope);
  if(!bootstrap||typeof bootstrap!=='object')fail('RBRIDGE_WORKER_CONFIGURATION_INVALID');
  exact(bootstrap,['schema','browserInstanceId','browserProfileId','nativeHostVersion']);
  if(bootstrap.schema!=='RBRIDGE_EXTENSION_BOOTSTRAP_V1'||[bootstrap.browserInstanceId,bootstrap.browserProfileId,bootstrap.nativeHostVersion].some(value=>typeof value!=='string'||!ID.test(value)))fail('RBRIDGE_WORKER_CONFIGURATION_INVALID');
  requireV3Peer(peer);exact(peer,['peerId','releaseSha','browserInstanceId','browserProfileId','protocolMinor','maxMessageBytes','capabilities']);
  if(!Array.isArray(initialHistory)||!Number.isInteger(captureTimeoutMs)||captureTimeoutMs<1||captureTimeoutMs>120000||!Number.isInteger(capturePollMs)||capturePollMs<1||capturePollMs>5000)fail('RBRIDGE_WORKER_CONFIGURATION_INVALID');
  const eventScope=(event:RbridgeChatEventV1)=>{if(event.sessionId!==scope.sessionId||event.generation!==scope.generation)fail('RBRIDGE_WORKER_HISTORY_SCOPE_MISMATCH');};
  for(const event of initialHistory)eventScope(event);
  const storage=api.storage.local,stops=new RbridgeScopeStopStoreV1(storage,scope);
  await stops.initialize();
  const driver=new ChromeContentDriverV1(api.tabs,api.scripting),runtime=new BrowserAuthorityRuntimeV1(new BrowserAuthorityStoreV1(storage),new ChromeLiveTargetReaderV1(api.tabs,bootstrap.browserInstanceId,bootstrap.browserProfileId),driver),effects=new RbridgeEffectStoreV1(storage);
  const delivery=new ChatgptDeliveryAdapterV3(storage,new ChromeDeliverySurfaceReaderV3(api.tabs,bootstrap.browserInstanceId,bootstrap.browserProfileId,api.scripting)),rollover=new ChatgptRolloverAdapterV3(runtime,new UnavailableChatgptRolloverDriverV3()),executor=new BrowserEffectExecutorV3(runtime,effects,delivery,rollover);
  let qualified=false,connection=0,lastCapture:WorkerCaptureStatusV3|null=null,captureSequence=0,helloTask:Promise<void>|null=null;
  const ready=()=>qualified&&link.protocolReady;
  const assertReady=()=>{if(!ready())fail('RBRIDGE_WORKER_PEER_NOT_READY');};
  const assertScope=(request:CocwinRbridgeEffectRequestV1)=>{
    for(const key of ['appId','baseSha','sessionId','generation']as const)if(request[key]!==scope[key])fail('RBRIDGE_WORKER_SCOPE_MISMATCH');
    if(request.payload.target.browserInstanceId!==bootstrap.browserInstanceId||request.payload.target.browserProfileId!==bootstrap.browserProfileId)fail('RBRIDGE_WORKER_SCOPE_MISMATCH');
  };
  const captureOptions={storage,runtime,effects,extensionId:api.runtime.id,browserInstanceId:bootstrap.browserInstanceId,browserProfileId:bootstrap.browserProfileId,ownerAppId:scope.appId,maxMessageBytes:peer.maxMessageBytes,initialHistory,publish:async(event:RbridgeChatEventV1)=>{assertReady();await link.sendEvent(event);}};
  const outbox=new RbridgeCaptureEgressV3(captureOptions);
  // Validate retained records before opening another connection; never reset them.
  const origins=new Set<string>();
  for(const event of [...initialHistory,...await outbox.events()]){eventScope(event);if(event.effectId)origins.add(event.effectId);}
  const retained=(await runtime.state())?.activeSend;if(retained)origins.add(retained.effectId);
  for(const effectId of origins){const original=await effects.requestForEffect(effectId);if(!original)fail('RBRIDGE_WORKER_HISTORY_ORIGIN_MISSING');assertScope(original);}
  if(api.runtime.onMessage)installCaptureMessageBridgeV3({onMessage:api.runtime.onMessage},null);
  const waiters=new Map<string,Promise<void>>();
  const capture=async(request:CocwinRbridgeEffectRequestV1,admit:()=>void):Promise<void>=>{
    const pending=waiters.get(request.requestDigest);if(pending)return await pending;
    const sequence=++captureSequence,update=(state:WorkerCaptureStatusV3['state'],reason?:string)=>{if(sequence===captureSequence)lastCapture={requestDigest:request.requestDigest,state,...(reason?{reason}:{})};};
    const check=()=>{assertReady();admit();};
    const siteReader:SiteMarkdownReaderV3={acquire:(input,observed,prepare)=>reader.acquire(input,observed,async()=>{check();const permit=await prepare();check();return ()=>{check();permit();};})};
    const egress=new RbridgeCaptureEgressV3({...captureOptions,siteReader,delivery});
    const work=(async()=>{
      const deadline=Date.now()+captureTimeoutMs;update('WAITING');
      try{
        while(Date.now()<deadline){
          check();const current=await runtime.state();check();
          const tx=current?.activeSend,binding=current?.binding,lease=current?.capture;
          if(!tx||!binding||!lease||tx.effectId!==request.effectId||tx.sessionId!==scope.sessionId||tx.generation!==scope.generation||!['SENT_VERIFIED','WAITING_RESPONSE','RESPONSE_VERIFIED'].includes(tx.state)){update('BLOCKED','RBRIDGE_WORKER_CAPTURE_STATE_CHANGED');return;}
          try{
            const ack=await egress.acquireSite('capture:'+lease.sessionId+':'+String(lease.epoch),{id:api.runtime.id,tabId:binding.tabId,frameId:0,url:binding.origin+'/g/'+binding.projectId+'/c/'+binding.conversationId});
            const event=(await egress.events()).find(value=>value.eventId===ack.eventId&&value.eventSha256===ack.eventSha256);if(!event)fail('RBRIDGE_WORKER_CAPTURE_RECORD_MISSING');
            update(event.eventType==='ASSISTANT_TURN_CAPTURED_V2'?'CAPTURED':'TERMINAL');await egress.flush();return;
          }catch(error){if(code(error)!=='RBRIDGE_SITE_CAPTURE_NOT_READY')throw error;}
          const left=deadline-Date.now();if(left>0)await new Promise(resolve=>setTimeout(resolve,Math.min(capturePollMs,left)));
        }
        update('TIMED_OUT','RBRIDGE_WORKER_CAPTURE_TIMEOUT');
      }catch(error){let changed=false;try{check();}catch{changed=true;}update(changed?'PEER_CHANGED':'BLOCKED',code(error));}
    })();
    waiters.set(request.requestDigest,work);try{await work;}finally{if(waiters.get(request.requestDigest)===work)waiters.delete(request.requestDigest);}
  };
  const legacy=new RbridgeChatCommandDispatcherV1(runtime,new ChromeTabsInventoryAdapterV1(api.tabs,bootstrap.browserInstanceId,bootstrap.browserProfileId),bootstrap.browserInstanceId,bootstrap.browserProfileId);
  const hello:RbridgeChatHelloV1={schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:1,releaseSha,maxMessageBytes:peer.maxMessageBytes,capabilities:[...V3_CAPABILITIES],browserInstanceId:bootstrap.browserInstanceId,browserProfileId:bootstrap.browserProfileId,nativeHostVersion:bootstrap.nativeHostVersion};
  const pin=(remote:RbridgeChatHelloV1,negotiated:NegotiatedHelloV1)=>{
    if(remote.protocolMajor!==1||remote.protocolMinor!==peer.protocolMinor||remote.releaseSha!==peer.releaseSha||remote.browserInstanceId!==peer.browserInstanceId||remote.browserProfileId!==peer.browserProfileId||remote.maxMessageBytes!==peer.maxMessageBytes||negotiated.maxMessageBytes!==peer.maxMessageBytes||negotiated.protocolMinor<1||canonicalJson([...remote.capabilities].sort())!==canonicalJson([...peer.capabilities].sort())||V3_CAPABILITIES.some(cap=>!negotiated.capabilities.includes(cap)))fail('RBRIDGE_WORKER_PEER_PIN_MISMATCH');
  };
  const close=()=>{qualified=false;connection++;helloTask=null;};
  const link=new ExtensionNativePortLinkV1({connectNative:name=>api.runtime.connectNative(name)},hello,{
    onServerHello:async(remote,negotiated)=>{
      const current=++connection;qualified=false;pin(remote,negotiated);
      const task=(async()=>{await outbox.events();if(current!==connection||!link.connected)fail('RBRIDGE_PEER_CONNECTION_CHANGED');qualified=true;})();
      helloTask=task;await task;await outbox.flush();
    },
    onServerCommand:async(command:RbridgeChatCommandV1)=>{const current=connection,pending=helloTask;if(!pending)fail('RBRIDGE_WORKER_PEER_NOT_READY');await pending;assertReady();if(current!==connection)fail('RBRIDGE_PEER_CONNECTION_CHANGED');const result=command.action==='READ_STATE'||command.action==='DISCOVER_TARGET'?await legacy.execute(command):buildCommandResultV1(command,{ok:false,errorCode:'RBRIDGE_V1_MUTATION_DISABLED'});assertReady();if(current!==connection)fail('RBRIDGE_PEER_CONNECTION_CHANGED');link.sendCommandResult(result);},
    onServerEffectCommand:async(original)=>{
      const admission=link.admittedEffect(original),pending=helloTask;if(!pending)fail('RBRIDGE_WORKER_PEER_NOT_READY');await pending;
      assertReady();admission.assertCurrent();const command=admission.command;assertScope(command.request);
      const current=()=>{assertReady();admission.assertCurrent();},admit=()=>{current();stops.assertExecuteAllowed();};
      current();
      if(command.action==='EXECUTE'){
        let blocked:string|null=null;try{stops.assertExecuteAllowed();}catch(error){blocked=code(error);}
        if(blocked){
          // Retained completed commands replay their exact original bytes. A new
          // stopped command gets no invented completion or ledger reservation;
          // the authenticated transport retains its unresolved request.
          const prior=await effects.getCommand(command);
          await effects.read(command.request.effectId,command.request.requestDigest);
          if(!prior?.result)fail(blocked);
          current();await link.sendEffectResult(original,prior.result);return;
        }
      }
      const dispatcher=new RbridgeEffectDispatcherV1(effects,request=>executor.executeBrowserEffect(request,admit));
      const result=await dispatcher.dispatch(command);await link.sendEffectResult(original,result);
      if(!stops.stopped&&result.state==='VERIFIED'&&(command.request.effectKind==='RBRIDGE_SEND'||command.request.effectKind==='RBRIDGE_RESULT_SEND'))await capture(command.request,admit);
    },
    onDisconnected:close,onProtocolError:close,
  });
  link.connect();
  return {link,get ready(){return ready();},get lastCapture(){return lastCapture?structuredClone(lastCapture):null;},get stopped(){return stops.stopped;},requestScopeStop:input=>stops.requestStop(input)};
}
