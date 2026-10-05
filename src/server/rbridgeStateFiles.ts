import {randomUUID} from 'node:crypto';
import {constants,type Stats} from 'node:fs';
import {link,mkdir,open,rename,statfs,unlink,type FileHandle} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,resolve} from 'node:path';
export interface RBridgeStateIo{
  beforeStageCreate():Promise<void>;syncFile(handle:FileHandle):Promise<void>;beforePlacement():Promise<void>;
  rename:typeof rename;syncParent(handle:FileHandle):Promise<void>;
}
export interface RBridgeStateFiles{
  read(path:string,uid:number,maxBytes:number):Promise<Buffer>;
  commit(path:string,data:Buffer,uid:number,createOnly:boolean):Promise<void>;
  validateTree(root:string,uid:number):Promise<void>;
  ensureDirectory(path:string,uid:number):Promise<void>;
  directory(path:string,uid:number,privateDirectory?:boolean):Promise<FileHandle>;
  file(path:string,uid:number,maxBytes:number):Promise<FileHandle>;
}
const flags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
function fail(code='RBRIDGE_STATE_UNSAFE'):never{throw new Error(code);}
function lexical(path:string){if(!isAbsolute(path)||path.startsWith('//')||path.includes('\0')||resolve(path)!==path)fail();}
function identity(uid:number){if(!Number.isSafeInteger(uid)||uid<0)fail();}
export function rbridgeStateFdPath(handle:FileHandle,name?:string):string{return join('/proc/self/fd',String(handle.fd),...(name===undefined?[]:[name]));}
function validateDirectory(info:Stats,uid:number,privateDirectory:boolean){
  if(!info.isDirectory()||(info.uid!==0&&info.uid!==uid)||(info.mode&0o022)!==0)fail();
  if(privateDirectory&&(info.uid!==uid||(info.mode&0o7777)!==0o700))fail();
}
export function validateRBridgeStateHandle(info:Stats,uid:number,maxBytes:number):void{
  if(!info.isFile()||info.nlink!==1||info.uid!==uid||(info.mode&0o7777)!==0o600||!Number.isSafeInteger(info.size)||info.size<0||info.size>maxBytes)fail();
}
export async function checkPersistentRBridgeFilesystem(root:string):Promise<void>{
  const info=await statfs(root);if(![0xef53,0x58465342,0x9123683e].includes(info.type))fail('RBRIDGE_STATE_FILESYSTEM_UNSUPPORTED');
}
export function createRBridgeStateFiles(options:{io?:Partial<RBridgeStateIo>;checkFilesystem?:(root:string)=>Promise<void>}={}):RBridgeStateFiles{
  const io:RBridgeStateIo={beforeStageCreate:async()=>undefined,syncFile:handle=>handle.sync(),beforePlacement:async()=>undefined,rename,syncParent:handle=>handle.sync(),...options.io};
  const checkFilesystem=options.checkFilesystem??checkPersistentRBridgeFilesystem;
  async function directory(path:string,uid:number,privateDirectory=false):Promise<FileHandle>{
    lexical(path);identity(uid);let handle=await open('/',flags|constants.O_DIRECTORY);
    try{
      validateDirectory(await handle.stat(),uid,false);
      const parts=path.split('/').filter(Boolean);
      for(let n=0;n<parts.length;n++){
        const next=await open(rbridgeStateFdPath(handle,parts[n]!),flags|constants.O_DIRECTORY);
        try{validateDirectory(await next.stat(),uid,privateDirectory&&n===parts.length-1);}catch(error){await next.close();throw error;}
        await handle.close();handle=next;
      }
      return handle;
    }catch(error){await handle.close().catch(()=>undefined);throw error;}
  }
  async function file(path:string,uid:number,maxBytes:number):Promise<FileHandle>{
    lexical(path);identity(uid);if(!Number.isSafeInteger(maxBytes)||maxBytes<0)fail();
    const parent=await directory(dirname(path),uid,true);
    try{
      const handle=await open(rbridgeStateFdPath(parent,basename(path)),flags);
      try{validateRBridgeStateHandle(await handle.stat(),uid,maxBytes);return handle;}catch(error){await handle.close();throw error;}
    }finally{await parent.close();}
  }
  return Object.freeze({directory,file,
    async read(path:string,uid:number,maxBytes:number):Promise<Buffer>{
      const handle=await file(path,uid,maxBytes),chunks:Buffer[]=[];let total=0;
      try{
        for(;;){const buffer=Buffer.alloc(Math.min(65536,maxBytes+1-total));const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(bytesRead===0)break;chunks.push(buffer.subarray(0,bytesRead));total+=bytesRead;if(total>maxBytes)fail('RBRIDGE_STATE_FILE_LIMIT');}
        validateRBridgeStateHandle(await handle.stat(),uid,maxBytes);return Buffer.concat(chunks,total);
      }finally{await handle.close();}
    },
    async ensureDirectory(path:string,uid:number):Promise<void>{
      lexical(path);identity(uid);const parent=await directory(dirname(path),uid);
      try{try{await mkdir(rbridgeStateFdPath(parent,basename(path)),{mode:0o700});await io.syncParent(parent);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}finally{await parent.close();}
      const checked=await directory(path,uid,true);await checked.close();
    },
    async validateTree(root:string,uid:number):Promise<void>{const handle=await directory(root,uid,true);try{await checkFilesystem(rbridgeStateFdPath(handle));}finally{await handle.close();}},
    async commit(path:string,data:Buffer,uid:number,createOnly:boolean):Promise<void>{
      lexical(path);identity(uid);const parent=await directory(dirname(path),uid,true),stage=rbridgeStateFdPath(parent,`.${basename(path)}.${randomUUID()}.stage`),target=rbridgeStateFdPath(parent,basename(path));
      try{
        if(!createOnly){const current=await file(path,uid,Number.MAX_SAFE_INTEGER);await current.close();}
        await io.beforeStageCreate();const handle=await open(stage,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
        try{validateRBridgeStateHandle(await handle.stat(),uid,data.length);await handle.writeFile(data);validateRBridgeStateHandle(await handle.stat(),uid,data.length);await io.syncFile(handle);}finally{await handle.close();}
        await io.beforePlacement();
        if(createOnly){await link(stage,target);await unlink(stage);}else await io.rename(stage,target);
        await io.syncParent(parent);
      }finally{await parent.close();}
    },
  });
}
const productionFiles=createRBridgeStateFiles();
export const readRBridgeStateFile=productionFiles.read;
export const commitRBridgeStateFile=productionFiles.commit;
export const validateRBridgeStateTree=productionFiles.validateTree;
