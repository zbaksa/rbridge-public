import {randomUUID} from 'node:crypto';
import {lstat,open,readdir,readFile,realpath,rename,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {RemoteBridgeStage2Operation} from '../domain/remoteBridgeStage2Protocol.js';

type FileOperation=Extract<RemoteBridgeStage2Operation,{kind:'FILE'}>;
export interface RemoteBridgeFileOpsConfig{allowedRoots:readonly string[];maxReadBytes:number;maxSearchResults:number;}
const SECRET=new Set(['.ssh','.gnupg','.aws','.azure','.config/gcloud','.env','.npmrc','.pypirc','credentials','secrets']);

function fail(code:string):never{throw new Error(code);}
function int(value:unknown,min:number,max:number,fallback:number,code:string){if(value===undefined)return fallback;if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)fail(code);return value;}
function text(value:unknown,code:string){if(typeof value!=='string'||value.includes('\0'))fail(code);return value;}
function errno(error:unknown):string|undefined{return error!==null&&typeof error==='object'&&'code' in error&&typeof (error as {code?:unknown}).code==='string'?(error as {code:string}).code:undefined;}
function lexical(path:string){if(!isAbsolute(path)||path.startsWith('//')||path.includes('\0')||resolve(path)!==path)fail('REMOTE_BRIDGE_FILE_PATH_INVALID');return path;}
function secret(path:string){const parts=path.split('/').filter(Boolean);for(let i=0;i<parts.length;i++){const part=parts[i]!.toLowerCase();if(SECRET.has(part)||SECRET.has(parts.slice(i,i+2).join('/').toLowerCase())||/(^|[._-])(token|secret|credential|id_rsa|id_ed25519)([._-]|$)/i.test(part))fail('REMOTE_BRIDGE_FILE_SECRET_PATH');}}
function typeOf(info:{isFile():boolean;isDirectory():boolean;isSymbolicLink():boolean}){return info.isFile()?'file':info.isDirectory()?'directory':info.isSymbolicLink()?'symlink':'other';}

export function createRemoteBridgeFileOps(config:RemoteBridgeFileOpsConfig){
  if(!Array.isArray(config.allowedRoots)||config.allowedRoots.length<1||config.allowedRoots.length>16)fail('REMOTE_BRIDGE_FILE_ROOTS_INVALID');
  const roots=[...new Set(config.allowedRoots.map(root=>lexical(root)))].sort((a,b)=>b.length-a.length);
  if(!Number.isInteger(config.maxReadBytes)||config.maxReadBytes<1||config.maxReadBytes>16*1024*1024)fail('REMOTE_BRIDGE_FILE_READ_LIMIT_INVALID');
  if(!Number.isInteger(config.maxSearchResults)||config.maxSearchResults<1||config.maxSearchResults>5000)fail('REMOTE_BRIDGE_FILE_SEARCH_LIMIT_INVALID');

  function rootFor(path:string){const p=lexical(path);secret(p);const root=roots.find(r=>p===r||p.startsWith(r+sep));if(!root)fail('REMOTE_BRIDGE_FILE_ROOT_DENIED');return {path:p,root};}
  async function verifyRoot(root:string){const info=await lstat(root).catch(()=>fail('REMOTE_BRIDGE_FILE_ROOT_INVALID'));if(info.isSymbolicLink()||!info.isDirectory())fail('REMOTE_BRIDGE_FILE_ROOT_INVALID');if(await realpath(root)!==root)fail('REMOTE_BRIDGE_FILE_ROOT_INVALID');}
  async function noSymlinks(path:string,root:string,finalMayMissing=false){await verifyRoot(root);const rel=relative(root,path);if(rel.startsWith('..')||isAbsolute(rel))fail('REMOTE_BRIDGE_FILE_ROOT_DENIED');let current=root;const parts=rel?rel.split(sep):[];for(let i=0;i<parts.length;i++){current=join(current,parts[i]!);try{const info=await lstat(current);if(info.isSymbolicLink())fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');}catch(error){if(errno(error)==='ENOENT'&&finalMayMissing&&i===parts.length-1)return;throw error;}}}
  async function safeExisting(path:string,kind?:'file'|'directory'){const x=rootFor(path);await noSymlinks(x.path,x.root);const info=await lstat(x.path);if(kind==='file'&&!info.isFile())fail('REMOTE_BRIDGE_FILE_NOT_FILE');if(kind==='directory'&&!info.isDirectory())fail('REMOTE_BRIDGE_FILE_NOT_DIRECTORY');return {...x,info};}
  async function safeDestination(path:string){const x=rootFor(path);await noSymlinks(dirname(x.path),x.root);try{const info=await lstat(x.path);if(info.isSymbolicLink())fail('REMOTE_BRIDGE_FILE_SYMLINK_DENIED');}catch(error){if(errno(error)!=='ENOENT')throw error;}return x;}
  async function readText(path:string){await safeExisting(path,'file');const info=await lstat(path);if(info.size>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');const data=await readFile(path);if(data.byteLength>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');if(data.includes(0))fail('REMOTE_BRIDGE_FILE_BINARY_REQUIRES_CHUNK');return data.toString('utf8');}
  async function atomicWrite(path:string,value:string){const data=Buffer.from(value);if(data.byteLength>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');const dest=await safeDestination(path);const temp=join(dirname(dest.path),`.remote-bridge-${randomUUID()}.tmp`);let handle;try{handle=await open(temp,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=undefined;await rename(temp,dest.path);}finally{if(handle)await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});}}

  async function execute(operation:FileOperation):Promise<unknown>{
    const {action,target,args}=operation;
    if(action==='LIST'){const {path}=await safeExisting(target,'directory');const max=int(args.maxEntries,1,500,500,'REMOTE_BRIDGE_FILE_LIST_LIMIT_INVALID');const rows=(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,max);return {path,entries:rows.map(row=>({name:row.name,type:typeOf(row)}))};}
    if(action==='STAT'){const {path,info}=await safeExisting(target);return {path,type:typeOf(info),size:info.size,mtimeMs:Math.trunc(info.mtimeMs)};}
    if(action==='READ')return {path:target,text:await readText(target)};
    if(action==='READ_MANY'){await safeExisting(target,'directory');if(!Array.isArray(args.paths)||args.paths.length<1||args.paths.length>32)fail('REMOTE_BRIDGE_FILE_READ_MANY_INVALID');const files=[];let totalBytes=0;for(const item of args.paths){if(typeof item!=='string'||isAbsolute(item)||item.includes('\0')||item.split(/[\\/]/).some(x=>!x||x==='.'||x==='..'))fail('REMOTE_BRIDGE_FILE_PATH_INVALID');const path=join(target,item),value=await readText(path);totalBytes+=Buffer.byteLength(value);if(totalBytes>config.maxReadBytes)fail('REMOTE_BRIDGE_FILE_TOO_LARGE');files.push({path,text:value});}return {files};}
    if(action==='WRITE_TEXT'){await atomicWrite(target,text(args.text,'REMOTE_BRIDGE_FILE_TEXT_INVALID'));return {path:target,written:true};}
    if(action==='APPEND_TEXT'){const extra=text(args.text,'REMOTE_BRIDGE_FILE_TEXT_INVALID');let current='';try{current=await readText(target);}catch(error){if(errno(error)!=='ENOENT')throw error;}await atomicWrite(target,current+extra);return {path:target,appended:true};}
    if(action==='EDIT_EXACT'){const oldText=text(args.oldText,'REMOTE_BRIDGE_FILE_EDIT_INVALID'),newText=text(args.newText,'REMOTE_BRIDGE_FILE_EDIT_INVALID');if(!oldText)fail('REMOTE_BRIDGE_FILE_EDIT_INVALID');const expected=int(args.expectedReplacements,1,10000,1,'REMOTE_BRIDGE_FILE_EDIT_INVALID');const current=await readText(target),count=current.split(oldText).length-1;if(count!==expected)fail('REMOTE_BRIDGE_FILE_REPLACEMENT_COUNT_MISMATCH');await atomicWrite(target,current.split(oldText).join(newText));return {path:target,replacements:count};}
    if(action==='MOVE'){const source=await safeExisting(target),destination=text(args.destination,'REMOTE_BRIDGE_FILE_MOVE_INVALID'),dest=await safeDestination(destination);if(source.root!==dest.root)fail('REMOTE_BRIDGE_FILE_CROSS_ROOT_MOVE');await rename(source.path,dest.path);return {from:source.path,to:dest.path};}
    if(action==='SEARCH'){const {path}=await safeExisting(target,'directory');const query=text(args.query,'REMOTE_BRIDGE_FILE_SEARCH_INVALID');if(!query||Buffer.byteLength(query)>4096)fail('REMOTE_BRIDGE_FILE_SEARCH_INVALID');const matches:{path:string}[]=[];let visited=0;const walk=async(dir:string,depth:number):Promise<void>=>{if(depth>32||matches.length>config.maxSearchResults)return;for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(++visited>10000)fail('REMOTE_BRIDGE_FILE_SEARCH_SCAN_LIMIT');const path=join(dir,entry.name);try{secret(path);}catch{continue;}if(entry.isSymbolicLink())continue;if(entry.isDirectory()){await walk(path,depth+1);if(matches.length>config.maxSearchResults)return;}else if(entry.isFile()){const info=await lstat(path);if(info.size>config.maxReadBytes)continue;const data=await readFile(path);if(!data.includes(0)&&data.toString('utf8').includes(query))matches.push({path});if(matches.length>config.maxSearchResults)return;}}};await walk(path,0);return {matches:matches.slice(0,config.maxSearchResults),truncated:matches.length>config.maxSearchResults};}
    fail('REMOTE_BRIDGE_FILE_ACTION_INVALID');
  }
  return {execute};
}
