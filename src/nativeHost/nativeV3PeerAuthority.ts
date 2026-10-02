import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {parseHello,type RbridgeChatHelloV1} from '../domain/rbridgeChatCore.js';
import {canonicalDigest,canonicalJson,requireV3Peer,type ExactBrowserTargetV1,type VerifiedPeerV3} from '../domain/rbridgeEffectProtocol.js';
import type {RbridgeChatEventStoreV1} from '../server/rbridgeChatEventStore.js';
import type {RbridgeEffectResultStoreV3} from './rbridgeEffectResultStore.js';

export interface NativeV3HistoryAnchor {sequence:number;eventSha256:string|null}
export interface NativeV3PeerAuthorityOptions {
  eventStoreRoot:string;appId:string;peerPins:VerifiedPeerV3;initialHistory:NativeV3HistoryAnchor;
}
interface Marker {schema:'RBRIDGE_NATIVE_V3_PEER_OWNER_V1';appId:string;peerPins:VerifiedPeerV3;initialHistory:NativeV3HistoryAnchor;sha256:string}
function fail(code:string):never{throw Error(code);}
function privateMode(mode:number):boolean{return process.platform==='win32'||(mode&0o077)===0;}
function uid():number|undefined{return typeof process.getuid==='function'?process.getuid():undefined;}
function samePath(a:string,b:string):boolean{return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;}

/** Trusted private configuration, never a claim made by a wire HELLO. Fixed-channel installation remains a separate gate. */
export class NativeV3PeerAuthority {
  private readonly options:NativeV3PeerAuthorityOptions;
  private initialized:Promise<void>|null=null;
  constructor(options:NativeV3PeerAuthorityOptions){
    this.options=structuredClone(options);
    const {eventStoreRoot,appId,peerPins,initialHistory}=this.options;
    if(!isAbsolute(eventStoreRoot)||resolve(eventStoreRoot)!==eventStoreRoot||/[\0\r\n]/.test(eventStoreRoot)||!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(appId))fail('RBRIDGE_NATIVE_PEER_CONFIG_INVALID');
    requireV3Peer(peerPins);
    if(!Number.isSafeInteger(initialHistory.sequence)||initialHistory.sequence<0||(initialHistory.sequence===0?initialHistory.eventSha256!==null:typeof initialHistory.eventSha256!=='string'||! /^[a-f0-9]{64}$/.test(initialHistory.eventSha256)))fail('RBRIDGE_NATIVE_HISTORY_ANCHOR_INVALID');
  }
  get maxMessageBytes():number{return this.options.peerPins.maxMessageBytes;}
  validateTarget(target:ExactBrowserTargetV1):void{
    const pins=this.options.peerPins;
    if(target.browserInstanceId!==pins.browserInstanceId||target.browserProfileId!==pins.browserProfileId)fail('RBRIDGE_NATIVE_COMMAND_TARGET_PIN_MISMATCH');
  }
  validateHello(input:unknown):RbridgeChatHelloV1{
    const hello=parseHello(input),pins=this.options.peerPins;
    if(hello.protocolMinor!==pins.protocolMinor||hello.releaseSha!==pins.releaseSha||hello.browserInstanceId!==pins.browserInstanceId||hello.browserProfileId!==pins.browserProfileId)fail('RBRIDGE_NATIVE_PEER_PIN_MISMATCH');
    if(hello.maxMessageBytes!==pins.maxMessageBytes)fail('RBRIDGE_NATIVE_PEER_MESSAGE_PIN_MISMATCH');
    if(pins.capabilities.some(cap=>!hello.capabilities.includes(cap)))fail('RBRIDGE_NATIVE_PEER_CAPABILITY_MISSING');
    return structuredClone(hello);
  }
  initialize(events:RbridgeChatEventStoreV1,results:RbridgeEffectResultStoreV3):Promise<void>{
    if(results.eventStoreRoot!==this.options.eventStoreRoot||results.appId!==this.options.appId)fail('RBRIDGE_NATIVE_PEER_OWNER_ROOT_MISMATCH');
    return this.initialized??=results.admitPeerOwner(hasHistory=>this.admit(events,hasHistory));
  }
  private async root():Promise<void>{
    const path=this.options.eventStoreRoot,info=await lstat(path);
    if(!info.isDirectory()||info.isSymbolicLink()||!privateMode(info.mode)||(uid()!==undefined&&info.uid!==uid())||!samePath(await realpath(path),path))fail('RBRIDGE_NATIVE_PEER_ROOT_INVALID');
  }
  private async syncRoot():Promise<void>{
    if(process.platform==='win32')return;
    const handle=await open(this.options.eventStoreRoot,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try{await handle.sync();}finally{await handle.close();}
  }
  private async read():Promise<string|null>{
    let handle;
    try{handle=await open(join(this.options.eventStoreRoot,'v3-peer-owner.json'),constants.O_RDONLY|constants.O_NOFOLLOW|(process.platform==='win32'?0:constants.O_NONBLOCK));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    try{
      const before=await handle.stat();
      if(!before.isFile()||before.nlink!==1||!privateMode(before.mode)||(uid()!==undefined&&before.uid!==uid())||before.size<2||before.size>16384)fail('RBRIDGE_NATIVE_PEER_OWNER_INVALID');
      const bytes=await handle.readFile(),after=await handle.stat();
      if(after.size!==before.size||after.nlink!==1||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||bytes.length!==before.size)fail('RBRIDGE_NATIVE_PEER_OWNER_INVALID');
      return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    }finally{await handle.close();}
  }
  private async admit(events:RbridgeChatEventStoreV1,hasResultHistory:boolean):Promise<void>{
    await this.root();
    const body={schema:'RBRIDGE_NATIVE_V3_PEER_OWNER_V1' as const,appId:this.options.appId,peerPins:this.options.peerPins,initialHistory:this.options.initialHistory};
    const expected:Marker={...body,sha256:await canonicalDigest(body)},expectedText=canonicalJson(expected)+'\n';
    let text=await this.read();
    const history=await events.load(),anchor=this.options.initialHistory;
    if(history.length<anchor.sequence||(anchor.sequence>0&&history[anchor.sequence-1]?.eventSha256!==anchor.eventSha256))fail('RBRIDGE_NATIVE_HISTORY_OWNERSHIP_UNVERIFIED');
    if(text===null){
      if(hasResultHistory)fail('RBRIDGE_NATIVE_RESULT_HISTORY_OWNERSHIP_UNVERIFIED');
      if(history.length!==anchor.sequence)fail('RBRIDGE_NATIVE_HISTORY_OWNERSHIP_UNVERIFIED');
      await this.root();
      let handle;
      try{handle=await open(join(this.options.eventStoreRoot,'v3-peer-owner.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      if(handle){try{await handle.writeFile(expectedText);await handle.sync();}finally{await handle.close();}}
      await this.syncRoot();text=await this.read();
    }
    // Canonical byte equality checks every configured field and the complete marker digest. Never relabel history.
    if(text!==expectedText)fail('RBRIDGE_NATIVE_PEER_OWNER_PIN_MISMATCH');
    await this.syncRoot();await this.root();
  }
}
