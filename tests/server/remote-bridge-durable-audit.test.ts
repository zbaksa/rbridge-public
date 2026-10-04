import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {auditRemoteBridgeDurableState,type DurableAuditIssueLookup} from '../../src/server/remoteBridgeDurableAudit.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function root(){const dir=await mkdtemp(join(tmpdir(),'rbridge-durable-audit-'));roots.push(dir);return dir;}
async function durable(dir:string,input:{requestId:string;issueNumber:number;phase:string;scope?:boolean}){
  await writeFile(join(dir,`${input.requestId}.json`),JSON.stringify({
    schema:'COCWIN_REMOTE_BRIDGE_STORE_V1',
    requestId:input.requestId,
    requestSha256:'a'.repeat(64),
    ...(input.scope?{scopeSha256:'b'.repeat(64)}:{}),
    issueNumber:input.issueNumber,
    jobId:'job-1',
    phase:input.phase,
    createdAt:'2026-09-01T00:00:00.000Z',
    updatedAt:'2026-09-01T00:01:00.000Z'
  })+'\n');
}
function lookup(states:Record<number,{state:'open'|'closed';author?:string;title?:string}>):DurableAuditIssueLookup{
  return async number=>{
    const row=states[number];if(!row)throw new Error('NOT_FOUND');
    return {number,state:row.state,authorLogin:row.author??'bridge-owner',title:row.title??`[COCWIN BRIDGE REQUEST] req-${number}`,isPullRequest:false};
  };
}

describe('V1 durable-state cutover audit',()=>{
  it('passes when unresolved historical records are attached only to closed trusted issues',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-1',issueNumber:1,phase:'SUBMITTED'});
    const out=await auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({1:{state:'closed'}})});
    expect(out).toMatchObject({auditStatus:'PASS',cutoverGate:'PASS',unresolvedRecords:1,unresolvedOpenTrusted:0,unresolvedClosedTrusted:1,activeSessions:0,unscopedRecords:1});
  });

  it('blocks when a trusted unresolved request issue is still open',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-2',issueNumber:2,phase:'SUBMITTED'});
    const out=await auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({2:{state:'open'}})});
    expect(out.cutoverGate).toBe('BLOCKED');expect(out.unresolvedOpenTrusted).toBe(1);expect(out.openTrusted[0]).toMatchObject({requestId:'req-2',issueNumber:2,phase:'SUBMITTED'});
  });

  it('treats CLAIMED and unpublished TERMINAL records as unresolved for cutover',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-3',issueNumber:3,phase:'CLAIMED'});await durable(dir,{requestId:'req-4',issueNumber:4,phase:'TERMINAL'});
    const out=await auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({3:{state:'closed'},4:{state:'closed'}})});
    expect(out).toMatchObject({cutoverGate:'PASS',unresolvedRecords:2,unresolvedClosedTrusted:2});
  });

  it('blocks identity mismatches instead of trusting issue state alone',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-5',issueNumber:5,phase:'SUBMITTED'});
    const out=await auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({5:{state:'closed',author:'other'}})});
    expect(out.cutoverGate).toBe('BLOCKED');expect(out.identityMismatches).toBe(1);expect(out.identityMismatchIssues).toEqual([5]);
  });

  it('returns UNKNOWN when GitHub lookup cannot prove issue state',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-6',issueNumber:6,phase:'SUBMITTED'});
    const out=await auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:async()=>{throw new Error('transport');}});
    expect(out).toMatchObject({auditStatus:'UNKNOWN',cutoverGate:'UNKNOWN',lookupErrors:1});
  });

  it('blocks while a process session is not terminal',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-7',issueNumber:7,phase:'PUBLISHED'});
    const sessionDir=join(dir,'sessions','abc');await mkdir(sessionDir,{recursive:true});
    await writeFile(join(sessionDir,'record.json'),JSON.stringify({state:'RUNNING'})+'\n');
    const out=await auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})});
    expect(out).toMatchObject({cutoverGate:'BLOCKED',activeSessions:1});expect(out.activeSessionIds).toEqual(['abc']);
  });
});
