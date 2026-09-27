import {createHash,randomBytes} from 'node:crypto';
import {chmod,lstat,mkdir,open,readFile,readdir,rename,rm} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

export interface RemoteBridgeChunkStoreConfig {root:string;now?:()=>Date;maxChunkBytes?:number;maxTransferBytes?:number;maxChunks?:number;}
export interface RemoteBridgeChunkInput {transferId:string;index:number;count:number;dataBase64:string;chunkSha256:string;objectSha256:string;expiresAt:string;}
interface ChunkMeta {index:number;sha256:string;size:number;}
interface TransferManifest {schema:'COCWIN_REMOTE_BRIDGE_TRANSFER_V1';transferId:string;count:number;objectSha256:string;expiresAt:string;createdAt:string;updatedAt:string;phase:'OPEN'|'COMPLETE';chunks:ChunkMeta[];totalBytes?:number;}

const ID_RE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SHA_RE=/^[0-9a-f]{64}$/;
const B64_RE=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const sha=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
function fail(code:string):never{throw new Error(code);}
function isErrno(error:unknown,code:string){return (error as NodeJS.ErrnoException)?.code===code;}
function canonicalIso(value:string,code:string){const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)fail(code);return ms;}
function validRoot(value:string){if(typeof value!=='string'||!isAbsolute(value)||value.startsWith('//')||value.includes('\0')||value.split('/').some((part,index)=>index>0&&(part===''||part==='.'||part==='..')))fail('REMOTE_BRIDGE_CHUNK_CONFIG_INVALID');return value;}
function decodeBase64(value:string){if(typeof value!=='string'||value.length%4!==0||!B64_RE.test(value))fail('REMOTE_BRIDGE_CHUNK_BASE64_INVALID');const data=Buffer.from(value,'base64');if(data.toString('base64')!==value)fail('REMOTE_BRIDGE_CHUNK_BASE64_INVALID');return data;}
function validateManifest(value:unknown,maxChunks:number,maxChunkBytes:number,maxTransferBytes:number):TransferManifest{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT');
  const row=value as Record<string,unknown>;
  if(row.schema!=='COCWIN_REMOTE_BRIDGE_TRANSFER_V1'||typeof row.transferId!=='string'||!ID_RE.test(row.transferId)||!Number.isSafeInteger(row.count)||Number(row.count)<1||Number(row.count)>maxChunks||typeof row.objectSha256!=='string'||!SHA_RE.test(row.objectSha256)||typeof row.expiresAt!=='string'||typeof row.createdAt!=='string'||typeof row.updatedAt!=='string'||!['OPEN','COMPLETE'].includes(String(row.phase))||!Array.isArray(row.chunks))fail('REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT');
  canonicalIso(row.expiresAt,'REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT');canonicalIso(row.createdAt,'REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT');canonicalIso(row.updatedAt,'REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT');
  const seen=new Set<number>();let total=0;
  for(const item of row.chunks){if(!item||typeof item!=='object'||Array.isArray(item))fail('REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT');const chunk=item as Record<string,unknown>;if(!Number.isSafeInteger(chunk.index)||Number(chunk.index)<0||Number(chunk.index)>=Number(row.count)||seen.has(Number(chunk.index))||typeof chunk.sha256!=='string'||!SHA_RE.test(chunk.sha256)||!Number.isSafeInteger(chunk.size)||Number(chunk.size)<0||Number(chunk.size)>maxChunkBytes)fail('REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT');seen.add(Number(chunk.index));total+=Number(chunk.size);}
  if(total>maxTransferBytes)fail('REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT');
  if(row.phase==='COMPLETE'&&(!Number.isSafeInteger(row.totalBytes)||Number(row.totalBytes)!==total||row.chunks.length!==Number(row.count)))fail('REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT');
  return row as unknown as TransferManifest;
}

export function createRemoteBridgeChunkStore(config:RemoteBridgeChunkStoreConfig){
  const root=validRoot(config?.root),now=config.now??(()=>new Date()),maxChunkBytes=config.maxChunkBytes??40_000,maxTransferBytes=config.maxTransferBytes??8_000_000,maxChunks=config.maxChunks??256;
  if(!Number.isSafeInteger(maxChunkBytes)||maxChunkBytes<1024||maxChunkBytes>1_000_000||!Number.isSafeInteger(maxTransferBytes)||maxTransferBytes<maxChunkBytes||maxTransferBytes>64_000_000||!Number.isSafeInteger(maxChunks)||maxChunks<1||maxChunks>4096)fail('REMOTE_BRIDGE_CHUNK_CONFIG_INVALID');
  const dirFor=(id:string)=>join(root,sha(Buffer.from(id)));
  const manifestFor=(id:string)=>join(dirFor(id),'manifest.json');
  const chunkFor=(id:string,index:number)=>join(dirFor(id),`${index}.chunk`);
  const validateId=(id:string)=>{if(typeof id!=='string'||!ID_RE.test(id))fail('REMOTE_BRIDGE_CHUNK_TRANSFER_ID_INVALID');};
  async function secureDir(path:string){await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())fail('REMOTE_BRIDGE_CHUNK_STATE_INVALID');await chmod(path,0o700);}
  async function ensureTransfer(id:string){await secureDir(root);await secureDir(dirFor(id));}
  async function syncDir(path:string){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
  async function atomicWrite(path:string,data:Buffer|string){const directory=path.slice(0,path.lastIndexOf('/'));const temp=join(directory,`.pending-${process.pid}-${randomBytes(6).toString('hex')}`);const handle=await open(temp,'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}try{await rename(temp,path);await chmod(path,0o600);await syncDir(directory);}catch(error){await rm(temp,{force:true}).catch(()=>undefined);throw error;}}
  async function readManifest(id:string):Promise<TransferManifest|undefined>{validateId(id);try{return validateManifest(JSON.parse(await readFile(manifestFor(id),'utf8')),maxChunks,maxChunkBytes,maxTransferBytes);}catch(error){if(isErrno(error,'ENOENT'))return undefined;throw error;}}
  async function writeManifest(manifest:TransferManifest){await atomicWrite(manifestFor(manifest.transferId),JSON.stringify(manifest)+'\n');}
  async function expireIfNeeded(manifest:TransferManifest){if(manifest.phase==='COMPLETE')return;const stamp=now().getTime();if(!Number.isFinite(stamp))fail('REMOTE_BRIDGE_CHUNK_NOW_INVALID');if(stamp>=canonicalIso(manifest.expiresAt,'REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT')){await rm(dirFor(manifest.transferId),{recursive:true,force:true});fail('REMOTE_BRIDGE_CHUNK_EXPIRED');}}
  async function readVerified(manifest:TransferManifest,index:number){const meta=manifest.chunks.find(chunk=>chunk.index===index);if(!meta)fail('REMOTE_BRIDGE_CHUNK_NOT_FOUND');let data:Buffer;try{data=await readFile(chunkFor(manifest.transferId,index));}catch(error){if(isErrno(error,'ENOENT'))fail('REMOTE_BRIDGE_CHUNK_CORRUPT');throw error;}if(data.length!==meta.size||sha(data)!==meta.sha256)fail('REMOTE_BRIDGE_CHUNK_CORRUPT');return {meta,data};}
  return {
    async putChunk(input:RemoteBridgeChunkInput){
      validateId(input?.transferId);if(!Number.isSafeInteger(input.index)||input.index<0||!Number.isSafeInteger(input.count)||input.count<1||input.count>maxChunks||input.index>=input.count||typeof input.chunkSha256!=='string'||!SHA_RE.test(input.chunkSha256)||typeof input.objectSha256!=='string'||!SHA_RE.test(input.objectSha256))fail('REMOTE_BRIDGE_CHUNK_INPUT_INVALID');
      const expires=canonicalIso(input.expiresAt,'REMOTE_BRIDGE_CHUNK_EXPIRES_INVALID'),stamp=now().getTime();if(!Number.isFinite(stamp)||expires<=stamp)fail('REMOTE_BRIDGE_CHUNK_EXPIRED');
      const data=decodeBase64(input.dataBase64);if(data.length>maxChunkBytes)fail('REMOTE_BRIDGE_CHUNK_TOO_LARGE');if(sha(data)!==input.chunkSha256)fail('REMOTE_BRIDGE_CHUNK_DIGEST_MISMATCH');
      await ensureTransfer(input.transferId);let manifest=await readManifest(input.transferId);
      if(manifest){await expireIfNeeded(manifest);if(manifest.count!==input.count||manifest.objectSha256!==input.objectSha256||manifest.expiresAt!==input.expiresAt)fail('REMOTE_BRIDGE_CHUNK_COLLISION');const existing=manifest.chunks.find(chunk=>chunk.index===input.index);if(existing){const persisted=await readVerified(manifest,input.index);if(existing.sha256===input.chunkSha256&&persisted.data.equals(data))return {state:'REPLAY' as const,index:input.index};fail('REMOTE_BRIDGE_CHUNK_COLLISION');}if(manifest.phase==='COMPLETE')fail('REMOTE_BRIDGE_CHUNK_COLLISION');}
      else{const createdAt=now().toISOString();manifest={schema:'COCWIN_REMOTE_BRIDGE_TRANSFER_V1',transferId:input.transferId,count:input.count,objectSha256:input.objectSha256,expiresAt:input.expiresAt,createdAt,updatedAt:createdAt,phase:'OPEN',chunks:[]};}
      const total=manifest.chunks.reduce((sum,chunk)=>sum+chunk.size,0)+data.length;if(total>maxTransferBytes)fail('REMOTE_BRIDGE_CHUNK_TRANSFER_TOO_LARGE');await atomicWrite(chunkFor(input.transferId,input.index),data);manifest={...manifest,updatedAt:now().toISOString(),chunks:[...manifest.chunks,{index:input.index,sha256:input.chunkSha256,size:data.length}].sort((a,b)=>a.index-b.index)};await writeManifest(manifest);return {state:'STORED' as const,index:input.index};
    },
    async getChunk(transferId:string,index:number){const manifest=await readManifest(transferId);if(!manifest)fail('REMOTE_BRIDGE_CHUNK_TRANSFER_NOT_FOUND');await expireIfNeeded(manifest);if(!Number.isSafeInteger(index)||index<0||index>=manifest.count)fail('REMOTE_BRIDGE_CHUNK_INDEX_INVALID');const {meta,data}=await readVerified(manifest,index);return {schema:'COCWIN_REMOTE_BRIDGE_CHUNK_RESULT_V1' as const,transferId,index,count:manifest.count,dataBase64:data.toString('base64'),chunkSha256:meta.sha256,objectSha256:manifest.objectSha256};},
    async finalizeTransfer(transferId:string){const manifest=await readManifest(transferId);if(!manifest)fail('REMOTE_BRIDGE_CHUNK_TRANSFER_NOT_FOUND');await expireIfNeeded(manifest);if(manifest.chunks.length!==manifest.count||manifest.chunks.some((chunk,index)=>chunk.index!==index))fail('REMOTE_BRIDGE_CHUNK_INCOMPLETE');const pieces:Buffer[]=[];for(let index=0;index<manifest.count;index++)pieces.push((await readVerified(manifest,index)).data);const data=Buffer.concat(pieces);if(data.length>maxTransferBytes)fail('REMOTE_BRIDGE_CHUNK_TRANSFER_TOO_LARGE');const digest=sha(data);if(digest!==manifest.objectSha256)fail('REMOTE_BRIDGE_CHUNK_FINAL_DIGEST_MISMATCH');if(manifest.phase!=='COMPLETE')await writeManifest({...manifest,updatedAt:now().toISOString(),phase:'COMPLETE',totalBytes:data.length});return {schema:'COCWIN_REMOTE_BRIDGE_TRANSFER_RESULT_V1' as const,transferId,state:'COMPLETE' as const,count:manifest.count,totalBytes:data.length,sha256:digest,dataBase64:data.toString('base64')};},
    async stats(){await secureDir(root);const stamp=now().getTime();if(!Number.isFinite(stamp))fail('REMOTE_BRIDGE_CHUNK_NOW_INVALID');let activeTransfers=0;for(const entry of await readdir(root,{withFileTypes:true})){if(!entry.isDirectory()||entry.isSymbolicLink())continue;let manifest:TransferManifest;try{manifest=validateManifest(JSON.parse(await readFile(join(root,entry.name,'manifest.json'),'utf8')),maxChunks,maxChunkBytes,maxTransferBytes);}catch(error){if(isErrno(error,'ENOENT'))continue;throw error;}if(manifest.phase==='OPEN'&&stamp<canonicalIso(manifest.expiresAt,'REMOTE_BRIDGE_CHUNK_MANIFEST_CORRUPT'))activeTransfers++;}return {activeTransfers};}
  };
}