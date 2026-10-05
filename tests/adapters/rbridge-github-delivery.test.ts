import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {createRBridgeGitHubCore} from '../../src/adapters/rbridgeGitHubCore.js';
import {cleanupRBridgeTestStates} from '../fixtures/rbridge-core-state.js';
import {createRBridgeGitHubFixture,githubFence,githubHash,githubUnfence} from '../fixtures/rbridge-github.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const run of cleanup.splice(0).reverse())await run();await cleanupRBridgeTestStates();});
async function fixture(output?:Parameters<typeof createRBridgeGitHubFixture>[0]){const f=await createRBridgeGitHubFixture(output);cleanup.push(()=>f.close());return f;}
async function ready(f:Awaited<ReturnType<typeof fixture>>){expect(await f.adapter.admit(f.issue())).toBe('CORE');expect((await f.deliveries.get(17))!.state).toBe('PENDING');expect(f.comments.get(17)).toEqual([]);return f.terminal();}
describe('independent resumable GitHub delivery',()=>{
  it('publication failure never reexecutes',async()=>{
    const f=await fixture(),original=await ready(f),before=await readFile(join(f.root,'operations/shared-read.json'));f.failAfter('COMMENT');
    await f.adapter.reconcileDeliveries(20);expect(f.issues.get(17)!.state).toBe('open');expect((await f.deliveries.get(17))!.state).toBe('PENDING');expect(f.comments.get(17)).toHaveLength(1);
    f.setNow(new Date('2026-10-06T10:00:00.000Z'));await createRBridgeGitHubCore(f.options).reconcileDeliveries(20);
    expect(f.calls).toBe(1);expect((await f.journal.get('shared-read'))!.receipt).toEqual(original);expect(await readFile(join(f.root,'operations/shared-read.json'))).toEqual(before);expect(f.comments.get(17)).toHaveLength(1);expect((await f.deliveries.get(17))!.state).toBe('PUBLISHED');
  });
  it('closed issue reconciliation proves its existing receipt',async()=>{
    const f=await fixture(),original=await ready(f);f.failAfter('CLOSE');await f.adapter.reconcileDeliveries(20);
    expect(f.issues.get(17)!.state).toBe('closed');expect((await f.deliveries.get(17))!.state).toBe('PENDING');const commentsBefore=structuredClone(f.comments.get(17));
    await createRBridgeGitHubCore(f.options).reconcileDeliveries(20);expect(f.comments.get(17)).toEqual(commentsBefore);expect((await f.deliveries.get(17))!.state).toBe('PUBLISHED');
    const envelope=githubUnfence(f.comments.get(17)![0]!.body),result=envelope.operationResult as {receipt:unknown;output:unknown};expect(result.receipt).toEqual(original);expect(githubHash(JSON.stringify(result.output))).toBe(original.resultSha256);expect(envelope.resultSha256).toBe(githubHash(JSON.stringify(result)));expect(envelope.resultSha256).not.toBe(original.resultSha256);expect(envelope.completedAt).toBe(original.transitions.at(-1)!.at);
  });
  it('a crash before local PUBLISHED acknowledgement needs no new comment or execution',async()=>{
    const f=await fixture();await ready(f);let failed=false;const adapter=createRBridgeGitHubCore({...f.options,deliveries:{...f.deliveries,async update(number,revision,next){if(next.state==='PUBLISHED'&&!failed){failed=true;throw new Error('LOCAL_COMMIT_FAILED');}return f.deliveries.update(number,revision,next);}}});
    await adapter.reconcileDeliveries(20);expect(failed).toBe(true);expect(f.issues.get(17)!.state).toBe('closed');expect((await f.deliveries.get(17))!.state).toBe('PENDING');
    await f.adapter.reconcileDeliveries(20);expect(f.comments.get(17)).toHaveLength(1);expect(f.calls).toBe(1);expect((await f.deliveries.get(17))!.state).toBe('PUBLISHED');
  });
  it('a closed issue without verified publication stays pending',async()=>{
    const f=await fixture();await ready(f);f.issues.get(17)!.state='closed';await f.adapter.reconcileDeliveries(20);expect((await f.deliveries.get(17))!.state).toBe('PENDING');expect(f.comments.get(17)).toEqual([]);expect(f.calls).toBe(1);
  });
  it('foreign-author receipts cannot authorize closure',async()=>{
    const f=await fixture();await ready(f);f.failAfter('COMMENT');await f.adapter.reconcileDeliveries(20);const forged=f.comments.get(17)![0]!;forged.authorLogin='attacker';
    await f.adapter.reconcileDeliveries(20);expect(f.comments.get(17)).toHaveLength(2);const record=(await f.deliveries.get(17))!;expect(record.publication!.receiptCommentId).toBe(f.comments.get(17)![1]!.id);expect(record.publication!.receiptCommentId).not.toBe(forged.id);
  });
  it('same-author conflicting receipt digest cannot be silently replaced',async()=>{
    const f=await fixture();await ready(f);f.failAfter('COMMENT');await f.adapter.reconcileDeliveries(20);const row=githubUnfence(f.comments.get(17)![0]!.body);row.resultSha256='a'.repeat(64);f.comments.get(17)![0]!.body=githubFence(row);
    await f.adapter.reconcileDeliveries(20);expect(f.issues.get(17)!.state).toBe('open');expect(f.comments.get(17)).toHaveLength(1);expect((await f.deliveries.get(17))!.state).toBe('PENDING');expect(f.calls).toBe(1);
  });
  it('paginated history exceeding2MiB is scanned pagewise rather than as one comments object',async()=>{
    const f=await fixture();await ready(f);for(let n=0;n<60;n++)f.addComment(17,'unrelated-'+ 'x'.repeat(50000),'reader');
    await f.adapter.reconcileDeliveries(20);expect((await f.deliveries.get(17))!.state).toBe('PUBLISHED');expect(Math.max(...f.pages)).toBeGreaterThan(2);expect(f.comments.get(17)).toHaveLength(61);
  });
  it('more than1024 comments cannot authorize a write or closure',async()=>{
    const f=await fixture();await ready(f);for(let n=0;n<1025;n++)f.addComment(17,'unrelated','reader');await f.adapter.reconcileDeliveries(20);
    expect(f.issues.get(17)!.state).toBe('open');expect(f.comments.get(17)).toHaveLength(1025);expect((await f.deliveries.get(17))!.state).toBe('PENDING');expect(Math.max(...f.pages)).toBeLessThanOrEqual(52);
  });
  it('missing chunks and lost manifest acknowledgements resume from exact frozen bytes',async()=>{
    const f=await fixture({data:'x'.repeat(100000)}),original=await ready(f);f.failAfter('MANIFEST');await f.adapter.reconcileDeliveries(20);
    const first=structuredClone(f.comments.get(17));expect(first?.some(c=>githubUnfence(c.body).schema==='COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1')).toBe(true);expect(f.issues.get(17)!.state).toBe('open');
    await createRBridgeGitHubCore(f.options).reconcileDeliveries(20);expect(f.comments.get(17)).toEqual(first);expect(f.calls).toBe(1);expect((await f.journal.get('shared-read'))!.receipt).toEqual(original);expect((await f.deliveries.get(17))!.state).toBe('PUBLISHED');
  });
  it('independently verifies the inner output digest before publishing any receipt',async()=>{
    const f=await fixture();await ready(f);const adapter=createRBridgeGitHubCore({...f.options,core:{...f.core,async result(id,cursor,max,ctx){const page=await f.core.result(id,cursor,max,ctx);if(page.status==='RESULT')return {...page,dataBase64:Buffer.from('{"observed":"evil"}').toString('base64'),nextCursor:19};return page;}}});
    await adapter.reconcileDeliveries(20);expect(f.comments.get(17)).toEqual([]);expect(f.issues.get(17)!.state).toBe('open');expect((await f.deliveries.get(17))!.state).toBe('PENDING');
  });
  it('8MiB output is published in bounded passes with at most8 missing chunks per pass',async()=>{
    const f=await fixture({data:'x'.repeat(8388608-11)}),receipt=await ready(f);
    // This consumer test uses the real committed output once, then a byte-page
    // port over those identical bytes; per-page disk verification is Task3's test.
    const bytes=await readFile(join(f.root,'results/shared-read.json'));
    expect(bytes.length).toBe(8388608);expect(githubHash(bytes)).toBe(receipt.resultSha256);
    const adapter=createRBridgeGitHubCore({...f.options,core:{...f.core,async result(_id,cursor,max){const part=bytes.subarray(cursor,Math.min(bytes.length,cursor+max));return {status:'RESULT' as const,receipt,resultSha256:receipt.resultSha256!,cursor,nextCursor:cursor+part.length,eof:cursor+part.length===bytes.length,dataBase64:part.toString('base64')};}}});
    let passes=0;while((await f.deliveries.get(17))!.state==='PENDING'&&passes++<33){const before=f.comments.get(17)!.filter(c=>githubUnfence(c.body).schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1').length;await adapter.reconcileDeliveries(20);const after=f.comments.get(17)!.filter(c=>githubUnfence(c.body).schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1').length;expect(after-before).toBeLessThanOrEqual(8);}
    expect((await f.deliveries.get(17))!.state).toBe('PUBLISHED');expect(passes).toBeGreaterThan(1);expect(f.calls).toBe(1);expect(f.comments.get(17)!.every(c=>Buffer.byteLength(c.body)<60000)).toBe(true);
    const rows=f.comments.get(17)!.map(c=>githubUnfence(c.body)),chunks=rows.filter(r=>r.schema==='COCWIN_REMOTE_BRIDGE_RESULT_CHUNK_V1').sort((a,b)=>Number(a.index)-Number(b.index)),manifest=rows.find(r=>r.schema==='COCWIN_REMOTE_BRIDGE_RESULT_MANIFEST_V1')!;
    const reconstructed=Buffer.concat(chunks.map(r=>Buffer.from(String(r.dataBase64),'base64')));expect(githubHash(reconstructed)).toBe(manifest.objectSha256);const envelope=JSON.parse(reconstructed.toString()) as {operationResult:{output:unknown;receipt:unknown}};expect(envelope.operationResult.receipt).toEqual(receipt);expect(githubHash(JSON.stringify(envelope.operationResult.output))).toBe(receipt.resultSha256);
  },60000);
});
