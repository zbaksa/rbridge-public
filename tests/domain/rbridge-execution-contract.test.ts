import {describe,expect,it} from 'vitest';
import {
  canTransitionRBridgeExecutionPhase,
  parseRBridgeOperationSubmissionV1,
  RBRIDGE_SAFE_CAPABILITY_KINDS,
  rbridgeOperationIntentDigest,
  rbridgeOperationScopeDigest,
} from '../../src/domain/rbridgeExecutionContract.js';

const base=()=>({
  schema:'RBRIDGE_OPERATION_SUBMISSION_V1',
  operationId:'op-001',
  principalId:'owner',
  targetInstanceId:'host-a',
  operation:{kind:'FILE',action:'EDIT_EXACT',target:'/mnt/data/project/a.txt',args:{oldText:'a',newText:'b',expectedReplacements:1}},
});

describe('RBridge 2.0 P0 transport-neutral execution contract',()=>{
  it('accepts only the SAFE capability kinds frozen for 2.0',()=>{
    expect(RBRIDGE_SAFE_CAPABILITY_KINDS).toEqual(['HEALTH','FILE','PROCESS','CHUNK']);
    expect(parseRBridgeOperationSubmissionV1(base()).operation.kind).toBe('FILE');
    expect(()=>parseRBridgeOperationSubmissionV1({...base(),operation:{kind:'APP_RUN',appId:'x',jobId:'y',payload:{}}})).toThrow('RBRIDGE_OPERATION_KIND_INVALID');
    expect(()=>parseRBridgeOperationSubmissionV1({...base(),operation:{kind:'SHELL',action:'EXEC',args:{command:'id'}}})).toThrow('RBRIDGE_OPERATION_KIND_INVALID');
  });

  it('binds intent to principal, target and semantic operation but not transport metadata or operation id',()=>{
    const a=base();
    const reordered={...base(),operation:{kind:'FILE',action:'EDIT_EXACT',target:'/mnt/data/project/a.txt',args:{expectedReplacements:1,newText:'b',oldText:'a'}}};
    expect(rbridgeOperationIntentDigest(reordered)).toBe(rbridgeOperationIntentDigest(a));
    expect(rbridgeOperationIntentDigest({...base(),operationId:'retry-via-other-transport'})).toBe(rbridgeOperationIntentDigest(a));
    expect(rbridgeOperationIntentDigest({...base(),principalId:'other'})).not.toBe(rbridgeOperationIntentDigest(a));
    expect(rbridgeOperationIntentDigest({...base(),targetInstanceId:'host-b'})).not.toBe(rbridgeOperationIntentDigest(a));
    expect(rbridgeOperationIntentDigest({...base(),operation:{...base().operation,target:'/mnt/data/project/b.txt'}})).not.toBe(rbridgeOperationIntentDigest(a));
  });

  it('computes a separate trust scope digest for principal plus target instance',()=>{
    const a=base();
    expect(rbridgeOperationScopeDigest({...a,operationId:'other',operation:{kind:'HEALTH',action:'STATUS'}})).toBe(rbridgeOperationScopeDigest(a));
    expect(rbridgeOperationScopeDigest({...a,principalId:'other'})).not.toBe(rbridgeOperationScopeDigest(a));
    expect(rbridgeOperationScopeDigest({...a,targetInstanceId:'host-b'})).not.toBe(rbridgeOperationScopeDigest(a));
  });

  it('keeps request-controlled executable and file-root expansion outside SAFE',()=>{
    expect(()=>parseRBridgeOperationSubmissionV1({...base(),operation:{kind:'PROCESS',action:'START',args:{profileId:'git-read',executable:'/bin/sh'}}})).toThrow('RBRIDGE_OPERATION_PROCESS_EXECUTABLE_REQUEST_CONTROLLED');
    expect(()=>parseRBridgeOperationSubmissionV1({...base(),operation:{kind:'PROCESS',action:'START',args:{profileId:'git-read',command:'id'}}})).toThrow('RBRIDGE_OPERATION_PROCESS_EXECUTABLE_REQUEST_CONTROLLED');
    expect(()=>parseRBridgeOperationSubmissionV1({...base(),operation:{kind:'FILE',action:'READ',target:'/mnt/data/a.txt',args:{allowedRoots:['/']}}})).toThrow('RBRIDGE_OPERATION_FILE_ROOTS_REQUEST_CONTROLLED');
  });

  it('rejects malformed identity, paths and non-JSON arguments',()=>{
    expect(()=>parseRBridgeOperationSubmissionV1({...base(),operationId:'Bad ID'})).toThrow('RBRIDGE_OPERATION_ID_INVALID');
    expect(()=>parseRBridgeOperationSubmissionV1({...base(),operation:{kind:'FILE',action:'READ',target:'/mnt/data/../etc/passwd',args:{}}})).toThrow('RBRIDGE_OPERATION_FILE_TARGET_INVALID');
    expect(()=>parseRBridgeOperationSubmissionV1({...base(),operation:{kind:'PROCESS',action:'START',args:{profileId:'git-read',bad:undefined}}})).toThrow('RBRIDGE_OPERATION_ARGS_INVALID');
  });

  it.each(['__proto__','constructor','prototype'])('rejects prototype-sensitive JSON key %s in FILE, PROCESS and CHUNK arguments',key=>{
    const sensitive=JSON.parse(JSON.stringify({[key]:{text:'hidden-intent'}})) as Record<string,unknown>;
    const operations=[
      {kind:'FILE',action:'WRITE_TEXT',target:'/mnt/data/project/a.txt',args:sensitive},
      {kind:'PROCESS',action:'START',args:{profileId:'git-read',nested:sensitive}},
      {kind:'CHUNK',action:'PUT',transferId:'transfer-001',args:{manifest:[sensitive]}},
    ];
    for(const operation of operations){
      const submission={...base(),operation};
      expect(()=>parseRBridgeOperationSubmissionV1(submission)).toThrow('RBRIDGE_OPERATION_ARGS_INVALID');
      expect(()=>rbridgeOperationIntentDigest(submission)).toThrow('RBRIDGE_OPERATION_ARGS_INVALID');
      expect(()=>rbridgeOperationScopeDigest(submission)).toThrow('RBRIDGE_OPERATION_ARGS_INVALID');
    }
  });

  it('does not collapse a prototype-carried FILE mutation into an empty-args intent',()=>{
    const operation={kind:'FILE',action:'WRITE_TEXT',target:'/mnt/data/project/a.txt',args:JSON.parse('{"__proto__":{"text":"different-effect"}}')};
    const submission={...base(),operation};
    // JSON.parse produces an own key; a JS object literal would test a different input.
    expect(Object.hasOwn(operation.args,'__proto__')).toBe(true);
    expect(()=>rbridgeOperationIntentDigest(submission)).toThrow('RBRIDGE_OPERATION_ARGS_INVALID');
  });

  it('preserves prototype-sensitive text values and their semantic digest',()=>{
    const text='{"__proto__":{"constructor":"prototype"}}';
    const submission={...base(),operation:{kind:'FILE',action:'WRITE_TEXT',target:'/mnt/data/project/a.txt',args:{text}}};
    expect(parseRBridgeOperationSubmissionV1(submission).operation).toEqual(submission.operation);
    expect(rbridgeOperationIntentDigest(submission)).not.toBe(rbridgeOperationIntentDigest({...submission,operation:{...submission.operation,args:{text:'different'}}}));
  });

  it('freezes the monotonic core phase graph and prevents reopening terminal work',()=>{
    expect(canTransitionRBridgeExecutionPhase('CLAIMED','AUTHORIZED')).toBe(true);
    expect(canTransitionRBridgeExecutionPhase('CLAIMED','TERMINAL')).toBe(true);
    expect(canTransitionRBridgeExecutionPhase('AUTHORIZED','STARTING')).toBe(true);
    expect(canTransitionRBridgeExecutionPhase('STARTING','RUNNING')).toBe(true);
    expect(canTransitionRBridgeExecutionPhase('RUNNING','TERMINAL')).toBe(true);
    expect(canTransitionRBridgeExecutionPhase('RUNNING','AUTHORIZED')).toBe(false);
    expect(canTransitionRBridgeExecutionPhase('TERMINAL','RUNNING')).toBe(false);
    expect(canTransitionRBridgeExecutionPhase('TERMINAL','TERMINAL')).toBe(false);
  });
});
