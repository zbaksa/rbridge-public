import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';

const root='dist-p01-owner-v3-kit/extension/';
const source=await readFile(root+'setup.js','utf8');
const raw=await readFile(root+'p01-startup.json','utf8');
const pin=createHash('sha256').update(raw).digest('hex');
assert.ok(source.includes(pin),'PIN_NOT_COMPILED');
const parsed=JSON.parse(raw);
assert.equal(parsed.extensionId,'ebibbijpegoankenmggdnehpoadcophk');

async function run(name,initial,expected){
  let store=structuredClone(initial),writes=0,access=0,reloads=0,activator,copied='';const handlers=new Map();
  const btn={disabled:false,addEventListener(event,handler){assert.equal(event,'click');activator=handler;}};
  const status={textContent:'',insertAdjacentElement(where){assert.equal(where,'beforebegin');}};
  const chrome={
    runtime:{id:parsed.extensionId,getURL:relative=>'chrome-extension://'+parsed.extensionId+'/'+relative,reload(){reloads++;}},
    tabs:{async query(){return [{id:43,windowId:18,url:'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-owner-project/c/abcdef01-2345-6789-abcd-ef0123456789'}];}},
    storage:{local:{
      async get(){return structuredClone(store);},
      async setAccessLevel({accessLevel}){assert.equal(accessLevel,'TRUSTED_CONTEXTS');access++;},
      async set(entry){writes++;Object.assign(store,structuredClone(entry));},
    }},
  };
  const ctx=vm.createContext({chrome,crypto:webcrypto,TextEncoder,Uint8Array,ArrayBuffer,URL,Date,
    navigator:{clipboard:{async writeText(value){copied=value;}}},
    document:{getElementById:id=>id==='activate'?btn:id==='status'?status:null,
      createElement(tag){assert.equal(tag,'button');return {disabled:false,textContent:'',id:'',addEventListener(event,fn){assert.equal(event,'click');handlers.set(this.id,fn);}}}},
    fetch:async()=>({ok:true,text:async()=>raw})});
  vm.runInContext(source,ctx,{timeout:3000});
  assert.equal(typeof activator,'function');
  await activator();
  assert.equal(writes,expected.writes,name+' writes');
  assert.equal(reloads,expected.reloads,name+' reload');
  assert.equal(access,expected.access,name+' access');
  assert.equal(btn.disabled,expected.blocked,name+' button state');
  if(!expected.blocked)assert.match(status.textContent,/BLOKIRANO:/,name);
  if(expected.reloads)assert.equal(store.rbridgeExtensionStartupV3,raw,name+' valid startup');
  for(const [key,value]of Object.entries(initial))assert.deepEqual(store[key],value,name+' preserves '+key);
  if(name==='same_pinned_startup_with_retained_history_no_write'){
    assert.equal(typeof handlers.get('copy-target'),'function');
    await handlers.get('copy-target')();
    const observation=JSON.parse(copied);
    assert.equal(observation.schema,'COCWIN_P01_OWNER_ACTIVE_TAB_OBSERVATION_V1');
    assert.equal(observation.status,'OBSERVED_NOT_BOUND');
    assert.equal(observation.peerId,parsed.peer.peerId);
    assert.equal(observation.scopeSessionId,parsed.scope.sessionId);
    assert.equal(observation.tabId,43);
    assert.equal(observation.windowId,18);
    assert.equal(observation.canonicalProjectId,'g-p-0123456789abcdef0123456789abcdef');
    assert.equal(observation.conversationId,'abcdef01-2345-6789-abcd-ef0123456789');
    assert.equal(writes,0,'target export must never write');
    assert.match(status.textContent,/CILJ KOPIRAN/);
    console.log('PASS P01_POPUP exact_owner_target_export_read_only');
  }
  console.log('PASS P01_POPUP '+name);
}
await run('empty_startup_once',{}, {writes:1,reloads:1,access:1,blocked:true});
await run('same_pinned_startup_with_retained_history_no_write',{
  rbridgeExtensionStartupV3:raw,
  rbridgeCaptureOutboxV3:{schema:'RETAIN',effects:['uncertain']},
}, {writes:0,reloads:1,access:0,blocked:true});
await run('inert_legacy_v1_bootstrap_is_preserved',{
  rbridgeExtensionBootstrapV1:{schema:'RBRIDGE_EXTENSION_BOOTSTRAP_V1',browserInstanceId:'old',browserProfileId:'old',nativeHostVersion:'old'},
}, {writes:1,reloads:1,access:1,blocked:true});
await run('real_history_blocks_without_reset',{
  rbridgeBrowserAuthorityStoreV1:{activeSend:'UNCERTAIN'},
}, {writes:0,reloads:0,access:0,blocked:false});
await run('different_existing_startup_blocks_without_overwrite',{
  rbridgeExtensionStartupV3:'{"unknown":true}',
}, {writes:0,reloads:0,access:0,blocked:false});
console.log('COCWIN_P01_POPUP_NON_DESTRUCTIVE_GATE=PASS');


// A package proof must expose original own-package bytes and remain read-only.
const packagePaths=['manifest.json','serviceWorker.js','contentScript.js','p01-startup.json','setup.html','setup.js'];
const packageBytes=new Map(await Promise.all(packagePaths.map(async path=>[path,await readFile(root+path)])));
const packageManifest=JSON.parse(packageBytes.get('manifest.json').toString('utf8'));
const activeTab={id:43,windowId:18,url:'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-owner-project/c/abcdef01-2345-6789-abcd-ef0123456789'};
async function proofHarness(options={}){
  const buttons=new Map(),writes=[],reads=[],requests=[],messages=[],clipboard=[];
  let state=structuredClone(options.state??{rbridgeExtensionStartupV3:raw,secretOtherExtensionValue:'PRIVATE_SENTINEL_DO_NOT_EXPORT'});
  let queries=0,startupReads=0,reloads=0,access=0;
  const status={textContent:'',insertAdjacentElement(where){assert.equal(where,'beforebegin');}};
  const button=()=>({id:'',textContent:'',disabled:false,addEventListener(event,fn){assert.equal(event,'click');buttons.set(this.id,fn);}});
  const activate=button();activate.id='activate';
  const chrome={
    runtime:{id:parsed.extensionId,getURL:relative=>'chrome-extension://'+parsed.extensionId+'/'+relative,getManifest:()=>structuredClone(packageManifest),reload(){reloads++;},sendMessage(value){messages.push(value);}},
    tabs:{async query(){queries++;return [structuredClone(options.changeTarget&&queries>1?{...activeTab,id:44}:activeTab)];}},
    storage:{local:{
      async get(key){reads.push(key);if(key===undefined||key===null)return structuredClone(state);
        if(key==='rbridgeExtensionStartupV3'){startupReads++;if(options.changeStartup&&startupReads>1)return {rbridgeExtensionStartupV3:'changed'};return Object.prototype.hasOwnProperty.call(state,key)?{[key]:state[key]}:{};}
        throw Error('UNEXPECTED_STORAGE_READ');
      },
      async set(value){writes.push(value);Object.assign(state,structuredClone(value));},
      async setAccessLevel(){access++;},
    }},
  };
  const context=vm.createContext({chrome,crypto:webcrypto,TextEncoder,Uint8Array,ArrayBuffer,URL,Date,
    btoa:value=>Buffer.from(value,'latin1').toString('base64'),
    navigator:{clipboard:{async writeText(value){clipboard.push(value);}}},
    document:{getElementById:id=>id==='activate'?activate:id==='status'?status:null,createElement:tag=>{assert.equal(tag,'button');return button();}},
    fetch:async url=>{
      assert.ok(url.startsWith('chrome-extension://'+parsed.extensionId+'/'),'own extension URL only');
      const relative=url.slice(('chrome-extension://'+parsed.extensionId+'/').length);
      assert.ok(packagePaths.includes(relative),'fixed allowlisted resource only');requests.push(relative);
      if(options.failResource===relative)return {ok:false,status:404};
      const bytes=options.oversizeResource===relative?Buffer.alloc(524289):packageBytes.get(relative);
      return {ok:true,status:200,text:async()=>bytes.toString('utf8'),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    },
  });
  vm.runInContext(source,context,{timeout:3000});
  await Promise.resolve();
  reads.length=0;requests.length=0;
  return {buttons,status,writes,reads,requests,messages,clipboard,get reloads(){return reloads;},get access(){return access;}};
}
async function check(name,work){
  try{await work();console.log('PASS P01_INSTALLED_PROOF '+name);}
  catch(error){console.error('FAIL P01_INSTALLED_PROOF '+name+': '+error.stack);process.exitCode=1;}
}
await check('preserves_existing_owner_summary_without_writes',async()=>{
  const h=await proofHarness();
  assert.equal(typeof h.buttons.get('copy-p01-proof'),'function','delivered owner summary must remain available');
  await h.buttons.get('copy-p01-proof')();
  const report=JSON.parse(h.clipboard.at(-1));
  assert.equal(report.schema,'COCWIN_P01_OWNER_READONLY_REPORT_V1');
  assert.equal(report.target.tabId,43);
  assert.equal(report.local.status,'UNTRUSTED_LOCAL_OBSERVATION');
  assert.equal(report.local.startupPresent,true);
  assert.equal(report.local.initialBindCandidate,true);
  assert.equal(h.writes.length,0);assert.equal(h.reloads,0);assert.equal(h.access,0);
});
await check('exports_original_package_bytes_and_stored_startup_without_effects',async()=>{
  const h=await proofHarness();
  assert.equal(typeof h.buttons.get('copy-installed-proof'),'function','installed proof action must exist');
  await h.buttons.get('copy-installed-proof')();
  assert.equal(h.clipboard.length,1,'one complete report only');
  const serialized=h.clipboard[0],report=JSON.parse(serialized);
  assert.deepEqual(Object.keys(report).sort(),['schema','status','independentlyAuthenticated','createdAt','extensionId','runtimeManifest','target','resources','storedStartup','browserSends','storageWrites'].sort());
  assert.equal(report.schema,'COCWIN_P01_OWNER_INSTALLED_EXTENSION_PROOF_V1');
  assert.equal(report.status,'LOCAL_OWNER_OBSERVATION');
  assert.equal(report.independentlyAuthenticated,false);
  assert.equal(report.extensionId,'ebibbijpegoankenmggdnehpoadcophk');
  assert.deepEqual(report.runtimeManifest,packageManifest);
  assert.equal(report.target.tabId,43);assert.equal(report.target.windowId,18);
  assert.deepEqual(report.resources.map(row=>row.path),packagePaths);
  for(const row of report.resources){
    assert.deepEqual(Object.keys(row).sort(),['path','bytes','sha256','base64'].sort());
    const original=packageBytes.get(row.path),returned=Buffer.from(row.base64,'base64');
    assert.deepEqual(returned,original,'original bytes: '+row.path);
    assert.equal(row.bytes,original.length);
    assert.equal(row.sha256,createHash('sha256').update(original).digest('hex'));
  }
  assert.equal(report.storedStartup.state,'PRESENT');
  assert.equal(Buffer.from(report.storedStartup.base64,'base64').toString('utf8'),raw);
  assert.equal(report.storedStartup.bytes,Buffer.byteLength(raw));
  assert.equal(report.storedStartup.sha256,pin);
  assert.equal(report.browserSends,0);assert.equal(report.storageWrites,0);
  assert.ok(!serialized.includes('PRIVATE_SENTINEL_DO_NOT_EXPORT'));
  assert.deepEqual(h.reads,['rbridgeExtensionStartupV3','rbridgeExtensionStartupV3']);
  assert.equal(h.writes.length,0);assert.equal(h.messages.length,0);assert.equal(h.reloads,0);assert.equal(h.access,0);
});
for(const [name,state,want]of [
  ['absent_startup_is_reported_without_synthesizing',{},'ABSENT'],
  ['non_string_startup_is_not_exported',{rbridgeExtensionStartupV3:{private:'PRIVATE_SENTINEL_DO_NOT_EXPORT'}},'NOT_STRING'],
]){
  await check(name,async()=>{
    const h=await proofHarness({state});assert.equal(typeof h.buttons.get('copy-installed-proof'),'function');
    await h.buttons.get('copy-installed-proof')();
    const text=h.clipboard[0],report=JSON.parse(text);
    assert.deepEqual(report.storedStartup,{state:want,bytes:null,sha256:null,base64:null});
    assert.ok(!text.includes('PRIVATE_SENTINEL_DO_NOT_EXPORT'));
    assert.equal(h.writes.length,0);assert.equal(h.reloads,0);
  });
}
for(const [name,options]of [
  ['failed_resource_never_publishes_partial_proof',{failResource:'contentScript.js'}],
  ['oversize_resource_never_publishes_partial_proof',{oversizeResource:'serviceWorker.js'}],
  ['changed_tab_never_publishes_stale_target',{changeTarget:true}],
  ['changed_startup_never_publishes_mixed_snapshot',{changeStartup:true}],
]){
  await check(name,async()=>{
    const h=await proofHarness(options);assert.equal(typeof h.buttons.get('copy-installed-proof'),'function');
    await h.buttons.get('copy-installed-proof')();
    assert.equal(h.clipboard.length,0,'no partial proof');
    assert.match(h.status.textContent,/BLOKIRANO:/);
    assert.equal(h.writes.length,0);assert.equal(h.messages.length,0);assert.equal(h.reloads,0);
  });
}
if(!process.exitCode)console.log('COCWIN_P01_INSTALLED_PROOF_GATE=PASS');
