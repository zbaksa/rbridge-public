'use strict';
const btn=document.getElementById('activate');
const status=document.getElementById('status');
btn.addEventListener('click',async()=>{
  btn.disabled=true;status.textContent='Provjeravam...';
  try{
    const keys=Object.keys(await chrome.storage.local.get(null));
    if(keys.some(key=>key.startsWith('rbridge')))throw Error('RBRIDGE_HISTORY_PRESENT_DO_NOT_RESET');
    const response=await fetch(chrome.runtime.getURL('p01-startup.json'));
    if(!response.ok)throw Error('STARTUP_FILE_UNAVAILABLE');
    const raw=await response.text(),bytes=new TextEncoder().encode(raw);
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(digest!=='__STARTUP_SHA256__')throw Error('STARTUP_PIN_MISMATCH');
    const cfg=JSON.parse(raw);
    if(cfg.extensionId!==chrome.runtime.id||cfg.schema!=='RBRIDGE_EXTENSION_STARTUP_V3')throw Error('EXTENSION_ID_MISMATCH');
    await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    await chrome.storage.local.set({rbridgeExtensionStartupV3:raw});
    status.textContent='Spremljeno. Aktiviram Native vezu...';
    chrome.runtime.reload();
  }catch(error){status.textContent='BLOKIRANO: '+String(error?.message??error);btn.disabled=false;}
});
