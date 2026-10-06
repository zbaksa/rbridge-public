import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {open,readdir,lstat,readlink,type FileHandle} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeInstallReport,parseRBridgeInstallProfile,validateInstallContract,type Budget,type InstallProfile,type SnapshotToken} from './types.js';
import {validateArtifactManifest,verifyProtectedArtifact} from './artifactQualification.js';

export interface SnapshotMetadata{dev:string;ino:string;uid:number;gid:number;mode:number;nlink:number;size:number;mtime_ns:string;ctime_ns:string;atime_ns:string;}
export interface SnapshotEntry extends SnapshotMetadata{path:string;kind:'DIRECTORY'|'FILE'|'SYMLINK'|'SOCKET'|'FIFO'|'OTHER';sha256:string;target:string;}
type Scope='QUALIFIED_READONLY_HELPER'|'FIXTURE_AUTHORITY_ONLY';
function fail(code='STATE_CHANGED'):never{throw new Error(code);}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function pathParts(path:string){const parts=path.split('/');if(!path||path.length>4096||/[\x00\r\n]/.test(path)||parts.some(p=>!p||p==='.'||p==='..'))fail('STATE_PATH_INVALID');return parts;}
function metadata(s:BigIntStats):SnapshotMetadata{return {dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),gid:Number(s.gid),mode:Number(s.mode&0o7777n),nlink:Number(s.nlink),size:Number(s.size),mtime_ns:String(s.mtimeNs),ctime_ns:String(s.ctimeNs),atime_ns:String(s.atimeNs)};}
function identity(s:BigIntStats){const m=metadata(s);return digest(encodeInstallReport({dev:m.dev,ino:m.ino,uid:m.uid,gid:m.gid,mode:m.mode,nlink:m.nlink,size:m.size,mtime_ns:m.mtime_ns,ctime_ns:m.ctime_ns}));}
function basic(s:BigIntStats){return [s.dev,s.ino,s.mode,s.uid,s.gid].map(String).join(':');}
function fingerprint(root:SnapshotMetadata,entries:readonly SnapshotEntry[]){
  const omit=(v:SnapshotMetadata|SnapshotEntry)=>Object.fromEntries(Object.entries(v).filter(([k])=>k!=='atime_ns'));
  return digest(encodeInstallReport({root:omit(root),entries:entries.map(omit)}));
}
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const fileFlags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
const fdPath=(fd:FileHandle,name='')=>`/proc/self/fd/${fd.fd}`+(name?'/'+name:'');
async function anchoredRoot(path:string){
  if(!path.startsWith('/')||path==='/')fail('STATE_PATH_INVALID');const parts=pathParts(path.slice(1));
  const handles:FileHandle[]=[await open('/',directoryFlags)],links:Array<{parent:FileHandle;name:string;child:FileHandle;identity:string}>=[];
  try{
    for(const name of parts){const parent=handles.at(-1)!,before=await lstat(fdPath(parent,name),{bigint:true}),child=await open(fdPath(parent,name),directoryFlags);handles.push(child);
      if(basic(before)!==basic(await child.stat({bigint:true})))fail();links.push({parent,name,child,identity:basic(before)});
    }
    return {root:handles.at(-1)!,async check(){for(const link of links)if(basic(await lstat(fdPath(link.parent,link.name),{bigint:true}))!==link.identity||basic(await link.child.stat({bigint:true}))!==link.identity)fail();},async close(){for(const h of handles.reverse())await h.close();}};
  }catch(error){for(const h of handles.reverse())await h.close();throw error;}
}
async function inventory(root:FileHandle,uid:number,gid:number,budget:Budget,stoppedSockets:readonly string[]){
  const entries:SnapshotEntry[]=[],reasons=new Set<string>(),accessTimes=new Map<string,string>(),started=performance.now();let bytes=0;
  const timely=()=>{if(performance.now()-started>=budget.scan_ms)fail('STATE_SCAN_DEADLINE');};
  const rootStat=await root.stat({bigint:true}),rootMetadata=metadata(rootStat);
  if(rootStat.uid!==BigInt(uid)||rootStat.gid!==BigInt(gid)||(rootStat.mode&0o7777n)!==0o700n)reasons.add('STATE_ROOT_UNPROTECTED');
  async function walk(parent:FileHandle,prefix='',depth=0){
    timely();if(depth>budget.state_depth)fail('STATE_DEPTH_LIMIT');const before=await parent.stat({bigint:true});
    const names=(await readdir(fdPath(parent))).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
    for(const name of names){
      timely();const path=prefix+name;pathParts(path);if(entries.length>=budget.state_entries)fail('STATE_ENTRY_LIMIT');
      const s=await lstat(fdPath(parent,name),{bigint:true}),m=metadata(s);let kind:SnapshotEntry['kind']='OTHER',sha256='',target='';
      if(s.uid!==BigInt(uid)||s.gid!==BigInt(gid)||(!s.isSymbolicLink()&&(s.mode&0o6022n)!==0n))reasons.add('STATE_OWNERSHIP_OR_MODE');
      if(s.isDirectory()){
        kind='DIRECTORY';const child=await open(fdPath(parent,name),directoryFlags);
        try{if(identity(s)!==identity(await child.stat({bigint:true})))fail();entries.push({path,kind,...m,sha256,target});await walk(child,path+'/',depth+1);}finally{await child.close();}
      }else if(s.isFile()){
        kind='FILE';const key=m.dev+':'+m.ino;m.atime_ns=accessTimes.get(key)??m.atime_ns;accessTimes.set(key,m.atime_ns);
        if(s.size>BigInt(budget.state_bytes-bytes))fail('STATE_BYTE_LIMIT');const child=await open(fdPath(parent,name),fileFlags);
        try{
          if(identity(s)!==identity(await child.stat({bigint:true})))fail();const hash=createHash('sha256'),buffer=Buffer.alloc(1048576);let count=0;
          for(;;){timely();const {bytesRead}=await child.read(buffer,0,buffer.length,null);if(!bytesRead)break;count+=bytesRead;if(count>m.size)fail();hash.update(buffer.subarray(0,bytesRead));}
          if(count!==m.size||identity(s)!==identity(await child.stat({bigint:true})))fail();sha256=hash.digest('hex');bytes+=count;
        }finally{await child.close();}
      }else if(s.isSymbolicLink()){kind='SYMLINK';target=await readlink(fdPath(parent,name));reasons.add('STATE_SYMLINK_UNCLASSIFIED');}
      else if(s.isSocket()){kind='SOCKET';if(!stoppedSockets.includes(path))reasons.add('STATE_SOCKET_UNCLASSIFIED');}
      else if(s.isFIFO()){kind='FIFO';reasons.add('STATE_SPECIAL_OBJECT');}
      else reasons.add('STATE_SPECIAL_OBJECT');
      if(kind!=='DIRECTORY')entries.push({path,kind,...m,sha256,target});
      if(identity(s)!==identity(await lstat(fdPath(parent,name),{bigint:true})))fail();
    }
    if(identity(before)!==identity(await parent.stat({bigint:true}))||JSON.stringify(names)!==JSON.stringify((await readdir(fdPath(parent))).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))))fail();
  }
  await walk(root);if(identity(rootStat)!==identity(await root.stat({bigint:true})))fail();
  entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));const groups=new Map<string,SnapshotEntry[]>();
  for(const e of entries)if(e.kind==='FILE'){const key=e.dev+':'+e.ino;groups.set(key,[...(groups.get(key)??[]),e]);}
  for(const group of groups.values())if(group.some(e=>e.nlink!==group.length))reasons.add('STATE_EXTERNAL_HARDLINK');
  return {rootMetadata,entries:Object.freeze(entries.map(e=>Object.freeze(e))),bytes,reasonCodes:Object.freeze([...reasons].sort()),treeSHA256:fingerprint(rootMetadata,entries)};
}
export class ReadonlySnapshot{
  readonly rootMetadata:Readonly<SnapshotMetadata>;readonly entries:readonly Readonly<SnapshotEntry>[];readonly bytes:number;readonly reasonCodes:readonly string[];readonly treeSHA256:string;
  private closed=false;
  constructor(readonly scope:Scope,private anchor:Awaited<ReturnType<typeof anchoredRoot>>,private uid:number,private gid:number,private budget:Budget,private stoppedSockets:readonly string[],data:Awaited<ReturnType<typeof inventory>>){
    this.rootMetadata=Object.freeze(data.rootMetadata);this.entries=data.entries;this.bytes=data.bytes;this.reasonCodes=data.reasonCodes;this.treeSHA256=data.treeSHA256;
  }
  async verify(){if(this.closed)fail('STATE_SNAPSHOT_CLOSED');await this.anchor.check();const observed=await inventory(this.anchor.root,this.uid,this.gid,this.budget,this.stoppedSockets);if(observed.treeSHA256!==this.treeSHA256)fail();await this.anchor.check();}
  async read(path:string,maxBytes=this.budget.record_bytes){
    const entry=this.entries.find(e=>e.path===path);if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>this.budget.process_log_bytes||!entry||entry.kind!=='FILE'||entry.size>maxBytes)fail('STATE_READ_LIMIT_OR_MISSING');
    const bytes=await this.readRange(path,0,entry.size);if(digest(bytes)!==entry.sha256)fail();return bytes;
  }
  async readRange(path:string,cursor:number,maxBytes:number){
    if(this.closed)fail('STATE_SNAPSHOT_CLOSED');const parts=pathParts(path),entry=this.entries.find(e=>e.path===path);
    if(!entry||entry.kind!=='FILE'||!Number.isSafeInteger(cursor)||cursor<0||cursor>entry.size||!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>this.budget.process_log_bytes)fail('STATE_READ_LIMIT_OR_MISSING');
    await this.anchor.check();const handles:FileHandle[]=[],directories:Array<{handle:FileHandle;expected:SnapshotMetadata}>=[];let parent=this.anchor.root;
    const metaHash=(m:SnapshotMetadata)=>digest(encodeInstallReport(Object.fromEntries(Object.entries(m).filter(([k])=>k!=='atime_ns'))));
    if(metaHash(metadata(await parent.stat({bigint:true})))!==metaHash(this.rootMetadata))fail();
    try{
      let prefix='';
      for(const name of parts.slice(0,-1)){prefix+=name;const expected=this.entries.find(e=>e.path===prefix);if(expected?.kind!=='DIRECTORY')fail();const child=await open(fdPath(parent,name),directoryFlags);handles.push(child);const m=metadata(await child.stat({bigint:true}));if(metaHash(m)!==metaHash(Object.fromEntries(Object.entries(expected).filter(([k])=>!['path','kind','sha256','target'].includes(k))) as unknown as SnapshotMetadata))fail();directories.push({handle:child,expected:m});parent=child;prefix+='/';}
      const handle=await open(fdPath(parent,parts.at(-1)!),fileFlags);handles.push(handle);const before=await handle.stat({bigint:true});
      const actual=metadata(before),expected=Object.fromEntries(Object.entries(entry).filter(([k])=>!['path','kind','sha256','target','atime_ns'].includes(k)));
      if(!before.isFile()||JSON.stringify(Object.fromEntries(Object.entries(actual).filter(([k])=>k!=='atime_ns')))!==JSON.stringify(expected))fail();
      const output=Buffer.alloc(Math.min(maxBytes,entry.size-cursor));let count=0;
      while(count<output.length){const {bytesRead}=await handle.read(output,count,output.length-count,cursor+count);if(!bytesRead)fail();count+=bytesRead;}
      if(identity(before)!==identity(await handle.stat({bigint:true}))||identity(before)!==identity(await lstat(fdPath(parent,parts.at(-1)!),{bigint:true})))fail();
      for(const dir of directories)if(metaHash(metadata(await dir.handle.stat({bigint:true})))!==metaHash(dir.expected))fail();
      if(metaHash(metadata(await this.anchor.root.stat({bigint:true})))!==metaHash(this.rootMetadata))fail();await this.anchor.check();return output;
    }finally{for(const h of handles.reverse())await h.close();}
  }
  async close(){if(!this.closed){this.closed=true;await this.anchor.close();}}
}
async function openSnapshot(root:string,uid:number,gid:number,budget:Budget,scope:Scope,stoppedSockets:readonly string[]=[]){
  const anchor=await anchoredRoot(root);
  try{const data=await inventory(anchor.root,uid,gid,budget,stoppedSockets);await anchor.check();return new ReadonlySnapshot(scope,anchor,uid,gid,budget,stoppedSockets,data);}catch(error){await anchor.close();throw error;}
}
export async function openFixtureReadonlySnapshot(root:string,uid:number){
  const budget={state_depth:64,state_entries:40000,state_bytes:68719476736,scan_ms:600000,record_bytes:2097152,process_log_bytes:67108864} as Budget;
  if(process.getuid?.()!==uid||process.geteuid?.()!==uid)fail('STATE_FIXTURE_IDENTITY_INVALID');return openSnapshot(root,uid,process.getgid!(),budget,'FIXTURE_AUTHORITY_ONLY');
}
export async function openReadonlySnapshot(profile:InstallProfile,token:SnapshotToken):Promise<ReadonlySnapshot>{
  const p=parseRBridgeInstallProfile(profile);validateInstallContract(token,'SnapshotToken');const u=userInfo();
  if(process.getuid?.()!==p.binding.uid||process.geteuid?.()!==p.binding.uid||process.getgid?.()!==p.binding.gid||u.username!==p.binding.account||u.homedir!==p.binding.home||process.versions.node!==p.runtime.node_version||process.execArgv.length||process.env.NODE_OPTIONS||process.env.NODE_PATH)fail('STATE_QUALIFIED_RUNTIME_REQUIRED');
  const executable=await open('/proc/self/exe',constants.O_RDONLY);let nodeHash:string;
  try{const before=await executable.stat({bigint:true});if(!before.isFile()||before.size>268435456n)fail('STATE_QUALIFIED_RUNTIME_REQUIRED');nodeHash=digest(await executable.readFile());if(identity(before)!==identity(await executable.stat({bigint:true})))fail();}finally{await executable.close();}
  if(nodeHash!==p.runtime.node_sha256)fail('STATE_QUALIFIED_RUNTIME_REQUIRED');
  const toolkitRoot=join(p.paths.release_parent,'toolkit-'+p.toolkit.source_sha);
  if(fileURLToPath(import.meta.url)!==join(toolkitRoot,'dist/server/installation/readonlySnapshot.js'))fail('STATE_QUALIFIED_HELPER_REQUIRED');
  const manifests=await anchoredRoot(p.paths.release_parent);
  try{
    const name='toolkit-'+p.toolkit.source_sha+'.manifest.json',handle=await open(fdPath(manifests.root,name),fileFlags);
    try{
      const before=await handle.stat({bigint:true});
      if(!before.isFile()||before.uid!==0n||before.nlink!==1n||(before.mode&0o6022n)!==0n||before.size>33554432n)fail('STATE_QUALIFIED_HELPER_REQUIRED');
      const manifest=validateArtifactManifest(JSON.parse((await handle.readFile()).toString('utf8')));
      if(identity(before)!==identity(await handle.stat({bigint:true}))||manifest.kind!=='TOOLKIT'||manifest.source_sha!==p.toolkit.source_sha||manifest.tree_sha!==p.toolkit.tree_sha||manifest.sha256!==p.toolkit.manifest_sha256||manifest.node_sha256!==p.runtime.node_sha256)fail('STATE_QUALIFIED_HELPER_REQUIRED');
      await verifyProtectedArtifact(toolkitRoot,manifest,p);await manifests.check();
    }finally{await handle.close();}
  }finally{await manifests.close();}
  const snapshot=await openSnapshot(p.paths.state_root,p.binding.uid,p.binding.gid,p.budget,'QUALIFIED_READONLY_HELPER');
  const root=Object.fromEntries(Object.entries(snapshot.rootMetadata).filter(([k])=>k!=='atime_ns'));
  if(snapshot.treeSHA256!==token.tree_sha256||snapshot.entries.length!==token.entries||snapshot.bytes!==token.bytes||digest(encodeInstallReport(root))!==token.state_root_identity_sha256){await snapshot.close();fail('STATE_SNAPSHOT_TOKEN_MISMATCH');}
  return snapshot;
}
