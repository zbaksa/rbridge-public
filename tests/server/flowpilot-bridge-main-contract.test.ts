import {lstat,mkdtemp,readFile,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {runRemoteBridgeMain} from '../../src/server/remoteBridgeMain.js';
import {acquireRBridgeOwnerLock,assertRBridgeOwnerLockHeld} from '../../src/server/rbridgeOwnerLock.js';
import {assertRemoteBridgeProcessLockHeld} from '../../src/server/remoteBridgeStore.js';
const fixture=vi.hoisted(()=>({home:'',events:[] as string[],stop:()=>undefined as void}));
vi.mock('node:os',async importOriginal=>{const actual=await importOriginal<typeof import('node:os')>();return {...actual,userInfo:()=>({...actual.userInfo(),homedir:fixture.home||actual.userInfo().homedir})};});
vi.mock('../../src/adapters/githubIssueRemoteBridge.js',async importOriginal=>{const actual=await importOriginal<typeof import('../../src/adapters/githubIssueRemoteBridge.js')>();return {...actual,createGitHubIssueRemoteBridge:()=>({async listOpenRequests(){fixture.events.push('github-poll');fixture.stop();return [];},async publishResult(){throw new Error('TEST_UNEXPECTED_PUBLICATION');},async readIssue(){throw new Error('TEST_UNEXPECTED_READ');},async readCommentPage(){return [];},async postComment(){throw new Error('TEST_UNEXPECTED_POST');},async closeIssue(){throw new Error('TEST_UNEXPECTED_CLOSE');}})};});
vi.mock('../../src/adapters/controllerExecRemoteBridge.js',async importOriginal=>{const actual=await importOriginal<typeof import('../../src/adapters/controllerExecRemoteBridge.js')>();return {...actual,createControllerExecRemoteBridge:()=>({async submit(){fixture.events.push('legacy-submit');return {state:'QUEUED'};},async status(){fixture.events.push('legacy-status');return {state:'RUNNING'};},async result(){throw new Error('TEST_UNEXPECTED_RESULT');}})};});
vi.mock('../../src/server/remoteBridgeChunkStore.js',async importOriginal=>{const actual=await importOriginal<typeof import('../../src/server/remoteBridgeChunkStore.js')>();return {...actual,createRemoteBridgeChunkStore:(options:Parameters<typeof actual.createRemoteBridgeChunkStore>[0])=>{assertRBridgeOwnerLockHeld(join(fixture.home,'.local','state','rbridge','execution-v2'));fixture.events.push('transfers-guarded');return actual.createRemoteBridgeChunkStore(options);}};});
vi.mock('../../src/server/remoteBridgeProcessSessions.js',async importOriginal=>{const actual=await importOriginal<typeof import('../../src/server/remoteBridgeProcessSessions.js')>();return {...actual,createRemoteBridgeProcessSessions:(options:Parameters<typeof actual.createRemoteBridgeProcessSessions>[0])=>{assertRBridgeOwnerLockHeld(join(fixture.home,'.local','state','rbridge','execution-v2'));fixture.events.push('sessions-guarded');return actual.createRemoteBridgeProcessSessions(options);}};});
vi.mock('../../src/server/flowPilotBridgeRuntime.js',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../src/server/flowPilotBridgeRuntime.js')>();
 return {...actual,createFlowPilotBridgeRuntime:(options:Parameters<typeof actual.createFlowPilotBridgeRuntime>[0])=>{
  const root=join(options.root,'execution-v2');assertRBridgeOwnerLockHeld(root);fixture.events.push('flow-guarded');
  const runtime=actual.createFlowPilotBridgeRuntime({...options,port:0});if(!runtime)return runtime;
  return {...runtime,async start(){await assertRemoteBridgeProcessLockHeld(options.root,process.getuid!());await expect(acquireRBridgeOwnerLock({root,uid:process.getuid!()})).rejects.toThrow();const address=await runtime.start();fixture.events.push('flow-listening');const response=await fetch(`http://127.0.0.1:${address.port}/v1/execute`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+'b'.repeat(40)},body:JSON.stringify({schema:'FLOWPILOT_REMOTE_BRIDGE_V1',operationId:'op_run_0000000001_probe_a1',runId:'run_0000000001',stepId:'probe',attempt:1,fencingToken:7,idempotencyKey:'fp:run_0000000001:probe:1',appId:'fpilot',action:'APP_PROBE_V1',payload:{},timeoutSeconds:60,callback:{url:'http://127.0.0.1:8097/api/v1/executor/callback',bearerToken:'c'.repeat(40)}})});expect(response.status).toBe(202);return address;},async reconcile(){assertRBridgeOwnerLockHeld(root);fixture.events.push('flow-reconcile');return runtime.reconcile();},async stop(){assertRBridgeOwnerLockHeld(root);await assertRemoteBridgeProcessLockHeld(options.root,process.getuid!());fixture.events.push('flow-stopping');await runtime.stop();fixture.events.push('flow-stopped');}};
 }};
});
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();if(fixture.home)await rm(fixture.home,{recursive:true,force:true});fixture.home='';fixture.events=[];});
it('wires actual FlowPilot ingress, reconciliation and shutdown inside both owner exclusions',async()=>{
 const uid=process.getuid!();if(uid<=0)throw new Error('TEST_NONROOT_OWNER_REQUIRED');
 fixture.home=await mkdtemp(join(homedir(),'.rbridge-main-'));
 const {userInfo}=await import('node:os'),user=userInfo();
 for(const [key,value] of Object.entries({RBRIDGE_RUNTIME_USER:user.username,RBRIDGE_MCP_PRINCIPAL_ID:'operator-test',RBRIDGE_INSTANCE_ID:'target-test',RBRIDGE_GITHUB_REPOSITORY:'example/control',RBRIDGE_GITHUB_AUTHOR:'owner',RBRIDGE_RELEASE_SHA:'1'.repeat(40),COCWIN_FLOWPILOT_INGRESS_ENABLED:'true',FLOWPILOT_REMOTE_BRIDGE_TOKEN:'b'.repeat(40),FLOWPILOT_CALLBACK_TOKEN:'c'.repeat(40)}))vi.stubEnv(key,value);
 const originalOnce=process.once.bind(process);vi.spyOn(process,'once').mockImplementation((event,listener)=>{if(event==='SIGTERM'){fixture.stop=()=>{listener();};return process;}return originalOnce(event,listener);});
 const log=vi.spyOn(console,'log').mockImplementation(()=>undefined);
 await runRemoteBridgeMain();
 expect(fixture.events.slice(0,5)).toEqual(['transfers-guarded','sessions-guarded','flow-guarded','flow-listening','legacy-submit']);for(const event of ['github-poll','flow-reconcile','legacy-status']){expect(fixture.events.filter(value=>value===event)).toHaveLength(1);expect(fixture.events.indexOf(event)).toBeLessThan(fixture.events.indexOf('flow-stopping'));}expect(fixture.events.slice(-2)).toEqual(['flow-stopping','flow-stopped']);
 const parent=join(fixture.home,'.local','state','rbridge'),root=join(parent,'execution-v2');
 expect(JSON.parse(await readFile(join(root,'manifest.json'),'utf8'))).toMatchObject({runtimeUid:uid,principalId:'operator-test',targetInstanceId:'target-test'});
 expect(JSON.parse(await readFile(join(parent,'flowpilot','op_run_0000000001_probe_a1.json'),'utf8'))).toMatchObject({phase:'SUBMITTED'});
 expect(log.mock.calls.some(([row])=>String(row).includes('COCWIN_REMOTE_BRIDGE_TICK_V1'))).toBe(true);
 expect(()=>assertRBridgeOwnerLockHeld(root)).toThrow();await expect(lstat(join(parent,'relay.lock'))).rejects.toMatchObject({code:'ENOENT'});
 const replacement=await acquireRBridgeOwnerLock({root,uid});await replacement.close();
},30000);
