import {constants} from 'node:fs';
import {lstat,open,realpath,readFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {userInfo} from 'node:os';
import {pathToFileURL} from 'node:url';
import {canonicalJson,parseV3Scope} from '../domain/rbridgeEffectProtocol.js';
import {RbridgeChatPeerStoreV3} from './rbridgeChatPeerStore.js';
import {runRbridgeChatStdio} from './rbridgeChatStdio.js';

const OPERATIONS=new Set(['stage-chunk','commit-command','read-result','read-event','inspect-peer']);
const CONFIG='/etc/rbridge/chat-peer-v3.json';
function fail(code:string):never{throw Error(code);}
function fields(value:unknown,keys:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('RBRIDGE_PEER_CLI_FIELDS_INVALID');const row=value as Record<string,unknown>;
  if(Object.keys(row).length!==keys.length||keys.some(k=>!Object.hasOwn(row,k)))fail('RBRIDGE_PEER_CLI_FIELDS_INVALID');return row;
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
  else{fields(input,[]);value=await store.peer();}
  const result={schema:'RBRIDGE_CHAT_FIXED_PEER_CLI_V3' as const,status:'PASS' as const,operation,value};
  if(Buffer.byteLength(canonicalJson(result))>131072)fail('RBRIDGE_PEER_CLI_OUTPUT_BUDGET_EXCEEDED');return result;
}
/** Task11 installs this root-owned configuration and approved immutable release; an absent route stays BLOCKED. */
async function installedStore():Promise<RbridgeChatPeerStoreV3>{
  if(process.platform!=='linux'||process.getuid?.()===0||userInfo().username!=='rbridge')fail('RBRIDGE_PEER_INSTALL_IDENTITY_REQUIRED');
  let file;try{file=await open(CONFIG,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{fail('RBRIDGE_PEER_INSTALL_CONFIG_UNAVAILABLE');}
  let config:Record<string,unknown>;
  try{const metadata=await file.stat();if(!metadata.isFile()||metadata.uid!==0||metadata.nlink!==1||(metadata.mode&0o022)||metadata.size<2||metadata.size>4096||await realpath(CONFIG)!==CONFIG)fail('RBRIDGE_PEER_INSTALL_CONFIG_UNTRUSTED');config=fields(JSON.parse(await file.readFile('utf8')),['schema','releaseSha','releaseCwd','storeRoot']);}finally{await file.close();}
  if(config.schema!=='RBRIDGE_CHAT_FIXED_PEER_INSTALL_V3'||typeof config.releaseSha!=='string'||! /^[a-f0-9]{40}$/.test(config.releaseSha)||config.releaseCwd!=='/var/lib/rbridge/runtime/releases/'+config.releaseSha||typeof config.storeRoot!=='string'||!isAbsolute(config.storeRoot)||resolve(config.storeRoot)!==config.storeRoot||/[\0\r\n]/.test(config.storeRoot))fail('RBRIDGE_PEER_INSTALL_CONFIG_INVALID');
  for(const path of [config.releaseCwd as string,join(config.releaseCwd as string,'dist'),join(config.releaseCwd as string,'dist','src'),join(config.releaseCwd as string,'dist','src','server')]){const st=await lstat(path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022)||await realpath(path)!==path)fail('RBRIDGE_PEER_INSTALL_RELEASE_UNTRUSTED');}
  if(await realpath(process.cwd())!==config.releaseCwd)fail('RBRIDGE_PEER_INSTALL_RELEASE_MISMATCH');
  if((await readFile(join(config.releaseCwd as string,'SOURCE_SHA'),'utf8')).trim()!==config.releaseSha)fail('RBRIDGE_PEER_INSTALL_SOURCE_MISMATCH');
  const entry=await realpath(process.argv[1]??'');if(entry!==join(config.releaseCwd as string,'dist','src','server','rbridgeChatPeerCli.js'))fail('RBRIDGE_PEER_INSTALL_ENTRYPOINT_MISMATCH');
  const st=await lstat(entry);if(!st.isFile()||st.uid!==0||(st.mode&0o022)||st.nlink!==1)fail('RBRIDGE_PEER_INSTALL_ENTRYPOINT_UNTRUSTED');
  return new RbridgeChatPeerStoreV3(config.storeRoot);
}
async function main():Promise<void>{
  const args=process.argv.slice(2);if(args[0]==='stdio'&&args.length===1){if(process.env.SSH_ORIGINAL_COMMAND!=='rbridge-chat-stdio-v1')fail('RBRIDGE_PEER_FIXED_COMMAND_REQUIRED');await runRbridgeChatStdio(process.stdin,process.stdout,await installedStore());return;}
  if(args.length!==2||!OPERATIONS.has(args[0]!))fail('RBRIDGE_PEER_CLI_OPERATION_DENIED');const result=await executeRbridgeChatPeerCli(await installedStore(),args);process.stdout.write(canonicalJson(result)+'\n');
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){void main().catch(error=>{const reason=error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'RBRIDGE_PEER_CLI_FAILED';process.stderr.write(JSON.stringify({schema:'RBRIDGE_CHAT_FIXED_PEER_CLI_V3',status:'BLOCKED',reason})+'\n');process.exitCode=2;});}
