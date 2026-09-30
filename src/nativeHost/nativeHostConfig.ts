import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import type {NativeHostRuntimeConfigV1} from './nativeHostRuntime.js';

export interface NativeHostConfigFileV1 extends NativeHostRuntimeConfigV1 {
  schema:'RBRIDGE_NATIVE_HOST_CONFIG_V1';
}

const EXTENSION_ID=/^[a-p]{32}$/;
const SAFE_HOST=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
function fail(code:string):never{throw new Error(code);}
function object(value:unknown):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value))fail('RBRIDGE_NATIVE_CONFIG_INVALID');
  return value as Record<string,unknown>;
}
function exact(row:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]):void{
  const allowed=new Set([...required,...optional]),keys=Object.keys(row);
  if(required.some(key=>!Object.prototype.hasOwnProperty.call(row,key))||keys.some(key=>!allowed.has(key)))fail('RBRIDGE_NATIVE_CONFIG_FIELDS_INVALID');
}
function abs(value:unknown,code:string):string{
  if(typeof value!=='string'||!isAbsolute(value)||resolve(value)!==value||value.includes('\0')||/[\r\n]/u.test(value))fail(code);
  return value;
}
function privateMode(mode:number):boolean{return process.platform==='win32'||(mode&0o077)===0;}
function samePath(a:string,b:string):boolean{
  const left=resolve(a),right=resolve(b);return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
}
export function parseNativeHostConfigV1(input:unknown):NativeHostConfigFileV1{
  const row=object(input);
  exact(row,['schema','expectedExtensionId','eventStoreRoot','ssh'],['maxEvents','maxEventBytes']);
  if(row.schema!=='RBRIDGE_NATIVE_HOST_CONFIG_V1')fail('RBRIDGE_NATIVE_CONFIG_SCHEMA_INVALID');
  if(typeof row.expectedExtensionId!=='string'||!EXTENSION_ID.test(row.expectedExtensionId))fail('RBRIDGE_EXTENSION_ID_INVALID');
  const ssh=object(row.ssh);
  exact(ssh,['sshPath','host','port','user','identityFile','knownHostsFile']);
  if(typeof ssh.host!=='string'||!SAFE_HOST.test(ssh.host)||ssh.host.startsWith('-'))fail('RBRIDGE_SSH_HOST_INVALID');
  if(typeof ssh.port!=='number'||!Number.isInteger(ssh.port)||ssh.port<1||ssh.port>65535)fail('RBRIDGE_SSH_PORT_INVALID');
  if(ssh.user!=='rbridge')fail('RBRIDGE_SSH_USER_INVALID');
  const maxEvents=row.maxEvents;
  const maxEventBytes=row.maxEventBytes;
  if(maxEvents!==undefined&&(!Number.isInteger(maxEvents)||Number(maxEvents)<1||Number(maxEvents)>100000))fail('RBRIDGE_NATIVE_CONFIG_EVENT_LIMIT_INVALID');
  if(maxEventBytes!==undefined&&(!Number.isInteger(maxEventBytes)||Number(maxEventBytes)<4096||Number(maxEventBytes)>64*1024*1024))fail('RBRIDGE_NATIVE_CONFIG_BYTE_LIMIT_INVALID');
  return {
    schema:'RBRIDGE_NATIVE_HOST_CONFIG_V1',
    expectedExtensionId:row.expectedExtensionId,
    eventStoreRoot:abs(row.eventStoreRoot,'RBRIDGE_EVENT_STORE_ROOT_INVALID'),
    ssh:{
      sshPath:abs(ssh.sshPath,'RBRIDGE_SSH_PATH_INVALID'),
      host:ssh.host,port:ssh.port,user:'rbridge',
      identityFile:abs(ssh.identityFile,'RBRIDGE_SSH_IDENTITY_INVALID'),
      knownHostsFile:abs(ssh.knownHostsFile,'RBRIDGE_SSH_KNOWN_HOSTS_INVALID'),
    },
    ...(maxEvents===undefined?{}:{maxEvents:Number(maxEvents)}),
    ...(maxEventBytes===undefined?{}:{maxEventBytes:Number(maxEventBytes)}),
  };
}
export async function loadNativeHostConfigV1(path:string):Promise<NativeHostConfigFileV1>{
  const exactPath=abs(path,'RBRIDGE_NATIVE_CONFIG_PATH_INVALID');
  const info=await lstat(exactPath).catch(()=>fail('RBRIDGE_NATIVE_CONFIG_NOT_FOUND'));
  if(info.isSymbolicLink()||!info.isFile()||info.size<2||info.size>65536||!privateMode(info.mode))fail('RBRIDGE_NATIVE_CONFIG_FILE_INVALID');
  if(!samePath(await realpath(exactPath),exactPath))fail('RBRIDGE_NATIVE_CONFIG_FILE_INVALID');
  let value:unknown;try{value=JSON.parse(await readFile(exactPath,'utf8'));}catch{fail('RBRIDGE_NATIVE_CONFIG_JSON_INVALID');}
  return parseNativeHostConfigV1(value);
}
