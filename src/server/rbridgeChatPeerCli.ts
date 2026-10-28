import {constants} from 'node:fs';
import {lstat,open,realpath,readFile} from 'node:fs/promises';
import {join,posix,resolve} from 'node:path';
import {userInfo} from 'node:os';
import {pathToFileURL} from 'node:url';
import {canonicalJson,parseV3Scope} from '../domain/rbridgeEffectProtocol.js';
import {RbridgeChatPeerStoreV3} from './rbridgeChatPeerStore.js';
import {runRbridgeChatStdio} from './rbridgeChatStdio.js';

const OPERATIONS=new Set(['stage-chunk','commit-command','read-result','read-event','inspect-peer','submit-query','read-query']);
const CONFIG='/etc/rbridge/chat-peer-v3.json';
function fail(code:string):never{throw Error(code);}
function fields(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('RBRIDGE_PEER_CLI_FIELDS_INVALID');const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(k=>!Object.hasOwn(row,k)))fail('RBRIDGE_PEER_CLI_FIELDS_INVALID');return row;
}
export interface RbridgeChatPeerInstallV3 {
  readonly schema:'RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3'|'RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3_1';
  readonly releaseSha:string;readonly releaseCwd:string;readonly storeRoot:string;readonly launchCwd:string;
}
function absolutePosix(value:unknown):value is string{
  return typeof value==='string'&&value!=='/'&&value.length<=4096&&posix.isAbsolute(value)&&posix.resolve(value)===value&&!/[\0\r\n]/.test(value);
}
/** Private root-owned installation data; V3 retains its original release-cwd rule. */
export function parseRbridgeChatPeerInstallV3(input:unknown):RbridgeChatPeerInstallV3{
  if(!input||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_PEER_INSTALL_CONFIG_INVALID');
  const schema=(input as Record<string,unknown>).schema;
  if(schema!=='RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3'&&schema!=='RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3_1')fail('RBRIDGE_PEER_INSTALL_CONFIG_INVALID');
  const row=fields(input,schema==='RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3_1'?['schema','releaseSha','releaseCwd','storeRoot','launchCwd']:['schema','releaseSha','releaseCwd','storeRoot']);
  const {releaseSha,releaseCwd,storeRoot}=row,launchCwd=schema==='RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3'?releaseCwd:row.launchCwd;
  if(typeof releaseSha!=='string'||!/^[a-f0-9]{40}$/.test(releaseSha)||typeof releaseCwd!=='string'||releaseCwd!=='/var/lib/rbridge/runtime/releases/'+releaseSha||!absolutePosix(storeRoot)||!absolutePosix(launchCwd))fail('RBRIDGE_PEER_INSTALL_CONFIG_INVALID');
  return Object.freeze({schema,releaseSha,releaseCwd,storeRoot,launchCwd});
}
export function assertRbridgeChatPeerInvocationV3(config:RbridgeChatPeerInstallV3,cwd:string,entry:string):void{
  if(cwd!==config.launchCwd)fail('RBRIDGE_PEER_INSTALL_RELEASE_MISMATCH');
  if(entry!==posix.join(config.releaseCwd,'dist','src','server','rbridgeChatPeerCli.js'))fail('RBRIDGE_PEER_INSTALL_ENTRYPOINT_MISMATCH');
}
function decode(arg:unknown):unknown{
  if(typeof arg!=='string'||!arg||Buffer.byteLength(arg)>8192)fail('RBRIDGE_PEER_CLI_ARGUMENT_INVALID');const bytes=Buffer.from(arg,'base64');if(bytes.toString('base64')!==arg)fail('RBRIDGE_PEER_CLI_BASE64_INVALID');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('RBRIDGE_PEER_CLI_JSON_INVALID');}
}
/** The CLI caller selects a fixed operation and bounded data only. The installed entrypoint supplies the store. */
export async function executeRbridgeChatPeerCli(store:RbridgeChatPeerStoreV3,args:readonly string[]):Promise<{schema:'RBRIDGE_CHAT_FIXED_PEER_CLI_V3';status:'PASS';operation:string;value:unknown}>{
  if(args.length!==2||!OPERATIONS.has(args[0]!))fail('RBRIDGE_PEER_CLI_OPERATION_DENIED');const operation=args[0]!,input=decode(args[1]);let value:unknown;
  if(operation==='stage-chunk'){await store.stageChunk(input);value=null;}
  else if(operation==='commit-command'){await store.commitCommand(input);value=null;}
  else if(operation==='read-result'){const row=fields(input,['commandId','scope']);if(typeof row.commandId!=='string')fail('RBRIDGE_PEER_CLI_COMMAND_ID_INVALID');value=(await store.read(row.commandId,parseV3Scope(row.scope))).result;}
  else if(operation==='read-event'){const row=fields(input,['afterSequence']);if(!Number.isSafeInteger(row.afterSequence)||Number(row.afterSequence)<0)fail('RBRIDGE_PEER_CLI_CURSOR_INVALID');value=await store.readEvent(Number(row.afterSequence));}
  else if(operation==='submit-query'){fields(input,['scope','command']);value=await store.submitReadQuery(input);}
  else if(operation==='read-query'){const row=fields(input,['commandId','scope']);if(typeof row.commandId!=='string')fail('RBRIDGE_PEER_CLI_COMMAND_ID_INVALID');value=await store.readQuery(row.commandId,parseV3Scope(row.scope));}
  else{fields(input,[]);value=await store.peer();}
  const result={schema:'RBRIDGE_CHAT_FIXED_PEER_CLI_V3' as const,status:'PASS' as const,operation,value};
  if(Buffer.byteLength(canonicalJson(result))>131072)fail('RBRIDGE_PEER_CLI_OUTPUT_BUDGET_EXCEEDED');return result;
}
/** Task11 installs this root-owned configuration and approved immutable release; an absent route stays BLOCKED. */
async function installedStore():Promise<RbridgeChatPeerStoreV3>{
  if(process.platform!=='linux'||process.getuid?.()===0||userInfo().username!=='rbridge')fail('RBRIDGE_PEER_INSTALL_IDENTITY_REQUIRED');
  let file;try{file=await open(CONFIG,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{fail('RBRIDGE_PEER_INSTALL_CONFIG_UNAVAILABLE');}
  let config:RbridgeChatPeerInstallV3;
  try{const metadata=await file.stat();if(!metadata.isFile()||metadata.uid!==0||metadata.nlink!==1||(metadata.mode&0o022)||metadata.size<2||metadata.size>4096||await realpath(CONFIG)!==CONFIG)fail('RBRIDGE_PEER_INSTALL_CONFIG_UNTRUSTED');config=parseRbridgeChatPeerInstallV3(JSON.parse(await file.readFile('utf8')));}finally{await file.close();}
  for(const path of [config.releaseCwd,join(config.releaseCwd,'dist'),join(config.releaseCwd,'dist','src'),join(config.releaseCwd,'dist','src','server')]){const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022)||await realpath(path)!==path)fail('RBRIDGE_PEER_INSTALL_RELEASE_UNTRUSTED');}
  const entry=await realpath(process.argv[1]??'');assertRbridgeChatPeerInvocationV3(config,await realpath(process.cwd()),entry);
  if((await readFile(join(config.releaseCwd,'SOURCE_SHA'),'utf8')).trim()!==config.releaseSha)fail('RBRIDGE_PEER_INSTALL_SOURCE_MISMATCH');
  const st=await lstat(entry);if(!st.isFile()||st.uid!==0||(st.mode&0o022)||st.nlink!==1)fail('RBRIDGE_PEER_INSTALL_ENTRYPOINT_UNTRUSTED');
  return new RbridgeChatPeerStoreV3(config.storeRoot);
}
async function main():Promise<void>{
  const args=process.argv.slice(2);if(args[0]==='stdio'&&args.length===1){if(process.env.SSH_ORIGINAL_COMMAND!=='rbridge-chat-stdio-v1')fail('RBRIDGE_PEER_FIXED_COMMAND_REQUIRED');await runRbridgeChatStdio(process.stdin,process.stdout,await installedStore());return;}
  if(args.length!==2||!OPERATIONS.has(args[0]!))fail('RBRIDGE_PEER_CLI_OPERATION_DENIED');const result=await executeRbridgeChatPeerCli(await installedStore(),args);process.stdout.write(canonicalJson(result)+'\n');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){void main().catch(error=>{const reason=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'RBRIDGE_PEER_CLI_FAILED';process.stderr.write(JSON.stringify({schema:'RBRIDGE_CHAT_FIXED_PEER_CLI_V3',status:'BLOCKED',reason})+'\n');process.exitCode=2;});}
