import {fork,type ChildProcess} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {RbridgeChatPeerStoreV3} from '../src/server/rbridgeChatPeerStore.js';
import {RbridgeEffectResultStoreV3} from '../src/nativeHost/rbridgeEffectResultStore.js';
import {executeRbridgeChatPeerCli} from '../src/server/rbridgeChatPeerCli.js';
import {canonicalJson,type V3Scope} from '../src/domain/rbridgeEffectProtocol.js';

export interface FixtureChild {child:ChildProcess;locked:Promise<void>;done:Promise<void>;release():void;stop():Promise<void>}
export function fixtureChild(mode:'peer-lock'|'result-lock'|'inspect-cli',root:string):FixtureChild{
  const child=fork(fileURLToPath(import.meta.url),[mode,root],{execPath:process.execPath,stdio:['ignore','ignore','ignore','ipc']});
  let lockResolve!:()=>void,lockReject!:(e:Error)=>void,doneResolve!:()=>void,doneReject!:(e:Error)=>void;
  const locked=new Promise<void>((resolve,reject)=>{lockResolve=resolve;lockReject=reject;});
  const done=new Promise<void>((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
  void locked.catch(()=>undefined);void done.catch(()=>undefined);
  const timeout=setTimeout(()=>{const error=Error('FIXTURE_CHILD_TIMEOUT');lockReject(error);doneReject(error);child.kill('SIGKILL');},10000);
  child.on('message',(message:unknown)=>{const row=message as {type?:string;error?:string};if(row.type==='LOCKED')lockResolve();if(row.type==='DONE'){doneResolve();clearTimeout(timeout);}if(row.type==='ERROR'){const e=Error(row.error??'FIXTURE_CHILD_ERROR');lockReject(e);doneReject(e);clearTimeout(timeout);}});
  child.once('error',e=>{lockReject(e);doneReject(e);clearTimeout(timeout);});
  child.once('exit',(code,signal)=>{clearTimeout(timeout);if(code!==0){const e=Error('FIXTURE_CHILD_EXIT_'+String(code)+'_'+String(signal));lockReject(e);doneReject(e);}});
  return {child,locked,done,release(){if(child.connected)child.send('RELEASE');},async stop(){clearTimeout(timeout);if(child.exitCode!==null||child.signalCode!==null)return;const closed=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await closed;}};
}
async function childMain(){
  const mode=process.argv[2],root=process.argv[3];if(!root)throw Error('FIXTURE_ROOT_REQUIRED');
  const hold=async()=>{process.send?.({type:'LOCKED'});await new Promise<void>(resolve=>process.once('message',()=>resolve()));};
  if(mode==='peer-lock'){
    const store=new RbridgeChatPeerStoreV3(root) as unknown as {exclusive<T>(fn:()=>Promise<T>):Promise<T>};await store.exclusive(hold);
  }else if(mode==='result-lock'){
    const config=JSON.parse(await readFile(root+'/v3-peer-config.json','utf8')) as {scope:V3Scope;peerPins:{maxMessageBytes:number}};
    const options={eventStoreRoot:root,scope:config.scope,maxMessageBytes:config.peerPins.maxMessageBytes,crossProcess:true};
    const store=new RbridgeEffectResultStoreV3(options) as unknown as {exclusive<T>(fn:()=>Promise<T>):Promise<T>};await store.exclusive(hold);
  }else if(mode==='inspect-cli'){
    const result=await executeRbridgeChatPeerCli(new RbridgeChatPeerStoreV3(root),['inspect-peer',Buffer.from(canonicalJson({})).toString('base64')]);if(result.status!=='PASS')throw Error('FIXTURE_CLI_NOT_PASS');
  }else throw Error('FIXTURE_MODE_INVALID');
  process.send?.({type:'DONE'});process.disconnect?.();
}
if(process.send)void childMain().catch(error=>{process.send?.({type:'ERROR',error:error instanceof Error?error.message:'FIXTURE_CHILD_ERROR'});process.exitCode=1;process.disconnect?.();});
