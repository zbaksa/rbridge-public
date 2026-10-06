import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach,describe,expect,it} from 'vitest';
import {auditTransferGate} from '../../src/installation/transferGate.js';
import {fixtureGateContext} from './fixtureContext.js';

const sha=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(options:{phase?:'OPEN'|'COMPLETE';pieces?:Buffer[];wrongDirectory?:boolean;extra?:boolean;missing?:boolean;corrupt?:boolean;stage?:boolean;mutate?:(row:Record<string,unknown>)=>void}={}){
  const root=await mkdtemp(join(tmpdir(),'rbridge-transfer-gate-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const id='retained-transfer',pieces=options.pieces??[Buffer.from('abc'),Buffer.from('def')],phase=options.phase??'COMPLETE';
  const dir=join(root,'transfers',options.wrongDirectory?'f'.repeat(64):sha(id));await mkdir(dir,{recursive:true,mode:0o700});
  const manifest:Record<string,unknown>={schema:'COCWIN_REMOTE_BRIDGE_TRANSFER_V1',transferId:id,count:pieces.length,objectSha256:sha(Buffer.concat(pieces)),expiresAt:'2026-10-05T00:10:00.000Z',createdAt:'2026-10-05T00:00:00.000Z',updatedAt:'2026-10-05T00:01:00.000Z',phase,chunks:pieces.map((bytes,index)=>({index,sha256:sha(bytes),size:bytes.length})),...(phase==='COMPLETE'?{totalBytes:Buffer.concat(pieces).length}:{})};
  options.mutate?.(manifest);await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
  for(const [index,bytes] of pieces.entries())if(!options.missing||index!==0)await writeFile(join(dir,`${index}.chunk`),options.corrupt&&index===0?Buffer.from('bad'):bytes,{mode:0o600});
  if(options.extra)await writeFile(join(dir,'999.chunk'),'extra',{mode:0o600});if(options.stage)await writeFile(join(dir,'.pending-123-fixture'),'pending',{mode:0o600});
  const context=await fixtureGateContext(root);cleanup.push(()=>context.snapshot.close());return {context,manifest};
}
describe('complete transfer gate without expiry cleanup',()=>{
  it('blocks expired and current OPEN transfers without changing any retained object',async()=>{
    for(const mutate of [undefined,(r:Record<string,unknown>)=>{r.expiresAt='2026-10-07T00:00:00.000Z';}]){const f=await fixture({phase:'OPEN',...(mutate?{mutate}:{})}),before=f.context.snapshot.treeSHA256;expect((await auditTransferGate(f.context)).status).toBe('BLOCKED');await f.context.snapshot.verify();expect(f.context.snapshot.treeSHA256).toBe(before);}
  });
  it('requires the exact directory, complete file set and all original chunk bytes',async()=>{
    const good=await fixture();expect((await auditTransferGate(good.context)).status).toBe('PASS');
    for(const options of [{wrongDirectory:true},{extra:true},{missing:true},{corrupt:true},{stage:true},{mutate:(r:Record<string,unknown>)=>{r.objectSha256='e'.repeat(64);}},{mutate:(r:Record<string,unknown>)=>{r.extra=true;}}]){const f=await fixture(options);expect((await auditTransferGate(f.context)).status).toBe('BLOCKED');await f.context.snapshot.verify();}
  });
  it('blocks contradictory ordered metadata, timestamps and whole-byte totals',async()=>{
    for(const mutate of [(r:Record<string,unknown>)=>{(r.chunks as unknown[]).reverse();},(r:Record<string,unknown>)=>{r.totalBytes=7;},(r:Record<string,unknown>)=>{r.updatedAt='2026-10-04T00:00:00.000Z';},(r:Record<string,unknown>)=>{r.expiresAt=r.createdAt;}]){const f=await fixture({mutate});expect((await auditTransferGate(f.context)).status).toBe('BLOCKED');}
  });
  it('retains valid empty chunks and distinguishes configured history from pinned main bounds',async()=>{
    for(const pieces of [[Buffer.alloc(0)],[Buffer.alloc(40000,65)]]){const f=await fixture({pieces});expect((await auditTransferGate(f.context)).status).toBe('PASS');}
    const other=await fixture({pieces:[Buffer.alloc(40001,65)]});expect((await auditTransferGate(other.context)).status).toBe('UNKNOWN');
  });
  it('accepts exact pinned count and total boundaries but never widens them',async()=>{
    const pieces=Array.from({length:256},(_,i)=>Buffer.alloc(i<200?40000:0,65));const good=await fixture({pieces});expect((await auditTransferGate(good.context)).status).toBe('PASS');
    const tooMany=await fixture({pieces:Array.from({length:257},()=>Buffer.alloc(0))});expect((await auditTransferGate(tooMany.context)).status).toBe('UNKNOWN');
    const tooLarge=await fixture({pieces:Array.from({length:201},()=>Buffer.alloc(40000,65))});expect((await auditTransferGate(tooLarge.context)).status).toBe('UNKNOWN');
  },30000);
});
