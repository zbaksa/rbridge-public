import {createHash} from 'node:crypto';
import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonicalJson,V3_CAPABILITIES,parseV3Scope,requireV3Peer} from '../dist/src/domain/rbridgeEffectProtocol.js';

const releaseSha='931e02d6b771a351e8c4e4977cf25ebf82d12a13';
const cocwinBaseSha='2f17ffcf5d8aefbb7bd3d3e4506f8fee965fd6db';
const kit=join(process.cwd(),'dist-p01-owner-v3-kit');
const digest=data=>createHash('sha256').update(data).digest('hex');
const pinnedFile='ops/p01-owner-generated/4786c8bd94d2/v3-peer-config.json';
const originalConfigText=await readFile(pinnedFile,'utf8');
const expectedLinuxSha='4db4f9f829cee4a90807117ec8bdf8685ca56d282c6317ef8f4b4af3567d1a77';
if(digest(originalConfigText)!==expectedLinuxSha)throw Error('P01_PINNED_LINUX_CONFIG_CHANGED');
const config=JSON.parse(originalConfigText);
if(config.schema!=='RBRIDGE_CHAT_PEER_CONFIG_V3'||config.scope?.appId!=='cocwin'
 ||config.scope?.baseSha!==cocwinBaseSha||config.peerPins?.releaseSha!==releaseSha
 ||config.initialHistory?.sequence!==0||config.initialHistory?.eventSha256!==null)throw Error('P01_ORIGINAL_OWNER_SCOPE_CHANGED');
const scope=parseV3Scope(config.scope);
const peer=config.peerPins;
if(JSON.stringify(peer.capabilities)!==JSON.stringify(V3_CAPABILITIES))throw Error('P01_CAPABILITIES_CHANGED');
requireV3Peer(peer);
const initialHistory={sequence:0,eventSha256:null};
const startup={schema:'RBRIDGE_EXTENSION_STARTUP_V3',extensionId:'ebibbijpegoankenmggdnehpoadcophk',releaseSha,
  bootstrap:{schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1',browserInstanceId:peer.browserInstanceId,browserProfileId:peer.browserProfileId,nativeHostVersion:'rbridge-native-v3'},
  scope,peer,initialHistory:[],siteAdapter:'CHATGPT_EXACT_COPY_V3'};
const startupRaw=JSON.stringify(startup),startupHash=digest(startupRaw);
if(startupHash!=='fc4d970903a94d6c49fc6dd5a9edf6f4aec4a61ccbfaf8c149974b203d2649d5')throw Error('P01_ORIGINAL_STARTUP_PIN_CHANGED');
const env={...process.env,RBRIDGE_EXTENSION_PROFILE:'v3',RBRIDGE_V3_STARTUP_CONFIG_SHA256:startupHash,RBRIDGE_RELEASE_SHA:releaseSha};
const run=spawnSync('npm',['run','build:extension'],{env,encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024});
if(run.error||run.status!==0)throw Error('V3_EXTENSION_BUILD_FAILED '+JSON.stringify({status:run.status,error:run.error?.message,stdout:run.stdout?.slice(-2400),stderr:run.stderr?.slice(-2400)}));
await rm(kit,{recursive:true,force:true});
await mkdir(join(kit,'extension'),{recursive:true});
await mkdir(join(kit,'linux'),{recursive:true});
await cp('dist-extension-v3',join(kit,'extension'),{recursive:true});
const manifestPath=join(kit,'extension','manifest.json');
const extensionManifest=JSON.parse(await readFile(manifestPath,'utf8'));
if(extensionManifest.name!=='COCWIN RBridge Chat'||extensionManifest.permissions?.includes('nativeMessaging')!==true
 ||extensionManifest.background?.service_worker!=='serviceWorker.js')throw Error('EXTENSION_BUILD_MANIFEST_UNEXPECTED');
extensionManifest.action={default_popup:'setup.html',default_title:'COCWIN V3 — aktivacija'};
await writeFile(manifestPath,JSON.stringify(extensionManifest,null,2)+'\n');
await writeFile(join(kit,'extension','setup.html'),await readFile('scripts/p01-owner-setup.html'));
const setupSource=await readFile('scripts/p01-owner-setup.js','utf8');
if(!setupSource.includes('__STARTUP_SHA256__'))throw Error('SETUP_PIN_SLOT_MISSING');
await writeFile(join(kit,'extension','setup.js'),setupSource.replace('__STARTUP_SHA256__',startupHash));
await writeFile(join(kit,'extension','p01-startup.json'),startupRaw);
await writeFile(join(kit,'linux','v3-peer-config.json'),originalConfigText);
await writeFile(join(kit,'native-v3.json'),JSON.stringify({scope,peerPins:peer,initialHistory},null,2)+'\n');
await cp('scripts/p01-owner-configure-native.cjs',join(kit,'configure-native.cjs'));
await writeFile(join(kit,'INSTALL_NATIVE.cmd'),'@echo off\r\ncd /d "%~dp0"\r\nwhere node >nul 2>&1\r\nif errorlevel 1 (echo BLOCKED: Node.js nije na PATH & pause & exit /b 1)\r\nnode "%~dp0configure-native.cjs"\r\npause\r\n');
await writeFile(join(kit,'README.txt'),[
'COCWIN V3 P01 — kvalificirani source 931e02d6..., owner-specific fresh session.',
'BEFORE CHROME: run INSTALL_NATIVE.cmd once. It refuses old V3/history and preserves original Native config backup.',
'CHROME: chrome://extensions > Developer mode > Load unpacked > select extension folder.',
'CLICK COCWIN RBridge Chat extension icon > Aktiviraj V3.',
'LINUX: linux/v3-peer-config.json must first be installed in protected RBridge app-specific owner store by trusted execution.',
'Then COCWIN runtime factory must be installed/connected before any SEND is permitted.',
'Never reset legacy D0 or any uncertain SEND. No auto-loop included in installer.'
].join('\r\n')+'\r\n');
const linuxBytes=await readFile(join(kit,'linux','v3-peer-config.json'));
if(digest(linuxBytes)!==expectedLinuxSha)throw Error('P01_OUTPUT_LINUX_CONFIG_CHANGED');
const evidence={schema:'COCWIN_P01_OWNER_V3_INSTALL_KIT_V1',status:'BUILT_NOT_INSTALLED',sourceRelease:releaseSha,cocwinBaseSha,scope,peer,
 startupConfigSha256:startupHash,linuxConfigSha256:digest(linuxBytes),initialHistory,ownerWindows:'NOT_RUN',ownerChrome:'NOT_RUN',
 linuxProvision:'NOT_RUN',browserSends:0};
await writeFile(join(kit,'MANIFEST.json'),JSON.stringify(evidence,null,2)+'\n');
console.log('COCWIN_P01_BUILD_RESULT='+JSON.stringify(evidence));
