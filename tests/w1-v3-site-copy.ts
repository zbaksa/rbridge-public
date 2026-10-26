import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import * as adapter from '../src/browser/chatgptAssistantMarkdownCapture.js';

type Observation={kind:'CAPTURED';assistantTurnId:string;markdown:string}|{kind:'UNAVAILABLE';reason:'UI_PROTOCOL_CHANGED'};
type Entry=(input:{assistantTurnId:string;documentUrl:string})=>Promise<Observation>;
const unavailable={kind:'UNAVAILABLE',reason:'UI_PROTOCOL_CHANGED'};
const url='https://chatgpt.com/share/11111111-1111-4111-8111-111111111111';
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_SITE_COPY '+name);}catch(e){failed++;console.error('FAIL V3_SITE_COPY '+name+': '+String(e));}}
const itemData=new WeakMap<object,Readonly<Record<string,Promise<Blob>>>>();
// Test-only immutable browser boundary; native Blob accessors remain real.
class ClipboardItemBoundary{
 constructor(values:Record<string,Blob|Promise<Blob>>){const data:Record<string,Promise<Blob>>={};for(const [key,value]of Object.entries(values)){data[key]=Promise.resolve(value);void data[key]!.catch(()=>{});}itemData.set(this,Object.freeze(data));}
 get types():string[]{const data=itemData.get(this);if(!data)throw TypeError('Illegal ClipboardItem');return Object.keys(data);}
 getType(type:string):Promise<Blob>{const data=itemData.get(this);if(!data)throw TypeError('Illegal ClipboardItem');return data[type]??Promise.reject(Error('Missing type'));}
}
function setup(){
 const page=new JSDOM('<main><section data-turn="assistant" data-turn-id="assistant-1" data-turn-state="complete"><div data-message-author-role="assistant"><p>Stable response</p></div><button type="button" data-testid="copy-turn-action-button" aria-label="Copy response">Copy</button></section></main>',{url});
 const document=page.window.document,button=document.querySelector('button')!,section=document.querySelector('section')!;
 Object.defineProperty(button,'getClientRects',{value:()=>[{}] as unknown as DOMRectList,configurable:true});
 let forwarded=0,reads=0;
 const clipboard={write:async(_items:unknown)=>{void _items;forwarded++;},writeText:async(_text:unknown)=>{void _text;forwarded++;},readText:async()=>{reads++;throw Error('Shared clipboard read forbidden');}};
 Object.defineProperty(page.window.navigator,'clipboard',{value:clipboard,configurable:true});
 Object.defineProperty(page.window,'ClipboardItem',{value:ClipboardItemBoundary,configurable:true});
 Object.defineProperty(page.window,'Blob',{value:Blob,configurable:true});
 const initial=Object.getOwnPropertyDescriptors(clipboard);
 const item=(text:string,type='text/plain')=>new ClipboardItemBoundary({[type]:new Blob([text],{type})});
 const delayed=(read:()=>Promise<Blob>)=>new ClipboardItemBoundary({'text/plain':Promise.resolve().then(read)});
 const run=async(input={assistantTurnId:'assistant-1',documentUrl:url})=>{
  const entry=(adapter as unknown as {captureExactSiteCopyInMainWorldV3?:Entry}).captureExactSiteCopyInMainWorldV3;
  assert.equal(typeof entry,'function','Missing exact site Copy transaction component');
  const old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{value:document,configurable:true});
  try{return await entry!(input);}finally{if(old)Object.defineProperty(globalThis,'document',old);else Reflect.deleteProperty(globalThis,'document');}
 };
 const restored=()=>assert.deepEqual(Object.getOwnPropertyDescriptors(clipboard),initial);
 return {page,document,button,section,clipboard,item,delayed,run,restored,counts:()=>({forwarded,reads})};
}
await test('captures_write_blob_bytes_without_shared_clipboard',async()=>{
 const p=setup(),text='## Ž🙂\r\n\r\n```json\n{ "x": 1 }\n```\n';
 p.button.addEventListener('click',()=>{void p.clipboard.write([p.item(text)]);});
 assert.deepEqual(await p.run(),{kind:'CAPTURED',assistantTurnId:'assistant-1',markdown:text});p.restored();assert.deepEqual(p.counts(),{forwarded:0,reads:0});p.page.window.close();
});
await test('captures_writeText_including_empty_and_restores_own_descriptors',async()=>{
 for(const text of ['', '  indentation\n**bold**\n']){const p=setup();p.button.addEventListener('click',()=>{void p.clipboard.writeText(text);});assert.deepEqual(await p.run(),{kind:'CAPTURED',assistantTurnId:'assistant-1',markdown:text});p.restored();assert.deepEqual(p.counts(),{forwarded:0,reads:0});p.page.window.close();}
});
await test('restores_inherited_clipboard_methods_before_blob_await',async()=>{
 const p=setup(),prototype={write:async()=>{},writeText:async()=>{}},clip=Object.create(prototype) as typeof p.clipboard;Object.defineProperty(p.page.window.navigator,'clipboard',{value:clip,configurable:true});
 p.button.addEventListener('click',()=>{void clip.write([p.delayed(async()=>{assert.equal(Object.hasOwn(clip,'write'),false);assert.equal(Object.hasOwn(clip,'writeText'),false);return new Blob(['ok'],{type:'text/plain'});})]);});
 assert.deepEqual(await p.run(),{kind:'CAPTURED',assistantTurnId:'assistant-1',markdown:'ok'});assert.deepEqual(Object.keys(clip),[]);p.page.window.close();
});
await test('wrong_turn_duplicate_or_hidden_control_never_clicks',async()=>{
 for(const change of ['wrong','duplicate','hidden','generating']){const p=setup();let clicks=0;p.button.addEventListener('click',()=>{clicks++;});
  if(change==='duplicate')p.section.after(p.section.cloneNode(true));if(change==='hidden')Object.defineProperty(p.button,'getClientRects',{value:()=>[],configurable:true});if(change==='generating')p.section.setAttribute('data-turn-state','streaming');
  assert.deepEqual(await p.run({assistantTurnId:change==='wrong'?'other':'assistant-1',documentUrl:url}),unavailable);assert.equal(clicks,0);p.restored();p.page.window.close();
 }
});
await test('wrong_url_or_origin_never_clicks',async()=>{
 for(const documentUrl of [url+'/other','https://other.example/share/111']){const p=setup();let clicks=0;p.button.addEventListener('click',()=>{clicks++;});assert.deepEqual(await p.run({assistantTurnId:'assistant-1',documentUrl}),unavailable);assert.equal(clicks,0);p.page.window.close();}
});
await test('deferred_site_writes_are_not_attributed_to_the_click',async()=>{
 const p=setup();p.button.addEventListener('click',()=>{queueMicrotask(()=>{void p.clipboard.writeText('late unrelated text');});});assert.deepEqual(await p.run(),unavailable);await Promise.resolve();p.restored();assert.deepEqual(p.counts(),{forwarded:1,reads:0});p.page.window.close();
});
await test('multiple_clipboard_calls_are_ambiguous',async()=>{
 const p=setup();p.button.addEventListener('click',()=>{void p.clipboard.writeText('first');void p.clipboard.write([p.item('second')]);});assert.deepEqual(await p.run(),unavailable);p.restored();assert.deepEqual(p.counts(),{forwarded:0,reads:0});p.page.window.close();
});
await test('other_document_writes_do_not_supply_the_response',async()=>{
 const p=setup(),other=setup();p.button.addEventListener('click',()=>{void other.clipboard.writeText('foreign writer');});assert.deepEqual(await p.run(),unavailable);p.restored();assert.deepEqual(p.counts(),{forwarded:0,reads:0});assert.equal(other.counts().forwarded,1);p.page.window.close();other.page.window.close();
});
await test('detached_or_changed_response_is_rejected',async()=>{
 for(const change of ['detach','body','identity']){const p=setup();p.button.addEventListener('click',()=>{void p.clipboard.write([p.item('old response')]);if(change==='detach')p.section.remove();if(change==='body')p.document.querySelector('[data-message-author-role]')!.textContent='changed';if(change==='identity')p.section.setAttribute('data-turn-id','other');});assert.deepEqual(await p.run(),unavailable);p.restored();p.page.window.close();}
});
await test('response_changed_during_blob_resolution_is_rejected',async()=>{
 const p=setup();p.button.addEventListener('click',()=>{void p.clipboard.write([p.delayed(async()=>{p.document.querySelector('[data-message-author-role]')!.textContent='changed after click';return new Blob(['before'],{type:'text/plain'});})]);});assert.deepEqual(await p.run(),unavailable);p.restored();p.page.window.close();
});
await test('html_only_multiple_items_and_non_string_values_are_rejected',async()=>{
 for(const kind of ['html','multiple','non-string']){const p=setup();p.button.addEventListener('click',()=>{if(kind==='non-string')void p.clipboard.writeText(7);else void p.clipboard.write(kind==='html'?[p.item('<b>x</b>','text/html')]:[p.item('one'),p.item('two')]);});assert.deepEqual(await p.run(),unavailable);p.restored();p.page.window.close();}
});
await test('oversized_and_unreadable_blobs_are_rejected_after_restoration',async()=>{
 for(const kind of ['large','unreadable']){const p=setup();p.button.addEventListener('click',()=>{void p.clipboard.write(kind==='large'?[p.item('x'.repeat(4*1024*1024+1))]:[p.delayed(async()=>{throw Error('not readable');})]);});assert.deepEqual(await p.run(),unavailable);p.restored();p.page.window.close();}
});
await test('partial_hook_installation_is_restored_without_click',async()=>{
 const p=setup();let clicks=0;p.button.addEventListener('click',()=>{clicks++;});Object.defineProperty(p.clipboard,'writeText',{configurable:false,writable:false,value:p.clipboard.writeText});const before=Object.getOwnPropertyDescriptors(p.clipboard);assert.deepEqual(await p.run(),unavailable);assert.equal(clicks,0);assert.deepEqual(Object.getOwnPropertyDescriptors(p.clipboard),before);p.page.window.close();
});
await test('navigation_during_copy_is_rejected',async()=>{
 const p=setup();p.button.addEventListener('click',()=>{void p.clipboard.writeText('old');p.page.reconfigure({url:url+'/other'});});assert.deepEqual(await p.run(),unavailable);p.restored();p.page.window.close();
});
await test('never_resolving_blob_is_bounded_and_restores_hooks',async()=>{
 const p=setup();p.button.addEventListener('click',()=>{void p.clipboard.write([p.delayed(()=>new Promise<Blob>(()=>{}))]);});assert.deepEqual(await p.run(),unavailable);p.restored();p.page.window.close();
});
await test('clipboard_item_array_mutation_does_not_replace_captured_argument',async()=>{
 const p=setup();p.button.addEventListener('click',()=>{const items=[p.item('first')];void p.clipboard.write(items);items[0]=p.item('replacement');});assert.deepEqual(await p.run(),{kind:'CAPTURED',assistantTurnId:'assistant-1',markdown:'first'});p.restored();p.page.window.close();
});
await test('changed_clipboard_method_is_rejected_without_clobbering_new_owner',async()=>{
 const p=setup(),other=async()=>{};p.button.addEventListener('click',()=>{void p.clipboard.writeText('text');p.clipboard.writeText=other;});assert.deepEqual(await p.run(),unavailable);assert.equal(p.clipboard.writeText,other);assert.deepEqual(p.counts(),{forwarded:0,reads:0});p.page.window.close();
});
await test('lossy_utf8_and_mime_mismatch_are_rejected',async()=>{
 for(const blob of [new Blob([new Uint8Array([255])],{type:'text/plain'}),new Blob([new Uint8Array([240,159,146])],{type:'text/plain'}),new Blob(['wrong mime'],{type:'text/html'})]){const p=setup();p.button.addEventListener('click',()=>{void p.clipboard.write([new ClipboardItemBoundary({'text/plain':blob})]);});assert.deepEqual(await p.run(),unavailable);p.restored();p.page.window.close();}
});
await test('caller_input_mutation_cannot_adopt_a_navigated_document',async()=>{
 const p=setup(),input={assistantTurnId:'assistant-1',documentUrl:url};p.button.addEventListener('click',()=>{void p.clipboard.write([p.delayed(async()=>{p.page.reconfigure({url:url+'/other'});input.documentUrl=url+'/other';return new Blob(['old document'],{type:'text/plain'});})]);});assert.deepEqual(await p.run(input),unavailable);p.restored();p.page.window.close();
});
await test('mutable_non_native_clipboard_item_is_rejected',async()=>{
 const p=setup();p.button.addEventListener('click',()=>{const item={types:['text/plain'],blob:new Blob(['at invocation'],{type:'text/plain'}),getType(){return Promise.resolve(this.blob);}};void p.clipboard.write([item]);item.blob=new Blob(['after invocation'],{type:'text/plain'});});assert.deepEqual(await p.run(),unavailable);p.restored();p.page.window.close();
});
await test('spoofed_blob_tag_does_not_pass_native_brand_checks',async()=>{
 const p=setup(),fake={[Symbol.toStringTag]:'Blob',size:4,type:'text/plain',text:async()=> 'fake'};p.button.addEventListener('click',()=>{void p.clipboard.write([new ClipboardItemBoundary({'text/plain':fake as unknown as Blob})]);});assert.deepEqual(await p.run(),unavailable);p.restored();p.page.window.close();
});
await test('valid_utf8_bom_is_preserved_byte_for_byte',async()=>{
 const p=setup(),text='\ufeffok';p.button.addEventListener('click',()=>{void p.clipboard.write([p.item(text)]);});assert.deepEqual(await p.run(),{kind:'CAPTURED',assistantTurnId:'assistant-1',markdown:text});p.restored();p.page.window.close();
});
await test('copy_success_feedback_does_not_invalidate_the_same_copy_control',async()=>{
 const p=setup();p.button.addEventListener('click',()=>{void p.clipboard.write([p.delayed(async()=>{p.button.setAttribute('aria-label','Response copied');return new Blob(['ok'],{type:'text/plain'});})]);});assert.deepEqual(await p.run(),{kind:'CAPTURED',assistantTurnId:'assistant-1',markdown:'ok'});p.restored();p.page.window.close();
});
await test('prototype_component_never_enables_the_production_adapter',async()=>{
 assert.equal(adapter.SITE_ASSISTANT_MARKDOWN_AVAILABLE_V3,false);const p=setup();let clicks=0;p.button.addEventListener('click',()=>{clicks++;});assert.deepEqual(await adapter.acquireSiteAssistantMarkdown(p.document,{assistantTurnId:'assistant-1',captureToken:'capture:bound:1',conversationId:'conv-123',captureEpoch:1}),unavailable);assert.equal(clicks,0);p.page.window.close();
});
console.log(JSON.stringify({suite:'W1_V3_SITE_COPY_COMPONENT',passed,failed,productionAdapter:'UNAVAILABLE',liveAppShell:'NOT_RUN'}));if(failed)process.exitCode=1;
