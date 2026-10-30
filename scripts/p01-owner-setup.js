'use strict';
// This handoff is exclusively for the original P01 pristine startup.
// Transaction records preserve the exact predecessor and never authorize SEND.
const btn=document.getElementById('activate');
const status=document.getElementById('status');
const STARTUP_KEY='rbridgeExtensionStartupV3';
const TX_KEY='rbridgeP01PristineContinuationV1';
const OLD_PIN='fc4d970903a94d6c49fc6dd5a9edf6f4aec4a61ccbfaf8c149974b203d2649d5';
const pin='__STARTUP_SHA256__';
const encode=value=>new TextEncoder().encode(value);
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const same=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
const own=(row,key)=>Object.prototype.hasOwnProperty.call(row,key);
function safeKeys(data){return Object.keys(data).filter(key=>key.startsWith('rbridge')).sort();}
function snapshot(rows){return JSON.stringify(safeKeys(rows).map(key=>[key,rows[key]]));}
function show(error){const reason=String(error?.message??error);status.textContent=(reason.includes('_UNKNOWN')?'UNKNOWN: ':'BLOKIRANO: ')+reason.slice(0,350);}
async function hash(raw){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encode(raw))),byte=>byte.toString(16).padStart(2,'0')).join('');}
async function pinnedDocument(){
 const response=await fetch(chrome.runtime.getURL('p01-startup.json'),{cache:'no-store'});
 if(!response.ok)throw Error('STARTUP_FILE_UNAVAILABLE');
 const raw=await response.text();if(encode(raw).length>16384||await hash(raw)!==pin)throw Error('STARTUP_PIN_MISMATCH');
 const cfg=JSON.parse(raw);
 if(cfg.extensionId!==chrome.runtime.id||chrome.runtime.id!=='ebibbijpegoankenmggdnehpoadcophk'||cfg.schema!=='RBRIDGE_EXTENSION_STARTUP_V3')throw Error('EXTENSION_ID_MISMATCH');
 return {raw,cfg};
}
function pristine(rows,cfg){
 const allowed=[STARTUP_KEY,TX_KEY,'rbridgeExtensionBootstrapV1'];
 if(safeKeys(rows).some(key=>!allowed.includes(key)))throw Error('HISTORY_PRESENT_KEYS');
 if(own(rows,'rbridgeExtensionBootstrapV1')&&!same(rows.rbridgeExtensionBootstrapV1,cfg.bootstrap))throw Error('BOOTSTRAP_IDENTITY_MISMATCH');
}
async function predecessor(oldRaw,cfg){
 if(typeof oldRaw!=='string'||encode(oldRaw).length!==1095||await hash(oldRaw)!==OLD_PIN)throw Error('ORIGINAL_STARTUP_PREIMAGE_MISMATCH');
 const old=JSON.parse(oldRaw),peer={...cfg.peer,releaseSha:old.peer.releaseSha,capabilities:old.peer.capabilities};
 if(!same(cfg.scope,old.scope)||!same(cfg.bootstrap,old.bootstrap)||!same(peer,old.peer)
   ||cfg.releaseSha===old.releaseSha||!/^[a-f0-9]{40}$/.test(cfg.releaseSha)||cfg.peer.releaseSha!==cfg.releaseSha
   ||!same(cfg.peer.capabilities,[...old.peer.capabilities,'CHAT_SCOPE_QUIESCENCE_V1'])
   ||!same(cfg.initialHistory,[])||cfg.siteAdapter!==old.siteAdapter)throw Error('ORIGINAL_STARTUP_IDENTITY_MISMATCH');
}
function transaction(oldRaw,phase){return {schema:'COCWIN_P01_PRISTINE_CONTINUATION_V1',phase,predecessorRaw:oldRaw,predecessorSha256:OLD_PIN,targetSha256:pin};}
async function inspect(){
 const rows=await chrome.storage.local.get(null);
 status.textContent='RBridge zapisi: '+safeKeys(rows).join(', ').slice(0,450);
 return rows;
}
void inspect().catch(show);
async function publishReady(oldRaw){
 // READY is published only after a successful full COMPLETE snapshot read.
 // No later fallible read may turn a rejected COMPLETE candidate into first admission.
 try{await chrome.storage.local.set({[TX_KEY]:transaction(oldRaw,'READY')});}
 catch{throw Error('CONTINUATION_READY_WRITE_UNKNOWN');}
}
async function upgrade(){
 const {raw,cfg}=await pinnedDocument(),rows=await chrome.storage.local.get(null);
 pristine(rows,cfg);
 const prior=rows[STARTUP_KEY],tx=rows[TX_KEY];
 if(own(rows,TX_KEY)){
   if(!tx||!['COMPLETE','READY','ADMITTED'].includes(tx.phase)||!same(tx,transaction(tx.predecessorRaw,tx.phase))||prior!==raw)throw Error('CONTINUATION_PARTIAL_OR_COLLISION');
   await predecessor(tx.predecessorRaw,cfg);
   if(snapshot(await chrome.storage.local.get(null))!==snapshot(rows))throw Error('STORAGE_CHANGED_DURING_ACTIVATION');
   if(tx.phase==='COMPLETE')await publishReady(tx.predecessorRaw);
   status.textContent='Primopredaja je provjerena; worker neovisno provjerava prvo povezivanje.';
   chrome.runtime.reload();return;
 }
 await predecessor(prior,cfg);
 if(typeof chrome.storage.local.setAccessLevel!=='function')throw Error('TRUSTED_STORAGE_UNAVAILABLE');
 await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
 if(snapshot(await chrome.storage.local.get(null))!==snapshot(rows))throw Error('STORAGE_CHANGED_DURING_ACTIVATION');
 const prepared=transaction(prior,'PREPARED');
 // One record durably carries the intent and exact raw backup before startup changes.
 await chrome.storage.local.set({[TX_KEY]:prepared});
 const expectedPrepared={...rows,[TX_KEY]:prepared};
 if(snapshot(await chrome.storage.local.get(null))!==snapshot(expectedPrepared))throw Error('CONTINUATION_INTENT_WRITE_UNCERTAIN');
 // The provisioned worker refuses PREPARED, COMPLETE candidates and missing admission records.
 await chrome.storage.local.set({[STARTUP_KEY]:raw});
 const published={...expectedPrepared,[STARTUP_KEY]:raw};
 if(snapshot(await chrome.storage.local.get(null))!==snapshot(published))throw Error('CONTINUATION_STARTUP_WRITE_UNCERTAIN');
 const complete=transaction(prior,'COMPLETE');
 await chrome.storage.local.set({[TX_KEY]:complete});
 if(snapshot(await chrome.storage.local.get(null))!==snapshot({...published,[TX_KEY]:complete}))throw Error('CONTINUATION_RECEIPT_WRITE_UNCERTAIN');
 await publishReady(prior);
 status.textContent='Izvorni zapis je sačuvan; primopredaja READY čeka neovisnu provjeru workera.';
 chrome.runtime.reload();
}
btn.addEventListener('click',async()=>{
 btn.disabled=true;status.textContent='Provjeravam izvorni P01 zapis i praznu povijest...';
 try{
   if(typeof navigator?.locks?.request!=='function')throw Error('EXCLUSIVE_SETUP_LOCK_UNAVAILABLE');
   await navigator.locks.request('rbridge-p01-original-pristine-upgrade',{mode:'exclusive',ifAvailable:true},async lock=>{
     if(!lock)throw Error('ANOTHER_SETUP_ACTIVE');await upgrade();
   });
 }catch(error){show(error);btn.disabled=false;}
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
async function v3OwnerSummary(rows,target,pinnedRaw){
  let continuationComplete=false;
  if(own(rows,TX_KEY)){
    const tx=rows[TX_KEY];
    if(tx&&['READY','ADMITTED'].includes(tx.phase)&&typeof tx.predecessorRaw==='string'&&same(tx,transaction(tx.predecessorRaw,tx.phase))&&encode(tx.predecessorRaw).length===1095&&await hash(tx.predecessorRaw)===OLD_PIN)continuationComplete=true;
  }
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
  const expectedBootstrap=JSON.parse(pinnedRaw).bootstrap;
  const bootstrapMatches=!own(rows,'rbridgeExtensionBootstrapV1')||same(rows.rbridgeExtensionBootstrapV1,expectedBootstrap);
  const historyFree=continuationComplete&&bootstrapMatches&&authority==='ABSENT'&&!hasEffectLedger&&!hasCaptureOutbox&&
    startupVerified&&
    keys.every(key=>key==='rbridgeExtensionStartupV3'||key==='rbridgeExtensionBootstrapV1'||(key===TX_KEY&&continuationComplete));
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
      local:await v3OwnerSummary(storage,target,raw),createdAt:new Date().toISOString()};
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
