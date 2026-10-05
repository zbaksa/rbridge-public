import {readlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createRBridgeExecutionCore} from '../../src/server/rbridgeExecutionCore.js';
import {createRBridgeExecutionJournal,type RBridgeExecutionJournal} from '../../src/server/rbridgeExecutionJournal.js';
import {createRBridgeExecutionResults} from '../../src/server/rbridgeExecutionResults.js';
import {createRBridgeExecutionPolicy} from '../../src/server/rbridgeExecutionPolicy.js';
import {createRBridgeOperationSerializer} from '../../src/server/rbridgeOperationSerializer.js';
import {acquireRBridgeOwnerLock} from '../../src/server/rbridgeOwnerLock.js';
import {createRBridgeReadonlyHandlers} from '../../src/server/rbridgeReadonlyHandlers.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';
async function main(){
  const [root,sourceRoot,point]=process.argv.slice(2);if(!root||!sourceRoot||!['CLAIMED','AUTHORIZED','STARTING','RUNNING','RESULT_FSYNC','RESULT_PLACED','TERMINAL_BEFORE','TERMINAL'].includes(point??''))throw new Error('FIXTURE_ARGUMENTS');
  const uid=process.getuid!(),binding={runtimeUid:uid,principalId:'operator',targetInstanceId:'aether'},files=createRBridgeStateFiles({checkFilesystem:async()=>undefined}),owner=await acquireRBridgeOwnerLock({root,uid,files}),serializer=createRBridgeOperationSerializer(),policy=createRBridgeExecutionPolicy(binding);
  let paused=false;async function checkpoint(name:string){if(name===point&&!paused){paused=true;process.stdout.write(JSON.stringify({schema:'RBRIDGE_CRASH_CHECKPOINT_V1',checkpoint:name,pid:process.pid})+'\n');setInterval(()=>undefined,1000);await new Promise<void>(()=>undefined);}}
  const actual=await createRBridgeExecutionJournal({root,binding,serializer,files});
  const journal:RBridgeExecutionJournal={...actual,async claim(input){const record=await actual.claim(input);await checkpoint('CLAIMED');return record;},async update(id,revision,next){if(next.receipt.phase==='TERMINAL')await checkpoint('TERMINAL_BEFORE');const record=await actual.update(id,revision,next);await checkpoint(record.receipt.phase);return record;}};
  const resultFiles=createRBridgeStateFiles({checkFilesystem:async()=>undefined,io:{async syncFile(handle){await handle.sync();await checkpoint('RESULT_FSYNC');},async syncParent(handle){if(await readlink(`/proc/self/fd/${handle.fd}`)===join(root,'results'))await checkpoint('RESULT_PLACED');await handle.sync();}}});
  const results=await createRBridgeExecutionResults({root,journal,files:resultFiles}),readonly=createRBridgeReadonlyHandlers({policy,sourceRoot,health:{snapshot:()=>({})}});
  const core=createRBridgeExecutionCore({binding,subjects:{GITHUB:'example/control:operator',MCP:`uid:${uid}`},journal,results,policy,serializer,legacyReservations:{async isReserved(){return false;}},handler:{async execute(...args){await writeFile(join(sourceRoot,'child-handler.called'),'1',{mode:0o600});return readonly.execute(...args);}}});
  await core.submit({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:'read-1',principalId:'operator',targetInstanceId:'aether',operation:{kind:'FILE',action:'READ',target:'/mnt/data/source.txt',args:{}}},{schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:`uid:${uid}`,principalId:'operator'},new AbortController().signal);
  await core.close();await owner.close();throw new Error('CHECKPOINT_NOT_REACHED');
}
main().catch(error=>{process.stderr.write(JSON.stringify({schema:'RBRIDGE_CRASH_FIXTURE_ERROR_V1',reason:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'FIXTURE_FAILED'})+'\n');process.exitCode=2;});
