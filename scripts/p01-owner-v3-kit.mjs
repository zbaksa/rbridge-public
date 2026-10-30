import {createHash} from 'node:crypto';
import {access,cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,win32} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {canonicalJson,V3_CAPABILITIES,parseV3Scope,requireV3Peer} from '../dist/src/domain/rbridgeEffectProtocol.js';
import {RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY} from '../dist/src/domain/rbridgeScopeQuiescence.js';

const OLD_RELEASE='931e02d6b771a351e8c4e4977cf25ebf82d12a13';
const OLD_LINUX_SHA='4db4f9f829cee4a90807117ec8bdf8685ca56d282c6317ef8f4b4af3567d1a77';
const OLD_STARTUP_SHA='fc4d970903a94d6c49fc6dd5a9edf6f4aec4a61ccbfaf8c149974b203d2649d5';
const CONFIG_PATH='ops/p01-owner-generated/4786c8bd94d2/v3-peer-config.json';
const RESOURCES=Object.freeze(['manifest.json','serviceWorker.js','contentScript.js','p01-startup.json','setup.html','setup.js']);
const digest=data=>createHash('sha256').update(data).digest('hex');
const need=(condition,code)=>{if(!condition)throw Error(code);};
const exact=(row,keys,code)=>{need(row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===keys.length&&Object.keys(row).every(key=>keys.includes(key)),code);};
const sha160=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const sha256=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export function deriveP01Startup(originalConfigRaw,releaseSha){
 need(typeof originalConfigRaw==='string'&&Buffer.byteLength(originalConfigRaw)===783&&digest(originalConfigRaw)===OLD_LINUX_SHA,'P01_PINNED_LINUX_CONFIG_CHANGED');
 need(sha160(releaseSha)&&releaseSha!==OLD_RELEASE,'P01_TARGET_RELEASE_REQUIRED');
 const config=JSON.parse(originalConfigRaw);
 need(config.schema==='RBRIDGE_CHAT_PEER_CONFIG_V3'&&config.peerPins?.releaseSha===OLD_RELEASE&&config.initialHistory?.sequence===0&&config.initialHistory?.eventSha256===null,'P01_ORIGINAL_OWNER_SCOPE_CHANGED');
 const parsed=parseV3Scope(config.scope);
 need(parsed.appId==='cocwin'&&parsed.baseSha==='2f17ffcf5d8aefbb7bd3d3e4506f8fee965fd6db'&&parsed.sessionId==='exta-4786c8bd94d2feecc1e26a031b0693d6'&&parsed.generation==='7e7d5e17-2c44-4094-a6c8-0cf470ed564c','P01_ORIGINAL_OWNER_SCOPE_CHANGED');
 const scope={appId:parsed.appId,baseSha:parsed.baseSha,sessionId:parsed.sessionId,generation:parsed.generation};
 const data=config.peerPins,oldPeer={peerId:data.peerId,releaseSha:data.releaseSha,browserInstanceId:data.browserInstanceId,browserProfileId:data.browserProfileId,protocolMinor:data.protocolMinor,maxMessageBytes:data.maxMessageBytes,capabilities:data.capabilities};
 need(canonicalJson(oldPeer.capabilities)===canonicalJson(V3_CAPABILITIES),'P01_ORIGINAL_CAPABILITIES_CHANGED');
 requireV3Peer(oldPeer);
 const old={schema:'RBRIDGE_EXTENSION_STARTUP_V3',extensionId:'ebibbijpegoankenmggdnehpoadcophk',releaseSha:OLD_RELEASE,bootstrap:{schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1',browserInstanceId:data.browserInstanceId,browserProfileId:data.browserProfileId,nativeHostVersion:'rbridge-native-v3'},scope,peer:oldPeer,initialHistory:[],siteAdapter:'CHATGPT_EXACT_COPY_V3'};
 const predecessorRaw=JSON.stringify(old);
 need(Buffer.byteLength(predecessorRaw)===1095&&digest(predecessorRaw)===OLD_STARTUP_SHA,'P01_ORIGINAL_STARTUP_PIN_CHANGED');
 const peer={...oldPeer,releaseSha,capabilities:[...V3_CAPABILITIES,RBRIDGE_SCOPE_QUIESCENCE_CAPABILITY]};
 requireV3Peer(peer);
 const startup={...old,releaseSha,peer},raw=JSON.stringify(startup);
 return {raw,sha256:digest(raw),predecessorRaw,scope,peer,linuxConfigRaw:canonicalJson({...config,peerPins:peer})+'\n'};
}

/** This verifies content bindings. The release operator independently authenticates the canonical source and CI artifact proofs. */
export function verifyP01BuildProof({sourceProof,local,nativeProof,nativeBytes,metadataRaw}){
 exact(sourceProof,['schema','appCommit','canonicalCommit','tree','canonicalCommitBase64'],'P01_SOURCE_PROOF_INVALID');
 need(sourceProof.schema==='COCWIN_P01_CANONICAL_SOURCE_PROOF_V1'&&[sourceProof.appCommit,sourceProof.canonicalCommit,sourceProof.tree].every(sha160),'P01_SOURCE_PROOF_INVALID');
 need(local?.clean===true&&local.appCommit===sourceProof.appCommit&&local.tree===sourceProof.tree,'P01_LOCAL_SOURCE_TREE_MISMATCH');
 need(typeof sourceProof.canonicalCommitBase64==='string'&&sourceProof.canonicalCommitBase64.length<=131072,'P01_CANONICAL_COMMIT_INVALID');
 const commit=Buffer.from(sourceProof.canonicalCommitBase64,'base64');
 need(commit.toString('base64')===sourceProof.canonicalCommitBase64,'P01_CANONICAL_COMMIT_INVALID');
 const gitSha=createHash('sha1').update(Buffer.concat([Buffer.from('commit '+commit.length+'\0'),commit])).digest('hex');
 need(gitSha===sourceProof.canonicalCommit&&commit.subarray(0,46).toString()==='tree '+sourceProof.tree+'\n','P01_CANONICAL_COMMIT_MISMATCH');
 exact(nativeProof,['schema','sourceCommit','sourceTree','bytes','sha256','metadataSha256'],'P01_NATIVE_PROOF_INVALID');
 need(nativeProof.schema==='COCWIN_P01_NATIVE_ARTIFACT_PROOF_V1'&&nativeProof.sourceCommit===sourceProof.canonicalCommit&&nativeProof.sourceTree===sourceProof.tree,'P01_NATIVE_SOURCE_MISMATCH');
 need(Buffer.isBuffer(nativeBytes)&&nativeBytes.length>=1048576&&nativeBytes[0]===0x4d&&nativeBytes[1]===0x5a&&nativeProof.bytes===nativeBytes.length&&sha256(nativeProof.sha256)&&digest(nativeBytes)===nativeProof.sha256,'P01_NATIVE_EXECUTABLE_MISMATCH');
 need(typeof metadataRaw==='string'&&sha256(nativeProof.metadataSha256)&&digest(metadataRaw)===nativeProof.metadataSha256,'P01_NATIVE_METADATA_MISMATCH');
 const metadata=JSON.parse(metadataRaw);
 exact(metadata,['schema','status','nodeVersion','postjectVersion','sha256','bytes'],'P01_NATIVE_METADATA_INVALID');
 need(metadata.schema==='RBRIDGE_NATIVE_HOST_WINDOWS_SEA_V1'&&metadata.status==='PASS'&&/^v22\./.test(metadata.nodeVersion)&&metadata.postjectVersion==='1.0.0-alpha.6'&&metadata.sha256===nativeProof.sha256&&metadata.bytes===nativeProof.bytes,'P01_NATIVE_METADATA_INVALID');
 return {source:{appCommit:sourceProof.appCommit,canonicalCommit:sourceProof.canonicalCommit,tree:sourceProof.tree},native:{path:'native/rbridge-native-host.exe',bytes:nativeBytes.length,sha256:nativeProof.sha256,metadataPath:'native/rbridge-native-host.metadata.json',metadataSha256:nativeProof.metadataSha256,sourceCommit:nativeProof.sourceCommit,sourceTree:nativeProof.sourceTree}};
}
function git(args){
 const result=spawnSync('git',args,{encoding:'utf8',timeout:15000,maxBuffer:1048576});
 need(!result.error&&result.status===0,'P01_SOURCE_GIT_CHECK_FAILED');
 return result.stdout.trim();
}
function localProof(){return {appCommit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),clean:git(['status','--porcelain','--untracked-files=all'])===''};}
function argumentsFor(argv){
 const allowed=['--source-proof','--native-proof','--native-executable','--native-metadata'],out={};
 need(argv.length===8,'P01_BUILD_ARGUMENTS_REQUIRED');
 for(let index=0;index<argv.length;index+=2){const key=argv[index];need(allowed.includes(key)&&!Object.hasOwn(out,key)&&typeof argv[index+1]==='string'&&argv[index+1].length>0,'P01_BUILD_ARGUMENTS_INVALID');out[key]=argv[index+1];}
 return out;
}
export function p01ExtensionBuildInvocation(platform,nodeExecutable){
 if(platform==='win32')return {file:nodeExecutable,args:[win32.join(win32.dirname(nodeExecutable),'node_modules','npm','bin','npm-cli.js'),'run','build:extension'],shell:false};
 return {file:'npm',args:['run','build:extension'],shell:false};
}
export async function buildP01OwnerKit(argv){
 const args=argumentsFor(argv),sourceProof=JSON.parse(await readFile(args['--source-proof'],'utf8')),nativeProof=JSON.parse(await readFile(args['--native-proof'],'utf8'));
 const nativeBytes=await readFile(args['--native-executable']),metadataRaw=await readFile(args['--native-metadata'],'utf8');
 const verified=verifyP01BuildProof({sourceProof,local:localProof(),nativeProof,nativeBytes,metadataRaw});
 const originalConfigRaw=await readFile(CONFIG_PATH,'utf8'),startup=deriveP01Startup(originalConfigRaw,verified.source.canonicalCommit);
 const env={...process.env,RBRIDGE_EXTENSION_PROFILE:'v3',RBRIDGE_V3_STARTUP_CONFIG_SHA256:startup.sha256,RBRIDGE_RELEASE_SHA:verified.source.canonicalCommit};
 const invocation=p01ExtensionBuildInvocation(process.platform,process.execPath);
 if(process.platform==='win32'){try{await access(invocation.args[0]);}catch{throw Error('P01_STANDARD_NPM_CLI_REQUIRED');}}
 const run=spawnSync(invocation.file,invocation.args,{shell:invocation.shell,env,encoding:'utf8',timeout:180000,maxBuffer:2097152});
 need(!run.error&&run.status===0,'P01_V3_EXTENSION_BUILD_FAILED '+JSON.stringify({status:run.status,error:run.error?.message,tail:(String(run.stdout)+String(run.stderr)).slice(-2400)}));
 verifyP01BuildProof({sourceProof,local:localProof(),nativeProof,nativeBytes,metadataRaw});
 const kit=join(process.cwd(),'dist-p01-owner-v3-kit');
 await mkdir(kit); // Never replace an existing kit or follow an existing output link.
 await cp('dist-extension-v3',join(kit,'extension'),{recursive:true,errorOnExist:true,force:false});
 const extensionManifest=JSON.parse(await readFile(join(kit,'extension','manifest.json'),'utf8'));
 need(extensionManifest.name==='COCWIN RBridge Chat'&&extensionManifest.permissions?.includes('nativeMessaging')===true&&extensionManifest.background?.service_worker==='serviceWorker.js','P01_EXTENSION_BUILD_MANIFEST_UNEXPECTED');
 extensionManifest.action={default_popup:'setup.html',default_title:'COCWIN V3 — P01 nadogradnja'};
 await writeFile(join(kit,'extension','manifest.json'),JSON.stringify(extensionManifest,null,2)+'\n');
 await cp('scripts/p01-owner-setup.html',join(kit,'extension','setup.html'),{errorOnExist:true,force:false});
 const setup=await readFile('scripts/p01-owner-setup.js','utf8');
 need(setup.split('__STARTUP_SHA256__').length===2,'P01_SETUP_PIN_SLOT_INVALID');
 await writeFile(join(kit,'extension','setup.js'),setup.replace('__STARTUP_SHA256__',startup.sha256),{flag:'wx'});
 await writeFile(join(kit,'extension','p01-startup.json'),startup.raw,{flag:'wx'});
 for(const folder of ['linux','native','predecessor'])await mkdir(join(kit,folder));
 await writeFile(join(kit,'linux','v3-peer-config.json'),startup.linuxConfigRaw,{flag:'wx'});
 await writeFile(join(kit,'predecessor','v3-peer-config.json'),originalConfigRaw,{flag:'wx'});
 await writeFile(join(kit,'predecessor','p01-startup.json'),startup.predecessorRaw,{flag:'wx'});
 await writeFile(join(kit,'native','rbridge-native-host.exe'),nativeBytes,{flag:'wx'});
 await writeFile(join(kit,'native','rbridge-native-host.metadata.json'),metadataRaw,{flag:'wx'});
 await cp('scripts/upgrade-p01-pristine-native-windows.ps1',join(kit,'upgrade-p01-pristine-native-windows.ps1'),{errorOnExist:true,force:false});
 const resources=[];
 for(const path of RESOURCES){const bytes=await readFile(join(kit,'extension',path));resources.push({path,bytes:bytes.length,sha256:digest(bytes)});}
 const manifest={schema:'COCWIN_P01_PRISTINE_OWNER_KIT_V1',source:verified.source,scope:startup.scope,peer:startup.peer,
  predecessor:{startup:{bytes:1095,sha256:OLD_STARTUP_SHA},nativeConfig:{bytes:1553,sha256:'648e5d88a3eb3a98dd0c7c2508a7071eeaf642176b3587f5ecd22f4d43e0a70a'},nativeManifest:{bytes:372,sha256:'537717d92a24d8cf696e7b506fbdaeb745cbbc6627f16566e346e7c7056424a3'},nativeExecutable:{bytes:87200256,sha256:'c4d9317d84dbd7ac2f0d73df3c939fe2452eb6a78e56a142d17c83876228e5ee'},ownerMarker:{bytes:696,sha256:'81ab1ca55f715567c56e2efda611f12f23398b68023062db2740bb8e8103d3de'}},
  startup:{path:'extension/p01-startup.json',bytes:Buffer.byteLength(startup.raw),sha256:startup.sha256},native:verified.native,resources};
 const manifestRaw=JSON.stringify(manifest,null,2)+'\n';
 await writeFile(join(kit,'MANIFEST.json'),manifestRaw,{flag:'wx'});
 const cmd=await readFile('scripts/install-p01-pristine-native.cmd.template','utf8');
 need(cmd.split('__MANIFEST_SHA256__').length===2,'P01_CMD_MANIFEST_SLOT_INVALID');
 await writeFile(join(kit,'INSTALL_NATIVE.cmd'),cmd.replace('__MANIFEST_SHA256__',digest(manifestRaw)),{flag:'wx'});
 await writeFile(join(kit,'README.txt'),[
 'Original P01 pristine upgrade — BUILT, NOT INSTALLED.',
 'Offer this package for execution only after the actual Linux COMPLETE receipt has been independently read back.',
 'A package assertion is not an authenticated Linux receipt.',
 'WINDOWS: run INSTALL_NATIVE.cmd. No admin, private-key export, SSH connection or SEND is performed.',
 'CHROME: keep the original Chrome profile, extension ID/storage and original ChatGPT target tab.',
 'Copy all six files from kit extension/ into the EXISTING unpacked extension folder; click Reload for the existing COCWIN RBridge Chat in chrome://extensions.',
 'Then open the existing COCWIN RBridge Chat setup and use its guarded pristine continuation.',
 'Do not uninstall/re-add the extension, reset storage or create another profile.',
 'The exact old startup, intent and completion receipt are preserved; partial or conflicting state remains blocked.',
 'No transaction record authorizes SEND. Fresh C readiness and peer/source/provenance verification remain mandatory.',
 'App and canonical commits are separately recorded; their trees must match.',
 ].join('\r\n')+'\r\n',{flag:'wx'});
 console.log(JSON.stringify({schema:'COCWIN_P01_PRISTINE_OWNER_KIT_BUILD_V1',status:'BUILT_NOT_INSTALLED',source:verified.source,manifestSha256:digest(manifestRaw),startupSha256:startup.sha256,linuxConfigSha256:digest(startup.linuxConfigRaw),ownerWindows:'NOT_RUN',ownerChrome:'NOT_RUN',linuxProvision:'NOT_RUN',browserSends:0}));
 return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 await buildP01OwnerKit(process.argv.slice(2));
}
