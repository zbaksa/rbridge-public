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
