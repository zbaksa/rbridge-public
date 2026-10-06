/** Resume only the isolated artifact owner to read its original terminal bytes. */
import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {captureArtifactOperation} from './artifactEvidence.js';
import {validateArtifactIsolationHome,verifyProtectedArtifact} from './artifactQualification.js';
import {parseRBridgeCarrierJson} from './carrierJson.js';
import {verifyInstalledReaderAuthority,type InstalledReaderAuthority} from './rbridge-installation-client.js';
import {encodeInstallReport,validateInstallContract,type ArtifactManifest,type InstallProfile} from './types.js';
import type {ReaderQualificationReport} from './readerQualification.js';
import {createIsolatedCoreCarrierPort,produceCoreCarrierCases} from './coreCarrierFixture.js';
import type {RBridgeGitHubPort} from '../adapters/githubIssueRemoteBridge.js';
import type {RBridgeOwnerRuntime} from '../server/rbridgeOwnerRuntime.js';
import type {RBridgeDeploymentBinding} from '../domain/rbridgeCoreProtocol.js';
import type {RBridgeExecutionReceiptV1,RBridgeOperationSubmissionV1,RBridgeTransportContextV1} from '../domain/rbridgeExecutionContract.js';

const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fail():never{throw new Error('READER_ARCHIVED_FIXTURE_INVALID');}
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))fail();return v as Record<string,unknown>;}
function parsed(v:unknown){if(typeof v!=='string')fail();return parseRBridgeCarrierJson(Buffer.from(v),131072);}
function artifactReceipts(profile:InstallProfile,value:unknown){
  const row=object(value),binding={runtimeUid:profile.binding.uid,principalId:profile.binding.principal_id,targetInstanceId:profile.binding.target_instance_id};
  if(row.schema!=='RBRIDGE_FINAL_ARTIFACT_FIXTURE_V1'||row.bindingSHA256!==hash(encodeInstallReport(binding))||row.fixture!=='OWNER_IPC_MCP_HELPER_STDIO'||row.productionEntrypointAcceptance!=='NOT_PERFORMED'||row.healthCalls!==1||!Array.isArray(row.receipts)||row.receipts.length!==2)fail();
  return row.receipts.map((value,index)=>{
    const r=object(value),id=index===0?'artifact-health':'artifact-read',receipt=parsed(r.receiptJSON) as RBridgeExecutionReceiptV1;
    if(r.operationId!==id||typeof r.resultBase64!=='string'||!Array.isArray(r.pagesJSON)||r.pagesJSON.length>512)fail();
    const submission:RBridgeOperationSubmissionV1={schema:'RBRIDGE_OPERATION_SUBMISSION_V1',operationId:id,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId,
      operation:index===0?{kind:'HEALTH',action:'STATUS'}:{kind:'FILE',action:'READ',target:'/mnt/data/source.txt',args:{}}};
    const context:RBridgeTransportContextV1={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:profile.binding.mcp_subject,principalId:binding.principalId};
    if(hash(encodeInstallReport(parsed(r.submissionJSON)))!==hash(encodeInstallReport(submission))||hash(encodeInstallReport(parsed(r.contextJSON)))!==hash(encodeInstallReport(context)))fail();
    const rebuilt=captureArtifactOperation({submission,context,receipt,pages:r.pagesJSON.map(parsed),output:Buffer.from(r.resultBase64,'base64'),policy_sha256:profile.binding.policy_sha256});
    if(hash(encodeInstallReport(rebuilt))!==hash(encodeInstallReport(r)))fail();
    return {record:rebuilt,receipt};
  });
}

export function prepareArchivedReaderInput(profile:InstallProfile,fixtures:unknown,artifactFixture:unknown,isolatedHome:string){
  const home=validateArtifactIsolationHome(profile,isolatedHome),root=join(home,'.local/state/rbridge/execution-v2'),rows=artifactReceipts(profile,artifactFixture),input=object(fixtures);
  if(Object.keys(input).some(k=>k!=='cases')||!Array.isArray(input.cases)||input.cases.length>512)fail();
  const eras=new Set<string>(),cases=input.cases.map(value=>{
    const f=object(value);if(f.transport==='GITHUB')return structuredClone(f);
    if(f.transport!=='MCP'||f.case_id!=='C09'||!['legacy','modern'].includes(String(f.era))||eras.has(String(f.era))||Object.hasOwn(f,'isolated_root')||Object.hasOwn(f,'transcript'))fail();
    eras.add(String(f.era));const e=object(f.expected),original=rows.find(row=>row.record.operationId===e.operationId);if(!original)fail();
    if(e.principalId!==profile.binding.principal_id||e.targetInstanceId!==profile.binding.target_instance_id||e.runtime_uid!==profile.binding.uid||e.policy_sha256!==profile.binding.policy_sha256||e.intent_sha256!==original.receipt.intentSha256||e.receipt_sha256!==original.record.receiptSHA256||e.output_sha256!==original.record.resultSHA256)fail();
    return {...structuredClone(f),isolated_root:root};
  });
  if(eras.size!==2)fail();return {root,fixtures:{cases},originals:rows};
}

async function withArchivedOwner<T>(authority:InstalledReaderAuthority,runtimeManifest:ArtifactManifest,isolatedHome:string,artifactFixture:unknown,github:RBridgeGitHubPort,run:(owner:RBridgeOwnerRuntime)=>Promise<T>):Promise<T>{
  await verifyInstalledReaderAuthority(authority);const p=authority.profile,runtimeRoot=join(p.paths.release_parent,p.runtime.source_sha),root=join(validateArtifactIsolationHome(p,isolatedHome),'.local/state/rbridge/execution-v2'),originals=artifactReceipts(p,artifactFixture);
  if(runtimeManifest.kind!=='RUNTIME'||runtimeManifest.source_sha!==p.runtime.source_sha||runtimeManifest.tree_sha!==p.runtime.tree_sha||runtimeManifest.sha256!==p.runtime.manifest_sha256||runtimeManifest.node_sha256!==p.runtime.node_sha256)fail();
  await verifyProtectedArtifact(runtimeRoot,runtimeManifest,p);
  for(const path of [isolatedHome,join(isolatedHome,'.local'),join(isolatedHome,'.local/state'),dirname(root),root,join(isolatedHome,'source')]){
    const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==p.binding.uid||(s.mode&0o7777)!==0o700)fail();
  }
  const load=async<T>(name:string)=>await import(pathToFileURL(join(runtimeRoot,'dist/server/server',name+'.js')).href) as T;
  const owners=await load<typeof import('../server/rbridgeOwnerRuntime.js')>('rbridgeOwnerRuntime'),locks=await load<typeof import('../server/remoteBridgeStore.js')>('remoteBridgeStore'),ipcModule=await load<typeof import('../server/rbridgeCoreIpc.js')>('rbridgeCoreIpc');
  const user=userInfo(),binding:RBridgeDeploymentBinding={runtimeUid:p.binding.uid,principalId:p.binding.principal_id,targetInstanceId:p.binding.target_instance_id},context:RBridgeTransportContextV1={schema:'RBRIDGE_TRANSPORT_CONTEXT_V1',transport:'MCP',authenticatedSubject:p.binding.mcp_subject,principalId:binding.principalId};
  const relay=await locks.acquireRemoteBridgeProcessLock(dirname(root));let owner:Awaited<ReturnType<typeof owners.startRBridgeOwnerRuntime>>|undefined,ipc:Awaited<ReturnType<typeof ipcModule.connectRBridgeCoreIpcClient>>|undefined;
  try{
    owner=await owners.startRBridgeOwnerRuntime({runtimeIdentity:{username:user.username,homedir:isolatedHome,uid:p.binding.uid,euid:p.binding.uid},env:{RBRIDGE_RUNTIME_USER:p.binding.account,RBRIDGE_MCP_PRINCIPAL_ID:binding.principalId,RBRIDGE_INSTANCE_ID:binding.targetInstanceId,RBRIDGE_GITHUB_REPOSITORY:p.binding.repository,RBRIDGE_GITHUB_AUTHOR:p.binding.author},sourceRoot:join(isolatedHome,'source'),health:{snapshot(){fail();}},github:{...github,async listOpenRequests(){return [];},async publishResult(){fail();}}});
    ipc=await ipcModule.connectRBridgeCoreIpcClient({root,expectedBinding:binding});
    if((await ipc.binding()).policySha256!==p.binding.policy_sha256)fail();
    const check=async()=>{for(const original of originals){const result=await ipc!.status(original.record.operationId,context);if(result.status!=='RECEIPT'||hash(encodeInstallReport(result.receipt))!==original.record.receiptSHA256)fail();}};
    await check();const result=await run(owner);await check();
    await verifyProtectedArtifact(runtimeRoot,runtimeManifest,p);await verifyInstalledReaderAuthority(authority);return result;
  }finally{await ipc?.close();await owner?.close();await relay.release();}
}

export async function runArchivedReaderFixture(authority:InstalledReaderAuthority,runtimeManifest:ArtifactManifest,isolatedHome:string,artifactFixture:unknown,registry:unknown,fixtures:unknown):Promise<ReaderQualificationReport>{
  await verifyInstalledReaderAuthority(authority);const p=authority.profile,prepared=prepareArchivedReaderInput(p,fixtures,artifactFixture,isolatedHome);
  const github:RBridgeGitHubPort={async readIssue(){fail();},async readCommentPage(){fail();},async postComment(){fail();},async closeIssue(){fail();}};
  return withArchivedOwner(authority,runtimeManifest,isolatedHome,artifactFixture,github,async()=>{
    const {runRBridgeReadResult}=await import('../cli/rbridgeReadResult.js');
    const result=await runRBridgeReadResult({schema:'RBRIDGE_READER_INPUT_V1',operation:'QUALIFY_INSTALLED',profile:p,toolkit_manifest:authority.manifest,runtime_manifest:runtimeManifest,registry,fixtures:prepared.fixtures});
    validateInstallContract(result,'ReaderQualificationReport');return result as ReaderQualificationReport;
  });
}

export async function runArchivedCoreProducer(authority:InstalledReaderAuthority,runtimeManifest:ArtifactManifest,isolatedHome:string,artifactFixture:unknown,contextSHA256:string){
  await verifyInstalledReaderAuthority(authority);const p=authority.profile;
  if(!/^[0-9a-f]{64}$/.test(contextSHA256)||p.readers.some(r=>r.transport==='GITHUB'&&r.trusted_context_sha256!==contextSHA256))fail();
  const port=createIsolatedCoreCarrierPort(p.binding.repository,p.binding.author),originals=artifactReceipts(p,artifactFixture).map(r=>r.record);
  return withArchivedOwner(authority,runtimeManifest,isolatedHome,artifactFixture,port,owner=>produceCoreCarrierCases({
    binding:{runtimeUid:p.binding.uid,principalId:p.binding.principal_id,targetInstanceId:p.binding.target_instance_id},repository:p.binding.repository,author:p.binding.author,
    source_sha:p.runtime.source_sha as 'b5881fd8367b4249e82683f1f884f2392cb696d4',context_sha256:contextSHA256,sourceDirectory:join(isolatedHome,'source'),
    core:owner.core,adapter:owner.githubCore,port,originals,deadline_ms:Math.min(p.budget.acceptance_ms,180000)}));
}
