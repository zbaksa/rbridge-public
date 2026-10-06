import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {parseRemoteBridgeRequest,remoteBridgeRequestDigest} from '../../src/domain/remoteBridgeProtocol.js';
import {parseRemoteBridgeRequestV2,remoteBridgeRequestV2Digest} from '../../src/domain/remoteBridgeStage2Protocol.js';
import {parseRBridgeInstallProfile,encodeInstallReport,type IssueEvidence} from '../../src/installation/types.js';
import {openFixtureReadonlySnapshot} from '../../src/installation/readonlySnapshot.js';
import {auditLegacyGate,collectLegacyIssueNumbers} from '../../src/installation/legacyGate.js';
import type {GateContext} from '../../src/installation/gateContext.js';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex'),cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(options:{size?:number;phase?:string;changedBody?:boolean;missingLookup?:boolean;v2?:'HEALTH'|'APP_RUN';mutate?:(record:Record<string,unknown>,body:string)=>void;raw?:(raw:string)=>string}={}){
  const profile=parseRBridgeInstallProfile(JSON.parse(await readFile(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')));
  const root=await mkdtemp(join(tmpdir(),'rbridge-legacy-gate-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
  const app={appId:'fixture',jobId:'fixture-job',payload:{tool:'probe',cwd:'/home/rbridge',args:[],timeout_ms:1000,max_bytes:4096}},base={requestId:'legacy-fixture',createdAt:'2026-10-05T00:00:00.000Z',expiresAt:'2026-10-05T00:10:00.000Z'};
  const body=JSON.stringify(options.v2?{schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',...base,operation:options.v2==='HEALTH'?{kind:'HEALTH',action:'STATUS'}:{kind:'APP_RUN',...app}}:{schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V1',...base,...app,operation:'RUN'});
  let requestSHA:string,jobId:string;
  if(options.v2){const request=parseRemoteBridgeRequestV2({title:'[COCWIN BRIDGE REQUEST] legacy-fixture',body,author:'zbaksa',repository:profile.binding.repository,expectedAuthor:'zbaksa',expectedRepository:profile.binding.repository,now:new Date('2026-10-06T00:00:00.000Z'),allowExpired:true});requestSHA=remoteBridgeRequestV2Digest(request);jobId=request.operation.kind==='APP_RUN'?request.operation.jobId:'host-'+requestSHA.slice(0,48);}
  else{const request=parseRemoteBridgeRequest({title:'[COCWIN BRIDGE REQUEST] legacy-fixture',body,authorLogin:'zbaksa',expectedAuthorLogin:'zbaksa',allowExpired:true});requestSHA=remoteBridgeRequestDigest(request);jobId=request.jobId;}
  const payload={state:'SUCCEEDED',stdout:''};
  const result={schema:options.v2?'COCWIN_REMOTE_BRIDGE_RESULT_V2':'COCWIN_REMOTE_BRIDGE_RESULT_V1',requestId:base.requestId,issueNumber:17,status:'PASS',requestSha256:requestSHA,resultSha256:sha(JSON.stringify(payload)),[options.v2?'operationResult':'controllerResult']:payload,completedAt:'2026-10-05T00:01:00.000Z'};
  const record:Record<string,unknown>={schema:'COCWIN_REMOTE_BRIDGE_STORE_V1',requestId:base.requestId,requestSha256:requestSHA,issueNumber:17,jobId,phase:options.phase??'PUBLISHED',createdAt:'2026-10-05T00:00:01.000Z',updatedAt:'2026-10-05T00:01:01.000Z',...(['CLAIMED','SUBMITTED'].includes(options.phase??'')?{}:{result})};
  if(options.size){payload.stdout='x'.repeat(options.size-Buffer.byteLength(JSON.stringify(record)));result.resultSha256=sha(JSON.stringify(payload));}
  options.mutate?.(record,body);
  await writeFile(join(root,base.requestId+'.json'),options.raw?.(JSON.stringify(record))??JSON.stringify(record),{mode:0o600});
  const snapshot=await openFixtureReadonlySnapshot(root,process.getuid!());cleanup.push(()=>snapshot.close());
  const value={number:17,state:'CLOSED' as const,title:'[COCWIN BRIDGE REQUEST] '+base.requestId,body:options.changedBody?body.replace('"probe"','"node"'):body,author:'zbaksa',url:'https://github.com/zbaksa/rbridge-public/issues/17',isPullRequest:false,updatedAt:'2026-10-05T00:01:01.000Z'};
  const issue:IssueEvidence={...value,capture_sha256:sha(encodeInstallReport(value))};
  const token={transaction_id:'a'.repeat(32),state_root_identity_sha256:'1'.repeat(64),tree_sha256:snapshot.treeSHA256,entries:snapshot.entries.length,bytes:snapshot.bytes,pause_sha256:'2'.repeat(64),captured_at:'2026-10-06T00:00:00.000Z'};
  const context:GateContext={profile,snapshot,token,issues:options.missingLookup?[]:[issue],lookup:{scope:'FIXTURE_AUTHORITY_ONLY',status:'PASS',viewer:'zbaksa',repository:profile.binding.repository,profile_sha256:sha(encodeInstallReport(profile)),snapshot_sha256:sha(encodeInstallReport(token)),capture_sha256:sha(encodeInstallReport(options.missingLookup?[]:[issue]))}};
  return {context,record,root};
}
describe('complete immutable legacy gate',()=>{
  it('discovers every retained issue number before authenticated lookup without declaring admission PASS',async()=>{
    const f=await fixture({missingLookup:true});expect(await collectLegacyIssueNumbers(f.context)).toEqual([17]);
    const invalid=await fixture({mutate:r=>{r.issueNumber=2147483648;delete r.result;r.phase='SUBMITTED';}});await expect(collectLegacyIssueNumbers(invalid.context)).rejects.toThrow();
  });
  it('preserves closed unscoped unresolved history and published terminal results',async()=>{
    for(const phase of ['SUBMITTED','TERMINAL','PUBLISHED']){const f=await fixture({phase}),before=f.context.snapshot.treeSHA256;expect((await auditLegacyGate(f.context)).status).toBe('PASS');await f.context.snapshot.verify();expect(f.context.snapshot.treeSHA256).toBe(before);expect('scopeSha256'in f.record).toBe(false);}
  });
  it('accepts65537 and2MiB legacy records while larger records block',async()=>{
    for(const size of [65537,2097152,2097153]){const f=await fixture({size});expect((await auditLegacyGate(f.context)).status).toBe(size<=2097152?'PASS':'BLOCKED');}
  });
  it('changed body and omitted lookup never pass, including published rows',async()=>{
    const changed=await fixture({changedBody:true});expect((await auditLegacyGate(changed.context)).status).toBe('BLOCKED');const omitted=await fixture({missingLookup:true});expect((await auditLegacyGate(omitted.context)).status).toBe('UNKNOWN');
  });
  it('correlates both V2 APP and host request digests and derived job identities',async()=>{
    for(const v2 of ['APP_RUN','HEALTH'] as const){const valid=await fixture({v2});expect((await auditLegacyGate(valid.context)).status).toBe('PASS');const wrong=await fixture({v2,mutate:r=>{r.jobId='wrong-job';}});expect((await auditLegacyGate(wrong.context)).status).toBe('BLOCKED');}
  });
  it('unresolved open trusted work blocks',async()=>{
    const f=await fixture({phase:'SUBMITTED'}),issue=f.context.issues[0]!,base=Object.fromEntries(Object.entries(issue).filter(([k])=>k!=='capture_sha256')) as Omit<IssueEvidence,'capture_sha256'>;const open={...base,state:'OPEN' as const};
    const updated={...open,capture_sha256:sha(encodeInstallReport(open))};
    const context={...f.context,issues:[updated],lookup:{...f.context.lookup,capture_sha256:sha(encodeInstallReport([updated]))}};
    expect((await auditLegacyGate(context)).status).toBe('BLOCKED');
  });
  it('rejects scope, result digest, job and timestamp drift without rewriting it',async()=>{
    const mutations=[(r:Record<string,unknown>)=>{r.scopeSha256='f'.repeat(64);},(r:Record<string,unknown>)=>{(r.result as Record<string,unknown>).resultSha256='f'.repeat(64);},(r:Record<string,unknown>)=>{r.jobId='other';},(r:Record<string,unknown>)=>{r.updatedAt='2026-10-04T00:00:00.000Z';}];
    for(const mutate of mutations){const f=await fixture({mutate}),before=f.context.snapshot.treeSHA256;expect((await auditLegacyGate(f.context)).status).toBe('BLOCKED');await f.context.snapshot.verify();expect(f.context.snapshot.treeSHA256).toBe(before);}
  });
  it('rejects duplicate keys and unexpected terminal fields',async()=>{
    for(const raw of [(s:string)=>s.replace('"schema":','"phase":"PUBLISHED","schema":'),(s:string)=>s.replace('"status":"PASS"','"status":"PASS","unexpected":true')]){const f=await fixture({raw});expect((await auditLegacyGate(f.context)).status).toBe('BLOCKED');}
  });
  it('preserves producer APP number semantics and full bounded arrays',async()=>{
    for(const payload of [{state:'SUCCEEDED',mtime_ns:1600000000000000000},{state:'SUCCEEDED',values:Array(100001).fill(0)}]){
      const f=await fixture({mutate:r=>{const result=r.result as Record<string,unknown>;result.controllerResult=payload;result.resultSha256=sha(JSON.stringify(payload));}});
      expect((await auditLegacyGate(f.context)).status).toBe('PASS');
    }
  });
  it('keeps closed raw-body expired rejection separate from canonical admission',async()=>{
    const make=async(reason:string,schema='COCWIN_REMOTE_BRIDGE_RESULT_V1')=>fixture({mutate:(r,body)=>{
      // Whitespace makes the raw body digest distinct from the canonical request digest.
      const raw=' '+body;
      r.requestSha256=sha(raw);r.updatedAt='2026-10-05T00:11:01.000Z';
      r.result={schema,requestId:r.requestId,issueNumber:17,status:'BLOCKED',requestSha256:r.requestSha256,completedAt:'2026-10-05T00:11:00.000Z',reason};
    }});
    for(const [reason,schema,expected] of [['REMOTE_BRIDGE_REQUEST_EXPIRED','COCWIN_REMOTE_BRIDGE_RESULT_V1','PASS'],['REMOTE_BRIDGE_TOOL_INVALID','COCWIN_REMOTE_BRIDGE_RESULT_V1','BLOCKED'],['REMOTE_BRIDGE_REQUEST_EXPIRED','COCWIN_REMOTE_BRIDGE_RESULT_V2','BLOCKED']]){
      const f=await make(reason!,schema),old=f.context.issues[0]!,base={...Object.fromEntries(Object.entries(old).filter(([k])=>k!=='capture_sha256')),body:' '+old.body} as Omit<IssueEvidence,'capture_sha256'>;
      const issue={...base,capture_sha256:sha(encodeInstallReport(base))},issues=[issue];
      expect((await auditLegacyGate({...f.context,issues,lookup:{...f.context.lookup,capture_sha256:sha(encodeInstallReport(issues))}})).status).toBe(expected);
    }
  });
});
