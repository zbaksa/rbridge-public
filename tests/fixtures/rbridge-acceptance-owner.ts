import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {homedir,userInfo} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {startRBridgeOwnerRuntime} from '../../src/server/rbridgeOwnerRuntime.js';
import {acquireRemoteBridgeProcessLock} from '../../src/server/remoteBridgeStore.js';
import {createRBridgeStateFiles} from '../../src/server/rbridgeStateFiles.js';
import type {ChildProcess} from 'node:child_process';
import {Client} from '@modelcontextprotocol/client';
import type {GitHubBridgeIssue,RBridgeGitHubComment} from '../../src/adapters/githubIssueRemoteBridge.js';
import type {RBridgeDeploymentBinding} from '../../src/domain/rbridgeCoreProtocol.js';
import type {RBridgeOperationSubmissionV1,RBridgeTransportContextV1} from '../../src/domain/rbridgeExecutionContract.js';
export interface RBridgeAcceptanceActor {child:ChildProcess;request(command:string,value?:unknown):Promise<unknown>;event(name:string,count?:number):Promise<void>;kill():Promise<void>;close():Promise<void>;}
export interface RBridgeAcceptanceFixture {home:string;root:string;sourceRoot:string;binding:RBridgeDeploymentBinding;context:RBridgeTransportContextV1;issues:Map<number,GitHubBridgeIssue&{state:'open'|'closed'}>;comments:Map<number,RBridgeGitHubComment[]>;submission(id?:string,operation?:RBridgeOperationSubmissionV1['operation']):RBridgeOperationSubmissionV1;issue(id?:string,operation?:RBridgeOperationSubmissionV1['operation'],number?:number,ttl_ms?:number):GitHubBridgeIssue;start(options?:{holdRead?:boolean;holdHealth?:boolean;holdClaim?:boolean;fullResult?:boolean;target?:string;releaseSha?:string}):Promise<RBridgeAcceptanceActor>;stdio(era:'legacy'|'modern'):Promise<Client>;failCloseOnce():void;lostCloseAcknowledgements():number;close():Promise<void>;}
type Message={type:string;id?:number;command?:string;value?:unknown;method?:string;args?:unknown[];name?:string;error?:string};
function exited(child:ChildProcess){return child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise<void>(done=>child.once('exit',()=>done()));}
export async function createRBridgeAcceptanceFixture():Promise<RBridgeAcceptanceFixture>{
 const uid=process.getuid!();if(uid<=0||process.geteuid!()!==uid)throw new Error('TEST_NONROOT_OWNER_REQUIRED');
 const home=await fs.mkdtemp(join(homedir(),'.rbridge-acceptance-')),sourceRoot=join(home,'source'),parent=join(home,'.local','state','rbridge'),root=join(parent,'execution-v2'),files=createRBridgeStateFiles();
 for(const path of [join(home,'.local'),join(home,'.local','state'),parent,sourceRoot])await files.ensureDirectory(path,uid);
 await fs.writeFile(join(sourceRoot,'source.txt'),'acceptance source\n',{mode:0o600});
 const binding={runtimeUid:uid,principalId:'operator-test',targetInstanceId:'target-test'},context:RBridgeTransportContextV1={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:`uid:${uid}`,principalId:binding.principalId};
 const issues=new Map<number,GitHubBridgeIssue&{state:'open'|'closed'}>(),comments=new Map<number,RBridgeGitHubComment[]>(),actors:RBridgeAcceptanceActor[]=[],clients:Client[]=[];let commentId=1,closeFault=false,lostCloseAcks=0;
 const submission=(id='shared-acceptance',operation:RBridgeOperationSubmissionV1['operation']={kind:'FILE',action:'READ',target:'/mnt/data/source.txt',args:{}}):RBridgeOperationSubmissionV1=>({schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:id,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,operation});
 function issue(id='shared-acceptance',operation=submission(id).operation,number=17,ttl_ms=600000){const now=new Date(),row={number,title:'[COCWIN BRIDGE REQUEST] '+id,authorLogin:'owner',url:'https://github.com/example/control/issues/'+number,body:JSON.stringify({schema:'COCWIN_REMOTE_BRIDGE_REQUEST_V2',requestId:id,createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+ttl_ms).toISOString(),operation}),state:'open' as const};issues.set(row.number,row);comments.set(row.number,[]);return row;}
 async function external(method:string,args:unknown[]):Promise<unknown>{
  const number=args[0] as number;
  if(method==='readIssue'){const row=issues.get(number);if(!row)throw new Error('FIXTURE_ISSUE_MISSING');return structuredClone(row);}
  if(method==='readCommentPage'){const page=args[1] as number;return structuredClone((comments.get(number)??[]).slice((page-1)*20,page*20));}
  if(method==='postComment'){const id=commentId++,row={id,body:args[1] as string,authorLogin:'owner',url:`https://github.com/example/control/issues/${number}#issuecomment-${id}`};comments.set(number,[...(comments.get(number)??[]),row]);return row;}
  if(method==='closeIssue'){issues.get(number)!.state='closed';if(closeFault){closeFault=false;lostCloseAcks++;throw new Error('FIXTURE_CLOSE_ACK_LOST');}return null;}
  throw new Error('FIXTURE_METHOD_INVALID');
 }
 async function start(options:Parameters<RBridgeAcceptanceFixture['start']>[0]={}):Promise<RBridgeAcceptanceActor>{
  const child=spawn(process.execPath,['--import','tsx',resolve('tests/fixtures/rbridge-acceptance-owner.ts'),'--owner',home,sourceRoot,JSON.stringify(options)],{stdio:['ignore','ignore','pipe','ipc']});
  const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>(),events=new Map<string,number>();let nextId=1,stderr='',resolveReady!:()=>void,rejectReady!:(error:Error)=>void;
  const ready=new Promise<void>((done,reject)=>{resolveReady=done;rejectReady=reject;});
  const timer=setTimeout(()=>{child.kill('SIGKILL');rejectReady(new Error('ACCEPTANCE_OWNER_STARTUP_DEADLINE'));},10000);
  child.stderr!.on('data',chunk=>{stderr+=String(chunk);if(stderr.length>8192)child.kill('SIGKILL');});
  child.on('message',(raw:unknown)=>{const m=raw as Message;
   if(m.type==='READY'){clearTimeout(timer);resolveReady();}
   else if(m.type==='ERROR'){clearTimeout(timer);rejectReady(new Error('ACCEPTANCE_OWNER_STARTUP_FAILED'));}
   else if(m.type==='EVENT')events.set(m.name!,1+(events.get(m.name!)??0));
   else if(m.type==='RESPONSE'){const p=pending.get(m.id!);pending.delete(m.id!);if(m.error)p?.reject(new Error(m.error));else p?.resolve(m.value);}
   else if(m.type==='GH_REQUEST')void external(m.method!,m.args??[]).then(value=>{if(child.connected)child.send({type:'GH_RESPONSE',id:m.id!,value});},()=>{if(child.connected)child.send({type:'GH_RESPONSE',id:m.id!,error:'FIXTURE_GITHUB_UNAVAILABLE'});});
  });
  child.once('error',()=>{clearTimeout(timer);rejectReady(new Error('ACCEPTANCE_OWNER_STARTUP_FAILED'));});
  child.once('exit',()=>{clearTimeout(timer);rejectReady(new Error('ACCEPTANCE_OWNER_STARTUP_FAILED'));for(const p of pending.values())p.reject(new Error('ACCEPTANCE_OWNER_LOST'));pending.clear();});
  async function request(command:string,value?:unknown):Promise<unknown>{if(!child.connected)throw new Error('ACCEPTANCE_OWNER_LOST');const id=nextId++;return new Promise<unknown>((done,reject)=>{const deadline=setTimeout(()=>{pending.delete(id);reject(new Error('ACCEPTANCE_OWNER_RPC_DEADLINE'));},12000);pending.set(id,{resolve(value){clearTimeout(deadline);done(value);},reject(error){clearTimeout(deadline);reject(error);}});child.send({type:'CONTROL',id,command,value});});}
  const actor:RBridgeAcceptanceActor={child,request,async event(name,count=1){const until=Date.now()+10000;while((events.get(name)??0)<count&&Date.now()<until){if(child.exitCode!==null||child.signalCode!==null)throw new Error('ACCEPTANCE_OWNER_LOST');await new Promise<void>(done=>setTimeout(done,5));}if((events.get(name)??0)<count)throw new Error('ACCEPTANCE_EVENT_DEADLINE');},async kill(){child.kill('SIGKILL');await exited(child);},async close(){if(child.exitCode!==null||child.signalCode!==null)return;await request('RELEASE_ALL');await request('CLOSE');await exited(child);}};
  actors.push(actor);await ready;return actor;
 }
 async function stdio(era:'legacy'|'modern'){
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',resolve('tests/fixtures/rbridge-stdio-owner.ts'),'--client',root],env:{PATH:process.env.PATH??''},stderr:'pipe'}),client=new Client({name:'acceptance-untrusted-name',version:'test'},{versionNegotiation:{mode:era==='legacy'?'legacy':{pin:'2026-07-28'}}});
  clients.push(client);await client.connect(transport);return client;
 }
 return {home,root,sourceRoot,binding,context,issues,comments,submission,issue,start,stdio,failCloseOnce(){closeFault=true;},lostCloseAcknowledgements(){return lostCloseAcks;},async close(){for(const client of clients)await client.close();for(const actor of actors)try{await actor.close();}catch{await actor.kill();}await fs.rm(home,{recursive:true,force:true});}};
}
async function runOwner(){
 const [home,sourceRoot,rawOptions]=process.argv.slice(3);if(!home||!sourceRoot)throw new Error('FIXTURE_ARGUMENT_INVALID');
 const options=JSON.parse(rawOptions??'{}') as {holdRead?:boolean;holdHealth?:boolean;holdClaim?:boolean;fullResult?:boolean;target?:string;releaseSha?:string};
 const uid=process.getuid!(),user=userInfo(),root=join(home,'.local','state','rbridge','execution-v2');let reads=0,health=0,claimHeld=false;
 let releaseRead!:()=>void,releaseHealth!:()=>void,releaseClaim!:()=>void;
 const readGate=new Promise<void>(done=>releaseRead=done),healthGate=new Promise<void>(done=>releaseHealth=done),claimGate=new Promise<void>(done=>releaseClaim=done);
 if(!options.holdRead)releaseRead();if(!options.holdHealth)releaseHealth();if(!options.holdClaim)releaseClaim();
 const send=(message:Message)=>process.send?.(message),event=(name:string)=>send({type:'EVENT',name});
 // Observe an actual source FileHandle.read while preserving every filesystem guard.
 // This monkeypatch is confined to this test-only owner process and never the entrypoint.
 const originalOpen=fs.open;
 fs.open=(async(...args:Parameters<typeof fs.open>)=>{const handle=await originalOpen(...args);const path=await fs.realpath('/proc/self/fd/'+handle.fd).catch(()=>undefined);
  if(path===join(sourceRoot,'source.txt')){const read=handle.read.bind(handle);let counted=false;handle.read=(async(...args:Parameters<typeof handle.read>)=>{if(!counted){counted=true;reads++;event('READ_ENTERED');await readGate;}return read(...args);}) as typeof handle.read;}
  return handle;
 }) as typeof fs.open;
 syncBuiltinESMExports();
 const files=createRBridgeStateFiles({io:{async syncFile(handle){const path=await fs.readlink('/proc/self/fd/'+handle.fd);if(options.fullResult&&path.startsWith(join(root,'results')+'/'))throw Object.assign(new Error('FIXTURE_ENOSPC'),{code:'ENOSPC'});await handle.sync();},async syncParent(handle){await handle.sync();if(options.holdClaim&&!claimHeld&&await fs.readlink('/proc/self/fd/'+handle.fd)===join(root,'operations')){const path=join(root,'operations','shared-acceptance.json');try{const row=JSON.parse(await fs.readFile(path,'utf8')) as {receipt:{phase:string}};if(row.receipt.phase==='CLAIMED'){claimHeld=true;event('CLAIM_ACK_HELD');await claimGate;}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}}});
 const githubPending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();let nextGH=1;
 function github(method:string,args:unknown[]):Promise<unknown>{const id=nextGH++;return new Promise<unknown>((resolve,reject)=>{githubPending.set(id,{resolve,reject});send({type:'GH_REQUEST',id,method,args});});}
 let owner:Awaited<ReturnType<typeof startRBridgeOwnerRuntime>>|undefined;
 const relay=await acquireRemoteBridgeProcessLock(dirname(root));
 process.on('message',(raw:unknown)=>{const m=raw as Message;
  if(m.type==='GH_RESPONSE'){const p=githubPending.get(m.id!);githubPending.delete(m.id!);if(m.error)p?.reject(new Error(m.error));else p?.resolve(m.value);return;}
  if(m.type!=='CONTROL')return;
  void(async()=>{
   let value:unknown=null;
   if(m.command==='RELEASE_READ')releaseRead();else if(m.command==='RELEASE_HEALTH')releaseHealth();else if(m.command==='RELEASE_CLAIM')releaseClaim();else if(m.command==='RELEASE_ALL'){releaseRead();releaseHealth();releaseClaim();}
   else if(m.command==='COUNTS')value={reads,health};
   else if(m.command==='ADMIT')value=await owner!.githubCore.admit(m.value as GitHubBridgeIssue);
   else if(m.command==='DRAIN')await owner!.githubCore.reconcileDeliveries(20);
   else if(m.command==='CLOSE'){await owner!.close();await relay.release();}
   else throw new Error('FIXTURE_CONTROL_INVALID');
   if(m.command==='CLOSE')process.send?.({type:'RESPONSE',id:m.id!,value},()=>process.disconnect?.());else send({type:'RESPONSE',id:m.id!,value});
  })().catch(()=>send({type:'RESPONSE',id:m.id!,error:'ACCEPTANCE_CONTROL_FAILED'}));
 });
 try{
  owner=await startRBridgeOwnerRuntime({runtimeIdentity:{username:user.username,homedir:home,uid,euid:process.geteuid!()},env:{RBRIDGE_RUNTIME_USER:user.username,RBRIDGE_MCP_PRINCIPAL_ID:'operator-test',RBRIDGE_INSTANCE_ID:options.target??'target-test',RBRIDGE_GITHUB_REPOSITORY:'example/control',RBRIDGE_GITHUB_AUTHOR:'owner'},files,sourceRoot,health:{async snapshot(){health++;event('HEALTH_ENTERED');await healthGate;return {schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:options.releaseSha??'1'.repeat(40),uptimeMs:0,queueCount:0,sessionCount:0,transferCount:0,lastGitHubPollAt:null};}},github:{async listOpenRequests(){return [];},async publishResult(){throw new Error('FIXTURE_LEGACY_NOT_USED');},async readIssue(number){return await github('readIssue',[number]) as GitHubBridgeIssue&{state:'open'|'closed'};},async readCommentPage(number,page){return await github('readCommentPage',[number,page]) as RBridgeGitHubComment[];},async postComment(number,body){return await github('postComment',[number,body]) as RBridgeGitHubComment;},async closeIssue(number){await github('closeIssue',[number]);}}});
  send({type:'READY'});
 }catch(error){await owner?.close();await relay.release();throw error;}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url&&process.argv[2]==='--owner')void runOwner().catch(()=>{process.send?.({type:'ERROR'},()=>process.disconnect?.());process.exitCode=2;});
