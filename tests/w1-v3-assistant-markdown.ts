import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import * as markdownAdapter from '../src/browser/chatgptAssistantMarkdownCapture.js';

const matrix=['','```json\n{"x":1}\n```','```JSON\r\n{"x":1}\r\n```','```python\nprint(1)\n```',
  '```json\n{"x":1}\n```\nprose\n```json\n{"x":2}\n```','before\n```json\n{"x":1}',
  'Proza Ž🙂\r\n  indentation\r\n```json\r\n{ "x": 1 }\r\n```\nend'];
let passed=0,failed=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();passed++;console.log('PASS V3_MARKDOWN '+name);}catch(error){failed++;console.error('FAIL V3_MARKDOWN '+name+': '+String(error));}}
await test('unvalidated_site_export_never_becomes_original_markdown',async()=>{
  for(const text of matrix){
    const page=new JSDOM('<article data-testid="conversation-turn-1"><div data-message-author-role="assistant" data-message-id="assistant-1"></div><button data-testid="copy-turn">Copy</button></article>',{url:'https://chatgpt.com/g/g-p-'+'a'.repeat(32)+'-05-cocwin/c/conv-123'});
    page.window.document.querySelector('[data-message-author-role]')!.textContent=text;
    const observed=await markdownAdapter.acquireSiteAssistantMarkdown(page.window.document,{assistantTurnId:'assistant-1',captureToken:'capture:bound:1',conversationId:'conv-123',captureEpoch:1});
    assert.deepEqual(observed,{kind:'UNAVAILABLE',reason:'UI_PROTOCOL_CHANGED'});page.window.close();
  }
});
await test('no_global_clipboard_click_private_data_or_dom_reconstruction',async()=>{
  const page=new JSDOM('<article><div data-message-author-role="assistant" data-message-id="assistant-1"><pre><code>{"x":1}</code></pre></div><button>Copy</button></article>');let reads=0,clicks=0,domReads=0;
  Object.defineProperty(page.window.navigator,'clipboard',{get:()=>{reads++;throw Error('global clipboard forbidden');}});
  page.window.document.querySelector('button')!.addEventListener('click',()=>{clicks++;});
  Object.defineProperty(page.window.document,'querySelectorAll',{value:()=>{domReads++;throw Error('unvalidated DOM reconstruction forbidden');}});
  const result=await markdownAdapter.acquireSiteAssistantMarkdown(page.window.document,{assistantTurnId:'assistant-1',captureToken:'capture:bound:1',conversationId:'conv-123',captureEpoch:1});
  assert.equal(result.kind,'UNAVAILABLE');assert.equal(reads,0);assert.equal(clicks,0);assert.equal(domReads,0);page.window.close();
});
await test('wrong_token_baseline_updated_user_tool_or_missing_export_stays_unavailable',async()=>{
  for(const role of ['assistant','user','tool'])for(const token of ['capture:wrong:1','capture:bound:1']){
    const page=new JSDOM('<div data-message-author-role="'+role+'" data-message-id="assistant-1">updated before quiescence</div>');
    const result=await markdownAdapter.acquireSiteAssistantMarkdown(page.window.document,{assistantTurnId:'assistant-1',captureToken:token,conversationId:'wrong-conversation',captureEpoch:2});
    assert.equal(result.kind,'UNAVAILABLE');page.window.close();
  }
});
await test('no_unvalidated_lossless_capability_is_advertised',async()=>{
  assert.equal(markdownAdapter.SITE_ASSISTANT_MARKDOWN_AVAILABLE_V3,false);
});
console.log(JSON.stringify({suite:'W1_V3_ASSISTANT_MARKDOWN_UNAVAILABLE',passed,failed,positiveLosslessFeasibility:'BLOCKED_NO_VALIDATED_SITE_REPRESENTATION'}));if(failed)process.exitCode=1;
