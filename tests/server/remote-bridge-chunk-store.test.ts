import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {createRemoteBridgeChunkStore} from '../../src/server/remoteBridgeChunkStore.js';

const roots:string[]=[];
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
async function root(){const value=await mkdtemp(join(tmpdir(),'cocwin-bridge-chunk-'));roots.push(value);return value;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

function parts(value:Buffer,count=3){
  const size=Math.ceil(value.length/count);
  return Array.from({length:count},(_,index)=>value.subarray(index*size,Math.min(value.length,(index+1)*size)));
}

describe('remote bridge durable chunk store',()=>{
  it('reassembles ordered chunks only when per-chunk and object digests match',async()=>{
    const state=await root(),now=new Date('2026-09-16T21:00:00.000Z');
    const store=createRemoteBridgeChunkStore({root:state,now:()=>now});
    const body=Buffer.from('alpha\nbeta\ngamma\ndelta\n'.repeat(2000));
    const chunks=parts(body);
    for(const [index,chunk] of chunks.entries()){
      await expect(store.putChunk({transferId:'tx.ordered',index,count:chunks.length,dataBase64:chunk.toString('base64'),chunkSha256:sha(chunk),objectSha256:sha(body),expiresAt:'2026-09-16T21:20:00.000Z'})).resolves.toMatchObject({state:'STORED',index});
    }
    await expect(store.getChunk('tx.ordered',1)).resolves.toMatchObject({index:1,chunkSha256:sha(chunks[1]!),dataBase64:chunks[1]!.toString('base64')});
    await expect(store.finalizeTransfer('tx.ordered')).resolves.toEqual({schema:'COCWIN_REMOTE_BRIDGE_TRANSFER_RESULT_V1',transferId:'tx.ordered',state:'COMPLETE',count:3,totalBytes:body.length,sha256:sha(body),dataBase64:body.toString('base64')});
  });

  it('is idempotent for an identical duplicate and blocks same index with different bytes',async()=>{
    const state=await root(),store=createRemoteBridgeChunkStore({root:state,now:()=>new Date('2026-09-16T21:00:00.000Z')});
    const body=Buffer.from('one-two-three'),chunk=body;
    const input={transferId:'tx.dup',index:0,count:1,dataBase64:chunk.toString('base64'),chunkSha256:sha(chunk),objectSha256:sha(body),expiresAt:'2026-09-16T21:20:00.000Z'};
    await expect(store.putChunk(input)).resolves.toMatchObject({state:'STORED'});
    await expect(store.putChunk(input)).resolves.toMatchObject({state:'REPLAY'});
    const other=Buffer.from('different');
    await expect(store.putChunk({...input,dataBase64:other.toString('base64'),chunkSha256:sha(other)})).rejects.toThrow('REMOTE_BRIDGE_CHUNK_COLLISION');
  });

  it('persists across store restart and rejects incomplete expired transfers',async()=>{
    const state=await root(),body=Buffer.from('persisted restart payload'),chunks=parts(body,2);
    let clock=new Date('2026-09-16T21:00:00.000Z');
    const first=createRemoteBridgeChunkStore({root:state,now:()=>clock});
    await first.putChunk({transferId:'tx.restart',index:0,count:2,dataBase64:chunks[0]!.toString('base64'),chunkSha256:sha(chunks[0]!),objectSha256:sha(body),expiresAt:'2026-09-16T21:05:00.000Z'});
    const second=createRemoteBridgeChunkStore({root:state,now:()=>clock});
    await second.putChunk({transferId:'tx.restart',index:1,count:2,dataBase64:chunks[1]!.toString('base64'),chunkSha256:sha(chunks[1]!),objectSha256:sha(body),expiresAt:'2026-09-16T21:05:00.000Z'});
    await expect(second.finalizeTransfer('tx.restart')).resolves.toMatchObject({state:'COMPLETE',sha256:sha(body),totalBytes:body.length});

    const expiring=createRemoteBridgeChunkStore({root:state,now:()=>clock});
    const incomplete=Buffer.from('incomplete');
    await expiring.putChunk({transferId:'tx.expired',index:0,count:2,dataBase64:incomplete.toString('base64'),chunkSha256:sha(incomplete),objectSha256:sha(Buffer.concat([incomplete,Buffer.from('missing')])),expiresAt:'2026-09-16T21:01:00.000Z'});
    clock=new Date('2026-09-16T21:02:00.000Z');
    await expect(expiring.finalizeTransfer('tx.expired')).rejects.toThrow('REMOTE_BRIDGE_CHUNK_EXPIRED');
  });

  it('fails closed on malformed base64, digest mismatch and inconsistent transfer metadata',async()=>{
    const state=await root(),store=createRemoteBridgeChunkStore({root:state,now:()=>new Date('2026-09-16T21:00:00.000Z')});
    const body=Buffer.from('safe'),good={transferId:'tx.bad',index:0,count:2,dataBase64:body.toString('base64'),chunkSha256:sha(body),objectSha256:sha(Buffer.concat([body,body])),expiresAt:'2026-09-16T21:20:00.000Z'};
    await expect(store.putChunk({...good,dataBase64:'***'})).rejects.toThrow('REMOTE_BRIDGE_CHUNK_BASE64_INVALID');
    await expect(store.putChunk({...good,chunkSha256:'0'.repeat(64)})).rejects.toThrow('REMOTE_BRIDGE_CHUNK_DIGEST_MISMATCH');
    await store.putChunk(good);
    await expect(store.putChunk({...good,index:1,count:3})).rejects.toThrow('REMOTE_BRIDGE_CHUNK_COLLISION');
  });
});