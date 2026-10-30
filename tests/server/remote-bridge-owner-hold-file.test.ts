import {createHash} from 'node:crypto';
import {beforeEach,describe,expect,it,vi} from 'vitest';

const fake=vi.hoisted(()=>({
  raw:Buffer.alloc(0),
  uid:0n,gid:1027n,mode:0o100640n,nlink:1n,
  parentSymlink:false,readIncomplete:false,swapAfter:false,fileStats:0,readCalls:0,closeCalls:0,
}));
vi.mock('node:fs',async()=>{
  const real=await vi.importActual<typeof import('node:fs')>('node:fs');
  function stat(path:string,folder:boolean){
    const swap=!folder&&fake.swapAfter&&fake.fileStats++>1;
    const mode=folder?0o40755n:fake.mode;
    return {
      dev:1n,ino:folder?2n:swap?10n:9n,uid:folder?0n:fake.uid,
      gid:folder?0n:fake.gid,mode,nlink:folder?2n:fake.nlink,
      size:folder?4096n:BigInt(fake.raw.length),mtimeNs:7n,ctimeNs:7n,
      isFile:()=>!folder,isDirectory:()=>folder,isSymbolicLink:()=>folder&&fake.parentSymlink&&path==='/etc/rbridge',
    };
  }
  return {...real,
    lstatSync:(path:string,...args:unknown[])=>{
      if(path==='/'||path==='/etc'||path==='/etc/rbridge')return stat(path,true);
      if(path==='/etc/rbridge/owner-app-run-hold-v1.json')return stat(path,false);
      return (real.lstatSync as (...args:unknown[])=>unknown)(path,...args);
    },
    fstatSync:(fd:number,...args:unknown[])=>fd===99?stat('file',false):(real.fstatSync as (...args:unknown[])=>unknown)(fd,...args),
    openSync:(path:string,...args:unknown[])=>path==='/etc/rbridge/owner-app-run-hold-v1.json'?99:(real.openSync as (...args:unknown[])=>number)(path,...args),
    closeSync:(fd:number)=>{if(fd===99){fake.closeCalls++;return;}return real.closeSync(fd);},
    readSync:(fd:number,buffer:Buffer,offset:number,length:number,position:number|null)=>{
      if(fd!==99)return real.readSync(fd,buffer,offset,length,position);
      fake.readCalls++;
      if(fake.readIncomplete)return 0;
      const start=typeof position==='number'?position:0;
      if(start>=fake.raw.length)return 0;
      return fake.raw.copy(buffer,offset,start,start+length);
    },
  };
});
import {createProtectedOwnerHold,loadProtectedOwnerHold} from '../../src/server/remoteBridgeOwnerHold.js';
const base={repository:'example/rbridge-control',authorLogin:'bridge-owner',instanceId:'test-machine',runtimeUid:1027,runtimeGid:1027};
function fixture(){
  const apps=['aplall','aplall','aplall','dart','dart','editor','editor','editor','editor'];
  const manifest={schema:'RBRIDGE_OWNER_APP_RUN_HOLD_V1',mode:'HOLD',repository:base.repository,authorLogin:base.authorLogin,instanceId:base.instanceId,
    apps:['aplall','dart','editor'],originals:apps.map((appId,i)=>({appId,requestId:'old-'+i,jobId:'job-'+i,issueNumber:200+i,
      requestSha256:(i+1).toString(16).repeat(64),storeSha256:(i+1).toString(16).repeat(64),phase:'WAITING',scope:'UNSCOPED'}))};
  const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
    ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical((v as Record<string,unknown>)[k])])):v;
  const raw=Buffer.from(JSON.stringify(canonical(manifest))+'\n');
  return{raw,context:{...base,expectedSha256:createHash('sha256').update(raw).digest('hex')}};
}
const identity=(appId:string)=>({appId,requestId:'old-0',jobId:'job-0',issueNumber:200,requestSha256:'1'.repeat(64)});
beforeEach(()=>{fake.uid=0n;fake.gid=1027n;fake.mode=0o100640n;fake.nlink=1n;fake.parentSymlink=false;fake.readIncomplete=false;fake.swapAfter=false;fake.fileStats=0;fake.readCalls=0;fake.closeCalls=0;fake.raw=fixture().raw;});
describe('protected ROOT-owned HOLD source file IO gate in synthetic namespace',()=>{
  it('accepts ONLY fully stable root file and keeps exact held app after each re-read',async()=>{
    const pkg=fixture(),decide=createProtectedOwnerHold(pkg.context);
    expect(fake.closeCalls).toBe(1);
    await expect(decide(identity('aplall'))).resolves.toBe(true);
    await expect(decide(identity('dart'))).resolves.toBe(true);
    await expect(decide(identity('editor'))).resolves.toBe(true);
    expect(fake.closeCalls).toBe(4);
    await expect(decide(identity('games2d'))).resolves.toBe(false);
    expect(fake.closeCalls).toBe(4); // unrelated app not required to read protected owner file
  });
  it('stays held when pinned protected content changes or disappears after bootstrap',async()=>{
    const pkg=fixture(),decide=createProtectedOwnerHold(pkg.context);
    fake.raw=Buffer.from('UNVERIFIED CHANGED OWNER POLICY\n');
    await expect(decide(identity('editor'))).resolves.toBe(true);
    await expect(decide(identity('aplall'))).resolves.toBe(true);
    await expect(decide(identity('games2d'))).resolves.toBe(false);
  });
  it('rejects wrong gid, ownership, public file mode, hard links and parent symlinks at startup',()=>{
    const pkg=fixture();
    for(const change of [
      ()=>{fake.uid=1027n;},()=>{fake.gid=0n;},()=>{fake.mode=0o100644n;},
      ()=>{fake.nlink=2n;},()=>{fake.parentSymlink=true;},
    ]){
      change();expect(()=>loadProtectedOwnerHold(pkg.context)).toThrow();
      fake.uid=0n;fake.gid=1027n;fake.mode=0o100640n;fake.nlink=1n;fake.parentSymlink=false;fake.fileStats=0;
    }
  });
  it('fails closed on unstable inode and short read with no filesystem writes',()=>{
    const pkg=fixture();
    fake.swapAfter=true;
    expect(()=>loadProtectedOwnerHold(pkg.context)).toThrow('RBRIDGE_OWNER_HOLD_FILE_CHANGED');
    fake.swapAfter=false;fake.fileStats=0;fake.readIncomplete=true;
    expect(()=>loadProtectedOwnerHold(pkg.context)).toThrow('RBRIDGE_OWNER_HOLD_READ_INCOMPLETE');
  });
});
