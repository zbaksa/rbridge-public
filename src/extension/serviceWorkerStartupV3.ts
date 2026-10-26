import {sha256Hex} from '../domain/rbridgeEffectProtocol.js';
import {ChromeSiteMarkdownReaderV3,type ChromeSiteScriptingApiV3} from './chromeAuthorityAdapters.js';
import {RBRIDGE_EXTENSION_ID} from './extensionManifest.js';
import {startQualifiedExtensionServiceWorkerV3,type QualifiedV3WorkerChromeApi,type QualifiedV3WorkerComposition,type QualifiedV3WorkerOptions} from './serviceWorkerCompositionV3.js';

export type ProvisionedV3WorkerChromeApi=QualifiedV3WorkerChromeApi&{
  storage:{local:QualifiedV3WorkerChromeApi['storage']['local']&{setAccessLevel(options:{accessLevel:'TRUSTED_CONTEXTS'}):Promise<void>}};
  scripting:QualifiedV3WorkerChromeApi['scripting']&ChromeSiteScriptingApiV3;
};
const KEY='rbridgeExtensionStartupV3';
function fail(code:string):never{throw Error(code);}
function object(input:unknown):Record<string,unknown>{if(input===null||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');return input as Record<string,unknown>;}

/** expectedConfigSha256 belongs to the trusted release/provisioning process, never the stored document or wire HELLO. */
export async function startProvisionedExtensionServiceWorkerV3(api:ProvisionedV3WorkerChromeApi,releaseSha:string,expectedConfigSha256:string):Promise<QualifiedV3WorkerComposition>{
  if(typeof releaseSha!=='string'||!/^[a-f0-9]{40}$/.test(releaseSha)||typeof expectedConfigSha256!=='string'||!/^[a-f0-9]{64}$/.test(expectedConfigSha256))fail('RBRIDGE_V3_STARTUP_BUILD_PIN_INVALID');
  if(api?.runtime?.id!==RBRIDGE_EXTENSION_ID)fail('RBRIDGE_V3_STARTUP_EXTENSION_MISMATCH');
  const storage=api?.storage?.local;
  if(typeof storage?.setAccessLevel!=='function'||typeof storage.get!=='function'||typeof storage.set!=='function')fail('RBRIDGE_V3_STARTUP_STORAGE_UNAVAILABLE');
  let raw:unknown;
  try{await storage.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});raw=(await storage.get(KEY))[KEY];}catch{fail('RBRIDGE_V3_STARTUP_STORAGE_UNAVAILABLE');}
  if(typeof raw!=='string')fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');
  const bytes=new TextEncoder().encode(raw).byteLength;
  if(bytes<2||bytes>65536)fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');
  if(await sha256Hex(raw)!==expectedConfigSha256)fail('RBRIDGE_V3_STARTUP_PIN_MISMATCH');
  let input:unknown;try{input=JSON.parse(raw);}catch{fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');}
  const row=object(input),keys=['schema','extensionId','releaseSha','bootstrap','scope','peer','initialHistory','siteAdapter'];
  if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||row.schema!=='RBRIDGE_EXTENSION_STARTUP_V3'||row.extensionId!==api.runtime.id||row.releaseSha!==releaseSha||row.siteAdapter!=='CHATGPT_EXACT_COPY_V3')fail('RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');
  const bootstrap=object(row.bootstrap) as unknown as QualifiedV3WorkerOptions['bootstrap'];
  const siteReader=new ChromeSiteMarkdownReaderV3(api.tabs,api.scripting,bootstrap.browserInstanceId,bootstrap.browserProfileId);
  return await startQualifiedExtensionServiceWorkerV3(api,releaseSha,{bootstrap,scope:row.scope as QualifiedV3WorkerOptions['scope'],peer:row.peer as QualifiedV3WorkerOptions['peer'],initialHistory:row.initialHistory as QualifiedV3WorkerOptions['initialHistory'],siteReader});
}
