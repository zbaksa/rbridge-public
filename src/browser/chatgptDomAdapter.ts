export interface AssistantTurnObservationV1{
  assistantTurnId:string;
  text:string;
  textUtf8Bytes:number;
  codeBlocks:string[];
}

export interface SendLocatorResultV1{
  status:'FOUND'|'NOT_FOUND'|'AMBIGUOUS';
  element:HTMLElement|null;
  evidence:{
    composerCount:number;
    candidateCount:number;
    topScore:number;
  };
}

export interface AssistantObserverOptionsV1{
  deferInitialScan?:boolean;
  debounceMs?:number;
}

const encoder=new TextEncoder();
const SEND_WORDS=/^(send|submit|pošalji|posalji)$/iu;
const REJECT_WORDS=/(microphone|mic|voice|speech|dictat|record|audio)/iu;

function stableTurnId(root:Element):string|null{
  const direct=root.getAttribute('data-message-id');
  if(direct&&direct.length<=256)return direct;
  const article=root.closest('[data-testid^="conversation-turn-"]');
  const testId=article?.getAttribute('data-testid')??'';
  if(/^conversation-turn-[A-Za-z0-9._:-]{1,200}$/u.test(testId))return testId;
  return null;
}

function elementText(element:Element):string{
  return element.textContent??'';
}

export function scanAssistantTurns(document:Document):AssistantTurnObservationV1[]{
  const out:AssistantTurnObservationV1[]=[];
  const roots=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
  for(const root of roots){
    const assistantTurnId=stableTurnId(root);
    if(!assistantTurnId)continue;
    const text=elementText(root);
    const seenBlocks=new Set<string>();
    const codeBlocks:string[]=[];
    for(const code of root.querySelectorAll('pre code')){
      const value=elementText(code);
      if(seenBlocks.has(value))continue;
      seenBlocks.add(value);
      codeBlocks.push(value);
    }
    out.push({assistantTurnId,text,textUtf8Bytes:encoder.encode(text).byteLength,codeBlocks});
  }
  return out;
}

function isHtmlElement(element:Element):element is HTMLElement{
  const ctor=element.ownerDocument.defaultView?.HTMLElement;
  return ctor?element instanceof ctor:'style' in element;
}

function isVisible(element:HTMLElement):boolean{
  if(element.hidden||element.getAttribute('aria-hidden')==='true')return false;
  const inline=element.style;
  if(inline.display==='none'||inline.visibility==='hidden')return false;
  const view=element.ownerDocument.defaultView;
  if(view){
    const style=view.getComputedStyle(element);
    if(style.display==='none'||style.visibility==='hidden')return false;
  }
  return true;
}

function allRoots(document:Document):ParentNode[]{
  const roots:ParentNode[]=[document];
  const queue=[...document.querySelectorAll('*')];
  for(const element of queue){
    const shadow=(element as HTMLElement).shadowRoot;
    if(!shadow)continue;
    roots.push(shadow);
    queue.push(...shadow.querySelectorAll('*'));
  }
  return roots;
}

function composerElements(document:Document):HTMLElement[]{
  const selectors=[
    '#prompt-textarea',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
  ];
  const found:HTMLElement[]=[];
  const seen=new Set<HTMLElement>();
  for(const root of allRoots(document)){
    for(const selector of selectors){
      for(const element of root.querySelectorAll(selector)){
        if(!isHtmlElement(element)||seen.has(element)||!isVisible(element))continue;
        seen.add(element);found.push(element);
      }
    }
  }
  return found;
}

export interface ComposerLocatorResultV1{
  status:'FOUND'|'NOT_FOUND'|'AMBIGUOUS';
  element:HTMLElement|null;
  count:number;
}

export interface ComposerStageResultV1{
  status:'STAGED_VERIFIED'|'ALREADY_PRESENT_IDEMPOTENT';
  utf8Bytes:number;
}

export function locateUniqueComposer(document:Document):ComposerLocatorResultV1{
  const composers=composerElements(document);
  if(composers.length===0)return {status:'NOT_FOUND',element:null,count:0};
  if(composers.length!==1)return {status:'AMBIGUOUS',element:null,count:composers.length};
  return {status:'FOUND',element:composers[0]!,count:1};
}

function readComposerText(element:HTMLElement):string{
  return element.tagName==='TEXTAREA'?(element as HTMLTextAreaElement).value:(element.textContent??'');
}

function dispatchComposerInput(element:HTMLElement,text:string):void{
  const view=element.ownerDocument.defaultView;
  if(!view)throw new Error('RBRIDGE_COMPOSER_WINDOW_UNAVAILABLE');
  element.focus();
  if(element.tagName==='TEXTAREA'){
    const ctor=view.HTMLTextAreaElement;
    const setter=Object.getOwnPropertyDescriptor(ctor.prototype,'value')?.set;
    if(setter)setter.call(element,text);
    else (element as HTMLTextAreaElement).value=text;
  }else{
    element.textContent=text;
  }
  const InputCtor=view.InputEvent;
  const event=InputCtor?new InputCtor('input',{bubbles:true,inputType:'insertText',data:text}):new view.Event('input',{bubbles:true});
  element.dispatchEvent(event);
}

export function stageComposerText(document:Document,text:string,maxUtf8Bytes=48_000):ComposerStageResultV1{
  if(typeof text!=='string'||text.length===0)throw new Error('RBRIDGE_COMPOSER_TEXT_INVALID');
  const bytes=encoder.encode(text).byteLength;
  if(!Number.isInteger(maxUtf8Bytes)||maxUtf8Bytes<1||bytes>maxUtf8Bytes)throw new Error('RBRIDGE_SEND_PAYLOAD_TOO_LARGE');
  const located=locateUniqueComposer(document);
  if(located.status==='NOT_FOUND')throw new Error('RBRIDGE_COMPOSER_NOT_FOUND');
  if(located.status==='AMBIGUOUS')throw new Error('RBRIDGE_COMPOSER_AMBIGUOUS');
  const element=located.element!;
  const before=readComposerText(element);
  if(before===text)return {status:'ALREADY_PRESENT_IDEMPOTENT',utf8Bytes:bytes};
  if(before.trim().length!==0)throw new Error('RBRIDGE_COMPOSER_NOT_EMPTY');
  dispatchComposerInput(element,text);
  if(readComposerText(element)!==text)throw new Error('RBRIDGE_COMPOSER_READBACK_MISMATCH');
  return {status:'STAGED_VERIFIED',utf8Bytes:bytes};
}

function buttonSemanticScore(element:HTMLElement):number{
  const buttonCtor=element.ownerDocument.defaultView?.HTMLButtonElement;
  if(buttonCtor&&element instanceof buttonCtor&&element.disabled)return -100;
  if(element.getAttribute('aria-disabled')==='true'||!isVisible(element))return -100;
  const testId=(element.getAttribute('data-testid')??'').trim();
  const aria=(element.getAttribute('aria-label')??'').trim();
  const title=(element.getAttribute('title')??'').trim();
  const type=(element.getAttribute('type')??'').trim().toLowerCase();
  const combined=(aria+' '+title).trim();
  if(REJECT_WORDS.test(combined))return -100;
  let score=0;
  if(testId==='send-button')score+=8;
  else if(/send|submit/iu.test(testId))score+=5;
  if(SEND_WORDS.test(aria)||SEND_WORDS.test(title))score+=6;
  else if(/\b(send|submit|pošalji|posalji)\b/iu.test(combined))score+=3;
  if(type==='submit')score+=4;
  return score;
}

function commonLocalAncestor(a:Element,b:Element):boolean{
  const seen=new Set<Element>();let x:Element|null=a;
  for(let depth=0;x&&depth<10;depth++,x=x.parentElement)seen.add(x);
  let y:Element|null=b;
  for(let depth=0;y&&depth<10;depth++,y=y.parentElement){
    if(seen.has(y)&&y.tagName!=='BODY'&&y.tagName!=='HTML')return true;
  }
  return false;
}

function relationScore(button:HTMLElement,composer:HTMLElement):number{
  const bf=button.closest('form'),cf=composer.closest('form');
  if(bf&&cf&&bf===cf)return 5;
  return commonLocalAncestor(button,composer)?3:0;
}

export function locateHighConfidenceSendButton(document:Document):SendLocatorResultV1{
  const composers=composerElements(document);
  if(composers.length===0)return {status:'NOT_FOUND',element:null,evidence:{composerCount:0,candidateCount:0,topScore:0}};
  const candidates:HTMLElement[]=[];
  const seen=new Set<HTMLElement>();
  const selectors=['button','[role="button"]'];
  for(const root of allRoots(document)){
    for(const selector of selectors){
      for(const node of root.querySelectorAll(selector)){
        if(!isHtmlElement(node)||seen.has(node))continue;
        seen.add(node);candidates.push(node);
      }
    }
  }
  const scored:candidatesRow[]=[];
  type candidatesRow={element:HTMLElement;score:number};
  for(const element of candidates){
    const semantic=buttonSemanticScore(element);if(semantic<4)continue;
    let relation=0;for(const composer of composers)relation=Math.max(relation,relationScore(element,composer));
    if(relation===0)continue;
    scored.push({element,score:semantic+relation});
  }
  if(scored.length===0)return {status:'NOT_FOUND',element:null,evidence:{composerCount:composers.length,candidateCount:0,topScore:0}};
  scored.sort((a,b)=>b.score-a.score);
  const top=scored[0]!,tied=scored.filter(row=>row.score===top.score);
  if(tied.length!==1)return {status:'AMBIGUOUS',element:null,evidence:{composerCount:composers.length,candidateCount:scored.length,topScore:top.score}};
  return {status:'FOUND',element:top.element,evidence:{composerCount:composers.length,candidateCount:scored.length,topScore:top.score}};
}

export function clickHighConfidenceSendButton(document:Document):SendLocatorResultV1{
  const result=locateHighConfidenceSendButton(document);
  if(result.status==='NOT_FOUND')throw new Error('RBRIDGE_SEND_BUTTON_NOT_FOUND');
  if(result.status==='AMBIGUOUS')throw new Error('RBRIDGE_SEND_BUTTON_AMBIGUOUS');
  const element=result.element!;
  element.click();
  return {...result,element};
}

export function startAssistantTurnObserver(document:Document,onScan:(turns:AssistantTurnObservationV1[])=>void,options:AssistantObserverOptionsV1={}):()=>void{
  const view=document.defaultView;if(!view)throw new Error('RBRIDGE_CAPTURE_WINDOW_UNAVAILABLE');
  const debounceMs=options.debounceMs??100;
  if(!Number.isInteger(debounceMs)||debounceMs<0||debounceMs>5000)throw new Error('RBRIDGE_CAPTURE_DEBOUNCE_INVALID');
  let timer:number|null=null;
  const scan=()=>onScan(scanAssistantTurns(document));
  const schedule=()=>{
    if(timer!==null)view.clearTimeout(timer);
    timer=view.setTimeout(()=>{timer=null;scan();},debounceMs);
  };
  const observer=new view.MutationObserver(schedule);
  observer.observe(document.body??document.documentElement,{childList:true,subtree:true});
  if(options.deferInitialScan!==true)scan();
  return ()=>{
    observer.disconnect();
    if(timer!==null)view.clearTimeout(timer);
    timer=null;
  };
}
