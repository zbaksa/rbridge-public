import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,open,readFile,readdir,readlink,rename,rm,symlink,writeFile,type FileHandle} from 'node:fs/promises';
import {Dir} from 'node:fs';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRemoteBridgeFileOps} from '../../src/server/remoteBridgeFileOps.js';
type ListResult={entries:Array<{name:string;type:string}>};
type StatResult={type:string;size:number};
type ReadResult={text:string};
type ReadManyResult={files:Array<{path:string;text:string}>};
type SearchResult={matches:Array<{path:string}>;truncated:boolean};
type BinaryResult={path:string;dataBase64:string;bytes:number;sha256:string};
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

async function fixture(){
  const base=await mkdtemp(join(tmpdir(),'bridge-fileops-'));
  roots.push(base);
  const root=join(base,'root'),outside=join(base,'outside');
  await mkdir(root);await mkdir(outside);
  const fileOps=createRemoteBridgeFileOps({allowedRoots:[root],maxReadBytes:64,maxSearchResults:2});
  return {base,root,outside,fileOps};
}

describe('remote bridge safe FILE operations',()=>{
  it('lists, stats, reads and reads many only below an allowed root',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'a.txt'),'alpha');
    await writeFile(join(root,'b.txt'),'beta');
    const list=await fileOps.execute({kind:'FILE',action:'LIST',target:root,args:{maxEntries:10}}) as ListResult;
    expect(list.entries.map(x=>x.name)).toEqual(['a.txt','b.txt']);
    const stat=await fileOps.execute({kind:'FILE',action:'STAT',target:join(root,'a.txt'),args:{}}) as StatResult;
    expect(stat.type).toBe('file');expect(stat.size).toBe(5);
    const read=await fileOps.execute({kind:'FILE',action:'READ',target:join(root,'a.txt'),args:{}}) as ReadResult;
    expect(read.text).toBe('alpha');
    const many=await fileOps.execute({kind:'FILE',action:'READ_MANY',target:root,args:{paths:['a.txt','b.txt']}}) as ReadManyResult;
    expect(many.files.map(x=>x.text)).toEqual(['alpha','beta']);
  });

  it('round-trips bounded binary files with canonical base64 and SHA-256 binding',async()=>{
    const {root,fileOps}=await fixture();const target=join(root,'asset.bin'),data=Buffer.from([0,255,1,2,3,128,10,0,77]),sha=digest(data);
    await expect(fileOps.execute({kind:'FILE',action:'WRITE_BINARY',target,args:{dataBase64:data.toString('base64'),sha256:sha}})).resolves.toEqual({path:target,written:true,bytes:data.byteLength,sha256:sha});
    expect(await readFile(target)).toEqual(data);
    const out=await fileOps.execute({kind:'FILE',action:'READ_BINARY',target,args:{}}) as BinaryResult;
    expect(out).toEqual({path:target,dataBase64:data.toString('base64'),bytes:data.byteLength,sha256:sha});
  });

  it('rejects malformed, digest-mismatched and oversized binary writes without replacing the target',async()=>{
    const {root,fileOps}=await fixture();const target=join(root,'asset.bin');await writeFile(target,Buffer.from([9,8,7]));
    const data=Buffer.from([0,1,2,3]);
    await expect(fileOps.execute({kind:'FILE',action:'WRITE_BINARY',target,args:{dataBase64:'***',sha256:digest(data)}})).rejects.toThrow(/BASE64_INVALID/);
    await expect(fileOps.execute({kind:'FILE',action:'WRITE_BINARY',target,args:{dataBase64:data.toString('base64'),sha256:'0'.repeat(64)}})).rejects.toThrow(/SHA256_MISMATCH/);
    const big=Buffer.alloc(65,1);await expect(fileOps.execute({kind:'FILE',action:'WRITE_BINARY',target,args:{dataBase64:big.toString('base64'),sha256:digest(big)}})).rejects.toThrow(/TOO_LARGE/);
    expect(await readFile(target)).toEqual(Buffer.from([9,8,7]));
  });

  it('writes/appends/edits/moves atomically inside one allowed root',async()=>{
    const {root,fileOps}=await fixture();
    const a=join(root,'a.txt'),b=join(root,'b.txt');
    await fileOps.execute({kind:'FILE',action:'WRITE_TEXT',target:a,args:{text:'one two one'}});
    await fileOps.execute({kind:'FILE',action:'APPEND_TEXT',target:a,args:{text:' three'}});
    await fileOps.execute({kind:'FILE',action:'EDIT_EXACT',target:a,args:{oldText:'one',newText:'ONE',expectedReplacements:2}});
    expect(await readFile(a,'utf8')).toBe('ONE two ONE three');
    await fileOps.execute({kind:'FILE',action:'MOVE',target:a,args:{destination:b}});
    expect(await readFile(b,'utf8')).toBe('ONE two ONE three');
  });

  it('searches with bounded results and deterministic ordering',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'a.txt'),'needle a');
    await writeFile(join(root,'b.txt'),'needle b');
    await writeFile(join(root,'c.txt'),'needle c');
    const out=await fileOps.execute({kind:'FILE',action:'SEARCH',target:root,args:{query:'needle'}}) as SearchResult;
    expect(out.matches).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.matches.map(x=>x.path)).toEqual([join(root,'a.txt'),join(root,'b.txt')]);
  });

  it('fails closed on traversal, symlink escapes, secret paths, cross-root moves and oversized reads',async()=>{
    const {root,outside,fileOps}=await fixture();
    const outsideFile=join(outside,'outside.txt');await writeFile(outsideFile,'outside');
    await symlink(outside,join(root,'escape'));
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'escape','outside.txt'),args:{}})).rejects.toThrow(/SYMLINK|ROOT/);
    await symlink(outsideFile,join(root,'final-link'));
    await expect(fileOps.execute({kind:'FILE',action:'WRITE_TEXT',target:join(root,'final-link'),args:{text:'x'}})).rejects.toThrow(/SYMLINK/);
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'..','outside','outside.txt'),args:{}})).rejects.toThrow(/PATH|ROOT/);
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'.ssh','id_ed25519'),args:{}})).rejects.toThrow(/SECRET/);
    await writeFile(join(root,'big.txt'),'x'.repeat(65));
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'big.txt'),args:{}})).rejects.toThrow(/TOO_LARGE/);
    await expect(fileOps.execute({kind:'FILE',action:'MOVE',target:outsideFile,args:{destination:join(root,'moved.txt')}})).rejects.toThrow(/ROOT/);
  });

  it('requires exact replacement count and leaves the original unchanged on mismatch',async()=>{
    const {root,fileOps}=await fixture();const target=join(root,'edit.txt');
    await writeFile(target,'x x');
    await expect(fileOps.execute({kind:'FILE',action:'EDIT_EXACT',target,args:{oldText:'x',newText:'y',expectedReplacements:1}})).rejects.toThrow(/REPLACEMENT_COUNT/);
    expect(await readFile(target,'utf8')).toBe('x x');
  });

  it('rejects READ target paths containing actual NUL characters with REMOTE_BRIDGE_FILE_PATH_INVALID',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'file.txt'),'content');
    await expect(fileOps.execute({kind:'FILE',action:'READ',target:join(root,'file\u0000.txt'),args:{}})).rejects.toThrow(/REMOTE_BRIDGE_FILE_PATH_INVALID/);
  });

  it('rejects READ_MANY with relative items containing actual NUL characters with REMOTE_BRIDGE_FILE_PATH_INVALID',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'file.txt'),'content');
    await expect(fileOps.execute({kind:'FILE',action:'READ_MANY',target:root,args:{paths:['file\u0000.txt']}})).rejects.toThrow(/REMOTE_BRIDGE_FILE_PATH_INVALID/);
  });

  it('rejects WRITE_TEXT with text containing actual NUL characters with REMOTE_BRIDGE_FILE_TEXT_INVALID',async()=>{
    const {root,fileOps}=await fixture();
    await expect(fileOps.execute({kind:'FILE',action:'WRITE_TEXT',target:join(root,'file.txt'),args:{text:'content\u0000'} })).rejects.toThrow(/REMOTE_BRIDGE_FILE_TEXT_INVALID/);
  });

  it('rejects READ_MANY when aggregate text bytes exceed maxReadBytes',async()=>{
    const {root,fileOps}=await fixture();
    await writeFile(join(root,'a.txt'),'a'.repeat(40));
    await writeFile(join(root,'b.txt'),'b'.repeat(40));
    await expect(fileOps.execute({kind:'FILE',action:'READ_MANY',target:root,args:{paths:['a.txt','b.txt']}})).rejects.toThrow(/REMOTE_BRIDGE_FILE_TOO_LARGE/);
  });
});

async function interceptReads(paths:readonly string[],before:()=>Promise<void>=async()=>undefined){
  const probe=await open(paths[0]!,'r');const prototype=Object.getPrototypeOf(probe) as {readFile(...args:unknown[]):Promise<Buffer|string>;read(...args:unknown[]):Promise<{bytesRead:number;buffer:Buffer}>};await probe.close();
  const originalFile=prototype.readFile,originalRead=prototype.read,stats={maxAllocation:0,totalBytes:0,calls:0};
  async function matches(handle:FileHandle){try{return paths.includes(await readlink(`/proc/self/fd/${handle.fd}`));}catch{return false;}}
  vi.spyOn(prototype,'readFile').mockImplementation(async function(this:FileHandle,...args:unknown[]){const tracked=await matches(this);if(tracked)await before();const value=await Reflect.apply(originalFile,this,args) as Buffer|string;if(tracked){const bytes=Buffer.byteLength(value);stats.maxAllocation=Math.max(stats.maxAllocation,bytes);stats.totalBytes+=bytes;stats.calls++;}return value;});
  vi.spyOn(prototype,'read').mockImplementation(async function(this:FileHandle,...args:unknown[]){const tracked=await matches(this);if(tracked){await before();if(Buffer.isBuffer(args[0]))stats.maxAllocation=Math.max(stats.maxAllocation,args[0].length);}const value=await Reflect.apply(originalRead,this,args) as {bytesRead:number;buffer:Buffer};if(tracked){stats.totalBytes+=value.bytesRead;stats.calls++;}return value;});return stats;
}
async function handlesBelow(root:string){let count=0;for(const fd of await readdir('/proc/self/fd'))try{const path=await readlink(`/proc/self/fd/${fd}`);if(path===root||path.startsWith(root+'/'))count++;}catch{}return count;}
describe('bounded descriptor read regressions',()=>{
  it.each(['STAT','READ_MANY'])('rejects FIFO without blocking (%s)',async action=>{
    const f=await fixture();await promisify(execFile)('/usr/bin/mkfifo',[join(f.root,'fifo')]);
    const result=await new Promise<{timedOut:boolean;status?:string}>((done,reject)=>{
      const child=spawn(process.execPath,['--import','tsx',resolve('tests/fixtures/rbridge-file-race.ts'),f.root,action],{stdio:['ignore','pipe','pipe']});let stdout='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},3500);child.stdout.on('data',b=>{stdout+=String(b);});child.stderr.on('data',()=>undefined);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',()=>{clearTimeout(timer);done({timedOut,...(stdout?JSON.parse(stdout.trim()) as {status:string}:{})});});
    });expect(result.timedOut).toBe(false);expect(result.status).toBe('REJECTED');
  },10000);
  it('rejects an intermediate symlink even when READ_MANY stays inside the allowed root',async()=>{
    const f=await fixture();await mkdir(join(f.root,'actual'));await writeFile(join(f.root,'actual','data'),'other');await symlink(join(f.root,'actual'),join(f.root,'sub'));
    await expect(f.fileOps.execute({kind:'FILE',action:'READ_MANY',target:f.root,args:{paths:['sub/data']}})).rejects.toThrow(/SYMLINK/);
  });
  it('bounds a growing file during reading using real descriptor read allocations',async()=>{
    const f=await fixture(),target=join(f.root,'grow');await writeFile(target,'a');let grew=false;const stats=await interceptReads([target],async()=>{if(!grew){grew=true;await writeFile(target,Buffer.alloc(1048576,97));}});
    const fileOps=createRemoteBridgeFileOps({allowedRoots:[f.root],maxReadBytes:256,maxSearchResults:2});await expect(fileOps.execute({kind:'FILE',action:'READ',target,args:{}})).rejects.toThrow(/TOO_LARGE/);expect(grew).toBe(true);expect(stats.calls).toBeGreaterThan(0);expect(stats.maxAllocation).toBeLessThanOrEqual(257);expect(stats.totalBytes).toBeLessThanOrEqual(257);expect(await handlesBelow(f.root)).toBe(0);
  });
  it('shares READ_MANY remaining bytes before reading the second file',async()=>{
    const f=await fixture(),a=join(f.root,'a'),b=join(f.root,'b');await writeFile(a,'a'.repeat(160));await writeFile(b,'b'.repeat(160));const stats=await interceptReads([a,b]);const fileOps=createRemoteBridgeFileOps({allowedRoots:[f.root],maxReadBytes:256,maxSearchResults:2});await expect(fileOps.execute({kind:'FILE',action:'READ_MANY',target:f.root,args:{paths:['a','b']}})).rejects.toThrow(/TOO_LARGE/);expect(stats.totalBytes).toBeLessThanOrEqual(257);expect(await handlesBelow(f.root)).toBe(0);
  });
  it('rejects pre-aborted reads before opening or reading a descriptor',async()=>{
    const f=await fixture(),target=join(f.root,'a');await writeFile(target,'a');const stats=await interceptReads([target]),controller=new AbortController();controller.abort();await expect(f.fileOps.execute({kind:'FILE',action:'READ',target,args:{}},{signal:controller.signal})).rejects.toThrow(/ABORT/);expect(stats.calls).toBe(0);
  });
  it('settles running cancellation only after the actual read and handles close',async()=>{
    const f=await fixture(),target=join(f.root,'a');await writeFile(target,'a');let entered!:()=>void,release!:()=>void;const started=new Promise<void>(done=>{entered=done;}),gate=new Promise<void>(done=>{release=done;});await interceptReads([target],async()=>{entered();await gate;});const controller=new AbortController();let settled=false;const pending=f.fileOps.execute({kind:'FILE',action:'READ',target,args:{}},{signal:controller.signal});void pending.then(()=>{settled=true;},()=>{settled=true;});
    try{await started;controller.abort();await new Promise<void>(done=>setImmediate(done));expect(settled).toBe(false);expect(await handlesBelow(f.root)).toBeGreaterThan(0);release();await expect(pending).rejects.toThrow(/ABORT/);expect(await handlesBelow(f.root)).toBe(0);}finally{release();await pending.catch(()=>undefined);}
  });
  it('fails a directory above the scan cap without loading unbounded output',async()=>{
    const f=await fixture();for(let start=0;start<10001;start+=200)await Promise.all(Array.from({length:Math.min(200,10001-start)},(_,i)=>writeFile(join(f.root,`entry-${String(start+i).padStart(5,'0')}`),'')));
    await expect(f.fileOps.execute({kind:'FILE',action:'LIST',target:f.root,args:{maxEntries:3}})).rejects.toThrow(/SCAN_LIMIT/);expect(await handlesBelow(f.root)).toBe(0);
  },20000);
  it('cancels directory iteration and closes both the iterator and directory handle',async()=>{
    const f=await fixture();await writeFile(join(f.root,'a'),'a');await writeFile(join(f.root,'b'),'b');const original=Dir.prototype[Symbol.asyncIterator];let entered!:()=>void,release!:()=>void;const started=new Promise<void>(done=>{entered=done;}),gate=new Promise<void>(done=>{release=done;});
    vi.spyOn(Dir.prototype,Symbol.asyncIterator).mockImplementation(async function*(this:Dir){let n=0;for await(const entry of original.call(this)){if(++n===2){entered();await gate;}yield entry;}return undefined;});
    const controller=new AbortController(),pending=f.fileOps.execute({kind:'FILE',action:'LIST',target:f.root,args:{}},{signal:controller.signal});void pending.catch(()=>undefined);
    try{await Promise.race([started,pending.then(()=>{throw new Error('READ_DID_NOT_STREAM');})]);controller.abort();release();await expect(pending).rejects.toThrow(/ABORT/);expect(await handlesBelow(f.root)).toBe(0);}finally{release();await pending.catch(()=>undefined);}
  });
  it('refuses a swapped directory component while an actual read is pending',async()=>{
    const f=await fixture(),target=join(f.root,'sub','a');await mkdir(join(f.root,'sub'));await mkdir(join(f.root,'other'));await writeFile(target,'original');await writeFile(join(f.root,'other','a'),'substitute');let swapped=false;
    await interceptReads([target],async()=>{if(!swapped){swapped=true;await rename(join(f.root,'sub'),join(f.root,'original-dir'));await symlink(join(f.root,'other'),join(f.root,'sub'));}});
    const output=await f.fileOps.execute({kind:'FILE',action:'READ',target,args:{}}) as ReadResult;expect(output.text).toBe('original');expect(swapped).toBe(true);await expect(f.fileOps.execute({kind:'FILE',action:'READ',target,args:{}})).rejects.toThrow(/SYMLINK/);expect(await handlesBelow(f.root)).toBe(0);
  });
});
