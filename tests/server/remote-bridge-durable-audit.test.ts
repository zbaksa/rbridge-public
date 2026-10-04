import {mkdtemp,mkdir,readFile,rename,rm,symlink,writeFile} from 'node:fs/promises';
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
const SESSION_ID='a'.repeat(32);
async function session(dir:string,state:string){
  const sessionDir=join(dir,'sessions',SESSION_ID);await mkdir(sessionDir,{recursive:true});
  await writeFile(join(sessionDir,'record.json'),JSON.stringify({
    schema:'COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1',sessionId:SESSION_ID,ownerDigest:'c'.repeat(64),
    profileId:'node-safe',state,createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:01:00.000Z',
    expiresAt:'2026-09-01T00:02:00.000Z',pid:null,identity:null,outputBytes:0,truncated:false,
    stdinAttached:false,exitCode:null,signal:null,reason:null,receipts:{}
  })+'\n');
  return sessionDir;
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
    await session(dir,'RUNNING');
    const out=await auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})});
    expect(out).toMatchObject({cutoverGate:'BLOCKED',activeSessions:1});expect(out.activeSessionIds).toEqual([SESSION_ID]);
  });

  it('does not treat UNCERTAIN as proof that a process stopped',async()=>{
    const dir=await root();await session(dir,'UNCERTAIN');
    const out=await auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})});
    expect(out).toMatchObject({cutoverGate:'BLOCKED',activeSessions:1});
  });

  it('rejects a session directory whose record disappeared instead of silently passing',async()=>{
    const dir=await root();await mkdir(join(dir,'sessions',SESSION_ID),{recursive:true});
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/SESSION_RECORD_MISSING/);
  });

  it('rejects unverified terminal session metadata',async()=>{
    const dir=await root(),path=await session(dir,'SUCCEEDED');
    await writeFile(join(path,'record.json'),JSON.stringify({state:'SUCCEEDED'}));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/SESSION_INVALID/);
  });

  it('does not follow or skip a symlinked durable record',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-8',issueNumber:8,phase:'PUBLISHED'});
    await rename(join(dir,'req-8.json'),join(dir,'record.backup'));
    await symlink(join(dir,'record.backup'),join(dir,'req-8.json'));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/FILE_INVALID/);
  });

  it('rejects a symlinked sessions root instead of reading outside the audited tree',async()=>{
    const dir=await root(),outside=await root();await symlink(outside,join(dir,'sessions'));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/SESSION_ROOT_INVALID/);
  });

  it('rejects a record whose filename does not bind its durable request identity',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-9',issueNumber:9,phase:'PUBLISHED'});
    await rename(join(dir,'req-9.json'),join(dir,'req-other.json'));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/FILENAME_MISMATCH/);
  });

  it('rejects missing intent digests rather than qualifying corrupt durable evidence',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-10',issueNumber:10,phase:'PUBLISHED'});
    const path=join(dir,'req-10.json'),row=JSON.parse(await readFile(path,'utf8'));delete row.requestSha256;
    await writeFile(path,JSON.stringify(row));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/DIGEST_INVALID/);
  });

  it('rejects zero lookup concurrency instead of issuing PASS without looking up unresolved work',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-11',issueNumber:11,phase:'SUBMITTED'});
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({11:{state:'open'}}),lookupConcurrency:0})).rejects.toThrow(/CONCURRENCY_INVALID/);
  });

  it('does not qualify a state snapshot that changed during issue lookup',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-12',issueNumber:12,phase:'SUBMITTED'});
    const issueLookup:DurableAuditIssueLookup=async number=>{
      await durable(dir,{requestId:'req-13',issueNumber:13,phase:'SUBMITTED'});
      return {number,state:'closed',authorLogin:'bridge-owner',title:'[COCWIN BRIDGE REQUEST] req-12',isPullRequest:false};
    };
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup})).rejects.toThrow(/SNAPSHOT_CHANGED/);
  });

  it('does not qualify an orphaned process START claim as an idle system',async()=>{
    const dir=await root(),claims=join(dir,'sessions','start-claims');await mkdir(claims,{recursive:true});
    await writeFile(join(claims,'c'.repeat(64)+'.json'),JSON.stringify({
      schema:'COCWIN_REMOTE_BRIDGE_PROCESS_START_CLAIM_V1',ownerDigest:'c'.repeat(64),
      sessionId:SESSION_ID,profileId:'node-safe',createdAt:'2026-09-01T00:00:00.000Z'
    }));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/SESSION_RECORD_MISSING/);
  });

  it('rejects a durable record missing its required creation evidence',async()=>{
    const dir=await root();await durable(dir,{requestId:'req-14',issueNumber:14,phase:'PUBLISHED'});
    const path=join(dir,'req-14.json'),row=JSON.parse(await readFile(path,'utf8'));delete row.createdAt;
    await writeFile(path,JSON.stringify(row));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/CREATED_AT_INVALID/);
  });

  it('rejects a terminal-state assertion with no process completion metadata',async()=>{
    const dir=await root(),path=await session(dir,'SUCCEEDED');
    await writeFile(join(path,'record.json'),JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_PROCESS_SESSION_V1',sessionId:SESSION_ID,ownerDigest:'c'.repeat(64),state:'SUCCEEDED'}));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/SESSION_INVALID/);
  });

  it('rejects a START claim that has lost its required profile and creation evidence',async()=>{
    const dir=await root();await session(dir,'FAILED');
    const claims=join(dir,'sessions','start-claims');await mkdir(claims);
    await writeFile(join(claims,'c'.repeat(64)+'.json'),JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_PROCESS_START_CLAIM_V1',ownerDigest:'c'.repeat(64),sessionId:SESSION_ID}));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/START_CLAIM_INVALID/);
  });

  it.each(['INVALID',['DONE']])('rejects a terminal PROCESS record with invalid receipt value %j',async value=>{
    const dir=await root(),sessionDir=await session(dir,'FAILED'),path=join(sessionDir,'record.json');
    const row=JSON.parse(await readFile(path,'utf8'));row.receipts={['d'.repeat(64)]:value};
    await writeFile(path,JSON.stringify(row));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/SESSION_INVALID/);
  });

  it('rejects process identity metadata that names no actual PID',async()=>{
    const dir=await root(),sessionDir=await session(dir,'FAILED'),path=join(sessionDir,'record.json');
    const row=JSON.parse(await readFile(path,'utf8'));row.identity={pid:null,startTimeTicks:'123',exe:'/usr/bin/node',cmdlineSha256:'d'.repeat(64)};
    await writeFile(path,JSON.stringify(row));
    await expect(auditRemoteBridgeDurableState({stateRoot:dir,expectedAuthor:'bridge-owner',issueLookup:lookup({})})).rejects.toThrow(/SESSION_INVALID/);
  });
});
