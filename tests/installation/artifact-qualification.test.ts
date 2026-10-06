import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {qualifyRBridgeArtifact,qualifyRBridgeArtifactWithEvidence,validateArtifactManifest,validateArtifactIsolationHome} from '../../src/installation/artifactQualification.js';
import {runArtifactQualification} from '../../src/cli/rbridgeArtifactQualification.js';
import {captureArtifactOperation} from '../../src/installation/artifactEvidence.js';
import {core} from '../fixtures/rbridge-reader-carriers.js';
import {rbridgeOperationIntentDigest,type RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {encodeInstallReport,parseRBridgeInstallProfile} from '../../src/installation/types.js';

describe('final artifact qualification',()=>{
  it('fixture home cannot traverse into another state root or use an unallocated name',()=>{
    const p=parseRBridgeInstallProfile(JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')));
    expect(validateArtifactIsolationHome(p,'/home/rbridge/.rbridge-artifact-'+'a'.repeat(32))).toBe('/home/rbridge/.rbridge-artifact-'+'a'.repeat(32));
    for(const home of ['/home/rbridge/.rbridge-artifact-x','/home/rbridge/.rbridge-artifact-'+'a'.repeat(32)+'/../.local/state',
      '/home/rbridge//.rbridge-artifact-'+'a'.repeat(32),'/tmp/.rbridge-artifact-'+'a'.repeat(32)])expect(()=>validateArtifactIsolationHome(p,home)).toThrow();
  });
  it('fixed artifact CLI rejects duplicate keys, extra argv and caller executable fields',async()=>{
    expect(await runArtifactQualification({schema:'RBRIDGE_INSTALL_ARTIFACT_INPUT_V1',execute:'/bin/sh'})).toMatchObject({status:'UNKNOWN',reason_codes:['ARTIFACT_INPUT_INVALID']});
    const entry=new URL('../../src/cli/rbridgeArtifactQualification.ts',import.meta.url).pathname;
    for(const [input,args] of [['{"schema":"RBRIDGE_INSTALL_ARTIFACT_INPUT_V1","schema":"other"}',[]],['{}',['arbitrary']]] as const){
      const result=spawnSync(process.execPath,['--import','tsx',entry,...args],{input,encoding:'utf8',timeout:10000,maxBuffer:65536});
      expect(result.status).toBe(2);expect(JSON.parse(result.stdout)).toMatchObject({status:'UNKNOWN',reason_codes:['ARTIFACT_INPUT_INVALID']});
    }
  },30000);
  function evidenceFixture(){
    const f=core(),submission:RBridgeOperationSubmissionV1={schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:'artifact-health',principalId:f.receipt.principalId,targetInstanceId:f.receipt.targetInstanceId,operation:{kind:'HEALTH',action:'STATUS'}};
    const receipt={...f.receipt,operationId:submission.operationId,intentSha256:rbridgeOperationIntentDigest(submission)};
    const output=Buffer.from(encodeInstallReport(f.output));
    const page={status:'RESULT',receipt,resultSha256:receipt.resultSha256,cursor:0,nextCursor:output.length,eof:true,dataBase64:output.toString('base64')};
    return {submission,receipt,output,pages:[page],policy_sha256:receipt.policy.policySha256,
      context:{schema:'RBRIDGE_TRANSPORT_CONTEXT_V1' as const,transport:'MCP' as const,authenticatedSubject:'uid:1027',principalId:receipt.principalId}};
  }
  it('retains complete receipt, page and output preimages without granting execution authority',()=>{
    const f=evidenceFixture(),r=captureArtifactOperation(f);
    expect(r.scope).toBe('FINAL_ARTIFACT_OPERATION_BYTES_ONLY');
    expect(r.receiptJSON).toBe(Buffer.from(encodeInstallReport(f.receipt)).toString());
    expect(createHash('sha256').update(r.receiptJSON).digest('hex')).toBe(r.receiptSHA256);
    expect(Buffer.from(r.resultBase64,'base64')).toEqual(f.output);expect(r.resultBytes).toBe(f.output.length);
    expect(r.pagesJSON.map(p=>JSON.parse(p))).toEqual(f.pages);expect(r).not.toHaveProperty('execution_qualified');
  });
  it('the cross-language golden fixture remains synthetic and reproduces every stored byte',()=>{
    const fixture=JSON.parse(readFileSync(new URL('../fixtures/rbridge-artifact-preimages.json',import.meta.url),'utf8'));
    expect(fixture.scope).toBe('SYNTHETIC_SOURCE_DATA_ONLY');
    for(const row of fixture.artifact.receipts){
      const value=captureArtifactOperation({submission:JSON.parse(row.submissionJSON),context:JSON.parse(row.contextJSON),receipt:JSON.parse(row.receiptJSON),pages:row.pagesJSON.map((v:string)=>JSON.parse(v)),output:Buffer.from(row.resultBase64,'base64'),policy_sha256:fixture.profile.binding.policy_sha256});
      expect(value).toEqual(row);
    }
  });
  it('missing EOF, reordered bytes, wrong policy or scope cannot become fixture evidence after rehashing',()=>{
    const f=evidenceFixture();
    for(const value of [{...f,pages:[]},{...f,pages:[{...f.pages[0],eof:false}]},
      {...f,pages:[f.pages[0],f.pages[0]]},{...f,output:Buffer.from('changed')},
      {...f,policy_sha256:'f'.repeat(64)},{...f,receipt:{...f.receipt,principalId:'attacker'}},
      {...f,context:{...f.context,principalId:'attacker'}}])expect(()=>captureArtifactOperation(value)).toThrow();
    for(const output of [Buffer.from('{"x":1,"x":1}'),Buffer.from('{"x":1} '),Buffer.from([255])]){
      const digest=createHash('sha256').update(output).digest('hex'),receipt={...f.receipt,resultSha256:digest};
      expect(()=>captureArtifactOperation({...f,receipt,output,pages:[{...f.pages[0],receipt,resultSha256:digest,nextCursor:output.length,dataBase64:output.toString('base64')}]})).toThrow();
    }
  });
  it('joins raw page bytes before decoding a split UTF8 file result',()=>{
    const f=evidenceFixture(),submission:RBridgeOperationSubmissionV1={...f.submission,operationId:'artifact-read',operation:{kind:'FILE',action:'READ',target:'/mnt/data/source.txt',args:{}}};
    const output=Buffer.from(encodeInstallReport({path:'/mnt/data/source.txt',text:'é\n'})),digest=createHash('sha256').update(output).digest('hex');
    const receipt={...f.receipt,operationId:submission.operationId,intentSha256:rbridgeOperationIntentDigest(submission),resultSha256:digest},split=output.indexOf(195)+1;
    const pages=[output.subarray(0,split),output.subarray(split)].map((part,i)=>({status:'RESULT',receipt,resultSha256:digest,cursor:i?split:0,nextCursor:i?output.length:split,eof:i===1,dataBase64:part.toString('base64')}));
    const result=captureArtifactOperation({...f,submission,receipt,output,pages});
    expect(result.resultJSON).toBe(output.toString());expect(result.pagesJSON).toHaveLength(2);
  });
  it('blocked qualification retains no invented fixture preimage',async()=>{
    const profile=parseRBridgeInstallProfile(JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')));
    const value=await qualifyRBridgeArtifactWithEvidence({profile,runtimeRoot:'/missing/final-artifact',manifestSHA256:'1'.repeat(64),isolatedHome:'/missing/isolated-home'});
    expect(value.report.status).not.toBe('PASS');expect(value.receipts).toBeNull();
    expect(value.report.fixtureReceiptsSHA256).toBe('');
  });
  it('never turns missing final artifact or wrong runtime into boot qualification',async()=>{
    const profile=parseRBridgeInstallProfile(JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')));
    const result=await qualifyRBridgeArtifact({profile,runtimeRoot:'/missing/final-artifact',manifestSHA256:'1'.repeat(64),isolatedHome:'/missing/isolated-home'});
    expect(result.status).not.toBe('PASS');
    expect(result.ownerBoot).toBe('NOT_PERFORMED');
    expect(result.mcpBoot).toBe('NOT_PERFORMED');
  });
  it('binds actual executable bytes independently of environment version labels',async()=>{
    const raw=JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8'));
    raw.runtime.node_path=process.execPath;
    raw.runtime.node_sha256=createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
    const result=await qualifyRBridgeArtifact({profile:parseRBridgeInstallProfile(raw),runtimeRoot:'/missing/final-artifact',manifestSHA256:'1'.repeat(64),isolatedHome:'/missing/isolated-home'});
    expect(result.status).not.toBe('PASS');
    expect(result.runtimeVersion).toBe(process.versions.node);
    expect(result.executedFixture).toBe(false);
  });
  it('rejects self-consistent manifests containing traversal, unsorted names or incompatible schema',()=>{
    const base={schema:'RBRIDGE_INSTALL_ARTIFACT_V1',kind:'RUNTIME',source_sha:'1'.repeat(40),tree_sha:'2'.repeat(40),node_sha256:'3'.repeat(64),uid_policy:'ROOT_IMMUTABLE_RUNTIME_READABLE',entries:[{path:'../outside',kind:'FILE',size:0,mode:420,sha256:'4'.repeat(64),target:''}]};
    const hash=(v:unknown)=>createHash('sha256').update(encodeInstallReport(v)).digest('hex');
    expect(()=>validateArtifactManifest({...base,sha256:hash(base)})).toThrow();
    for(const entries of [[{...base.entries[0],path:'b'},{...base.entries[0],path:'a'}],[{...base.entries[0],path:'a',mode:438}]]){
      const value={...base,entries};expect(()=>validateArtifactManifest({...value,sha256:hash(value)})).toThrow();
    }
    const value={...base,schema:'RBRIDGE_INSTALL_TOOLKIT_V1',entries:[]};expect(()=>validateArtifactManifest({...value,sha256:hash(value)})).toThrow();
  });
});
