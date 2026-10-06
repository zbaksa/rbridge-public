import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readFile,readlink} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {userInfo} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyProtectedArtifact} from './artifactQualification.js';
import {parseRBridgeInstallProfile,type ArtifactManifest,type InstallProfile} from './types.js';
import {installHash} from './gateContext.js';
import type {RBridgeScope} from '../domain/rbridgeCoreProtocol.js';
export interface McpReaderScope extends RBridgeScope{runtime_uid:number;intent_sha256:string;policy_sha256:string;deadline_ms:number;receipt_sha256?:string;output_sha256?:string;}
export interface McpReadClient{
  scope:'FIXTURE_AUTHORITY_ONLY'|'QUALIFIED_INSTALLED_MCP_CLIENT';sdk_package_version:string;negotiated_protocol_version:string;protocol_era:'legacy'|'modern';
  callTool(input:{name:'rbridge_capabilities'|'rbridge_status'|'rbridge_result';arguments:Record<string,unknown>},options:{signal:AbortSignal}):Promise<unknown>;
}
const authorities=new WeakSet<object>(),clients=new WeakSet<object>(),clientAuthorities=new WeakMap<object,InstalledReaderAuthority>();
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function fail(reason:string):never{throw new Error(reason);}
export interface InstalledReaderAuthority{profile:InstallProfile;manifest:ArtifactManifest;root:string;entrypoint:string;entrypoint_sha256:string;profile_sha256:string;version:'1';}
async function protectedDigest(path:string,proc=false){
  if(!proc){let current='';const parts=path.split('/').slice(1);for(let n=0;n<parts.length-1;n++){const part=parts[n];if(!part||part==='.'||part==='..')fail('READER_RUNTIME_UNQUALIFIED');current+='/'+part;const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.mode&0o6022)fail('READER_RUNTIME_UNQUALIFIED');}}
  const fd=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|(proc?0:constants.O_NOFOLLOW));
  try{const before=await fd.stat({bigint:true});if(!before.isFile()||before.uid!==0n||before.nlink!==1n||before.size>268435456n||before.mode&0o6022n)fail('READER_RUNTIME_UNQUALIFIED');const bytes=await fd.readFile(),after=await fd.stat({bigint:true});if(bytes.length!==Number(before.size)||['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].some(k=>before[k as keyof typeof before]!==after[k as keyof typeof after]))fail('READER_RUNTIME_CHANGED');return hash(bytes);}finally{await fd.close();}
}
export async function qualifyInstalledReaderRuntime(profile:InstallProfile,manifest:ArtifactManifest):Promise<InstalledReaderAuthority>{
  const p=parseRBridgeInstallProfile(profile),u=userInfo(),root=join(p.paths.release_parent,'toolkit-'+p.toolkit.source_sha),entrypoint=join(root,'dist/server/cli/rbridgeReadResult.js');
  if(process.getuid?.()!==p.binding.uid||process.geteuid?.()!==p.binding.uid||process.getgid?.()!==p.binding.gid||process.getegid?.()!==p.binding.gid||u.username!==p.binding.account||u.homedir!==p.binding.home||process.versions.node!==p.runtime.node_version||process.execArgv.length||process.env.NODE_OPTIONS||process.env.NODE_PATH||process.argv.length!==2||process.argv[1]!==entrypoint||fileURLToPath(import.meta.url)!==join(root,'dist/server/installation/rbridge-installation-client.js'))fail('READER_RUNTIME_UNQUALIFIED');
  if(JSON.stringify((process.getgroups?.()??[]).filter(g=>g!==p.binding.gid).sort((a,b)=>a-b))!==JSON.stringify(p.binding.supplementary_gids)||await readlink('/proc/self/exe')!==p.runtime.node_path||await protectedDigest('/proc/self/exe',true)!==p.runtime.node_sha256||await protectedDigest(p.runtime.node_path)!==p.runtime.node_sha256)fail('READER_RUNTIME_UNQUALIFIED');
  if(manifest.kind!=='TOOLKIT'||manifest.source_sha!==p.toolkit.source_sha||manifest.tree_sha!==p.toolkit.tree_sha||manifest.sha256!==p.toolkit.manifest_sha256||manifest.node_sha256!==p.runtime.node_sha256)fail('READER_TOOLKIT_UNQUALIFIED');
  await verifyProtectedArtifact(root,manifest,p);const e=manifest.entries.find(e=>e.path==='dist/server/cli/rbridgeReadResult.js'&&e.kind==='FILE');if(!e||await protectedDigest(entrypoint)!==e.sha256)fail('READER_ENTRYPOINT_UNQUALIFIED');
  const authority=Object.freeze({profile:p,manifest:Object.freeze({...structuredClone(manifest),entries:Object.freeze(manifest.entries.map(e=>Object.freeze({...e})))}),root,entrypoint,entrypoint_sha256:e.sha256,profile_sha256:installHash(p),version:'1' as const});authorities.add(authority);return authority;
}
export function isInstalledReaderAuthority(value:unknown):value is InstalledReaderAuthority{return !!value&&typeof value==='object'&&authorities.has(value);}
export async function verifyInstalledReaderAuthority(authority:InstalledReaderAuthority){if(!isInstalledReaderAuthority(authority))fail('READER_RUNTIME_UNQUALIFIED');await verifyProtectedArtifact(authority.root,authority.manifest,authority.profile);if(await protectedDigest(authority.entrypoint)!==authority.entrypoint_sha256)fail('READER_ENTRYPOINT_CHANGED');}
export async function observedSdkPackageVersion(){const req=createRequire(import.meta.url),pkg=JSON.parse(await readFile(join(dirname(dirname(req.resolve('@modelcontextprotocol/client'))),'package.json'),'utf8')) as {version?:unknown};if(pkg.version!=='2.3.0')fail('READER_SDK_VERSION_UNQUALIFIED');return pkg.version;}
export async function createFixtureSdkReadClient(client:Client):Promise<McpReadClient>{
  if(!(client instanceof Client))fail('READER_SDK_CLIENT_REQUIRED');const version=await observedSdkPackageVersion(),protocol=client.getNegotiatedProtocolVersion(),era=client.getProtocolEra();if(!protocol||!era)fail('READER_SDK_HANDSHAKE_REQUIRED');
  return {scope:'FIXTURE_AUTHORITY_ONLY',sdk_package_version:version,negotiated_protocol_version:protocol,protocol_era:era,callTool:(input,options)=>{if(!['rbridge_capabilities','rbridge_status','rbridge_result'].includes(input.name))fail('READER_READ_ONLY_TOOL_REQUIRED');return client.callTool(input,options);}};
}
export function isInstalledMcpReadClient(value:unknown):value is McpReadClient{return !!value&&typeof value==='object'&&clients.has(value);}
export function assertInstalledMcpReaderScope(client:McpReadClient,scope:McpReaderScope){const a=clientAuthorities.get(client),b=a?.profile.binding;if(!a||!b||scope.runtime_uid!==b.uid||scope.principalId!==b.principal_id||scope.targetInstanceId!==b.target_instance_id||scope.policy_sha256!==b.policy_sha256)fail('MCP_READER_BINDING_INVALID');}
export async function createInstalledMcpReadClient(authority:InstalledReaderAuthority,runtimeManifest:ArtifactManifest,era:'legacy'|'modern',isolatedRoot?:string):Promise<McpReadClient&{close():Promise<void>;pid:number}> {
  await verifyInstalledReaderAuthority(authority);const p=authority.profile,runtime=join(p.paths.release_parent,p.runtime.source_sha);
  if(runtimeManifest.kind!=='RUNTIME'||runtimeManifest.source_sha!==p.runtime.source_sha||runtimeManifest.tree_sha!==p.runtime.tree_sha||runtimeManifest.sha256!==p.runtime.manifest_sha256||runtimeManifest.node_sha256!==p.runtime.node_sha256)fail('READER_RUNTIME_ARTIFACT_UNQUALIFIED');await verifyProtectedArtifact(runtime,runtimeManifest,p);
  let args=[join(runtime,'dist/server/server/rbridgeMcpMain.js')];
  if(isolatedRoot!==undefined){
    const relative=isolatedRoot.slice(p.binding.home.length+1),parts=relative.split('/');if(!isolatedRoot.startsWith(p.binding.home+'/.rbridge-artifact-')||parts.length!==5||!/^\.rbridge-artifact-[a-zA-Z0-9_-]{1,128}$/.test(parts[0]??'')||parts.slice(1).join('/')!=='.local/state/rbridge/execution-v2')fail('READER_ISOLATED_ROOT_INVALID');
    let current=p.binding.home;for(const part of parts){current=join(current,part);const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==p.binding.uid||(s.mode&0o7777)!==0o700)fail('READER_ISOLATED_ROOT_INVALID');}
    args=[join(authority.root,'dist/server/installation/artifactFixture.js'),'--stdio-client',runtime,isolatedRoot,JSON.stringify({runtimeUid:p.binding.uid,principalId:p.binding.principal_id,targetInstanceId:p.binding.target_instance_id})];
  }
  if(!['legacy','modern'].includes(era))fail('READER_SDK_ERA_INVALID');
  const transport=new StdioClientTransport({command:p.runtime.node_path,args,env:{PATH:'/usr/bin:/bin',HOME:p.binding.home,USER:p.binding.account,LOGNAME:p.binding.account,LC_ALL:'C',RBRIDGE_RUNTIME_USER:p.binding.account,RBRIDGE_MCP_PRINCIPAL_ID:p.binding.principal_id,RBRIDGE_INSTANCE_ID:p.binding.target_instance_id},cwd:'/',stderr:'pipe',maxBufferSize:131072}),client=new Client({name:'rbridge-installation-reader',version:'1'},{versionNegotiation:{mode:era==='legacy'?'legacy':{pin:'2026-07-28'}}});let errorBytes=0,invalid=false;
  transport.stderr?.on('data',(bytes:Uint8Array)=>{errorBytes+=bytes.byteLength;invalid=true;if(errorBytes>131072)void client.close();});
  try{await client.connect(transport,{signal:AbortSignal.timeout(p.budget.lookup_ms)});if(invalid||!transport.pid)fail('READER_MCP_HELPER_UNQUALIFIED');const observed=await createFixtureSdkReadClient(client),wrapped={...observed,scope:'QUALIFIED_INSTALLED_MCP_CLIENT' as const,pid:transport.pid,async callTool(input:Parameters<McpReadClient['callTool']>[0],options:Parameters<McpReadClient['callTool']>[1]){if(invalid)fail('READER_MCP_HELPER_UNQUALIFIED');if(!['rbridge_capabilities','rbridge_status','rbridge_result'].includes(input.name))fail('READER_READ_ONLY_TOOL_REQUIRED');return client.callTool(input,options);},async close(){await client.close();await verifyProtectedArtifact(runtime,runtimeManifest,p);await verifyInstalledReaderAuthority(authority);}};clients.add(wrapped);clientAuthorities.set(wrapped,authority);return Object.freeze(wrapped);}catch(error){await client.close();throw error;}
}
