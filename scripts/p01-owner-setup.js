'use strict';
// P01 owner startup is pinned to the original qualified Linux/Windows session.
// Never delete, clear, reset or overwrite any existing RBridge state.
const btn=document.getElementById('activate');
const status=document.getElementById('status');
const STARTUP_KEY='rbridgeExtensionStartupV3';
const pin='__STARTUP_SHA256__';

function safeKeys(data) {
  return Object.keys(data).filter(key=>key.startsWith('rbridge')).sort();
}
function show(error) {
  const reason=String(error?.message??error);
  status.textContent='BLOKIRANO: '+reason.slice(0,350);
}
async function pinnedDocument() {
  const response=await fetch(chrome.runtime.getURL('p01-startup.json'));
  if(!response.ok)throw Error('STARTUP_FILE_UNAVAILABLE');
  const raw=await response.text();
  const bytes=new TextEncoder().encode(raw);
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(digest!==pin)throw Error('STARTUP_PIN_MISMATCH');
  const cfg=JSON.parse(raw);
  if(cfg.extensionId!==chrome.runtime.id||cfg.schema!=='RBRIDGE_EXTENSION_STARTUP_V3')throw Error('EXTENSION_ID_MISMATCH');
  return {raw,cfg};
}
async function inspect() {
  const state=await chrome.storage.local.get(null);
  const keys=safeKeys(state);
  status.textContent=keys.length?'RBridge zapisi: '+keys.join(', ').slice(0,450):'Nema prethodnih RBridge zapisa. Spremno za aktivaciju.';
  return state;
}
void inspect().catch(show);
btn.addEventListener('click',async()=>{
  btn.disabled=true;status.textContent='Provjeravam izvornu konfiguraciju i povijest...';
  try {
    const {raw}=await pinnedDocument();
    const state=await chrome.storage.local.get(null);
    const keys=safeKeys(state);
    const prior=state[STARTUP_KEY];
    if(prior!==undefined) {
      if(prior!==raw)throw Error('STARTUP_ALREADY_PRESENT_DIFFERENT_PIN: '+keys.join(', ').slice(0,240));
      // Legitimate idempotent restart: no storage writes, no resets, no sends.
      status.textContent='Konfiguracija je već točna; ponovno pokrećem worker, bez promjena povijesti.';
      chrome.runtime.reload();
      return;
    }
    // A same-identity V1 bootstrap is not history. Any other RBridge key
    // may contain live/uncertain state and must be preserved and reviewed.
    const other=keys.filter(key=>key!=='rbridgeExtensionBootstrapV1');
    if(other.length)throw Error('HISTORY_PRESENT_KEYS: '+other.join(', ').slice(0,240));
    if(typeof chrome.storage.local.setAccessLevel!=='function')throw Error('TRUSTED_STORAGE_UNAVAILABLE');
    await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    // An exclusive re-read blocks writing across observable conflicting keys.
    const current=await chrome.storage.local.get(null);
    if(Object.keys(current).some(key=>key.startsWith('rbridge')&&!keys.includes(key)))
      throw Error('STORAGE_CHANGED_DURING_ACTIVATION');
    if(Object.keys(current).some(key=>key.startsWith('rbridge')&&!['rbridgeExtensionBootstrapV1'].includes(key)))
      throw Error('HISTORY_APPEARED_DURING_ACTIVATION');
    if(keys.includes('rbridgeExtensionBootstrapV1')
       &&JSON.stringify(current.rbridgeExtensionBootstrapV1)!==JSON.stringify(state.rbridgeExtensionBootstrapV1))
      throw Error('LEGACY_BOOTSTRAP_CHANGED_DURING_ACTIVATION');
    await chrome.storage.local.set({[STARTUP_KEY]:raw});
    status.textContent='Početna V3 konfiguracija spremljena. Pokrećem vezu...';
    chrome.runtime.reload();
  } catch(error) {show(error);btn.disabled=false;}
});

/** Read-only exact live tab observation for Cocwin P01; never binds or sends. */
const copyTarget=document.createElement('button');
copyTarget.textContent='Kopiraj ChatGPT cilj';
copyTarget.id='copy-target';
status.insertAdjacentElement('beforebegin',copyTarget);
copyTarget.addEventListener('click',async()=>{
  copyTarget.disabled=true;
  try{
    const {cfg}=await pinnedDocument();
    if(typeof chrome.tabs?.query!=='function')throw Error('CHROME_TABS_UNAVAILABLE');
    const matches=await chrome.tabs.query({active:true,currentWindow:true});
    if(!Array.isArray(matches)||matches.length!==1)throw Error('EXACT_ACTIVE_TAB_AMBIGUOUS');
    const tab=matches[0];
    if(!Number.isInteger(tab?.id)||tab.id<0||!Number.isInteger(tab.windowId)||tab.windowId<0||typeof tab.url!=='string')
      throw Error('ACTIVE_TAB_IDENTITY_INVALID');
    let url;try{url=new URL(tab.url);}catch{throw Error('ACTIVE_TAB_URL_INVALID');}
    if(url.origin!=='https://chatgpt.com')throw Error('OPEN_CHATGPT_PROJECT_CONVERSATION_FIRST');
    const path=url.pathname.split('/').filter(Boolean);
    if(path.length!==4||path[0]!=='g'||path[2]!=='c')throw Error('OPEN_CHATGPT_PROJECT_CONVERSATION_FIRST');
    const projectId=path[1],conversationId=path[3];
    const canonical=projectId.match(/^(g-p-[A-Za-z0-9]{32})(?:-[A-Za-z0-9][A-Za-z0-9-]*)?$/)?.[1];
    if(!canonical||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(conversationId))
      throw Error('CHATGPT_ROUTE_IDENTITY_UNSUPPORTED');
    const result={schema:'COCWIN_P01_OWNER_ACTIVE_TAB_OBSERVATION_V1',status:'OBSERVED_NOT_BOUND',
      scopeSessionId:cfg.scope.sessionId,peerId:cfg.peer.peerId,
      browserInstanceId:cfg.peer.browserInstanceId,browserProfileId:cfg.peer.browserProfileId,
      windowId:tab.windowId,tabId:tab.id,origin:url.origin,canonicalProjectId:canonical,
      projectId,conversationId,observedAt:new Date().toISOString()};
    const serialized=JSON.stringify(result);
    status.textContent=serialized;
    if(navigator?.clipboard?.writeText) {
      try{await navigator.clipboard.writeText(serialized);status.textContent='CILJ KOPIRAN — zalijepi ga u ovaj ChatGPT razgovor.\n'+serialized;}
      catch{status.textContent='KOPIRANJE NIJE DOSTUPNO — kopiraj JSON ispod.\n'+serialized;}
    }
  }catch(error){show(error);}finally{copyTarget.disabled=false;}
});

/* P01 bootstrap owner evidence: read-only, no network, no browser mutation. */
const probeBtn=document.createElement('button');
probeBtn.textContent='Kopiraj P01 provjeru';
probeBtn.id='copy-p01-proof';
status.insertAdjacentElement('beforebegin',probeBtn);

function exactBrowserTarget(cfg,tab) {
  if(!Number.isInteger(tab?.id)||tab.id<0||!Number.isInteger(tab?.windowId)||tab.windowId<0||typeof tab.url!=='string')
    throw Error('ACTIVE_TAB_IDENTITY_INVALID');
  let url;try{url=new URL(tab.url);}catch{throw Error('ACTIVE_TAB_URL_INVALID');}
  if(url.origin!=='https://chatgpt.com')throw Error('OPEN_CHATGPT_PROJECT_CONVERSATION_FIRST');
  const route=url.pathname.split('/').filter(Boolean);
  if(route.length!==4||route[0]!=='g'||route[2]!=='c')throw Error('OPEN_CHATGPT_PROJECT_CONVERSATION_FIRST');
  const projectId=route[1],conversationId=route[3];
  const canonical=projectId.match(/^(g-p-[A-Za-z0-9]{32})(?:-[A-Za-z0-9][A-Za-z0-9-]*)?$/)?.[1];
  if(!canonical||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(conversationId))throw Error('CHATGPT_ROUTE_IDENTITY_UNSUPPORTED');
  return {schema:'COCWIN_P01_OWNER_ACTIVE_TAB_OBSERVATION_V1',status:'OBSERVED_NOT_BOUND',
    scopeSessionId:cfg.scope.sessionId,peerId:cfg.peer.peerId,
    browserInstanceId:cfg.peer.browserInstanceId,browserProfileId:cfg.peer.browserProfileId,
    windowId:tab.windowId,tabId:tab.id,origin:url.origin,
    canonicalProjectId:canonical,projectId,conversationId,observedAt:new Date().toISOString()};
}

function recordPresent(rows,key){return Object.prototype.hasOwnProperty.call(rows,key);}
function v3OwnerSummary(rows,target,pinnedRaw){
  const authorityKey='rbridgeBrowserAuthorityV1';
  const keys=safeKeys(rows);
  const value=recordPresent(rows,authorityKey)?rows[authorityKey]:null;
  let authority='ABSENT',binding='ABSENT',send='ABSENT',generation=null,match=null;
  if(value!==null){
    authority='PRESENT_UNVERIFIED';binding='UNKNOWN';send='UNKNOWN';
    if(value&&typeof value==='object'&&!Array.isArray(value)&&value.schema==='RBRIDGE_BROWSER_AUTHORITY_SNAPSHOT_V1'){
      authority='SNAPSHOT_NOT_CRYPTO_VERIFIED';
      binding=value.binding===null?'NONE':typeof value.binding?.status==='string'?value.binding.status:'INVALID';
      send=value.activeSend===null?'NONE':typeof value.activeSend?.state==='string'?value.activeSend.state:'INVALID';
      if(Number.isSafeInteger(value.binding?.conversationGeneration)&&value.binding.conversationGeneration>=1)
        generation=value.binding.conversationGeneration;
      if(value.binding&&Number.isSafeInteger(value.binding.windowId)&&Number.isSafeInteger(value.binding.tabId))
        match=value.binding.windowId===target.windowId&&value.binding.tabId===target.tabId&&
          value.binding.projectId===target.projectId&&value.binding.conversationId===target.conversationId;
    }
  }
  const hasEffectLedger=recordPresent(rows,'rbridgeEffectLedgerV1');
  const hasCaptureOutbox=recordPresent(rows,'rbridgeCaptureOutboxV3');
  // These are OBSERVATIONS, not cryptographic proof or permission to send.
  const startupVerified=recordPresent(rows,'rbridgeExtensionStartupV3')&&rows.rbridgeExtensionStartupV3===pinnedRaw;
  const historyFree=authority==='ABSENT'&&!hasEffectLedger&&!hasCaptureOutbox&&
    startupVerified&&
    keys.every(key=>key==='rbridgeExtensionStartupV3'||key==='rbridgeExtensionBootstrapV1');
  return {schema:'COCWIN_P01_OWNER_V3_LOCAL_SUMMARY_V1',status:'UNTRUSTED_LOCAL_OBSERVATION',
    startupPresent:startupVerified,
    recordNames:keys,authority,binding,send,conversationGeneration:generation,
    boundToCurrentTab:match,hasEffectLedger,hasCaptureOutbox,
    initialBindCandidate:historyFree,
    warning:'This is a read-only local summary, not a signed binding receipt or SEND authorization.'};
}

probeBtn.addEventListener('click',async()=>{
  probeBtn.disabled=true;
  try{
    const {cfg,raw}=await pinnedDocument();
    const tabs=await chrome.tabs.query({active:true,currentWindow:true});
    if(!Array.isArray(tabs)||tabs.length!==1)throw Error('EXACT_ACTIVE_TAB_AMBIGUOUS');
    const target=exactBrowserTarget(cfg,tabs[0]);
    const storage=await chrome.storage.local.get(null);
    const report={schema:'COCWIN_P01_OWNER_READONLY_REPORT_V1',target,
      local:v3OwnerSummary(storage,target,raw),createdAt:new Date().toISOString()};
    const serialized=JSON.stringify(report);
    if(navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(serialized);
        status.textContent='P01 PROVJERA KOPIRANA — zalijepi JSON u ovaj razgovor. Nijedna pohrana ni AI poruka nije mijenjana.\n'+serialized;
      } catch {
        status.textContent='KOPIRANJE NIJE DOSTUPNO — ručno označi i kopiraj JSON ispod.\n'+serialized;
      }
    } else {
      status.textContent='KOPIRANJE NIJE DOSTUPNO — ručno označi i kopiraj JSON ispod.\n'+serialized;
    }
  }catch(error){show(error);}finally{probeBtn.disabled=false;}
});

/* Export only this installed package and its one public startup record.
 * A local owner observation never authenticates itself for a remote consumer. */
const installedProofBtn=document.createElement('button');
installedProofBtn.textContent='Kopiraj V3 instalaciju';
installedProofBtn.id='copy-installed-proof';
status.insertAdjacentElement('beforebegin',installedProofBtn);
const installedProofPaths=Object.freeze(['manifest.json','serviceWorker.js','contentScript.js','p01-startup.json','setup.html','setup.js']);

function proofBase64(bytes){
  let binary='';
  for(let offset=0;offset<bytes.length;offset+=32768)
    binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return btoa(binary);
}
async function proofBytes(bytes){
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return {bytes:bytes.byteLength,sha256:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join(''),base64:proofBase64(bytes)};
}
async function proofResource(path){
  const expected='chrome-extension://'+chrome.runtime.id+'/'+path,url=chrome.runtime.getURL(path);
  if(url!==expected)throw Error('INSTALLED_RESOURCE_ORIGIN_INVALID');
  const response=await fetch(url,{cache:'no-store'});
  if(!response.ok)throw Error('INSTALLED_RESOURCE_UNAVAILABLE:'+path);
  if(typeof response.body?.getReader!=='function')throw Error('INSTALLED_RESOURCE_STREAM_UNAVAILABLE');
  const reader=response.body.getReader(),chunks=[];
  let count=0;
  try{
    while(true){
      const next=await reader.read();
      if(next.done)break;
      if(!(next.value instanceof Uint8Array))throw Error('INSTALLED_RESOURCE_BYTES_INVALID');
      count+=next.value.byteLength;
      if(count>524288){await reader.cancel();throw Error('INSTALLED_RESOURCE_TOO_LARGE:'+path);}
      chunks.push(new Uint8Array(next.value));
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(count);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}
function proofManifest(){
  if(typeof chrome.runtime.getManifest!=='function')throw Error('RUNTIME_MANIFEST_UNAVAILABLE');
  const manifest=JSON.parse(JSON.stringify(chrome.runtime.getManifest()));
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)
    ||new TextEncoder().encode(JSON.stringify(manifest)).byteLength>16384)
    throw Error('RUNTIME_MANIFEST_INVALID');
  return manifest;
}
async function proofStartup(value){
  if(value===undefined)return {state:'ABSENT',bytes:null,sha256:null,base64:null};
  if(typeof value!=='string')return {state:'NOT_STRING',bytes:null,sha256:null,base64:null};
  if(value.length>16384)throw Error('STORED_STARTUP_TOO_LARGE');
  const bytes=new TextEncoder().encode(value);
  if(bytes.byteLength>16384)throw Error('STORED_STARTUP_TOO_LARGE');
  return {state:'PRESENT',...await proofBytes(bytes)};
}
function proofTarget(cfg,tabs){
  if(!Array.isArray(tabs)||tabs.length!==1)throw Error('EXACT_ACTIVE_TAB_AMBIGUOUS');
  return exactBrowserTarget(cfg,tabs[0]);
}
function proofSameTarget(first,last){
  return ['scopeSessionId','peerId','browserInstanceId','browserProfileId','windowId','tabId','origin','canonicalProjectId','projectId','conversationId']
    .every(key=>first[key]===last[key]);
}
installedProofBtn.addEventListener('click',async()=>{
  installedProofBtn.disabled=true;
  try{
    if(chrome.runtime.id!=='ebibbijpegoankenmggdnehpoadcophk')throw Error('EXTENSION_ID_MISMATCH');
    const runtimeManifest=proofManifest();
    const tabsBefore=await chrome.tabs.query({active:true,currentWindow:true});
    const rows=await chrome.storage.local.get(STARTUP_KEY),original=rows[STARTUP_KEY];
    const storedStartup=await proofStartup(original),resources=[];
    let total=0,packagedStartup=null;
    for(const path of installedProofPaths){
      const bytes=await proofResource(path);total+=bytes.byteLength;
      if(total>2097152)throw Error('INSTALLED_RESOURCE_BUDGET_EXCEEDED');
      const record={path,...await proofBytes(bytes)};resources.push(record);
      if(path==='p01-startup.json'){
        if(record.sha256!==pin)throw Error('STARTUP_PIN_MISMATCH');
        packagedStartup=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      }
    }
    if(packagedStartup?.schema!=='RBRIDGE_EXTENSION_STARTUP_V3'||packagedStartup.extensionId!==chrome.runtime.id)
      throw Error('EXTENSION_ID_MISMATCH');
    const target=proofTarget(packagedStartup,tabsBefore);
    const current=await chrome.storage.local.get(STARTUP_KEY);
    const currentValue=current[STARTUP_KEY];
    if(typeof original==='string'||original===undefined){
      if(currentValue!==original)throw Error('STARTUP_CHANGED_DURING_PROOF');
    }else if(typeof currentValue==='string'||currentValue===undefined)throw Error('STARTUP_CHANGED_DURING_PROOF');
    const targetAfter=proofTarget(packagedStartup,await chrome.tabs.query({active:true,currentWindow:true}));
    if(!proofSameTarget(target,targetAfter))throw Error('TARGET_CHANGED_DURING_PROOF');
    if(JSON.stringify(proofManifest())!==JSON.stringify(runtimeManifest))throw Error('MANIFEST_CHANGED_DURING_PROOF');
    const report={schema:'COCWIN_P01_OWNER_INSTALLED_EXTENSION_PROOF_V1',status:'LOCAL_OWNER_OBSERVATION',
      independentlyAuthenticated:false,createdAt:new Date().toISOString(),extensionId:chrome.runtime.id,
      runtimeManifest,target,resources,storedStartup,browserSends:0,storageWrites:0};
    const serialized=JSON.stringify(report);
    if(navigator?.clipboard?.writeText){
      try{await navigator.clipboard.writeText(serialized);status.textContent='V3 INSTALACIJA KOPIRANA — lokalno opažanje; bez slanja i promjene pohrane.\n'+serialized;}
      catch{status.textContent='KOPIRANJE NIJE DOSTUPNO — kopiraj JSON ispod.\n'+serialized;}
    }else{status.textContent='KOPIRANJE NIJE DOSTUPNO — kopiraj JSON ispod.\n'+serialized;}
  }catch(error){show(error);}finally{installedProofBtn.disabled=false;}
});
