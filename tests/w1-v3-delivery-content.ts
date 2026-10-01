import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {ChatgptContentRuntimeV1} from '../src/extension/contentRuntime.js';
import * as chromeAdapters from '../src/extension/chromeAuthorityAdapters.js';
import {sha256Hex,type ExactBrowserTargetV1} from '../src/domain/rbridgeEffectProtocol.js';
import type {DeliverySurfaceV3,ChatgptDeliverySurfaceReaderV3} from '../src/browser/chatgptDeliveryAdapter.js';
import type {BrowserContentDriverV1} from '../src/extension/browserAuthorityRuntime.js';
const target:ExactBrowserTargetV1={browserInstanceId:'chrome-main',browserProfileId:'profile-main',windowId:10,tabId:20,origin:'https://chatgpt.com',canonicalProjectId:'g-p-'+'a'.repeat(32),projectId:'g-p-'+'a'.repeat(32)+'-05-cocwin',conversationId:'conv-123',conversationGeneration:1};
const pageUrl=target.origin+'/g/'+target.projectId+'/c/'+target.conversationId;
function setup(){
  const page=new JSDOM('<main><article data-testid="conversation-turn-old"><div data-message-author-role="user" data-message-id="old-user">old</div></article></main><form><div id="prompt-textarea" role="textbox" contenteditable="true">exact Ž🙂</div><button data-testid="send-button" type="button">Send</button></form>',{url:pageUrl});
  const runtime=new ChatgptContentRuntimeV1(page.window.document,{emit:()=>{}});let clicks=0;
  page.window.document.querySelector('button')!.addEventListener('click',()=>{clicks++;});
  return {page,runtime,clicks:()=>clicks};
}
async function scan(runtime:ChatgptContentRuntimeV1):Promise<DeliverySurfaceV3>{return await runtime.handle({schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:'delivery:scan',action:'DELIVERY_SCAN'}) as DeliverySurfaceV3;}
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_DELIVERY_CONTENT '+name);}catch(error){failed++;console.error('FAIL V3_DELIVERY_CONTENT '+name+': '+String(error));}}
await test('fixed_scan_observes_user_ids_and_exact_text_digest',async()=>{
  const h=setup(),first=await scan(h.runtime);assert.equal(first.documentUrl,pageUrl);assert.match(first.documentId,/^[A-Za-z0-9._:-]+$/);
  assert.deepEqual(first.turns,[{userTurnId:'old-user',textSha256:await sha256Hex('old')}]);
  assert.equal((await scan(h.runtime)).documentId,first.documentId);assert.equal(h.clicks(),0);h.page.window.close();
});
await test('new_content_document_gets_distinct_identity',async()=>{
  const a=setup(),b=setup();assert.notEqual((await scan(a.runtime)).documentId,(await scan(b.runtime)).documentId);a.page.window.close();b.page.window.close();
});
await test('guard_checks_document_url_baseline_and_original_composer_text',async()=>{
  for(const change of ['none','document','url','baseline','text'] as const){
    const h=setup(),baseline=await scan(h.runtime),guard={documentId:baseline.documentId,documentUrl:baseline.documentUrl,baselineUserTurnIds:['old-user'],text:'exact Ž🙂'};
    if(change==='document')guard.documentId='other-document';
    if(change==='url')guard.documentUrl=pageUrl.replace('conv-123','other-conversation');
    if(change==='baseline')guard.baselineUserTurnIds=[];
    if(change==='text')guard.text='different text';
    const result=await h.runtime.handle({schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:'delivery:click',action:'SEND_CLICK_V3',guard}) as {outcome:string};
    assert.equal(result.outcome,change==='none'?'CLICKED':'FAILED_BEFORE_CLICK');assert.equal(h.clicks(),change==='none'?1:0);h.page.window.close();
  }
});
await test('guarded_click_rejects_streaming_or_ambiguous_send_without_click',async()=>{
  for(const change of ['streaming','ambiguous']){
    const h=setup(),baseline=await scan(h.runtime);
    if(change==='streaming'){const button=h.page.window.document.createElement('button');button.setAttribute('aria-label','Stop generating');h.page.window.document.body.append(button);}
    else h.page.window.document.querySelector('form')!.append(h.page.window.document.querySelector('button')!.cloneNode(true));
    const result=await h.runtime.handle({schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:'delivery:click',action:'SEND_CLICK_V3',guard:{documentId:baseline.documentId,documentUrl:pageUrl,baselineUserTurnIds:['old-user'],text:'exact Ž🙂'}}) as {outcome:string};
    assert.equal(result.outcome,'FAILED_BEFORE_CLICK');assert.equal(h.clicks(),0);h.page.window.close();
  }
});
await test('scan_rejects_missing_duplicate_or_oversized_user_identity',async()=>{
  for(const change of ['missing','duplicate','oversized']){
    const h=setup(),root=h.page.window.document.querySelector('[data-message-author-role="user"]')!;
    if(change==='missing'){root.removeAttribute('data-message-id');root.closest('article')!.removeAttribute('data-testid');}
    if(change==='duplicate')root.parentElement!.append(root.cloneNode(true));
    if(change==='oversized')root.textContent='x'.repeat(48001);
    await assert.rejects(()=>scan(h.runtime),/DELIVERY/);assert.equal(h.clicks(),0);h.page.window.close();
  }
});
await test('chrome_reader_checks_browser_profile_tab_window_and_content_url',async()=>{
  const Constructor=(chromeAdapters as typeof chromeAdapters & {ChromeDeliverySurfaceReaderV3?:new(tabs:chromeAdapters.ChromeAuthorityTabsApiV1,browserInstanceId:string,browserProfileId:string)=>ChatgptDeliverySurfaceReaderV3}).ChromeDeliverySurfaceReaderV3;
  assert.equal(typeof Constructor,'function','CHROME_DELIVERY_SURFACE_READER_MISSING');
  for(const change of ['none','browser','profile','tab','window','contentUrl','lateNavigation']){
    const h=setup();let gets=0;
    const tabs:chromeAdapters.ChromeAuthorityTabsApiV1={get:async()=>{gets++;return {id:change==='tab'?21:20,windowId:change==='window'?11:10,url:change==='lateNavigation'&&gets>1?pageUrl.replace('conv-123','other'):pageUrl};},sendMessage:async(_tab,input)=>{
      const message=input as {requestId:string};const result=await scan(h.runtime);if(change==='contentUrl')result.documentUrl=pageUrl.replace('conv-123','wrong');return {schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:message.requestId,ok:true,result};
    }};
    const reader=new Constructor!(tabs,change==='browser'?'wrong-browser':'chrome-main',change==='profile'?'wrong-profile':'profile-main');
    if(change==='none')assert.equal((await reader.scan(target))?.turns[0]?.userTurnId,'old-user');
    else await assert.rejects(()=>reader.scan(target),/BROWSER_BINDING_STALE/);h.page.window.close();
  }
});
await test('chrome_click_transmits_fixed_guarded_action',async()=>{
  let action:unknown,received:unknown;
  const tabs:chromeAdapters.ChromeAuthorityTabsApiV1={get:async()=>({id:20,windowId:10,url:pageUrl}),sendMessage:async(_tab,input)=>{const row=input as {requestId:string;action:string;guard:unknown};action=row.action;received=row.guard;return {schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:row.requestId,ok:true,result:{outcome:'CLICKED'}};}};
  const guard={documentId:'doc',documentUrl:pageUrl,baselineUserTurnIds:[],text:'exact Ž🙂'};
  const driver:BrowserContentDriverV1=new chromeAdapters.ChromeContentDriverV1(tabs);await driver.clickSend(20,guard);
  assert.equal(action,'SEND_CLICK_V3');assert.deepEqual(received,guard);
});
console.log(JSON.stringify({suite:'W1_V3_DELIVERY_CONTENT',passed,failed}));if(failed)process.exitCode=1;
