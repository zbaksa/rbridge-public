import {canonicalJson,sha256Hex} from '../domain/rbridgeEffectProtocol.js';
import {ChromeSiteMarkdownReaderV3,type ChromeSiteScriptingApiV3} from './chromeAuthorityAdapters.js';
import {RBRIDGE_EXTENSION_ID} from './extensionManifest.js';
import {RbridgeEffectStoreV1} from './rbridgeEffectStore.js';
import {SiteCaptureActivityStoreV1} from './siteCaptureActivityStore.js';
import {startQualifiedExtensionServiceWorkerV3,type QualifiedV3WorkerChromeApi,type QualifiedV3WorkerComposition,type QualifiedV3WorkerOptions} from './serviceWorkerCompositionV3.js';

export type ProvisionedV3WorkerChromeApi=QualifiedV3WorkerChromeApi&{
  storage:{local:QualifiedV3WorkerChromeApi['storage']['local']&{setAccessLevel(options:{accessLevel:'TRUSTED_CONTEXTS'}):Promise<void>}};
  scripting:QualifiedV3WorkerChromeApi['scripting']&ChromeSiteScriptingApiV3;
};
type Storage=ProvisionedV3WorkerChromeApi['storage']['local'];
const KEY='rbridgeExtensionStartupV3',P01_KEY='rbridgeP01PristineContinuationV1';
const P01_LOCK='rbridge-p01-original-pristine-upgrade';
const P01_OLD_PIN='fc4d970903a94d6c49fc6dd5a9edf6f4aec4a61ccbfaf8c149974b203d2649d5';
const P01_SCOPE={appId:'cocwin',baseSha:'2f17ffcf5d8aefbb7bd3d3e4506f8fee965fd6db',sessionId:'exta-4786c8bd94d2feecc1e26a031b0693d6',generation:'7e7d5e17-2c44-4094-a6c8-0cf470ed564c'};
const P01_RUNTIME_KEYS=['rbridgeBrowserAuthorityV1','rbridgeEffectLedgerV1','rbridgeCaptureOutboxV3','rbridgeSiteCaptureActivityV1','rbridgeScopeStopV1'];
function fail(code:string):never{throw Error(code);}
function object(input:unknown):Record<string,unknown>{if(input===null||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');return input as Record<string,unknown>;}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
function rbridgeRows(rows:Record<string,unknown>):Record<string,unknown>{return Object.fromEntries(Object.entries(rows).filter(([key])=>key.startsWith('rbridge')));}
async function allRows(storage:Storage):Promise<Record<string,unknown>>{
  const read=storage.get as unknown as (keys:null)=>Promise<Record<string,unknown>>;
  return rbridgeRows(await read.call(storage,null));
}
async function p01Receipt(raw:string,pin:string,value:unknown):Promise<Record<string,unknown>>{
  const error='RBRIDGE_P01_CONTINUATION_BLOCKED',tx=object(value),keys=['schema','phase','predecessorRaw','predecessorSha256','targetSha256'];
  if(Object.keys(tx).length!==keys.length||Object.keys(tx).some(key=>!keys.includes(key))||tx.schema!=='COCWIN_P01_PRISTINE_CONTINUATION_V1'||(tx.phase!=='READY'&&tx.phase!=='ADMITTED')||tx.predecessorSha256!==P01_OLD_PIN||tx.targetSha256!==pin||typeof tx.predecessorRaw!=='string'||new TextEncoder().encode(tx.predecessorRaw).length!==1095)fail(error);
  if(await sha256Hex(tx.predecessorRaw)!==P01_OLD_PIN)fail(error);
  const old=object(JSON.parse(tx.predecessorRaw)),next=object(JSON.parse(raw)),oldPeer=object(old.peer),peer=object(next.peer);
  if(!same(next.scope,old.scope)||!same(next.bootstrap,old.bootstrap)||!same({...peer,releaseSha:oldPeer.releaseSha,capabilities:oldPeer.capabilities},oldPeer)||next.extensionId!==old.extensionId||next.releaseSha===old.releaseSha||peer.releaseSha!==next.releaseSha||!Array.isArray(oldPeer.capabilities)||!same(peer.capabilities,[...oldPeer.capabilities,'CHAT_SCOPE_QUIESCENCE_V1'])||!same(next.initialHistory,[])||next.siteAdapter!==old.siteAdapter)fail(error);
  return tx;
}
function p01Keys(rows:Record<string,unknown>,row:Record<string,unknown>,phase:unknown):void{
  const allowed=[KEY,P01_KEY,'rbridgeExtensionBootstrapV1',...(phase==='ADMITTED'?P01_RUNTIME_KEYS:[])];
  if(Object.keys(rows).some(key=>!allowed.includes(key)))fail('RBRIDGE_P01_HISTORY_UNPROVEN');
  if(Object.hasOwn(rows,'rbridgeExtensionBootstrapV1')&&!same(rows.rbridgeExtensionBootstrapV1,row.bootstrap))fail('RBRIDGE_P01_BOOTSTRAP_MISMATCH');
}
/** Composition independently validates authority, outbox and scope-stop. Validate the remaining retained stores read-only. */
async function p01RuntimeHistory(storage:Storage,rows:Record<string,unknown>,row:Record<string,unknown>):Promise<void>{
  const scope=row.scope as QualifiedV3WorkerOptions['scope'],bootstrap=object(row.bootstrap),peer=object(row.peer);
  const entries=await new RbridgeEffectStoreV1(storage).readScopeEntries(scope),ledger=rows.rbridgeEffectLedgerV1;
  if(ledger!==undefined){
    const commands=object(ledger).commands;
    if(!Array.isArray(commands)||commands.length!==entries.length||entries.some(entry=>entry.command.request.payload.target.browserInstanceId!==bootstrap.browserInstanceId||entry.command.request.payload.target.browserProfileId!==bootstrap.browserProfileId))fail('RBRIDGE_P01_HISTORY_SCOPE_MISMATCH');
  }
  await new SiteCaptureActivityStoreV1(storage,{extensionId:String(row.extensionId),browserInstanceId:String(bootstrap.browserInstanceId),browserProfileId:String(bootstrap.browserProfileId),ownerAppId:scope.appId,maxMessageBytes:Number(peer.maxMessageBytes)}).facts(scope);
  if(rows.rbridgeBrowserAuthorityV1!==undefined){
    const binding=object(rows.rbridgeBrowserAuthorityV1).binding;
    if(binding!==null){
      const b=object(binding);
      if(b.sessionId!==scope.sessionId||b.generation!==scope.generation||b.browserInstanceId!==bootstrap.browserInstanceId||b.browserProfileId!==bootstrap.browserProfileId)fail('RBRIDGE_P01_HISTORY_SCOPE_MISMATCH');
    }
  }
}

/** expectedConfigSha256 is a trusted release input, never a stored document or wire claim. */
export async function startProvisionedExtensionServiceWorkerV3(api:ProvisionedV3WorkerChromeApi,releaseSha:string,expectedConfigSha256:string):Promise<QualifiedV3WorkerComposition>{
  if(typeof releaseSha!=='string'||!/^[a-f0-9]{40}$/.test(releaseSha)||typeof expectedConfigSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedConfigSha256))fail('RBRIDGE_V3_STARTUP_BUILD_PIN_INVALID');
  if(api?.runtime?.id!==RBRIDGE_EXTENSION_ID)fail('RBRIDGE_V3_STARTUP_EXTENSION_MISMATCH');
  const storage=api?.storage?.local;
  if(typeof storage?.setAccessLevel!=='function'||typeof storage.get!=='function'||typeof storage.set!=='function')fail('RBRIDGE_V3_STARTUP_STORAGE_UNAVAILABLE');
  let loaded:unknown;
  try{await storage.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});loaded=(await storage.get(KEY))[KEY];}catch{fail('RBRIDGE_V3_STARTUP_STORAGE_UNAVAILABLE');}
  if(typeof loaded!=='string')fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');
  const raw=loaded,bytes=new TextEncoder().encode(raw).byteLength;
  if(bytes<2||bytes>65536)fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');
  if(await sha256Hex(raw)!==expectedConfigSha256)fail('RBRIDGE_V3_STARTUP_PIN_MISMATCH');
  let input:unknown;try{input=JSON.parse(raw);}catch{fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');}
  const row=object(input),keys=['schema','extensionId','releaseSha','bootstrap','scope','peer','initialHistory','siteAdapter'];
  if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||row.schema!=='RBRIDGE_EXTENSION_STARTUP_V3'||row.extensionId!==api.runtime.id||row.releaseSha!==releaseSha||row.siteAdapter!=='CHATGPT_EXACT_COPY_V3')fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');
  const bootstrap=object(row.bootstrap) as unknown as QualifiedV3WorkerOptions['bootstrap'];
  const siteReader=new ChromeSiteMarkdownReaderV3(api.tabs,api.scripting,bootstrap.browserInstanceId,bootstrap.browserProfileId);
  const options:QualifiedV3WorkerOptions={bootstrap,scope:row.scope as QualifiedV3WorkerOptions['scope'],peer:row.peer as QualifiedV3WorkerOptions['peer'],initialHistory:row.initialHistory as QualifiedV3WorkerOptions['initialHistory'],siteReader};
  const bounded=same(row.scope,P01_SCOPE)&&releaseSha!=='931e02d6b771a351e8c4e4977cf25ebf82d12a13';
  if(!bounded){
    if((await storage.get(P01_KEY))[P01_KEY]!==undefined)fail('RBRIDGE_P01_CONTINUATION_BLOCKED');
    return await startQualifiedExtensionServiceWorkerV3(api,releaseSha,{...options,beforeNativeConnect:async()=>{if((await storage.get(P01_KEY))[P01_KEY]!==undefined)fail('RBRIDGE_P01_CONTINUATION_BLOCKED');}});
  }
  // The same extension-origin Web Lock excludes setup from all admission awaits and Native connection.
  if(typeof globalThis.navigator?.locks?.request!=='function')fail('RBRIDGE_P01_EXCLUSIVE_LOCK_UNAVAILABLE');
  return await globalThis.navigator.locks.request(P01_LOCK,{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock)fail('RBRIDGE_P01_HANDOFF_ACTIVE');
    const rows=await allRows(storage);
    if(rows[KEY]!==raw)fail('RBRIDGE_P01_CONTINUATION_CHANGED');
    const tx=await p01Receipt(raw,expectedConfigSha256,rows[P01_KEY]);p01Keys(rows,row,tx.phase);
    const firstSnapshot=canonicalJson(rows);
    return await startQualifiedExtensionServiceWorkerV3(api,releaseSha,{...options,beforeNativeConnect:async()=>{
      await p01RuntimeHistory(storage,rows,row);
      if(canonicalJson(await allRows(storage))!==firstSnapshot)fail('RBRIDGE_P01_CONTINUATION_CHANGED');
      if(tx.phase==='READY'){
        const admitted={...tx,phase:'ADMITTED'};
        // This is the first-admission linearization boundary, never SEND authorization.
        // An applied-then-failed write blocks this attempt; restart must independently validate all retained state.
        try{
          await storage.set({[P01_KEY]:admitted});
          if(!same(await allRows(storage),{...rows,[P01_KEY]:admitted}))fail('RBRIDGE_P01_ADMISSION_WRITE_UNKNOWN');
        }catch{fail('RBRIDGE_P01_ADMISSION_WRITE_UNKNOWN');}
      }
    }});
  });
}
