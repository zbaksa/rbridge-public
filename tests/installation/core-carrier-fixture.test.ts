import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';
import {createIsolatedCoreCarrierPort,produceCoreCarrierCases} from '../../src/installation/coreCarrierFixture.js';
import {readRBridgeGitHubCarrier} from '../../src/installation/githubCarrierReader.js';
import {captureArtifactOperation} from '../../src/installation/artifactEvidence.js';
import {createRBridgeTestState,cleanupRBridgeTestStates} from '../fixtures/rbridge-core-state.js';
import {createRBridgeExecutionResults} from '../../src/server/rbridgeExecutionResults.js';
import {createRBridgeDeliveryJournal} from '../../src/server/rbridgeDeliveryJournal.js';
import {createRBridgeExecutionCore} from '../../src/server/rbridgeExecutionCore.js';
import {createRBridgeReadonlyHandlers} from '../../src/server/rbridgeReadonlyHandlers.js';
import {createRBridgeGitHubCore} from '../../src/adapters/rbridgeGitHubCore.js';
import {installHash} from '../../src/installation/gateContext.js';
import type {RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';

const source='b5881fd8367b4249e82683f1f884f2392cb696d4';
describe('fixed isolated Core producer',()=>{
  it('keeps its carrier port local, complete and bounded without claiming GitHub authentication',async()=>{
    const port=createIsolatedCoreCarrierPort('example/rbridge-control','fixture-owner');
    await expect(port.readIssue(101)).rejects.toThrow('CORE_FIXTURE_ISSUE_UNKNOWN');
    expect(()=>createIsolatedCoreCarrierPort('evil/repo/extra','fixture-owner')).toThrow();
    expect(()=>createIsolatedCoreCarrierPort('example/rbridge-control','bad author')).toThrow();
    const request={schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:'source-port',createdAt:'2026-10-06T00:00:00.000Z',expiresAt:'2026-10-06T00:20:00.000Z',operation:{kind:'HEALTH',action:'STATUS'}} as const;
    const issue=port.register(101,request);issue.body='caller edit';
    expect((await port.readIssue(101)).body).toBe(JSON.stringify(request));
    await port.postComment(101,'local bytes');await port.closeIssue(101);
    const capture=port.capture(101,'c'.repeat(64));
    expect(capture.scope).toBe('FIXTURE_AUTHORITY_ONLY');expect(capture.complete).toBe(true);
    expect(capture.comments[0]!.body).toBe('local bytes');
    expect(capture.issue.state).toBe('CLOSED');expect(()=>port.register(101,request)).toThrow();
    await expect(port.postComment(101,'x'.repeat(60000))).rejects.toThrow();
    await expect(port.readCommentPage(101,0)).rejects.toThrow();
  });
  it('emits real journal and publisher bytes, preserves originals, and derives reader expectations independently',async()=>{
    if(process.getuid!()===0){
      // Native UID0 is a refusal fixture, never a positive non-root runtime proof.
      await expect(produceCoreCarrierCases({} as never)).rejects.toThrow('CORE_FIXTURE_RUNTIME_UNQUALIFIED');return;
    }
    const state=await createRBridgeTestState(),directory=await mkdtemp(join(homedir(),'.rbridge-producer-source-'));
    const port=createIsolatedCoreCarrierPort('example/rbridge-control','fixture-owner');
    const results=await createRBridgeExecutionResults(state),deliveries=await createRBridgeDeliveryJournal(state);
    const health={snapshot(){return {schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:source,uptimeMs:0,queueCount:0,sessionCount:0,transferCount:0,lastGitHubPollAt:null};}};
    const handler=createRBridgeReadonlyHandlers({health,policy:state.policy,sourceRoot:directory});
    const core=createRBridgeExecutionCore({...state,results,subjects:{MCP:`uid:${state.uid}`,GITHUB:'example/rbridge-control:fixture-owner'},legacyReservations:{async isReserved(){return false;}},handler});
    const adapter=createRBridgeGitHubCore({binding:state.binding,repository:'example/rbridge-control',authorLogin:'fixture-owner',core,deliveries,github:port});
    try{
      await writeFile(join(directory,'source.txt'),'artifact read é\n',{mode:0o600,flag:'wx'});
      const originals=[];
      for(const [operationId,operation] of [['artifact-health',{kind:'HEALTH',action:'STATUS'}],['artifact-read',{kind:'FILE',action:'READ',target:'/mnt/data/source.txt',args:{}}]] as const){
        const submission:RBridgeOperationSubmissionV1={schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId,principalId:state.binding.principalId,targetInstanceId:state.binding.targetInstanceId,operation};
        await core.submit(submission,state.context,new AbortController().signal);
        let found=await core.status(operationId,state.context);
        for(let n=0;n<1000&&(found.status!=='RECEIPT'||found.receipt.phase!=='TERMINAL');n++){await new Promise<void>(done=>setTimeout(done,5));found=await core.status(operationId,state.context);}
        if(found.status!=='RECEIPT')throw new Error('SOURCE_ORIGINAL_UNAVAILABLE');
        const page=await core.result(operationId,0,32768,state.context);
        if(page.status!=='RESULT')throw new Error('SOURCE_RESULT_UNAVAILABLE');
        originals.push(captureArtifactOperation({submission,context:state.context,receipt:found.receipt,pages:[page],output:Buffer.from(page.dataBase64,'base64'),policy_sha256:found.receipt.policy.policySha256}));
      }
      const before=JSON.stringify(originals),report=await produceCoreCarrierCases({binding:state.binding,repository:'example/rbridge-control',author:'fixture-owner',source_sha:source,context_sha256:'c'.repeat(64),sourceDirectory:directory,core,adapter,port,originals,deadline_ms:15000});
      expect(report.scope).toBe('ISOLATED_CORE_SOURCE_DATA_ONLY');
      expect(report.cases.map(f=>f.case_id)).toEqual(['C02','C02','C03','C03','C04','C05','C06','C07','C08','C08']);
      expect(JSON.stringify(originals)).toBe(before);
      for(const f of report.cases){
        const verdict=readRBridgeGitHubCarrier(f.capture,f.expected);
        expect(JSON.stringify(verdict)).toBe(f.expected_verdict_json);
        expect(installHash(JSON.parse(f.expected_verdict_json))).toBe(f.expected_verdict_canonical_sha256);
        expect(f.capture.scope).toBe('FIXTURE_AUTHORITY_ONLY');
      }
      const outcomes=report.cases.map(f=>JSON.parse(f.expected_verdict_json));
      expect(outcomes.map(v=>v.kind)).toEqual(['CORE_RESULT','CORE_RESULT','CORE_RESULT','CORE_RESULT','CORE_RESULT','INVALID','INVALID','CORE_RESULT','UNAVAILABLE','UNAVAILABLE']);
      expect(outcomes[2].status).toBe('FAIL');expect(outcomes[3].status).toBe('BLOCKED');
      expect(outcomes[2]).not.toHaveProperty('output');expect(outcomes[3]).not.toHaveProperty('output');
      expect(outcomes[4].output.text.length).toBeGreaterThan(60000);
      expect(report.cases[7]!.capture.comments).toHaveLength(2);
      expect(outcomes[7].receipt).toEqual(JSON.parse(originals[0]!.receiptJSON));
      for(const v of outcomes.slice(8))expect(v).not.toHaveProperty('receipt');
      await expect(produceCoreCarrierCases({binding:state.binding,repository:'example/rbridge-control',author:'fixture-owner',source_sha:source,context_sha256:'c'.repeat(64),sourceDirectory:directory,core,adapter,port,originals,deadline_ms:15000})).rejects.toThrow();
    }finally{await core.close();await rm(directory,{recursive:true,force:true});await cleanupRBridgeTestStates();}
  },30000);
});
