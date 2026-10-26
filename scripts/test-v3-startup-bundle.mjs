import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

if(typeof vm.SourceTextModule!=='function'){
 const result=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(import.meta.url)],{env:process.env,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');if(result.error)throw result.error;process.exit(result.status??1);
}
const module=await import('./extension-build-profile.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
assert.equal(typeof module.extensionBuildProfile,'function','Missing explicit extension build profile');
const profile=module.extensionBuildProfile;
assert.deepEqual(profile({}),{profile:'v1',outDir:'dist-extension',v3ConfigSha256:null});
for(const env of [{RBRIDGE_EXTENSION_PROFILE:'other'},{RBRIDGE_EXTENSION_PROFILE:'v3'},{RBRIDGE_EXTENSION_PROFILE:'v3',RBRIDGE_V3_STARTUP_CONFIG_SHA256:'A'.repeat(64)},{RBRIDGE_V3_STARTUP_CONFIG_SHA256:'a'.repeat(64)}])assert.throws(()=>profile(env));
assert.deepEqual(profile({RBRIDGE_EXTENSION_PROFILE:'v3',RBRIDGE_V3_STARTUP_CONFIG_SHA256:'a'.repeat(64)}),{profile:'v3',outDir:'dist-extension-v3',v3ConfigSha256:'a'.repeat(64)});
const root=fileURLToPath(new URL('../',import.meta.url)),release=process.env.RBRIDGE_RELEASE_SHA??process.env.GITHUB_SHA??'1'.repeat(40);
const fixture=JSON.parse(await readFile(new URL('../tests/fixtures/rbridge-cocwin-contract-v3.json',import.meta.url),'utf8')),request=fixture.vectors[1].command.request,target=request.payload.target;
const document={schema:'RBRIDGE_EXTENSION_STARTUP_V3',extensionId:'ebibbijpegoankenmggdnehpoadcophk',releaseSha:release,bootstrap:{schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1',browserInstanceId:target.browserInstanceId,browserProfileId:target.browserProfileId,nativeHostVersion:'fixture-native'},scope:{appId:request.appId,baseSha:request.baseSha,sessionId:request.sessionId,generation:request.generation},peer:{peerId:'fixture-server',releaseSha:'9'.repeat(40),browserInstanceId:'peer-browser',browserProfileId:'peer-profile',protocolMinor:1,maxMessageBytes:65536,capabilities:[]},initialHistory:[],siteAdapter:'CHATGPT_EXACT_COPY_V3'};
// Use the real exported capability contract; the pin remains synthetic fixture data.
document.peer.capabilities=(await import('../dist/src/domain/rbridgeEffectProtocol.js')).V3_CAPABILITIES;
const raw=JSON.stringify(document),hash=text=>createHash('sha256').update(text).digest('hex');
function run(args,env,expected=0){const r=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});if(r.error||r.status!==expected)throw Error('STARTUP_BUNDLE_COMMAND_FAILED '+JSON.stringify({args,status:r.status,error:r.error?.code,stdout:r.stdout?.slice(-2000),stderr:r.stderr?.slice(-3000)}));return r;}
const envV1={...process.env,RBRIDGE_RELEASE_SHA:release,RBRIDGE_EXTENSION_PROFILE:'v1'};delete envV1.RBRIDGE_V3_STARTUP_CONFIG_SHA256;
const envV3={...envV1,RBRIDGE_EXTENSION_PROFILE:'v3',RBRIDGE_V3_STARTUP_CONFIG_SHA256:hash(raw)};
function build(env){for(const cfg of ['vite.content.config.ts','vite.worker.config.ts'])run(['node_modules/vite/bin/vite.js','build','--config',cfg],env);run(['scripts/write-extension-manifest.mjs'],env);run(['scripts/verify-extension-artifacts.mjs'],env);}
build(envV1);const legacy=await readFile(new URL('../dist-extension/serviceWorker.js',import.meta.url),'utf8'),legacyHash=hash(legacy);
build(envV3);const bundleUrl=new URL('../dist-extension-v3/serviceWorker.js',import.meta.url),bundle=await readFile(bundleUrl,'utf8');
assert.equal(hash(await readFile(new URL('../dist-extension/serviceWorker.js',import.meta.url),'utf8')),legacyHash,'V3 build changed default artifact');
const facts=[];
async function execute(name,source,stored,minor,errorCode){
 const order=[],messages=[],errors=[];let dom=0,connections=0;
 const data=structuredClone(stored),port={onMessage:{addListener(){}},onDisconnect:{addListener(){}},postMessage(value){messages.push(value);},disconnect(){}};
 const context=vm.createContext({crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,setTimeout,clearTimeout,console:{error:value=>errors.push(String(value)),log(){}},chrome:{runtime:{id:document.extensionId,connectNative(){connections++;order.push('CONNECT');return port;}},storage:{local:{async setAccessLevel(options){assert.equal(options.accessLevel,'TRUSTED_CONTEXTS');order.push('TRUSTED');},async get(key){order.push('GET:'+key);return key in data?{[key]:data[key]}:{};},async set(value){Object.assign(data,value);}}},tabs:{async get(){throw Error('UNEXPECTED_TAB');},async query(){return [];},async sendMessage(){throw Error('UNEXPECTED_CONTENT');}},scripting:{async executeScript(){throw Error('UNEXPECTED_SCRIPT');}}}});
 for(const key of ['document','window','MutationObserver'])Object.defineProperty(context,key,{get(){dom++;throw Error('WORKER_DOM_ACCESS');}});
 vm.runInContext('globalThis.structuredClone=value=>JSON.parse(JSON.stringify(value))',context);
 const worker=new vm.SourceTextModule(source,{context});await worker.link(()=>{throw Error('UNEXPECTED_BUNDLE_IMPORT');});await worker.evaluate({timeout:5000});
 const deadline=Date.now()+3000;while(messages.length===0&&errors.length===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(dom,0,name+' accessed worker DOM');
 if(errorCode){assert.equal(connections,0);assert.ok(errors.some(value=>value.includes(errorCode)),JSON.stringify(errors));}
 else{assert.equal(connections,1);assert.equal(messages.length,1);assert.equal(messages[0].schema,'RBRIDGE_CHAT_HELLO_V1');assert.equal(messages[0].protocolMinor,minor);assert.equal(messages[0].releaseSha,release);assert.deepEqual(errors,[]);if(minor===1)assert.deepEqual(order.slice(0,2),['TRUSTED','GET:rbridgeExtensionStartupV3']);}
 facts.push({name,state:'PASS',connections,workerDomAccesses:dom});
}
await execute('default_minor0_unchanged',legacy,{rbridgeExtensionBootstrapV1:document.bootstrap},0);
await execute('v3_exact_config_starts',bundle,{rbridgeExtensionStartupV3:raw},1);
await execute('v3_missing_config_closed',bundle,{},undefined,'RBRIDGE_V3_STARTUP_DOCUMENT_INVALID');
await execute('v3_changed_bytes_closed',bundle,{rbridgeExtensionStartupV3:raw+'\n'},undefined,'RBRIDGE_V3_STARTUP_PIN_MISMATCH');
try{await writeFile(bundleUrl,bundle+'\nvoid document;\n');const negative=run(['scripts/verify-extension-artifacts.mjs'],envV3,1);assert.ok(negative.stderr.includes('RBRIDGE_WORKER_BUNDLE_DOM_LEAK'));}finally{await writeFile(bundleUrl,bundle);}
run(['scripts/verify-extension-artifacts.mjs'],envV3);
console.log(JSON.stringify({schema:'RBRIDGE_V3_STARTUP_BUNDLE_QA_V1',state:'PASS',releaseSha:release,sourceConfig:'SYNTHETIC_EXTERNAL_PIN',facts,ambientDomNegative:'PASS',separateOutputs:'PASS',browserSends:0,ownerWindows:'NOT_RUN',productionActivation:false}));
