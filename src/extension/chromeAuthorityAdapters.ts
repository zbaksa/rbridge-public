import {requireExactProjectConversationUrl} from '../browser/chatgptConversationIdentity.js';
import type {BrowserBindingControlV1,BrowserTargetObservationV1} from '../domain/rbridgeChatCore.js';
import type {BrowserContentDriverV1,BrowserLiveTargetReaderV1} from './browserAuthorityRuntime.js';

export interface ChromeAuthorityTabV1{
  id?:number;
  windowId:number;
  url?:string;
}
export interface ChromeAuthorityTabsApiV1{
  get(tabId:number):Promise<ChromeAuthorityTabV1>;
  sendMessage(tabId:number,message:unknown):Promise<unknown>;
}
export interface ChromeAuthorityScriptingApiV1{
  executeScript(details:{target:{tabId:number};files:string[]}):Promise<unknown>;
}

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function fail(code:string):never{throw new Error(code);}
function identity(value:string,code:string):string{if(typeof value!=='string'||!ID.test(value))fail(code);return value;}
function reply(input:unknown,requestId:string):unknown{
  if(input===null||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_CONTENT_REPLY_INVALID');
  const row=input as Record<string,unknown>;
  const expected=row.ok===true?['schema','requestId','ok','result']:['schema','requestId','ok','errorCode'];
  if(Object.keys(row).length!==expected.length||Object.keys(row).some(key=>!expected.includes(key))||row.schema!=='RBRIDGE_CONTENT_REPLY_V1'||row.requestId!==requestId)fail('RBRIDGE_CONTENT_REPLY_INVALID');
  if(row.ok!==true){if(typeof row.errorCode!=='string')fail('RBRIDGE_CONTENT_REPLY_INVALID');throw new Error(row.errorCode);}
  return row.result;
}
function resultObject(input:unknown):Record<string,unknown>{
  if(input===null||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_CONTENT_RESULT_INVALID');return input as Record<string,unknown>;
}

export class ChromeLiveTargetReaderV1 implements BrowserLiveTargetReaderV1{
  constructor(private readonly tabs:ChromeAuthorityTabsApiV1,private readonly browserInstanceId:string,private readonly browserProfileId:string){
    identity(browserInstanceId,'RBRIDGE_BROWSER_INSTANCE_INVALID');identity(browserProfileId,'RBRIDGE_BROWSER_PROFILE_INVALID');
  }
  async observe(binding:BrowserBindingControlV1):Promise<BrowserTargetObservationV1>{
    const tab=await this.tabs.get(binding.tabId);
    if(tab.id!==binding.tabId||!Number.isInteger(tab.windowId)||typeof tab.url!=='string')fail('BROWSER_BINDING_STALE');
    const parsed=requireExactProjectConversationUrl(tab.url);
    return {
      sessionId:binding.sessionId,generation:binding.generation,browserInstanceId:this.browserInstanceId,browserProfileId:this.browserProfileId,
      windowId:tab.windowId,tabId:binding.tabId,origin:parsed.origin,projectId:parsed.projectId,conversationId:parsed.conversationId,
      conversationGeneration:binding.conversationGeneration,ownerSessionId:binding.ownerSessionId,
    };
  }
}

export class ChromeContentDriverV1 implements BrowserContentDriverV1{
  private sequence=0;
  constructor(private readonly tabs:ChromeAuthorityTabsApiV1,private readonly scripting:ChromeAuthorityScriptingApiV1|null=null){}

  async stagePrompt(tabId:number,text:string):Promise<{status:'STAGED_VERIFIED'|'ALREADY_PRESENT_IDEMPOTENT';utf8Bytes:number}>{
    await this.ensureContentRuntime(tabId);
    const result=resultObject(await this.call(tabId,'STAGE_PROMPT',{text}));
    if((result.status!=='STAGED_VERIFIED'&&result.status!=='ALREADY_PRESENT_IDEMPOTENT')||typeof result.utf8Bytes!=='number'||!Number.isInteger(result.utf8Bytes))fail('RBRIDGE_CONTENT_STAGE_REPLY_INVALID');
    return {status:result.status,utf8Bytes:result.utf8Bytes};
  }

  async startCapture(tabId:number,captureToken:string):Promise<{status:'ACTIVE'}>{
    await this.ensureContentRuntime(tabId);
    const result=resultObject(await this.call(tabId,'CAPTURE_START',{captureToken}));
    if(result.status!=='ACTIVE')fail('RBRIDGE_CONTENT_CAPTURE_START_REPLY_INVALID');
    return {status:'ACTIVE'};
  }

  async stopCapture(tabId:number):Promise<{status:'OFF'}>{
    const result=resultObject(await this.call(tabId,'CAPTURE_STOP'));
    if(result.status!=='OFF')fail('RBRIDGE_CONTENT_CAPTURE_STOP_REPLY_INVALID');
    return {status:'OFF'};
  }

  async preflightSend(tabId:number):Promise<{status:'FOUND'|'NOT_FOUND'|'AMBIGUOUS'}>{
    await this.ensureContentRuntime(tabId);
    const result=resultObject(await this.call(tabId,'SEND_PREFLIGHT'));
    if(result.status!=='FOUND'&&result.status!=='NOT_FOUND'&&result.status!=='AMBIGUOUS')fail('RBRIDGE_CONTENT_PREFLIGHT_REPLY_INVALID');
    return {status:result.status};
  }

  async clickSend(tabId:number):Promise<{outcome:'CLICKED'}|{outcome:'FAILED_BEFORE_CLICK';reason:string}|{outcome:'UNCERTAIN';reason:string}>{
    let raw:unknown;
    try{raw=await this.call(tabId,'SEND_CLICK');}catch{throw new Error('SEND_UNCERTAIN');}
    const result=resultObject(raw);
    if(result.outcome==='CLICKED')return {outcome:'CLICKED'};
    if(result.outcome==='FAILED_BEFORE_CLICK'&&typeof result.reason==='string')return {outcome:'FAILED_BEFORE_CLICK',reason:result.reason};
    if(result.outcome==='UNCERTAIN')return {outcome:'UNCERTAIN',reason:'SEND_UNCERTAIN'};
    fail('RBRIDGE_CONTENT_CLICK_REPLY_INVALID');
  }

  private async ensureContentRuntime(tabId:number):Promise<void>{
    if(!this.scripting)return;
    if(!Number.isInteger(tabId)||tabId<0)fail('RBRIDGE_TAB_ID_INVALID');
    try{await this.scripting.executeScript({target:{tabId},files:['contentScript.js']});}
    catch{throw new Error('RBRIDGE_CONTENT_INJECTION_FAILED');}
  }

  private async call(tabId:number,action:'STAGE_PROMPT'|'SEND_PREFLIGHT'|'SEND_CLICK'|'CAPTURE_START'|'CAPTURE_STOP',extra:Record<string,unknown>={}):Promise<unknown>{
    if(!Number.isInteger(tabId)||tabId<0)fail('RBRIDGE_TAB_ID_INVALID');
    const requestId='rbridge:'+String(++this.sequence)+':'+action.toLowerCase();
    let response:unknown;
    try{response=await this.tabs.sendMessage(tabId,{schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId,action,...extra});}
    catch{throw new Error('RBRIDGE_CONTENT_CHANNEL_UNCERTAIN');}
    return reply(response,requestId);
  }
}
