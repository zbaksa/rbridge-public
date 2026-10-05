import {execFile} from 'node:child_process';
import {chmod,link,mkdir,mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterEach,describe,expect,it} from 'vitest';
import {flowPilotAppIdentity,flowPilotOperationDigest,type FlowPilotBridgeOperation} from '../../src/domain/flowPilotBridgeProtocol.js';
import {createFlowPilotBridgeStore} from '../../src/server/flowPilotBridgeStore.js';
import {createRemoteBridgeStore} from '../../src/server/remoteBridgeStore.js';
import {createRBridgeOperationSerializer} from '../../src/server/rbridgeOperationSerializer.js';
import {createRBridgeLegacyClaimGuard,createRBridgeLegacyReservations} from '../../src/server/rbridgeLegacyReservations.js';
import {cleanupRBridgeTestStates,createRBridgeTestState} from '../fixtures/rbridge-core-state.js';

const roots:string[]=[];
afterEach(async()=>{await cleanupRBridgeTestStates();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(join(homedir(),'.rbridge-legacy-'));roots.push(root);const requestRoot=join(root,'requests'),flowPilotRoot=join(root,'flowpilot');await mkdir(requestRoot,{mode:0o700});await mkdir(flowPilotRoot,{mode:0o700});return {root,requestRoot,flowPilotRoot,uid:process.getuid!()};}
function v1(requestId:string){return {requestId,requestSha256:'a'.repeat(64),scopeSha256:'b'.repeat(64),issueNumber:1,jobId:'legacy-job'};}
function fp(operationId:string){const operation:FlowPilotBridgeOperation={schema:'FLOWPILOT_REMOTE_BRIDGE_V1',operationId,runId:'run-1',stepId:'probe',attempt:1,fencingToken:1,idempotencyKey:'run-1:probe',appId:'fpilot',action:'APP_PROBE_V1',payload:{},timeoutSeconds:60,callbackUrl:'http://127.0.0.1:8097/api/v1/executor/callback'};const app=flowPilotAppIdentity(operation);return {operation,digest:flowPilotOperationDigest(operation),appId:app.appId,jobId:app.jobId,phase:'CLAIMED' as const};}

describe('legacy identity reservations',()=>{
  it('probes V1, FlowPilot and tombstone filenames without reading or repairing records',async()=>{
    const f=await fixture(),reservations=createRBridgeLegacyReservations(f);
    for(const [directory,name] of [[f.requestRoot,'legacy.json'],[f.flowPilotRoot,'flow.json'],[f.flowPilotRoot,'finished.done'],[f.flowPilotRoot,`${'a'.repeat(192)}.done`]])await writeFile(join(directory!,name!),'malformed retained bytes',{mode:0o600});
    const before=await readFile(join(f.requestRoot,'legacy.json')),names=await readdir(f.flowPilotRoot);
    for(const id of ['legacy','flow','finished','a'.repeat(192)])expect(await reservations.isReserved(id)).toBe(true);
    expect(await reservations.isReserved('absent')).toBe(false);expect(await readFile(join(f.requestRoot,'legacy.json'))).toEqual(before);expect(await readdir(f.flowPilotRoot)).toEqual(names);
  });
  it('does not create missing roots and refuses unsafe candidates without chmod or healing',async()=>{
    const f=await fixture(),missing=join(f.root,'missing');expect(await createRBridgeLegacyReservations({...f,requestRoot:missing,flowPilotRoot:join(missing,'fp')}).isReserved('absent')).toBe(false);expect(await readdir(f.root)).toEqual(['flowpilot','requests']);
    const path=join(f.requestRoot,'unsafe.json');await writeFile(path,'bad',{mode:0o644});await expect(createRBridgeLegacyReservations(f).isReserved('unsafe')).rejects.toThrow();expect((await stat(path)).mode&0o777).toBe(0o644);
    await chmod(path,0o600);await link(path,join(f.requestRoot,'unsafe-copy'));await expect(createRBridgeLegacyReservations(f).isReserved('unsafe')).rejects.toThrow();expect((await stat(path)).nlink).toBe(2);
    await symlink(path,join(f.flowPilotRoot,'linked.done'));await expect(createRBridgeLegacyReservations(f).isReserved('linked')).rejects.toThrow();
    await promisify(execFile)('/usr/bin/mkfifo',[join(f.requestRoot,'fifo.json')]);await expect(createRBridgeLegacyReservations(f).isReserved('fifo')).rejects.toThrow();
    await chmod(f.requestRoot,0o755);await expect(createRBridgeLegacyReservations(f).isReserved('absent')).rejects.toThrow();expect((await stat(f.requestRoot)).mode&0o777).toBe(0o755);
    for(const id of ['../escape','x/y','a'.repeat(193),'Upper'])await expect(createRBridgeLegacyReservations(f).isReserved(id)).rejects.toThrow();
  });
  it('rejects a core-reserved V1 claim before any lookup or root creation',async()=>{
    const f=await fixture(),root=join(f.root,'new-requests'),serializer=createRBridgeOperationSerializer(),guard=createRBridgeLegacyClaimGuard({serializer,core:{has:async()=>true}}),store=createRemoteBridgeStore(root,undefined,{claimGuard:guard});
    await expect(store.claim(v1('winner'))).rejects.toThrow('RBRIDGE_CORE_LEGACY_ID_RESERVED');expect(await readdir(f.root)).toEqual(['flowpilot','requests']);
  });
  it('rejects a core-reserved FlowPilot claim and preserves 192-character legacy IDs',async()=>{
    const f=await fixture(),serializer=createRBridgeOperationSerializer();const checked:string[]=[];
    const guard=createRBridgeLegacyClaimGuard({serializer,core:{has:async id=>{checked.push(id);return true;}}}),store=createFlowPilotBridgeStore(f.flowPilotRoot,undefined,{claimGuard:guard});
    await expect(store.claim(fp('winner'))).rejects.toThrow('RBRIDGE_CORE_LEGACY_ID_RESERVED');expect(await readdir(f.flowPilotRoot)).toEqual([]);
    const long=fp('a'.repeat(192));expect((await store.claim(long)).state).toBe('NEW');expect((await store.claim(long)).state).toBe('REPLAY');expect(checked).toEqual(['winner']);
  });
  it('holds the common serializer through the entire V1 lookup and creation',async()=>{
    const f=await fixture(),serializer=createRBridgeOperationSerializer(),guard=createRBridgeLegacyClaimGuard({serializer,core:{has:async()=>false}}),store=createRemoteBridgeStore(f.requestRoot,undefined,{claimGuard:guard});
    const results=await Promise.all(Array.from({length:20},()=>store.claim(v1('same'))));expect(results.filter(r=>r.state==='CLAIMED')).toHaveLength(1);expect(results.filter(r=>r.state==='REPLAY')).toHaveLength(19);expect(await readdir(f.requestRoot)).toEqual(['same.json']);
    expect((await store.claim({...v1('same'),requestSha256:'c'.repeat(64)})).state).toBe('COLLISION');
  });
  for(const engine of ['V1','FLOWPILOT'] as const)it(`core and ${engine} claims cannot both win`,async()=>{
    const state=await createRBridgeTestState(),f=await fixture(),reservations=createRBridgeLegacyReservations(f),guard=createRBridgeLegacyClaimGuard({serializer:state.serializer,core:state.journal});
    const legacy=engine==='V1'?()=>createRemoteBridgeStore(f.requestRoot,undefined,{claimGuard:guard}).claim(v1('race')):()=>createFlowPilotBridgeStore(f.flowPilotRoot,undefined,{claimGuard:guard}).claim(fp('race'));
    for(const legacyFirst of [false,true]){
      const id=legacyFirst?'race-legacy':'race',submission=state.submission(id);const legacyClaim=()=>engine==='V1'?createRemoteBridgeStore(f.requestRoot,undefined,{claimGuard:guard}).claim(v1(id)):createFlowPilotBridgeStore(f.flowPilotRoot,undefined,{claimGuard:guard}).claim(fp(id));
      const coreClaim=()=>state.serializer.run(id,async()=>{if(await reservations.isReserved(id))throw new Error('RBRIDGE_CORE_LEGACY_ID_RESERVED');return state.journal.claim({submission,decision:state.policy.evaluate(submission),context:state.context});});
      const outcomes=await Promise.allSettled(legacyFirst?[legacyClaim(),coreClaim()]:[coreClaim(),legacy()]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);expect(await state.journal.has(id)).toBe(!legacyFirst);
    }
  });
});
