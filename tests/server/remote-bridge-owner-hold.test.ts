import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {
  RBRIDGE_OWNER_HOLD_PATH,createPinnedOwnerHoldDecision,createProtectedOwnerHold,
  loadProtectedOwnerHold,validateOwnerHoldManifest,type OwnerHoldManifest,
} from '../../src/server/remoteBridgeOwnerHold.js';

const context={repository:'example/rbridge-control',authorLogin:'bridge-owner',instanceId:'machine-test-001',runtimeUid:1027,runtimeGid:1027};
const sha=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
function canonical(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object'){
    const obj=value as Record<string,unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map(k=>[k,canonical(obj[k])]));
  }
  return value;
}
function fixture():OwnerHoldManifest{
  const apps=['aplall','aplall','aplall','dart','dart','editor','editor','editor','editor'];
  return {
    schema:'RBRIDGE_OWNER_APP_RUN_HOLD_V1',mode:'HOLD',
    repository:context.repository,authorLogin:context.authorLogin,instanceId:context.instanceId,
    apps:['aplall','dart','editor'],
    originals:apps.map((appId,i)=>({
      appId,issueNumber:101+i,requestId:'old-request-'+i,jobId:'old-job-'+i,
      requestSha256:(i+1).toString(16).repeat(64),storeSha256:(i+1).toString(16).repeat(64),
      phase:'WAITING',scope:'UNSCOPED',
    })),
  };
}
function packageOf(value:unknown){
  const raw=Buffer.from(JSON.stringify(canonical(value))+'\n');
  return{raw,ctx:{...context,expectedSha256:sha(raw)}};
}
function accept(value:unknown=fixture()){
  const data=packageOf(value);return validateOwnerHoldManifest(data.raw,data.ctx);
}
describe('owner-controlled exact-app HOLD manifest, source-only',()=>{
  it('parses a pinned, canonical nine-row manifest with original phase and byte pins',()=>{
    const out=accept();
    expect(out.apps).toEqual(['aplall','dart','editor']);
    expect(out.originals).toHaveLength(9);
    expect(out.originals.filter(r=>r.appId==='aplall')).toHaveLength(3);
    expect(out.originals.filter(r=>r.appId==='dart')).toHaveLength(2);
    expect(out.originals.filter(r=>r.appId==='editor')).toHaveLength(4);
    expect(RBRIDGE_OWNER_HOLD_PATH).toBe('/etc/rbridge/owner-app-run-hold-v1.json');
  });
  it('rejects any unpinned or changed raw owner bytes before parsing/authority',()=>{
    const p=packageOf(fixture());
    expect(()=>validateOwnerHoldManifest(p.raw,{...p.ctx,expectedSha256:undefined})).toThrow('RBRIDGE_OWNER_HOLD_PIN_REQUIRED');
    expect(()=>validateOwnerHoldManifest(Buffer.concat([p.raw,Buffer.from('x')]),p.ctx)).toThrow('RBRIDGE_OWNER_HOLD_DIGEST_MISMATCH');
    expect(()=>validateOwnerHoldManifest(p.raw,{...p.ctx,expectedSha256:'f'.repeat(64)})).toThrow('RBRIDGE_OWNER_HOLD_DIGEST_MISMATCH');
    expect(()=>validateOwnerHoldManifest(p.raw,{...p.ctx,instanceId:'wrong-machine'})).toThrow('RBRIDGE_OWNER_HOLD_SCOPE_INVALID');
    expect(()=>validateOwnerHoldManifest(p.raw,{...p.ctx,repository:'other/bridge'})).toThrow('RBRIDGE_OWNER_HOLD_SCOPE_INVALID');
  });
  it('never accepts release, narrowed/expanded app scope or extra manifest members',()=>{
    for(const modify of [
      (x:Record<string,unknown>)=>{x.mode='RELEASE';},
      (x:Record<string,unknown>)=>{x.apps=['dart','editor'];},
      (x:Record<string,unknown>)=>{x.apps=['aplall','dart','editor','games2d'];},
      (x:Record<string,unknown>)=>{x.extra='unknown';},
      (x:Record<string,unknown>)=>{x.instanceId='foreign';},
    ]){
      const row=structuredClone(fixture()) as unknown as Record<string,unknown>;
      modify(row);expect(()=>accept(row)).toThrow(/RBRIDGE_OWNER_HOLD_/);
    }
  });
  it('never accepts incomplete, reordered, duplicated or altered original nine-row evidence',()=>{
    for(const mutate of [
      (x:OwnerHoldManifest)=>{x.originals.pop();},
      (x:OwnerHoldManifest)=>{x.originals[0]!.issueNumber=999;},
      (x:OwnerHoldManifest)=>{x.originals[1]!.requestId=x.originals[0]!.requestId;},
      (x:OwnerHoldManifest)=>{x.originals[3]!.appId='aplall';},
      (x:OwnerHoldManifest)=>{x.originals[0]!.phase='TERMINAL' as 'WAITING';},
      (x:OwnerHoldManifest)=>{x.originals[0]!.scope='SCOPED' as 'UNSCOPED';},
      (x:OwnerHoldManifest)=>{x.originals[0]!.requestSha256='0';},
    ]){
      const row=structuredClone(fixture());
      mutate(row);expect(()=>accept(row)).toThrow('RBRIDGE_OWNER_HOLD_ORIGINALS_INVALID');
    }
  });
  it('rejects noncanonical JSON despite a matching digest; duplicate key/spacing is not normalized',()=>{
    const value=fixture(),raw=Buffer.from(JSON.stringify(value)+'\n'),ctx={...context,expectedSha256:sha(raw)};
    expect(()=>validateOwnerHoldManifest(raw,ctx)).toThrow('RBRIDGE_OWNER_HOLD_CANONICAL_INVALID');
    const p=packageOf(value);
    expect(()=>validateOwnerHoldManifest(Buffer.from(p.raw.toString().replace('"mode":"HOLD"','"mode":"HOLD","mode":"HOLD"')),
      {...p.ctx,expectedSha256:sha(Buffer.from(p.raw.toString().replace('"mode":"HOLD"','"mode":"HOLD","mode":"HOLD"')))})).toThrow('RBRIDGE_OWNER_HOLD_CANONICAL_INVALID');
  });
  it('keeps held apps blocked after owner-policy disappearance or readback failure, without affecting unrelated apps',async()=>{
    const check=vi.fn(()=>{throw Error('OWNER_FILE_DISAPPEARED');});
    const decide=createPinnedOwnerHoldDecision(fixture(),check);
    for(const appId of ['aplall','dart','editor']){
      await expect(decide({appId,requestId:'new-job',jobId:'different',issueNumber:900,requestSha256:'0'.repeat(64)})).resolves.toBe(true);
    }
    expect(check).toHaveBeenCalledTimes(3);
    await expect(decide({appId:'games2d',requestId:'new-job',jobId:'other',issueNumber:901,requestSha256:'0'.repeat(64)})).resolves.toBe(false);
    expect(check).toHaveBeenCalledTimes(3);
  });
  it('does not convert a syntactically invalid target into a release decision',async()=>{
    const decide=createPinnedOwnerHoldDecision(fixture(),()=>undefined);
    await expect(decide({appId:'Bad App',requestId:'r',jobId:'j',issueNumber:1,requestSha256:'0'.repeat(64)})).rejects.toThrow('RBRIDGE_OWNER_HOLD_APP_ID_INVALID');
  });
  it('fails before any protected path read if the required owner SHA pin is absent',()=>{
    expect(()=>createProtectedOwnerHold({...context,expectedSha256:undefined})).toThrow('RBRIDGE_OWNER_HOLD_PIN_REQUIRED');
  });
  it('cannot treat a non-root temporary file as an acceptable protected owner manifest',()=>{
    const p=packageOf(fixture());
    // No privileged installation is performed in this test. A genuine /etc/rbridge
    // owner-owned file and exact SHA are required at actual runtime bootstrap.
    expect(()=>loadProtectedOwnerHold({...p.ctx})).toThrow();
  });
});
