/** Fixed fixture shipped in the protected toolkit. No tsx/build-tree fallback. */
import {createHash} from 'node:crypto';
import {lstat,mkdir,readdir,writeFile} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {serveStdio,StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import type {RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeExecutionReceiptV1,RBridgeOperationSubmissionV1,RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';
import {parseRBridgeCoreResultPage} from '../domain/rbridgeCoreValidation.js';
import {encodeInstallReport} from './types.js';
import type {ArtifactQualificationInput} from './artifactQualification.js';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const object=(value:unknown)=>value as Record<string,unknown>|undefined;
function fail():never{throw new Error('ARTIFACT_FIXTURE_FAILED');}
async function runtime<T>(root:string,name:string):Promise<T>{return await import(pathToFileURL(join(root,'dist/server/server',name+'.js')).href) as T;}
export async function runFinalArtifactFixture(input:ArtifactQualificationInput){
  const {profile:p,runtimeRoot,isolatedHome:home}=input,uid=process.getuid?.(),user=userInfo();
  if(uid!==1027||process.geteuid?.()!==uid||uid!==p.binding.uid||user.username!==p.binding.account||process.versions.node!=='22.23.2')fail();
  const ownerModule=await runtime<typeof import('../server/rbridgeOwnerRuntime.js')>(runtimeRoot,'rbridgeOwnerRuntime');
  const locks=await runtime<typeof import('../server/remoteBridgeStore.js')>(runtimeRoot,'remoteBridgeStore');
  const ipcModule=await runtime<typeof import('../server/rbridgeCoreIpc.js')>(runtimeRoot,'rbridgeCoreIpc');
  // Import the actual production entrypoints and their shipped static closures.
  await runtime(runtimeRoot,'remoteBridgeMain');await runtime(runtimeRoot,'rbridgeMcpMain');
  const root=join(home,'.local/state/rbridge/execution-v2'),source=join(home,'source');
  for(const path of [join(home,'.local'),join(home,'.local/state'),dirname(root),source])await mkdir(path,{mode:0o700});
  await writeFile(join(source,'source.txt'),'artifact read é\n',{mode:0o600,flag:'wx'});
  const binding:RBridgeDeploymentBinding={runtimeUid:uid,principalId:p.binding.principal_id,targetInstanceId:p.binding.target_instance_id};
  const context:RBridgeTransportContextV1={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:`uid:${uid}`,principalId:binding.principalId};
  const relay=await locks.acquireRemoteBridgeProcessLock(dirname(root));
  let owner:Awaited<ReturnType<typeof ownerModule.startRBridgeOwnerRuntime>>|undefined,ipc:Awaited<ReturnType<typeof ipcModule.connectRBridgeCoreIpcClient>>|undefined,client:Client|undefined,healthCalls=0;
  try{
    owner=await ownerModule.startRBridgeOwnerRuntime({runtimeIdentity:{username:user.username,homedir:home,uid,euid:uid},env:{RBRIDGE_RUNTIME_USER:p.binding.account,RBRIDGE_MCP_PRINCIPAL_ID:binding.principalId,RBRIDGE_INSTANCE_ID:binding.targetInstanceId,RBRIDGE_GITHUB_REPOSITORY:p.binding.repository,RBRIDGE_GITHUB_AUTHOR:p.binding.author},sourceRoot:source,health:{snapshot(){healthCalls++;return {schema:'COCWIN_REMOTE_BRIDGE_HEALTH_V2',status:'PASS',releaseSha:p.runtime.source_sha,uptimeMs:0,queueCount:0,sessionCount:0,transferCount:0,lastGitHubPollAt:null};}},github:{async listOpenRequests(){return [];},async publishResult(){fail();},async readIssue(){fail();},async readCommentPage(){fail();},async postComment(){fail();},async closeIssue(){fail();}}});
    ipc=await ipcModule.connectRBridgeCoreIpcClient({root,expectedBinding:binding});
    if((await ipc.binding()).policySha256!==p.binding.policy_sha256)fail();
    const transport=new StdioClientTransport({command:p.runtime.node_path,args:[fileURLToPath(import.meta.url),'--stdio-client',runtimeRoot,root,JSON.stringify(binding)],env:{PATH:'/usr/bin:/bin'},stderr:'pipe'});
    client=new Client({name:'rbridge-artifact-qualification',version:'1'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
    const signal=AbortSignal.timeout(Math.min(p.budget.acceptance_ms,60000));
    await client.connect(transport);
    const receipts:Array<{operationId:string;receiptSHA256:string;resultSHA256:string}>=[];
    for(const [id,operation]of [['artifact-health',{kind:'HEALTH',action:'STATUS'}],['artifact-read',{kind:'FILE',action:'READ',target:'/mnt/data/source.txt',args:{}}]] as const){
      if(signal.aborted)fail();
      const submission:RBridgeOperationSubmissionV1={schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:id,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,operation};
      if((await ipc.submit(submission,context,signal)).status!=='RECEIPT')fail();
      const admitted=await client.callTool({name:'rbridge_submit',arguments:{operationId:id,operation}});
      if(object(admitted.structuredContent)?.status!=='CORE_RECEIPT')fail();
      let receipt:RBridgeExecutionReceiptV1|undefined;
      while(!signal.aborted){
        const row=await ipc.status(id,context);
        if(row.status==='RECEIPT'&&row.receipt.phase==='TERMINAL'){receipt=row.receipt;break;}
        await new Promise<void>(done=>setTimeout(done,10));
      }
      if(!receipt||receipt.outcome!=='PASS')fail();
      const status=object((await client.callTool({name:'rbridge_status',arguments:{operationId:id}})).structuredContent)?.result as {receipt?:unknown}|undefined;
      if(hash(encodeInstallReport(status?.receipt))!==hash(encodeInstallReport(receipt)))fail();
      let cursor=0,digest='';const chunks:Buffer[]=[];
      for(let pages=0;pages<512;pages++){
        const value=object((await client.callTool({name:'rbridge_result',arguments:{operationId:id,cursor,maxBytes:32768}})).structuredContent)?.result;
        const page=parseRBridgeCoreResultPage(value,submission,cursor,32768);
        if(page.status!=='RESULT'||(digest&&digest!==page.resultSha256)||page.nextCursor<=cursor&&!page.eof)fail();
        digest=page.resultSha256;chunks.push(Buffer.from(page.dataBase64,'base64'));cursor=page.nextCursor;
        if(page.eof)break;if(pages===511||signal.aborted)fail();
      }
      const bytes=Buffer.concat(chunks);if(hash(bytes)!==digest)fail();
      if(id==='artifact-read'&&(JSON.parse(bytes.toString('utf8')) as {text?:unknown}).text!=='artifact read é\n')fail();
      receipts.push({operationId:id,receiptSHA256:hash(encodeInstallReport(receipt)),resultSHA256:digest});
    }
    if(healthCalls!==1)fail();
    return {schema:'RBRIDGE_FINAL_ARTIFACT_FIXTURE_V1',bindingSHA256:hash(encodeInstallReport(binding)),receipts,healthCalls,fixture:'OWNER_IPC_MCP_HELPER_STDIO',productionEntrypointAcceptance:'NOT_PERFORMED'};
  }finally{await client?.close();await ipc?.close();await owner?.close();await relay.release();}
}
async function stdioClient(){
  const [runtimeRoot,root,rawBinding]=process.argv.slice(3),user=userInfo(),uid=process.getuid?.();
  if(!runtimeRoot||!root||!rawBinding||uid!==1027||process.geteuid?.()!==uid||user.username!=='rbridge'||process.versions.node!=='22.23.2'||process.execArgv.length||!root.startsWith(user.homedir+'/.rbridge-artifact-'))fail();
  const binding=JSON.parse(rawBinding) as RBridgeDeploymentBinding;
  if(binding.runtimeUid!==uid||! /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(binding.principalId)||! /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(binding.targetInstanceId))fail();
  const s=await lstat(dirname(root));if(!s.isDirectory()||s.uid!==uid||(s.mode&0o777)!==0o700||!(await readdir(dirname(root))).includes('relay.lock'))fail();
  const {connectRBridgeCoreIpcClient}=await runtime<typeof import('../server/rbridgeCoreIpc.js')>(runtimeRoot,'rbridgeCoreIpc');
  const {createRBridgeMcpSafeServer}=await runtime<typeof import('../server/rbridgeMcpSafe.js')>(runtimeRoot,'rbridgeMcpSafe');
  const client=await connectRBridgeCoreIpcClient({root,expectedBinding:binding}),transport=new StdioServerTransport(),originalClose=transport.close.bind(transport);
  transport.close=async()=>{await originalClose();await client.close();};
  serveStdio(()=>createRBridgeMcpSafeServer({binding:{authenticatedSubject:`uid:${uid}`,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId},core:client,bindingProvider:()=>client.binding()}),{transport,legacy:'serve',onerror:()=>{process.exitCode=2;}});
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url&&process.argv[2]==='--stdio-client')void stdioClient().catch(()=>{process.stderr.write('ARTIFACT_FIXTURE_FAILED\n');process.exitCode=2;});
