import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import type {RBridgeOperationSubmissionV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createRBridgeExecutionPolicy,type RBridgePolicyDocumentV1} from '../../src/server/rbridgeExecutionPolicy.js';
import {createRBridgeReadonlyHandlers} from '../../src/server/rbridgeReadonlyHandlers.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const policy=createRBridgeExecutionPolicy({runtimeUid:1027,principalId:'operator',targetInstanceId:'aether'}),healthValue={schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:'a'.repeat(40),uptimeMs:1,queueCount:0,sessionCount:0,transferCount:0,lastGitHubPollAt:null};
function submission(operation:RBridgeOperationSubmissionV1['operation']):RBridgeOperationSubmissionV1{return {schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:'read-1',principalId:'operator',targetInstanceId:'aether',operation};}
async function fixture(){const root=await mkdtemp(join(homedir(),'.rbridge-handler-'));roots.push(root);const handler=createRBridgeReadonlyHandlers({policy,health:{snapshot:()=>healthValue},sourceRoot:root});return {root,handler};}
describe('read-only P0 handler facade',()=>{
  it('waits for a pending HEALTH observation to settle after its cooperative deadline',async()=>{
    let entered!:()=>void,release!:()=>void;const started=new Promise<void>(done=>{entered=done;}),gate=new Promise<void>(done=>{release=done;});
    const tighter:RBridgePolicyDocumentV1={...policy.document,limits:{...policy.document.limits,handlerMs:5}};
    const handler=createRBridgeReadonlyHandlers({policy,health:{async snapshot(){entered();await gate;return healthValue;}}});let settled=false;
    const pending=handler.execute(submission({kind:'HEALTH',action:'STATUS'}),tighter,policy.document,new AbortController().signal);void pending.then(()=>{settled=true;},()=>{settled=true;});
    try{await Promise.race([started,pending.then(()=>{throw new Error('HEALTH_DID_NOT_RUN');},error=>{throw error;})]);await new Promise<void>(done=>setTimeout(done,30));expect(settled).toBe(false);release();await expect(pending).rejects.toThrow('RBRIDGE_READ_DEADLINE');}finally{release();await pending.catch(()=>undefined);}
  });
  it('reads actual private fixture bytes under the fixed logical policy and verifies HEALTH',async()=>{
    const f=await fixture();await writeFile(join(f.root,'a.txt'),'hello');const signal=new AbortController().signal;
    expect(await f.handler.execute(submission({kind:'FILE',action:'READ',target:'/mnt/data/a.txt',args:{}}),policy.document,policy.document,signal)).toEqual({path:'/mnt/data/a.txt',text:'hello'});
    expect(await f.handler.execute(submission({kind:'HEALTH',action:'STATUS'}),policy.document,policy.document,signal)).toEqual(healthValue);expect(policy.document.allowedRoots).toEqual(['/mnt/data']);
  });
  it('refuses disabled operations and unknown named arguments without mutating files',async()=>{
    const f=await fixture();await writeFile(join(f.root,'a'),'original');const operations:RBridgeOperationSubmissionV1['operation'][]=[{kind:'FILE',action:'WRITE_TEXT',target:'/mnt/data/a',args:{text:'changed'}},{kind:'FILE',action:'APPEND_TEXT',target:'/mnt/data/a',args:{text:'changed'}},{kind:'FILE',action:'MOVE',target:'/mnt/data/a',args:{destination:'/mnt/data/b'}},{kind:'PROCESS',action:'START',args:{}},{kind:'CHUNK',action:'PUT',transferId:'transfer',args:{}},{kind:'FILE',action:'READ',target:'/mnt/data/a',args:{callerRoot:f.root}}];
    for(const operation of operations)await expect(f.handler.execute(submission(operation),policy.document,policy.document,new AbortController().signal)).rejects.toThrow('RBRIDGE_READ_POLICY_BLOCKED');expect(await readFile(join(f.root,'a'),'utf8')).toBe('original');
  });
  it('intersects original and current read limits without replacing the original policy',async()=>{
    const f=await fixture();await writeFile(join(f.root,'a'),'hello');const tighter:RBridgePolicyDocumentV1={...policy.document,limits:{...policy.document.limits,readBytes:3}};const op=submission({kind:'FILE',action:'READ',target:'/mnt/data/a',args:{}});await expect(f.handler.execute(op,policy.document,tighter,new AbortController().signal)).rejects.toThrow('RBRIDGE_READ_TOO_LARGE');await expect(f.handler.execute(op,tighter,policy.document,new AbortController().signal)).rejects.toThrow('RBRIDGE_READ_TOO_LARGE');
    await expect(f.handler.execute(op,policy.document,{...policy.document,enabledActions:[]},new AbortController().signal)).rejects.toThrow('RBRIDGE_READ_POLICY_BLOCKED');expect(policy.document.limits.readBytes).toBe(1048576);
  });
  it('sanitizes missing files, binary text and invalid HEALTH without exposing raw errors',async()=>{
    const f=await fixture();await writeFile(join(f.root,'binary'),Buffer.from([0,1]));await expect(f.handler.execute(submission({kind:'FILE',action:'READ',target:'/mnt/data/absent',args:{}}),policy.document,policy.document,new AbortController().signal)).rejects.toThrow('RBRIDGE_READ_NOT_FOUND');await expect(f.handler.execute(submission({kind:'FILE',action:'READ',target:'/mnt/data/binary',args:{}}),policy.document,policy.document,new AbortController().signal)).rejects.toThrow('RBRIDGE_READ_BINARY_REQUIRES_CHUNK');
    for(const value of [{...healthValue,releaseSha:'invalid'},{...healthValue,queueCount:-1},{...healthValue,extra:'secret'},JSON.parse('{"schema":"COCWIN_REMOTE_BRIDGE_HEALTH_V2","constructor":{}}')]){const handler=createRBridgeReadonlyHandlers({policy,health:{snapshot:()=>value}});await expect(handler.execute(submission({kind:'HEALTH',action:'STATUS'}),policy.document,policy.document,new AbortController().signal)).rejects.toThrow('RBRIDGE_READ_HEALTH_INVALID');}
  });
  it('sanitizes a failed HEALTH source',async()=>{
    const handler=createRBridgeReadonlyHandlers({policy,health:{snapshot(){throw new Error('/private/credentials: EACCES');}}});
    await expect(handler.execute(submission({kind:'HEALTH',action:'STATUS'}),policy.document,policy.document,new AbortController().signal)).rejects.toThrow('RBRIDGE_READ_FAILED');
  });
  it('rejects a foreign runtime binding',async()=>{
    const foreign:RBridgePolicyDocumentV1={...policy.document,binding:{...policy.document.binding,runtimeUid:1028}};
    await expect((await fixture()).handler.execute(submission({kind:'HEALTH',action:'STATUS'}),foreign,foreign,new AbortController().signal)).rejects.toThrow('RBRIDGE_READ_POLICY_BLOCKED');
  });
});
