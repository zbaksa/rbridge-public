import {M0_LIMITS,REQUIRED_RBRIDGE_CAPABILITIES,type RbridgeChatHelloV1} from '../domain/rbridgeChatCore.js';
import {ExtensionNativePortLinkV1,type ExtensionRuntimeNativeApiV1,type NativePortEventV1} from './nativePortServiceWorker.js';

declare const __RBRIDGE_RELEASE_SHA__:string;

export interface ExtensionBootstrapConfigV1{
  schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1';
  browserInstanceId:string;
  browserProfileId:string;
  nativeHostVersion:string;
}

export interface ServiceWorkerStorageV1{
  get(key:string):Promise<Record<string,unknown>>;
}

export interface ServiceWorkerChromeApiV1{
  runtime:{
    connectNative(name:string):ReturnType<ExtensionRuntimeNativeApiV1['connectNative']>;
  };
  storage:{local:ServiceWorkerStorageV1};
}

const KEY='rbridgeExtensionBootstrapV1';
const SHA1=/^[0-9a-f]{40}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function fail(code:string):never{throw new Error(code);}
export function parseExtensionBootstrapConfigV1(input:unknown):ExtensionBootstrapConfigV1{
  if(input===null||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_EXTENSION_BOOTSTRAP_INVALID');
  const row=input as Record<string,unknown>,keys=['schema','browserInstanceId','browserProfileId','nativeHostVersion'];
  if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||row.schema!=='RBRIDGE_EXTENSION_BOOTSTRAP_V1')fail('RBRIDGE_EXTENSION_BOOTSTRAP_INVALID');
  for(const key of keys.slice(1))if(typeof row[key]!=='string'||!ID.test(row[key] as string))fail('RBRIDGE_EXTENSION_BOOTSTRAP_INVALID');
  return {schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1',browserInstanceId:row.browserInstanceId as string,browserProfileId:row.browserProfileId as string,nativeHostVersion:row.nativeHostVersion as string};
}

export async function startExtensionServiceWorkerV1(api:ServiceWorkerChromeApiV1,releaseSha:string):Promise<ExtensionNativePortLinkV1>{
  if(!SHA1.test(releaseSha))fail('RBRIDGE_RELEASE_SHA_INVALID');
  const stored=await api.storage.local.get(KEY),config=parseExtensionBootstrapConfigV1(stored[KEY]);
  const hello:RbridgeChatHelloV1={
    schema:'RBRIDGE_CHAT_HELLO_V1',protocolMajor:1,protocolMinor:0,releaseSha,maxMessageBytes:M0_LIMITS.maxRbridgeControlMessageUtf8Bytes,
    capabilities:[...REQUIRED_RBRIDGE_CAPABILITIES],browserInstanceId:config.browserInstanceId,browserProfileId:config.browserProfileId,nativeHostVersion:config.nativeHostVersion,
  };
  const nativeApi:ExtensionRuntimeNativeApiV1={connectNative:name=>api.runtime.connectNative(name)};
  const link=new ExtensionNativePortLinkV1(nativeApi,hello);
  link.connect();
  return link;
}

declare const chrome:ServiceWorkerChromeApiV1|undefined;
if(typeof chrome!=='undefined'){
  void startExtensionServiceWorkerV1(chrome,__RBRIDGE_RELEASE_SHA__).catch(()=>{});
}
