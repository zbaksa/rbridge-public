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
  let store=structuredClone(initial),writes=0,access=0,reloads=0,activator,exporter,copied='';
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
      createElement(tag){assert.equal(tag,'button');return {disabled:false,textContent:'',id:'',addEventListener(event,fn){assert.equal(event,'click');exporter=fn;}}}},
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
    assert.equal(typeof exporter,'function');
    await exporter();
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
