import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readdir,realpath,rename,unlink,type FileHandle} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {RemoteBridgeStage2Operation} from '../domain/remoteBridgeStage2Protocol.js';

type FileOperation=Extract<RemoteBridgeStage2Operation,{kind:'FILE'}>;
export interface RemoteBridgeFileOpsConfig{allowedRoots:readonly string[];maxReadBytes:number;maxSearchResults:number;}
const SECRET=new Set(['.ssh','.gnupg','.aws','.azure','.config/gcloud','.env','.npmrc','.pypirc','credentials','secrets']);
const PROC_FD='/proc/self/fd';

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

export function createRemoteBridgeFileOps(config:RemoteBridgeFileOpsConfig){
  if(!Array.isArray(config.allowedRoots)||config.allowedRoots.length<1||config.allowedRoots.length>16)fail('REMOTE_BRIDGE_FILE_ROOTS_INVALID');
  const roots=[...new Set(config.allowedRoots.map(root=>lexical(root)))].sort((a,b)=>b.length-a.length);
  if(!Number.isInteger(config.maxReadBytes)||config.maxReadBytes<1||config.maxReadBytes>16*1024*1024)fail('REMOTE_BRIDGE_FILE_READ_LIMIT_INVALID');
  if(!Number.isInteger(config.maxSearchResults)||config.maxSearchResults<1||config.maxSearchResults>5000)fail('REMOTE_BRIDGE_FILE_SEARCH_LIMIT_INVALID');

  function rootFor(path:string){const p=lexical(path);secret(p);const root=roots.find(r=>p===r||p.startsWith(r+sep));if(!root)fail('REMOTE_BRIDGE_FILE_ROOT_DENIED');return {path:p,root};}
  async function verifyRoot(root:string){const info=await lstat(root).catch(()=>fail('REMOTE_BRIDGE_FILE_ROOT_INVALID'));if(info.isSymbolicLink()||!info.isDirectory())fail('REMOTE_BRIDGE_FILE_ROOT_INVALID');if(await realpath(root)!==root)fail('REMOTE_BRIDGE_FILE_ROOT_INVALID');}
  async function noSymlinks(path:string,root:string,finalMayMissing=false){await verifyRoot(root);const rel=relative(root,path);if(rel.startsWith('..')||isAbsolute(rel))fail('REMOTE_BRIDGE_FILE_ROOT_DENIED');let current=root;const parts=rel?rel.split(sep):[];for(let i=0;i<parts.length;i++){current=join(current,parts[i]!);try{const info=await lstat(current);if(info.isSymbolicLink())fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');}catch(error){if(errno(error)==='ENOENT'&&finalMayMissing&&i===parts.length-1)return;throw error;}}}
  async function verifyHandle(handle:FileHandle,root:string){const actual=await realpath(fdPath(handle)).catch(()=>fail('REMOTE_BRIDGE_FILE_HANDLE_INVALID'));if(!inside(root,actual))fail('REMOTE_BRIDGE_FILE_ROOT_DENIED');secret(actual);return actual;}
  async function openExisting(path:string,kind?:'file'|'directory'){const x=rootFor(path);await noSymlinks(x.path,x.root);const pre=await lstat(x.path);if(pre.isSymbolicLink())fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');if(kind==='file'&&!pre.isFile())fail('REMOTE_BRIDGE_FILE_NOT_FILE');if(kind==='directory'&&!pre.isDirectory())fail('REMOTE_BRIDGE_FILE_NOT_DIRECTORY');let handle:FileHandle;try{handle=await open(x.path,constants.O_RDONLY|constants.O_NOFOLLOW|(kind==='directory'?constants.O_DIRECTORY:0));}catch(error){if(errno(error)==='ELOOP')fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');throw error;}try{await verifyHandle(handle,x.root);const info=await handle.stat();if(kind==='file'&&!info.isFile())fail('REMOTE_BRIDGE_FILE_NOT_FILE');if(kind==='directory'&&!info.isDirectory())fail('REMOTE_BRIDGE_FILE_NOT_DIRECTORY');return {...x,handle,info};}catch(error){await handle.close().catch(()=>undefined);throw error;}}
  async function openParent(path:string){const x=rootFor(path),parent=dirname(x.path);await noSymlinks(parent,x.root);let handle:FileHandle;try{handle=await open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}catch(error){if(errno(error)==='ELOOP')fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');throw error;}try{await verifyHandle(handle,x.root);const name=basename(x.path);const child=fdPath(handle,name);try{const info=await lstat(child);if(info.isSymbolicLink())fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');}catch(error){if(errno(error)!=='ENOENT')throw error;}return {...x,handle,name,child};}catch(error){await handle.close().catch(()=>undefined);throw error;}}
  async function readText(path:string){const opened=await openExisting(path,'file');try{if(opened.info.size>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');const data=await opened.handle.readFile();if(data.byteLength>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');if(data.includes(0))fail('REMOTE_BRIDGE_FILE_BINARY_REQUIRES_CHUNK');return data.toString('utf8');}finally{await opened.handle.close().catch(()=>undefined);}}
  async function readBinary(path:string){const opened=await openExisting(path,'file');try{if(opened.info.size>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');const data=await opened.handle.readFile();if(data.byteLength>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');return data;}finally{await opened.handle.close().catch(()=>undefined);}}
  async function atomicWriteBytes(path:string,data:Buffer){if(data.byteLength>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');const parent=await openParent(path);const tempName=`.remote-bridge-${randomUUID()}.tmp`,temp=fdPath(parent.handle,tempName);let handle:FileHandle|undefined;try{handle=await open(temp,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=undefined;await rename(temp,parent.child);await parent.handle.sync();}finally{if(handle)await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});await parent.handle.close().catch(()=>undefined);}}
  async function atomicWrite(path:string,value:string){await atomicWriteBytes(path,Buffer.from(value));}

  async function searchDirectory(target:string,query:string){
    const rootDir=await openExisting(target,'directory');const matches:{path:string}[]=[];let visited=0;
    async function walk(handle:FileHandle,display:string,root:string,depth:number):Promise<void>{
      if(depth>32||matches.length>config.maxSearchResults)return;
      const entries=(await readdir(fdPath(handle),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
      for(const entry of entries){
        if(++visited>10000)fail('REMOTE_BRIDGE_FILE_SEARCH_SCAN_LIMIT');
        const displayPath=join(display,entry.name);try{secret(displayPath);}catch{continue;}
        if(entry.isSymbolicLink())continue;
        const childPath=fdPath(handle,entry.name);
        if(entry.isDirectory()){
          let child:FileHandle|undefined;
          try{child=await open(childPath,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);await verifyHandle(child,root);const info=await child.stat();if(!info.isDirectory())continue;await walk(child,displayPath,root,depth+1);}catch(error){if(!['ENOENT','ELOOP','ENOTDIR'].includes(errno(error)??''))throw error;}finally{await child?.close().catch(()=>undefined);}
          if(matches.length>config.maxSearchResults)return;
        }else if(entry.isFile()){
          let child:FileHandle|undefined;
          try{child=await open(childPath,constants.O_RDONLY|constants.O_NOFOLLOW);await verifyHandle(child,root);const info=await child.stat();if(!info.isFile()||info.size>config.maxReadBytes)continue;const data=await child.readFile();if(data.byteLength<=config.maxReadBytes&&!data.includes(0)&&data.toString('utf8').includes(query))matches.push({path:displayPath});}catch(error){if(!['ENOENT','ELOOP'].includes(errno(error)??''))throw error;}finally{await child?.close().catch(()=>undefined);}
          if(matches.length>config.maxSearchResults)return;
        }
      }
    }
    try{await walk(rootDir.handle,target,rootDir.root,0);}finally{await rootDir.handle.close().catch(()=>undefined);}
    return {matches:matches.slice(0,config.maxSearchResults),truncated:matches.length>config.maxSearchResults};
  }

  async function execute(operation:FileOperation):Promise<unknown>{
    const {action,target,args}=operation;
    if(action==='LIST'){const opened=await openExisting(target,'directory');try{const max=int(args.maxEntries,1,500,500,'REMOTE_BRIDGE_FILE_LIST_LIMIT_INVALID');const rows=(await readdir(fdPath(opened.handle),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,max);return {path:target,entries:rows.map(row=>({name:row.name,type:typeOf(row)}))};}finally{await opened.handle.close().catch(()=>undefined);}}
    if(action==='STAT'){const opened=await openExisting(target);try{return {path:target,type:typeOf(opened.info),size:opened.info.size,mtimeMs:Math.trunc(opened.info.mtimeMs)};}finally{await opened.handle.close().catch(()=>undefined);}}
    if(action==='READ')return {path:target,text:await readText(target)};
    if(action==='READ_BINARY'){const data=await readBinary(target);return {path:target,dataBase64:data.toString('base64'),bytes:data.byteLength,sha256:sha256(data)};}
    if(action==='READ_MANY'){const opened=await openExisting(target,'directory');try{if(!Array.isArray(args.paths)||args.paths.length<1||args.paths.length>32)fail('REMOTE_BRIDGE_FILE_READ_MANY_INVALID');const files=[];let totalBytes=0;for(const item of args.paths){if(typeof item!=='string'||isAbsolute(item)||item.includes('\0')||item.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'))fail('REMOTE_BRIDGE_FILE_PATH_INVALID');const displayPath=join(target,item);secret(displayPath);let child:FileHandle;try{child=await open(fdPath(opened.handle,item),constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if(errno(error)==='ELOOP')fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');throw error;}try{await verifyHandle(child,opened.root);const info=await child.stat();if(!info.isFile())fail('REMOTE_BRIDGE_FILE_NOT_FILE');if(info.size>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');const data=await child.readFile();if(data.includes(0))fail('REMOTE_BRIDGE_FILE_BINARY_REQUIRES_CHUNK');totalBytes+=data.byteLength;if(totalBytes>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');files.push({path:displayPath,text:data.toString('utf8')});}finally{await child.close().catch(()=>undefined);}}return {files};}finally{await opened.handle.close().catch(()=>undefined);}}
    if(action==='WRITE_TEXT'){await atomicWrite(target,text(args.text,'REMOTE_BRIDGE_FILE_TEXT_INVALID'));return {path:target,written:true};}
    if(action==='WRITE_BINARY'){const data=binary(args.dataBase64,args.sha256);await atomicWriteBytes(target,data);return {path:target,written:true,bytes:data.byteLength,sha256:sha256(data)};}
    if(action==='APPEND_TEXT'){const extra=text(args.text,'REMOTE_BRIDGE_FILE_TEXT_INVALID');let current='';try{current=await readText(target);}catch(error){if(errno(error)!=='ENOENT')throw error;}await atomicWrite(target,current+extra);return {path:target,appended:true};}
    if(action==='EDIT_EXACT'){const oldText=text(args.oldText,'REMOTE_BRIDGE_FILE_EDIT_INVALID'),newText=text(args.newText,'REMOTE_BRIDGE_FILE_EDIT_INVALID');if(!oldText)fail('REMOTE_BRIDGE_FILE_EDIT_INVALID');const expected=int(args.expectedReplacements,1,10000,1,'REMOTE_BRIDGE_FILE_EDIT_INVALID');const current=await readText(target),count=current.split(oldText).length-1;if(count!==expected)fail('REMOTE_BRIDGE_FILE_REPLACEMENT_COUNT_MISMATCH');await atomicWrite(target,current.split(oldText).join(newText));return {path:target,replacements:count};}
    if(action==='MOVE'){const source=await openParent(target),destination=text(args.destination,'REMOTE_BRIDGE_FILE_MOVE_INVALID'),dest=await openParent(destination);try{if(source.root!==dest.root)fail('REMOTE_BRIDGE_FILE_CROSS_ROOT_MOVE');let sourceInfo;try{sourceInfo=await lstat(source.child);}catch(error){throw error;}if(sourceInfo.isSymbolicLink())fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');await rename(source.child,dest.child);await source.handle.sync();if(source.handle.fd!==dest.handle.fd)await dest.handle.sync();return {from:target,to:destination};}finally{await source.handle.close().catch(()=>undefined);await dest.handle.close().catch(()=>undefined);}}
    if(action==='SEARCH'){const query=text(args.query,'REMOTE_BRIDGE_FILE_SEARCH_INVALID');if(!query||Buffer.byteLength(query)>4096)fail('REMOTE_BRIDGE_FILE_SEARCH_INVALID');return await searchDirectory(target,query);}
    fail('REMOTE_BRIDGE_FILE_ACTION_INVALID');
  }
  return {execute};
}
