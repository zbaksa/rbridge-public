import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readdir,readlink} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {encodeInstallReport,validateInstallContract,type ArtifactManifest,type InstallProfile,type InstallStatus} from './types.js';

export interface ArtifactQualificationInput{
  profile:InstallProfile;runtimeRoot:string;manifestSHA256:string;isolatedHome:string;
  runtimeManifest?:ArtifactManifest;toolkitRoot?:string;toolkitManifest?:ArtifactManifest;
}
export interface ArtifactQualificationReport{
  schema:'RBRIDGE_INSTALL_ARTIFACT_QUALIFICATION_V1';status:InstallStatus;reason_codes:readonly string[];
  runtimeVersion:string;actualNodeSHA256:string;runtimeManifestSHA256:string;toolkitManifestSHA256:string;
  sourceSHA:string;toolkitSHA:string;scope:'ISOLATED_FINAL_ARTIFACT_OWNER_IPC_MCP_HELPER';
  ownerBoot:'PASS'|'NOT_PERFORMED';mcpBoot:'PASS'|'NOT_PERFORMED';executedFixture:boolean;fixtureReceiptsSHA256:string;
}
export interface ArtifactQualificationEvidence{
  report:ArtifactQualificationReport;
  receipts:Awaited<ReturnType<typeof import('./artifactFixture.js').runFinalArtifactFixture>>|null;
}
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fail(code:string):never{throw new Error(code);}
export function validateArtifactIsolationHome(profile:InstallProfile,path:string):string{
  if(typeof path!=='string'||dirname(path)!==profile.binding.home
    ||!/^\.rbridge-artifact-[0-9a-f]{32}$/.test(basename(path))
    ||path!==join(profile.binding.home,basename(path)))fail('ARTIFACT_ISOLATION_INVALID');
  return path;
}
function relative(path:string):string[]{
  const parts=path.split('/');
  if(!path||path.length>4096||/[\x00\r\n]/.test(path)||parts.some(p=>!p||p==='.'||p==='..'))fail('ARTIFACT_PATH_INVALID');
  return parts;
}
export function validateArtifactManifest(value:unknown):ArtifactManifest{
  validateInstallContract(value,'ArtifactManifest');
  const m=structuredClone(value) as ArtifactManifest,{sha256,...base}=m;
  if(hash(encodeInstallReport(base))!==sha256||m.schema!==(m.kind==='RUNTIME'?'RBRIDGE_INSTALL_ARTIFACT_V1':'RBRIDGE_INSTALL_TOOLKIT_V1'))fail('ARTIFACT_MANIFEST_INVALID');
  const paths=new Map<string,ArtifactManifest['entries'][number]>();let size=0,previous='';
  for(const e of m.entries){
    const parts=relative(e.path);
    if(parts.length>129||(previous&&Buffer.compare(Buffer.from(previous),Buffer.from(e.path))>=0))fail('ARTIFACT_MANIFEST_INVALID');
    for(let i=1;i<parts.length;i++)if(paths.get(parts.slice(0,i).join('/'))?.kind!=='DIRECTORY')fail('ARTIFACT_MANIFEST_INVALID');
    if(e.kind==='FILE'){
      if(![0o644,0o755].includes(e.mode)||e.target||! /^[0-9a-f]{64}$/.test(e.sha256))fail('ARTIFACT_MANIFEST_INVALID');
      size+=e.size;if(size>1073741824)fail('ARTIFACT_BYTE_LIMIT');
    }else if(e.kind==='DIRECTORY'){
      if(e.mode!==0o755||e.size||e.sha256||e.target)fail('ARTIFACT_MANIFEST_INVALID');
    }else if(e.mode!==0o777||e.sha256||e.size!==Buffer.byteLength(e.target)||!e.target||e.target.startsWith('/')||/[\x00\r\n]/.test(e.target))fail('ARTIFACT_MANIFEST_INVALID');
    paths.set(e.path,e);previous=e.path;
  }
  for(const e of m.entries)if(e.kind==='SYMLINK'){
    let pending=[...e.path.split('/').slice(0,-1),...e.target.split('/')],hops=0;const resolved:string[]=[];
    while(pending.length){
      const part=pending.shift()!;if(!part||part==='.')continue;
      if(part==='..'){if(!resolved.length)fail('ARTIFACT_LINK_ESCAPE');resolved.pop();continue;}
      resolved.push(part);const target=paths.get(resolved.join('/'));if(!target)fail('ARTIFACT_DANGLING_LINK');
      if(target.kind==='SYMLINK'){if(++hops>40)fail('ARTIFACT_LINK_INVALID');resolved.pop();pending=[...target.target.split('/'),...pending];}
      else if(pending.length&&target.kind!=='DIRECTORY')fail('ARTIFACT_LINK_INVALID');
    }
    if(!resolved.length)fail('ARTIFACT_LINK_INVALID');
  }
  return m;
}
async function protectedPath(path:string,directory:boolean):Promise<void>{
  if(!path.startsWith('/')||path==='/')fail('ARTIFACT_PATH_INVALID');
  const parts=relative(path.slice(1));let current='';
  for(let i=0;i<parts.length;i++){
    current+='/'+parts[i];const s=await lstat(current);
    if(s.uid!==0||(s.mode&0o6022)!==0||s.isSymbolicLink()||((i<parts.length-1||directory)?!s.isDirectory():!s.isFile()))fail('ARTIFACT_NOT_PROTECTED');
  }
}
async function fileDigest(path:string,sizeLimit:number):Promise<string>{
  // This fixed procfs link names the executable already running in this process.
  const h=await open(path,constants.O_RDONLY|(path==='/proc/self/exe'?0:constants.O_NOFOLLOW)|constants.O_NONBLOCK);
  try{
    const before=await h.stat({bigint:true});
    if(!before.isFile()||before.nlink!==1n||before.size>BigInt(sizeLimit))fail('ARTIFACT_FILE_INVALID');
    const digest=createHash('sha256'),buffer=Buffer.alloc(1048576);let bytes=0;
    for(;;){const {bytesRead}=await h.read(buffer,0,buffer.length,null);if(!bytesRead)break;bytes+=bytesRead;if(bytes>sizeLimit)fail('ARTIFACT_BYTE_LIMIT');digest.update(buffer.subarray(0,bytesRead));}
    const after=await h.stat({bigint:true});
    if(bytes!==Number(before.size)||['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].some(k=>before[k as keyof typeof before]!==after[k as keyof typeof after]))fail('ARTIFACT_CHANGED');
    return digest.digest('hex');
  }finally{await h.close();}
}
export async function verifyProtectedArtifact(root:string,manifest:ArtifactManifest,profile:InstallProfile):Promise<void>{
  const m=validateArtifactManifest(manifest);await protectedPath(root,true);
  const started=performance.now(),names=new Map<string,string[]>();names.set('',[]);
  for(const e of m.entries){
    if(performance.now()-started>=profile.budget.scan_ms)fail('ARTIFACT_SCAN_DEADLINE');
    const parent=dirname(e.path)==='.'?'':dirname(e.path),children=names.get(parent);if(!children)fail('ARTIFACT_MANIFEST_INVALID');children.push(e.path.split('/').at(-1)!);
    const path=join(root,e.path),s=await lstat(path);
    if(s.uid!==0)fail('ARTIFACT_NOT_PROTECTED');
    if(e.kind==='DIRECTORY'){if(!s.isDirectory()||(s.mode&0o7777)!==e.mode)fail('ARTIFACT_BYTES_MISMATCH');names.set(e.path,[]);}
    else if(e.kind==='FILE'){if(!s.isFile()||s.nlink!==1||s.size!==e.size||(s.mode&0o7777)!==e.mode||await fileDigest(path,e.size)!==e.sha256)fail('ARTIFACT_BYTES_MISMATCH');}
    else if(!s.isSymbolicLink()||s.nlink!==1||await readlink(path)!==e.target)fail('ARTIFACT_BYTES_MISMATCH');
  }
  for(const [path,expected]of names){const actual=await readdir(join(root,path));if(actual.length!==expected.length||actual.some(n=>!expected.includes(n)))fail('ARTIFACT_BYTES_MISMATCH');}
}
export async function qualifyRBridgeArtifact(input:ArtifactQualificationInput):Promise<ArtifactQualificationReport>{
  return (await qualifyRBridgeArtifactWithEvidence(input)).report;
}
export async function qualifyRBridgeArtifactWithEvidence(input:ArtifactQualificationInput):Promise<ArtifactQualificationEvidence>{
  const p=input.profile;
  let receipts:ArtifactQualificationEvidence['receipts']=null;
  const report:ArtifactQualificationReport={schema:'RBRIDGE_INSTALL_ARTIFACT_QUALIFICATION_V1',status:'UNKNOWN',reason_codes:[],runtimeVersion:process.versions.node,actualNodeSHA256:'',runtimeManifestSHA256:input.manifestSHA256,toolkitManifestSHA256:input.toolkitManifest?.sha256??'',sourceSHA:p.runtime.source_sha,toolkitSHA:p.toolkit.source_sha,scope:'ISOLATED_FINAL_ARTIFACT_OWNER_IPC_MCP_HELPER',ownerBoot:'NOT_PERFORMED',mcpBoot:'NOT_PERFORMED',executedFixture:false,fixtureReceiptsSHA256:''};
  try{
    // Observe the running executable, never a caller's version label or callback.
    report.actualNodeSHA256=await fileDigest('/proc/self/exe',268435456);
    if(process.versions.node!==p.runtime.node_version||report.actualNodeSHA256!==p.runtime.node_sha256)fail('ARTIFACT_NODE_MISMATCH');
    const u=userInfo();
    if(process.getuid?.()!==p.binding.uid||process.geteuid?.()!==p.binding.uid||process.getgid?.()!==p.binding.gid||process.getegid?.()!==p.binding.gid||u.uid!==p.binding.uid||u.username!==p.binding.account||u.homedir!==p.binding.home)fail('ARTIFACT_RUNTIME_IDENTITY_MISMATCH');
    const groups=(process.getgroups?.()??[]).filter(g=>g!==p.binding.gid).sort((a,b)=>a-b);
    if(JSON.stringify(groups)!==JSON.stringify(p.binding.supplementary_gids)||process.execArgv.length||process.env.NODE_OPTIONS||process.env.NODE_PATH)fail('ARTIFACT_NODE_CONTEXT_INVALID');
    await protectedPath(p.runtime.node_path,false);
    if(await fileDigest(p.runtime.node_path,268435456)!==report.actualNodeSHA256)fail('ARTIFACT_NODE_MISMATCH');
    if(!input.runtimeManifest||!input.toolkitRoot||!input.toolkitManifest)fail('ARTIFACT_MANIFEST_REQUIRED');
    for(const [kind,m]of [['RUNTIME',input.runtimeManifest],['TOOLKIT',input.toolkitManifest]] as const){
      validateArtifactManifest(m);const pin=kind==='RUNTIME'?p.runtime:p.toolkit;
      if(m.kind!==kind||m.source_sha!==pin.source_sha||m.tree_sha!==pin.tree_sha||m.sha256!==pin.manifest_sha256||m.node_sha256!==report.actualNodeSHA256)fail('ARTIFACT_PIN_MISMATCH');
    }
    if(input.manifestSHA256!==input.runtimeManifest.sha256||fileURLToPath(import.meta.url)!==join(input.toolkitRoot,'dist/server/installation/artifactQualification.js'))fail('ARTIFACT_ENTRYPOINT_MISMATCH');
    await verifyProtectedArtifact(input.runtimeRoot,input.runtimeManifest,p);await verifyProtectedArtifact(input.toolkitRoot,input.toolkitManifest,p);
    validateArtifactIsolationHome(p,input.isolatedHome);
    const home=await lstat(input.isolatedHome);
    if(!home.isDirectory()||home.uid!==p.binding.uid||(home.mode&0o7777)!==0o700||(await readdir(input.isolatedHome)).length)fail('ARTIFACT_ISOLATION_INVALID');
    report.executedFixture=true;
    const module=await import(pathToFileURL(join(input.toolkitRoot,'dist/server/installation/artifactFixture.js')).href) as typeof import('./artifactFixture.js');
    receipts=await module.runFinalArtifactFixture(input);
    await verifyProtectedArtifact(input.runtimeRoot,input.runtimeManifest,p);await verifyProtectedArtifact(input.toolkitRoot,input.toolkitManifest,p);
    report.fixtureReceiptsSHA256=hash(encodeInstallReport(receipts));report.ownerBoot='PASS';report.mcpBoot='PASS';report.status='PASS';
  }catch(error){report.status=report.executedFixture?'FAIL':'BLOCKED';report.reason_codes=[error instanceof Error&&/^ARTIFACT_[A-Z_]+$/.test(error.message)?error.message:'ARTIFACT_QUALIFICATION_UNAVAILABLE'];}
  return {report,receipts};
}
