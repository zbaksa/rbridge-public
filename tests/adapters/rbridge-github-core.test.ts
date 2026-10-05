import {afterEach,describe,expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRBridgeGitHubCore} from '../../src/adapters/rbridgeGitHubCore.js';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRemoteBridgeWorker} from '../../src/server/remoteBridgeWorker.js';
import {cleanupRBridgeTestStates} from '../fixtures/rbridge-core-state.js';
import {createRBridgeGitHubFixture,githubIssue,githubRepository,githubUnfence} from '../fixtures/rbridge-github.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const run of cleanup.splice(0).reverse())await run();await cleanupRBridgeTestStates();});
async function fixture(){const f=await createRBridgeGitHubFixture();cleanup.push(()=>f.close());return f;}
describe('authenticated GitHub core admission',()=>{
  it('authenticates before delegation and preserves known expired IDs',async()=>{
    const f=await fixture(),request=f.issue();await f.adapter.admit(request);const receipt=await f.terminal();
    f.setNow(new Date('2026-10-05T11:00:00.000Z'));expect(await f.adapter.admit(request)).toBe('CORE');
    expect((await f.journal.get('shared-read'))!.receipt).toEqual(receipt);expect(f.calls).toBe(1);
    const fresh=f.issue(githubIssue(18,'fresh-expired'));expect(await f.adapter.admit(fresh)).toBe('PUBLICATION_UNAVAILABLE');expect(await f.journal.get('fresh-expired')).toBeUndefined();
  });
  it('wrong repository and author create neither an operation nor delivery',async()=>{
    const f=await fixture(),request=f.issue();
    for(const bad of [{...request,authorLogin:'attacker'},{...request,url:'https://github.com/evil/repo/issues/17'},{...request,number:0}])expect(await f.adapter.admit(bad)).toBe('PUBLICATION_UNAVAILABLE');
    expect(f.journal.capacity().identities).toBe(0);expect(await f.deliveries.get(17)).toBeUndefined();expect(f.comments.get(17)).toEqual([]);
  });
  it('rereads current issue identity before creating a claim',async()=>{
    const f=await fixture(),request=f.issue();f.issues.get(17)!.body=githubIssue(17,'changed').body;
    expect(await f.adapter.admit(request)).toBe('PUBLICATION_UNAVAILABLE');expect(f.journal.capacity().identities).toBe(0);expect(await f.deliveries.get(17)).toBeUndefined();
  });
  it('unsafe and over-depth JSON never enters the recursive V2 digest or core',async()=>{
    const f=await fixture();let deep:unknown='leaf';for(let n=0;n<25;n++)deep={deep};
    for(const args of [JSON.parse('{"nested":{"constructor":{}}}'),{deep}]){
      const request=f.issue(githubIssue(17,'unsafe',{kind:'PROCESS',action:'START',args}));expect(await f.adapter.admit(request)).toBe('PUBLICATION_UNAVAILABLE');
    }
    expect(f.journal.capacity().identities).toBe(0);expect(await f.deliveries.get(17)).toBeUndefined();
  });
  it('a fresh issue replays the same intent but a collision never acquires a fake receipt',async()=>{
    const f=await fixture();await f.adapter.admit(f.issue());const original=await f.terminal(),path=join(f.root,'operations/shared-read.json'),before=await readFile(path);
    await f.adapter.admit(f.issue(githubIssue(18)));expect(f.calls).toBe(1);expect((await f.journal.get('shared-read'))!.receipt).toEqual(original);
    expect(await f.adapter.admit(f.issue(githubIssue(19,'shared-read',{kind:'FILE',action:'READ',target:'/mnt/data/other',args:{}})))).toBe('PUBLICATION_UNAVAILABLE');
    expect(await readFile(path)).toEqual(before);expect(await f.deliveries.get(19)).toBeUndefined();expect(f.comments.get(19)).toEqual([]);
  });
  it('delivery capacity failure retains accepted execution and allows later reconciliation',async()=>{
    const f=await fixture(),request=f.issue();const failing=createRBridgeGitHubCore({...f.options,deliveries:{...f.deliveries,async claim(){throw new Error('RBRIDGE_CORE_CAPACITY_REACHED');}}});
    expect(await failing.admit(request)).toBe('PUBLICATION_UNAVAILABLE');const receipt=await f.terminal();expect(f.calls).toBe(1);expect(await f.deliveries.get(17)).toBeUndefined();
    await f.adapter.admit(request);expect(f.calls).toBe(1);expect((await f.journal.get('shared-read'))!.receipt).toEqual(receipt);expect((await f.deliveries.get(17))!.state).toBe('PUBLISHED');
  });
  it('unsupported SAFE obtains the durable core BLOCK path without invoking a handler',async()=>{
    const f=await fixture(),request=f.issue(githubIssue(17,'blocked-write',{kind:'FILE',action:'WRITE_TEXT',target:'/mnt/data/new',args:{text:'never-write'}}));
    expect(await f.adapter.admit(request)).toBe('CORE');const record=(await f.journal.get('blocked-write'))!;
    expect(record.receipt.transitions.map(t=>t.phase)).toEqual(['CLAIMED','TERMINAL']);expect(record.receipt.outcome).toBe('BLOCKED');expect(f.calls).toBe(0);expect(f.issues.get(17)!.state).toBe('closed');
    const published=githubUnfence(f.comments.get(17)![0]!.body);expect(published.status).toBe('BLOCKED');expect(published.operationResult).toMatchObject({schema:'RBRIDGE_GITHUB_CORE_RESULT_V1',receipt:record.receipt});
  });
  it('issue mutation blocks delivery without rewriting or reexecuting the winner',async()=>{
    const f=await fixture(),request=f.issue();await f.adapter.admit(request);const original=await f.terminal();f.issues.get(17)!.authorLogin='attacker';
    await f.adapter.reconcileDeliveries(20);expect((await f.deliveries.get(17))!.state).toBe('IDENTITY_BLOCKED');expect(f.calls).toBe(1);expect((await f.journal.get('shared-read'))!.receipt).toEqual(original);expect(f.events).not.toContain('CLOSE');
  });
  it('changed published issue identity cannot be reported as a successful admission',async()=>{
    const f=await fixture();await f.adapter.admit(f.issue());const original=await f.terminal();await f.adapter.reconcileDeliveries(20);const published=(await f.deliveries.get(17))!,comments=structuredClone(f.comments.get(17));expect(published.state).toBe('PUBLISHED');
    const changed=githubIssue(17,'shared-read',{kind:'FILE',action:'READ',target:'/mnt/data/other',args:{}});f.issues.set(17,{...changed,state:'open'});
    expect(await f.adapter.admit(changed)).toBe('PUBLICATION_UNAVAILABLE');expect(await f.deliveries.get(17)).toEqual(published);expect((await f.journal.get('shared-read'))!.receipt).toEqual(original);expect(f.comments.get(17)).toEqual(comments);expect(f.calls).toBe(1);
  });
  it('a closed fresh issue cannot admit an unexecuted operation',async()=>{
    const f=await fixture(),request=f.issue();f.issues.get(17)!.state='closed';expect(await f.adapter.admit(request)).toBe('PUBLICATION_UNAVAILABLE');expect(f.journal.capacity().identities).toBe(0);
  });
  it('configured GitHub context shares the deployment scope without issue-selected authority',async()=>{
    const f=await fixture(),request=f.issue();await f.adapter.admit(request);await f.terminal();const record=(await f.journal.get('shared-read'))!;
    expect(record.observations.GITHUB?.first).toEqual({schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'GITHUB',authenticatedSubject:githubRepository+':bridge-owner',principalId:'operator',requestRef:'issue:17'});expect(record.receipt.targetInstanceId).toBe('aether');
  });
  it('finalizes a later closed lost-ACK delivery despite20 permanently unavailable carriers and open-list failure',async()=>{
    const f=await fixture(),requests=Array.from({length:21},(_,index)=>f.issue(githubIssue(index+1)));
    for(const request of requests)expect(await f.adapter.admit(request)).toBe('CORE');
    await f.terminal();const before=await readFile(join(f.root,'operations/shared-read.json'));
    const first=await f.deliveries.pending(20),prefix=new Set(first.map(record=>record.identity.issueNumber)),later=requests.find(request=>!prefix.has(request.number))!;
    for(const record of first)f.issues.get(record.identity.issueNumber)!.state='closed';
    f.failAfter('CLOSE');expect(await f.adapter.admit(later)).toBe('PUBLICATION_UNAVAILABLE');expect(f.issues.get(later.number)!.state).toBe('closed');expect((await f.deliveries.get(later.number))!.state).toBe('PENDING');expect(f.comments.get(later.number)).toHaveLength(1);
    const unavailable=async()=>{throw new Error('LEGACY_MUST_NOT_EXECUTE');};
    const worker=createRemoteBridgeWorker({repository:githubRepository,authorLogin:f.options.authorLogin,instanceId:'aether',now:f.options.now,githubCore:f.adapter,reservations:{async isReserved(){return false;}},store:createRemoteBridgeStore(join(f.root,'unused-legacy')),controller:{submit:unavailable,status:unavailable,result:unavailable},github:{async listOpenRequests(){throw new Error('TEST_OPEN_LIST_UNAVAILABLE');},publishResult:unavailable}});
    for(let pass=0;pass<2;pass++)await expect(worker.runOnce()).rejects.toThrow('TEST_OPEN_LIST_UNAVAILABLE');
    expect((await f.deliveries.get(later.number))!.state).toBe('PUBLISHED');expect(f.comments.get(later.number)).toHaveLength(1);expect(f.calls).toBe(1);expect(await readFile(join(f.root,'operations/shared-read.json'))).toEqual(before);
    for(const record of first){expect((await f.deliveries.get(record.identity.issueNumber))!.state).toBe('PENDING');expect(f.comments.get(record.identity.issueNumber)).toEqual([]);}
  },15000);
});
