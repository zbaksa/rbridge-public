import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {createRBridgeDeliveryJournal,type RBridgeGitHubDeliveryIdentity} from '../../src/server/rbridgeDeliveryJournal.js';
import {cleanupRBridgeTestStates,createRBridgeTestState} from '../fixtures/rbridge-core-state.js';
const identity=(issueNumber=1):RBridgeGitHubDeliveryIdentity=>({repository:'example/control',issueNumber,authorLogin:'operator',title:'SAFE read-1',bodySha256:'a'.repeat(64),requestSha256:'b'.repeat(64),operationId:'read-1',intentSha256:'c'.repeat(64)});
afterEach(cleanupRBridgeTestStates);
async function fixture(){const state=await createRBridgeTestState(),deliveries=await createRBridgeDeliveryJournal({...state});return {...state,deliveries};}

describe('independent GitHub delivery storage',()=>{
  it('persists delivery identity and CAS without changing an operation receipt',async()=>{
    const f=await fixture();await f.claim();const before=await readFile(join(f.root,'operations','read-1.json'));
    const first=await f.deliveries.claim(identity());expect(first).toMatchObject({state:'PENDING',revision:1,attempts:0});expect(await f.deliveries.claim(identity())).toEqual(first);
    const next=await f.deliveries.update(1,1,{...first,revision:2,attempts:1,lastReason:'publication-retry'});
    const reopened=await createRBridgeDeliveryJournal({...f});expect(await reopened.get(1)).toEqual(next);await expect(f.deliveries.update(1,1,{...first,revision:2})).rejects.toThrow();
    expect(await readFile(join(f.root,'operations','read-1.json'))).toEqual(before);
  });
  it('delivery exhaustion leaves execution intact and allocates no legacy claim',async()=>{
    const f=await fixture(),record=await f.claim(),journal={...f.journal,reserveDelivery:async()=>{throw new Error('RBRIDGE_CORE_CAPACITY_REACHED');}};
    const deliveries=await createRBridgeDeliveryJournal({...f,journal});await expect(deliveries.claim(identity())).rejects.toThrow('RBRIDGE_CORE_CAPACITY_REACHED');
    expect(await f.journal.get('read-1')).toEqual(record);expect(await readdir(join(f.root,'deliveries/github'))).toEqual([]);expect(await readdir(join(f.root,'operations'))).toEqual(['read-1.json']);
  });
  it('pending delivery scans do not depend on an open-issue list',async()=>{
    const f=await fixture();await f.deliveries.claim(identity(1));await f.deliveries.claim(identity(2));expect((await f.deliveries.pending(1)).map(r=>r.identity.issueNumber)).toHaveLength(1);expect((await f.deliveries.pending(128)).map(r=>r.identity.issueNumber).sort()).toEqual([1,2]);
    await expect(f.deliveries.pending(129)).rejects.toThrow();
  });
  it('freezes published identity and rejects changed publication progress',async()=>{
    const f=await fixture(),first=await f.deliveries.claim(identity()),prepared=await f.deliveries.update(1,1,{...first,revision:2,publication:{envelopeSha256:'d'.repeat(64),totalBytes:80000,chunkCount:2,nextIndex:1}});
    await expect(f.deliveries.update(1,2,{...prepared,revision:3,publication:{...prepared.publication!,nextIndex:0}})).rejects.toThrow();
    await expect(f.deliveries.claim({...identity(),bodySha256:'e'.repeat(64)})).rejects.toThrow();
    const published=await f.deliveries.update(1,2,{...prepared,revision:3,state:'PUBLISHED',publication:{...prepared.publication!,nextIndex:2,manifestCommentId:10,receiptCommentId:11}});
    await expect(f.deliveries.update(1,3,{...published,revision:4,lastReason:'rewrite'})).rejects.toThrow();expect(await f.deliveries.get(1)).toEqual(published);
  });
  it('retains corrupt filename identity and oversized records without repair',async()=>{
    const f=await fixture(),first=await f.deliveries.claim(identity()),path=join(f.root,'deliveries/github','1.json');
    await writeFile(path,JSON.stringify({...first,identity:{...first.identity,issueNumber:2}}));const before=await readFile(path);await expect(createRBridgeDeliveryJournal({...f})).rejects.toThrow();expect(await readFile(path)).toEqual(before);
    await writeFile(path,'x'.repeat(131073));await expect(f.deliveries.get(1)).rejects.toThrow();expect((await readFile(path)).length).toBe(131073);
  });
  it('validates publication fields before allocation and bounds failure reasons by UTF-8',async()=>{
    const f=await fixture(),first=await f.deliveries.claim(identity());
    await expect(f.deliveries.update(1,1,{...first,revision:2,lastReason:'é'.repeat(257)})).rejects.toThrow();
    await expect(f.deliveries.update(1,1,{...first,revision:2,publication:{envelopeSha256:'d'.repeat(64),totalBytes:10,chunkCount:1,nextIndex:2}})).rejects.toThrow();expect(await f.deliveries.get(1)).toEqual(first);
  });
});
