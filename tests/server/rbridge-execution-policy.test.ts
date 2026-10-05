import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {parseRBridgeOperationSubmissionV1,rbridgeOperationIntentDigest,type RBridgeJsonValue,type RBridgeOperationSubmissionV1,type RBridgeSafeOperation} from '../../src/domain/rbridgeExecutionContract.js';
import {canonicalRBridgeJson} from '../../src/domain/rbridgeCoreValidation.js';
import {createRBridgeExecutionPolicy,isRBridgePolicyRecoveryAllowed} from '../../src/server/rbridgeExecutionPolicy.js';

const binding={runtimeUid:1027,principalId:'operator',targetInstanceId:'aether'};
const make=(operation:RBridgeSafeOperation):RBridgeOperationSubmissionV1=>parseRBridgeOperationSubmissionV1({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:'test-1',principalId:'operator',targetInstanceId:'aether',operation});
const file=(action:Extract<RBridgeSafeOperation,{kind:'FILE'}>['action'],args={},target='/mnt/data/example'):RBridgeOperationSubmissionV1=>make({kind:'FILE',action,target,args});
describe('fixed read-only execution policy',()=>{
  it('authorizes exactly seven source-controlled actions and preserves disabled intent',()=>{
    const policy=createRBridgeExecutionPolicy(binding);
    for(const submission of [make({kind:'HEALTH',action:'STATUS'}),file('LIST'),file('STAT'),file('READ'),file('READ_MANY',{paths:['a/b.txt']}),file('READ_BINARY'),file('SEARCH',{query:'needle'})])expect(policy.evaluate(submission).snapshot.decision).toBe('ALLOW');
    for(const submission of [file('WRITE_TEXT',{text:'x'}),file('WRITE_BINARY'),file('APPEND_TEXT'),file('EDIT_EXACT'),file('MOVE'),make({kind:'PROCESS',action:'START',args:{}}),make({kind:'CHUNK',action:'GET',transferId:'chunk-1',args:{}})]){
      const before=rbridgeOperationIntentDigest(submission);expect(policy.evaluate(submission).snapshot.decision).toBe('BLOCK');expect(rbridgeOperationIntentDigest(submission)).toBe(before);
    }
  });
  it('denies unknown arguments, foreign scopes and secret or outside paths',()=>{
    const policy=createRBridgeExecutionPolicy(binding);
    for(const submission of [file('READ',{maxBytes:1}),file('STAT',{extra:true}),file('READ_BINARY',{extra:true}),file('LIST',{sort:'name'}),file('READ_MANY',{paths:['a'],extra:1}),file('SEARCH',{query:'x',regex:true}),file('READ',{},'/home/operator/a'),file('READ',{},'/mnt/data/.ssh/key'),file('READ',{},'/mnt/data/access_token.txt'),{...file('READ'),principalId:'foreign'}])expect(policy.evaluate(submission).snapshot.decision).toBe('BLOCK');
  });
  it('enforces action-specific argument boundaries',()=>{
    const policy=createRBridgeExecutionPolicy(binding);
    for(const submission of [file('LIST',{maxEntries:1}),file('LIST',{maxEntries:500}),file('READ_MANY',{paths:Array(32).fill('a')}),file('READ_MANY',{paths:['a'.repeat(1024)]}),file('SEARCH',{query:'é'.repeat(2048)})])expect(policy.evaluate(submission).snapshot.decision).toBe('ALLOW');
    for(const submission of [file('LIST',{maxEntries:0}),file('LIST',{maxEntries:501}),file('LIST',{maxEntries:1.5}),file('READ_MANY',{paths:[]}),file('READ_MANY',{paths:Array(33).fill('a')}),file('READ_MANY',{paths:['a'.repeat(1025)]}),file('SEARCH',{query:''}),file('SEARCH',{query:'é'.repeat(2049)}),file('SEARCH',{query:'x\0'})])expect(policy.evaluate(submission).snapshot.decision).toBe('BLOCK');
    for(const path of ['/a','a//b','a/../b','./a','a/','a\\b','a\0'])expect(policy.evaluate(file('READ_MANY',{paths:[path]})).snapshot.decision).toBe('BLOCK');
  });
  it('hashes and freezes the entire policy and binding without a self-hash',()=>{
    const policy=createRBridgeExecutionPolicy(binding),decision=policy.evaluate(file('READ'));
    expect(decision.snapshot.policySha256).toBe(createHash('sha256').update(canonicalRBridgeJson(policy.document as unknown as RBridgeJsonValue)).digest('hex'));
    expect(Object.isFrozen(policy.document.binding)).toBe(true);expect(Object.isFrozen(policy.document.limits)).toBe(true);
    expect(createRBridgeExecutionPolicy({...binding,targetInstanceId:'other'}).evaluate(file('READ')).snapshot.policySha256).not.toBe(decision.snapshot.policySha256);
  });
  it('recovery requires authorization by both policies and their smaller limits',()=>{
    const original=createRBridgeExecutionPolicy(binding).document;
    expect(isRBridgePolicyRecoveryAllowed(original,original,file('READ'))).toBe(true);
    expect(isRBridgePolicyRecoveryAllowed(original,{...original,enabledActions:['HEALTH/STATUS']},file('READ'))).toBe(false);
    expect(isRBridgePolicyRecoveryAllowed(original,{...original,limits:{...original.limits,paths:1}},file('READ_MANY',{paths:['a','b']}))).toBe(false);
    expect(isRBridgePolicyRecoveryAllowed(original,{...original,binding:{...binding,principalId:'other'}},file('READ'))).toBe(false);
    expect(isRBridgePolicyRecoveryAllowed(original,original,file('WRITE_TEXT',{text:'x'}))).toBe(false);
  });
});
