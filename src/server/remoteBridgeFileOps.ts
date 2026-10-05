import {createHash,randomUUID} from 'node:crypto';
import {constants,type Dirent} from 'node:fs';
import {lstat,open,opendir,realpath,rename,unlink,type FileHandle} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {RemoteBridgeStage2Operation} from '../domain/remoteBridgeStage2Protocol.js';

type FileOperation=Extract<RemoteBridgeStage2Operation,{kind:'FILE'}>;
export interface RemoteBridgeFileOpsConfig{
  allowedRoots:readonly string[];maxReadBytes:number;maxSearchResults:number;
  maxListEntries?:number;maxPaths?:number;maxScanEntries?:number;maxSearchDepth?:number;
}
const SECRET=new Set(['.ssh','.gnupg','.aws','.azure','.config/gcloud','.env','.npmrc','.pypirc','credentials','secrets']);
const PROC_FD='/proc/self/fd';
const READ_FLAGS=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
function fail(code:string):never{throw new Error(code);}
function int(value:unknown,min:number,max:number,fallback:number,code:string){if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)fail(code);return value;}
function text(value:unknown,code:string){if(typeof value!=='string'||value.includes('\0'))fail(code);return value;}
function errno(error:unknown):string|undefined{return error!==null&&typeof error==='object'&&'code' in error&&typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:undefined;}
function lexical(path:string){if(!isAbsolute(path)||path.startsWith('//')||path.includes('\0')||resolve(path)!==path)fail('REMOTE_BRIDGE_FILE_PATH_INVALID');return path;}
function secret(path:string){const parts=path.split('/').filter(Boolean);for(let i=0;i<parts.length;i++){const part=parts[i]!.toLowerCase();if(SECRET.has(part)||SECRET.has(parts.slice(i,i+2).join('/').toLowerCase())||/(^|[._-])(token|secret|credential|id_rsa|id_ed25519)([._-]|$)/i.test(part))fail('REMOTE_BRIDGE_FILE_SECRET_PATH');}}
function typeOf(info:{isFile():boolean;isDirectory():boolean;isSymbolicLink():boolean}){return info.isFile()?'file':info.isDirectory()?'directory':info.isSymbolicLink()?'symlink':'other';}
function sha256(data:Buffer){return createHash('sha256').update(data).digest('hex');}
function binary(value:unknown,expectedSha:unknown){if(typeof value!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('REMOTE_BRIDGE_FILE_BASE64_INVALID');const data=Buffer.from(value,'base64');if(data.toString('base64')!==value)fail('REMOTE_BRIDGE_FILE_BASE64_INVALID');if(typeof expectedSha!=='string'||!/^[0-9a-f]{64}$/.test(expectedSha))fail('REMOTE_BRIDGE_FILE_SHA256_INVALID');if(sha256(data)!==expectedSha)fail('REMOTE_BRIDGE_FILE_SHA256_MISMATCH');return data;}
function inside(root:string,path:string){const rel=relative(root,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));}
function fdPath(handle:FileHandle,name?:string){const base=join(PROC_FD,String(handle.fd));return name===undefined?base:join(base,name);}
function abort(signal?:AbortSignal){if(signal?.aborted)fail('REMOTE_BRIDGE_FILE_ABORTED');}
async function close(handle:FileHandle){await handle.close();}

export function assertRemoteBridgeFileTargetPolicy(target:string,allowedRoots:readonly string[]):{path:string;root:string}{
  const path=lexical(target);secret(path);const root=allowedRoots.find(r=>path===r||path.startsWith(r+sep));
  if(!root)fail('REMOTE_BRIDGE_FILE_ROOT_DENIED');return {path,root};
}

export function createRemoteBridgeFileOps(config:RemoteBridgeFileOpsConfig){
  if(!Array.isArray(config.allowedRoots)||config.allowedRoots.length<1||config.allowedRoots.length>16)fail('REMOTE_BRIDGE_FILE_ROOTS_INVALID');
  const roots=[...new Set(config.allowedRoots.map(root=>lexical(root)))].sort((a,b)=>b.length-a.length);
  const maxRead=int(config.maxReadBytes,1,16*1024*1024,0,'REMOTE_BRIDGE_FILE_READ_LIMIT_INVALID');
  const maxMatches=int(config.maxSearchResults,1,5000,0,'REMOTE_BRIDGE_FILE_SEARCH_LIMIT_INVALID');
  if(!maxRead||!maxMatches)fail('REMOTE_BRIDGE_FILE_LIMIT_INVALID');
  const maxList=int(config.maxListEntries,1,500,500,'REMOTE_BRIDGE_FILE_LIST_LIMIT_INVALID');
  const maxPaths=int(config.maxPaths,1,32,32,'REMOTE_BRIDGE_FILE_READ_MANY_INVALID');
  const maxScan=int(config.maxScanEntries,1,10000,10000,'REMOTE_BRIDGE_FILE_SCAN_LIMIT_INVALID');
  const maxDepth=int(config.maxSearchDepth,1,32,32,'REMOTE_BRIDGE_FILE_DEPTH_LIMIT_INVALID');

  function rootFor(path:string){return assertRemoteBridgeFileTargetPolicy(path,roots);}
  async function verifyHandle(handle:FileHandle,root:string,signal?:AbortSignal){
    abort(signal);const actual=await realpath(fdPath(handle)).catch(()=>fail('REMOTE_BRIDGE_FILE_HANDLE_INVALID'));abort(signal);
    if(!inside(root,actual))fail('REMOTE_BRIDGE_FILE_ROOT_DENIED');secret(actual);return actual;
  }
  async function openChild(parent:FileHandle,name:string,kind?:'file'|'directory',signal?:AbortSignal){
    abort(signal);const path=fdPath(parent,name),pre=await lstat(path);abort(signal);
    if(pre.isSymbolicLink())fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');
    if(kind==='directory'&&!pre.isDirectory())fail('REMOTE_BRIDGE_FILE_NOT_DIRECTORY');
    if(kind==='file'&&!pre.isFile())fail('REMOTE_BRIDGE_FILE_NOT_FILE');
    if(!pre.isFile()&&!pre.isDirectory())fail('REMOTE_BRIDGE_FILE_NOT_FILE');
    let handle:FileHandle;
    try{handle=await open(path,READ_FLAGS|(kind==='directory'?constants.O_DIRECTORY:0));}
    catch(error){if(['ELOOP','ENOTDIR'].includes(errno(error)??''))fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');throw error;}
    try{
      abort(signal);const info=await handle.stat();abort(signal);
      if(kind==='directory'&&!info.isDirectory())fail('REMOTE_BRIDGE_FILE_NOT_DIRECTORY');
      if(kind==='file'&&!info.isFile())fail('REMOTE_BRIDGE_FILE_NOT_FILE');
      if(!info.isFile()&&!info.isDirectory())fail('REMOTE_BRIDGE_FILE_NOT_FILE');
      return {handle,info};
    }catch(error){await close(handle);throw error;}
  }
  async function openRoot(root:string,signal?:AbortSignal){
    abort(signal);let current=await open('/',READ_FLAGS|constants.O_DIRECTORY);
    try{
      for(const part of root.split('/').filter(Boolean)){
        const next=await openChild(current,part,'directory',signal);
        const previous=current;current=next.handle;await close(previous);
      }
      if(await verifyHandle(current,root,signal)!==root)fail('REMOTE_BRIDGE_FILE_ROOT_INVALID');
      return current;
    }catch(error){await close(current);throw error;}
  }
  // Each lookup is relative to its held parent descriptor. A textual precheck alone
  // cannot prevent replacement of an intermediate component between check and open.
  async function openRelative(parent:FileHandle,parts:readonly string[],root:string,kind?:'file'|'directory',signal?:AbortSignal){
    let current=parent,owned=false;
    try{
      for(let i=0;i<parts.length;i++){
        const next=await openChild(current,parts[i]!,i===parts.length-1?kind:'directory',signal);
        try{await verifyHandle(next.handle,root,signal);}catch(error){await close(next.handle);throw error;}
        if(i===parts.length-1)return next;
        const previous=current,wasOwned=owned;current=next.handle;owned=true;if(wasOwned)await close(previous);
      }
      fail('REMOTE_BRIDGE_FILE_PATH_INVALID');
    }finally{if(owned)await close(current);}
  }
  async function openExisting(path:string,kind?:'file'|'directory',signal?:AbortSignal){
    const x=rootFor(path),root=await openRoot(x.root,signal),parts=relative(x.root,x.path).split(sep).filter(Boolean);
    if(!parts.length){
      try{const info=await root.stat();abort(signal);if(kind==='file')fail('REMOTE_BRIDGE_FILE_NOT_FILE');return {...x,handle:root,info};}
      catch(error){await close(root);throw error;}
    }
    try{return {...x,...await openRelative(root,parts,x.root,kind,signal)};}finally{await close(root);}
  }
  async function openParent(path:string){
    const x=rootFor(path),opened=await openExisting(dirname(x.path),'directory');
    try{
      const name=basename(x.path),child=fdPath(opened.handle,name);
      try{const info=await lstat(child);if(info.isSymbolicLink())fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');}catch(error){if(errno(error)!=='ENOENT')throw error;}
      return {...x,handle:opened.handle,name,child};
    }catch(error){await close(opened.handle);throw error;}
  }
  async function readBounded(handle:FileHandle,root:string,cap:number,signal?:AbortSignal){
    abort(signal);const before=await handle.stat();abort(signal);
    if(!before.isFile())fail('REMOTE_BRIDGE_FILE_NOT_FILE');if(before.size>cap)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');
    const pieces:Buffer[]=[];let bytes=0;
    while(true){
      abort(signal);const buffer=Buffer.alloc(Math.min(65536,cap+1-bytes));
      const {bytesRead}=await handle.read(buffer,0,buffer.length,null);abort(signal);
      if(!bytesRead)break;bytes+=bytesRead;if(bytes>cap)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');pieces.push(buffer.subarray(0,bytesRead));
    }
    await verifyHandle(handle,root,signal);return Buffer.concat(pieces,bytes);
  }
  async function readBinary(path:string,signal?:AbortSignal){
    const opened=await openExisting(path,'file',signal);
    try{return await readBounded(opened.handle,opened.root,maxRead,signal);}finally{await close(opened.handle);}
  }
  async function readText(path:string,signal?:AbortSignal){const data=await readBinary(path,signal);if(data.includes(0))fail('REMOTE_BRIDGE_FILE_BINARY_REQUIRES_CHUNK');return data.toString('utf8');}
  async function atomicWriteBytes(path:string,data:Buffer){
    if(data.byteLength>maxRead)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');const parent=await openParent(path);
    const tempName=`.remote-bridge-${randomUUID()}.tmp`,temp=fdPath(parent.handle,tempName);let handle:FileHandle|undefined;
    try{handle=await open(temp,'wx',0o600);await handle.writeFile(data);await handle.sync();await close(handle);handle=undefined;await rename(temp,parent.child);await parent.handle.sync();}
    finally{if(handle)await close(handle);await unlink(temp).catch(()=>undefined);await close(parent.handle);}
  }
  async function atomicWrite(path:string,value:string){await atomicWriteBytes(path,Buffer.from(value));}
  async function eachEntry(handle:FileHandle,signal:AbortSignal|undefined,visit:(entry:Dirent)=>Promise<void>){
    abort(signal);const directory=await opendir(fdPath(handle),{bufferSize:32});
    try{abort(signal);for await(const entry of directory){abort(signal);await visit(entry);abort(signal);}}
    finally{await directory.close().catch(error=>{if(errno(error)!=='ERR_DIR_CLOSED')throw error;});}
  }
  function keepSorted<T>(rows:T[],row:T,max:number,key:(value:T)=>string){rows.push(row);rows.sort((a,b)=>key(a).localeCompare(key(b)));if(rows.length>max)rows.pop();}
  async function list(target:string,max:number,signal?:AbortSignal){
    const opened=await openExisting(target,'directory',signal),rows:{name:string;type:string}[]=[];let scanned=0;
    try{await eachEntry(opened.handle,signal,async entry=>{if(++scanned>maxScan)fail('REMOTE_BRIDGE_FILE_LIST_SCAN_LIMIT');keepSorted(rows,{name:entry.name,type:typeOf(entry)},max,row=>row.name);});await verifyHandle(opened.handle,opened.root,signal);return {path:target,entries:rows};}
    finally{await close(opened.handle);}
  }
  async function searchDirectory(target:string,query:string,signal?:AbortSignal){
    const rootDir=await openExisting(target,'directory',signal),matches:{path:string}[]=[];let visited=0;
    async function walk(handle:FileHandle,display:string,root:string,depth:number):Promise<void>{
      await eachEntry(handle,signal,async entry=>{
        if(++visited>maxScan)fail('REMOTE_BRIDGE_FILE_SEARCH_SCAN_LIMIT');
        const path=join(display,entry.name);try{secret(path);}catch{return;}
        if(entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))return;
        if(entry.isDirectory()&&depth>=maxDepth)return;
        let child:FileHandle|undefined;
        try{
          const opened=await openChild(handle,entry.name,entry.isDirectory()?'directory':'file',signal);child=opened.handle;await verifyHandle(child,root,signal);
          if(opened.info.isDirectory())await walk(child,path,root,depth+1);
          else{
            const data=await readBounded(child,root,maxRead,signal);
            if(!data.includes(0)&&data.toString('utf8').includes(query))keepSorted(matches,{path},maxMatches+1,row=>row.path);
          }
        }catch(error){
          const code=error instanceof Error?error.message:'';
          if(!['ENOENT','ELOOP','ENOTDIR'].includes(errno(error)??'')&&!['REMOTE_BRIDGE_FILE_TOO_LARGE','REMOTE_BRIDGE_FILE_NOT_FILE','REMOTE_BRIDGE_FILE_NOT_DIRECTORY','REMOTE_BRIDGE_FILE_SYMLINK_DENIED'].includes(code))throw error;
        }finally{if(child)await close(child);}
      });
      await verifyHandle(handle,root,signal);
    }
    try{await walk(rootDir.handle,target,rootDir.root,0);return {matches:matches.slice(0,maxMatches),truncated:matches.length>maxMatches};}
    finally{await close(rootDir.handle);}
  }
  async function executeBody(operation:FileOperation,options:{signal?:AbortSignal}={}):Promise<unknown>{
    const {signal}=options;abort(signal);const {action,target,args}=operation;
    if(action==='LIST')return list(target,int(args.maxEntries,1,maxList,maxList,'REMOTE_BRIDGE_FILE_LIST_LIMIT_INVALID'),signal);
    if(action==='STAT'){const opened=await openExisting(target,undefined,signal);try{abort(signal);return {path:target,type:typeOf(opened.info),size:opened.info.size,mtimeMs:Math.trunc(opened.info.mtimeMs)};}finally{await close(opened.handle);}}
    if(action==='READ')return {path:target,text:await readText(target,signal)};
    if(action==='READ_BINARY'){const data=await readBinary(target,signal);return {path:target,dataBase64:data.toString('base64'),bytes:data.byteLength,sha256:sha256(data)};}
    if(action==='READ_MANY'){
      const opened=await openExisting(target,'directory',signal);
      try{
        if(!Array.isArray(args.paths)||args.paths.length<1||args.paths.length>maxPaths)fail('REMOTE_BRIDGE_FILE_READ_MANY_INVALID');
        const files=[];let totalBytes=0;
        for(const item of args.paths){
          abort(signal);if(typeof item!=='string'||isAbsolute(item)||item.includes('\0')||item.includes('\\')||item.split('/').some(x=>!x||x==='.'||x==='..'))fail('REMOTE_BRIDGE_FILE_PATH_INVALID');
          const path=join(target,item);secret(path);const child=await openRelative(opened.handle,item.split('/'),opened.root,'file',signal);
          try{const data=await readBounded(child.handle,opened.root,maxRead-totalBytes,signal);if(data.includes(0))fail('REMOTE_BRIDGE_FILE_BINARY_REQUIRES_CHUNK');totalBytes+=data.byteLength;files.push({path,text:data.toString('utf8')});}
          finally{await close(child.handle);}
        }
        return {files};
      }finally{await close(opened.handle);}
    }
    if(action==='WRITE_TEXT'){await atomicWrite(target,text(args.text,'REMOTE_BRIDGE_FILE_TEXT_INVALID'));return {path:target,written:true};}
    if(action==='WRITE_BINARY'){const data=binary(args.dataBase64,args.sha256);await atomicWriteBytes(target,data);return {path:target,written:true,bytes:data.byteLength,sha256:sha256(data)};}
    if(action==='APPEND_TEXT'){const extra=text(args.text,'REMOTE_BRIDGE_FILE_TEXT_INVALID');let current='';try{current=await readText(target,signal);}catch(error){if(errno(error)!=='ENOENT')throw error;}await atomicWrite(target,current+extra);return {path:target,appended:true};}
    if(action==='EDIT_EXACT'){const oldText=text(args.oldText,'REMOTE_BRIDGE_FILE_EDIT_INVALID'),newText=text(args.newText,'REMOTE_BRIDGE_FILE_EDIT_INVALID');if(!oldText)fail('REMOTE_BRIDGE_FILE_EDIT_INVALID');const expected=int(args.expectedReplacements,1,10000,1,'REMOTE_BRIDGE_FILE_EDIT_INVALID');const current=await readText(target,signal),count=current.split(oldText).length-1;if(count!==expected)fail('REMOTE_BRIDGE_FILE_REPLACEMENT_COUNT_MISMATCH');await atomicWrite(target,current.split(oldText).join(newText));return {path:target,replacements:count};}
    if(action==='MOVE'){
      const source=await openParent(target);let dest:Awaited<ReturnType<typeof openParent>>|undefined;
      try{const destination=text(args.destination,'REMOTE_BRIDGE_FILE_MOVE_INVALID');dest=await openParent(destination);if(source.root!==dest.root)fail('REMOTE_BRIDGE_FILE_CROSS_ROOT_MOVE');const info=await lstat(source.child);if(info.isSymbolicLink())fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');await rename(source.child,dest.child);await source.handle.sync();if(source.handle.fd!==dest.handle.fd)await dest.handle.sync();return {from:target,to:destination};}
      finally{await close(source.handle);if(dest)await close(dest.handle);}
    }
    if(action==='SEARCH'){const query=text(args.query,'REMOTE_BRIDGE_FILE_SEARCH_INVALID');if(!query||Buffer.byteLength(query)>4096)fail('REMOTE_BRIDGE_FILE_SEARCH_INVALID');return searchDirectory(target,query,signal);}
    fail('REMOTE_BRIDGE_FILE_ACTION_INVALID');
  }
  return {async execute(operation:FileOperation,options:{signal?:AbortSignal}={}){const output=await executeBody(operation,options);abort(options.signal);return output;}};
}
