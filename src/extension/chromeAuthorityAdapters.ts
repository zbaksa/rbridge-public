import {requireExactProjectConversationUrl} from '../browser/chatgptConversationIdentity.js';
import type {BrowserBindingControlV1,BrowserTargetObservationV1} from '../domain/rbridgeChatCore.js';
import type {BrowserContentDriverV1,BrowserLiveTargetReaderV1} from './browserAuthorityRuntime.js';
import type {DeliveryClickGuardV3,DeliverySurfaceV3,ChatgptDeliverySurfaceReaderV3} from '../browser/chatgptDeliveryAdapter.js';
import {canonicalJson,parseEffectRequest,sha256Hex,type ExactBrowserTargetV1,type CocwinRbridgeEffectRequestV1} from '../domain/rbridgeEffectProtocol.js';
import {snapshotEffectData} from './rbridgeEffectStore.js';
import {captureExactSiteCopyInMainWorldV3,type SiteMarkdownObservationV3} from '../browser/chatgptAssistantMarkdownCapture.js';
import type {DeliveryObservationV3} from '../browser/chatgptDeliveryAdapter.js';

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

  async clickSend(tabId:number,guard?:DeliveryClickGuardV3):Promise<{outcome:'CLICKED'}|{outcome:'FAILED_BEFORE_CLICK';reason:string}|{outcome:'UNCERTAIN';reason:string}>{
    let raw:unknown;
    try{raw=await this.call(tabId,guard?'SEND_CLICK_V3':'SEND_CLICK',guard?{guard}:{});}catch{throw new Error('SEND_UNCERTAIN');}
    const result=resultObject(raw);
    if(result.outcome==='CLICKED')return {outcome:'CLICKED'};
    if(result.outcome==='FAILED_BEFORE_CLICK'&&typeof result.reason==='string')return {outcome:'FAILED_BEFORE_CLICK',reason:result.reason};
    if(result.outcome==='UNCERTAIN')return {outcome:'UNCERTAIN',reason:'SEND_UNCERTAIN'};
    fail('RBRIDGE_CONTENT_CLICK_REPLY_INVALID');
  }

  async deliveryScan(tabId:number):Promise<DeliverySurfaceV3>{
    await this.ensureContentRuntime(tabId);
    const result=resultObject(await this.call(tabId,'DELIVERY_SCAN')),keys=['documentId','documentUrl','observedAt','turns'];
    if(Object.keys(result).length!==keys.length||Object.keys(result).some(key=>!keys.includes(key))||typeof result.documentId!=='string'||typeof result.documentUrl!=='string'||typeof result.observedAt!=='string'||!Array.isArray(result.turns))fail('RBRIDGE_DELIVERY_SURFACE_INVALID');
    return result as unknown as DeliverySurfaceV3;
  }

  private async ensureContentRuntime(tabId:number):Promise<void>{
    if(!this.scripting)return;
    if(!Number.isInteger(tabId)||tabId<0)fail('RBRIDGE_TAB_ID_INVALID');
    try{await this.scripting.executeScript({target:{tabId},files:['contentScript.js']});}
    catch{throw new Error('RBRIDGE_CONTENT_INJECTION_FAILED');}
  }

  private async call(tabId:number,action:'STAGE_PROMPT'|'SEND_PREFLIGHT'|'SEND_CLICK'|'CAPTURE_START'|'CAPTURE_STOP'|'DELIVERY_SCAN'|'SEND_CLICK_V3',extra:Record<string,unknown>={}):Promise<unknown>{
    if(!Number.isInteger(tabId)||tabId<0)fail('RBRIDGE_TAB_ID_INVALID');
    const requestId='rbridge:'+String(++this.sequence)+':'+action.toLowerCase();
    let response:unknown;
    try{response=await this.tabs.sendMessage(tabId,{schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId,action,...extra});}
    catch{throw new Error('RBRIDGE_CONTENT_CHANNEL_UNCERTAIN');}
    return reply(response,requestId);
  }
}

export class ChromeDeliverySurfaceReaderV3 implements ChatgptDeliverySurfaceReaderV3{
  private readonly content:ChromeContentDriverV1;
  constructor(private readonly tabs:ChromeAuthorityTabsApiV1,private readonly browserInstanceId:string,private readonly browserProfileId:string,scripting:ChromeAuthorityScriptingApiV1|null=null){
    identity(browserInstanceId,'RBRIDGE_BROWSER_INSTANCE_INVALID');identity(browserProfileId,'RBRIDGE_BROWSER_PROFILE_INVALID');this.content=new ChromeContentDriverV1(tabs,scripting);
  }
  async scan(target:ExactBrowserTargetV1):Promise<DeliverySurfaceV3>{
    if(target.browserInstanceId!==this.browserInstanceId||target.browserProfileId!==this.browserProfileId)fail('BROWSER_BINDING_STALE');
    const check=(url:string)=>{const parsed=requireExactProjectConversationUrl(url);if(parsed.origin!==target.origin||parsed.projectId!==target.projectId||parsed.canonicalProjectId!==target.canonicalProjectId||parsed.conversationId!==target.conversationId)fail('BROWSER_BINDING_STALE');};
    const tabCheck=async()=>{const tab=await this.tabs.get(target.tabId);if(tab.id!==target.tabId||tab.windowId!==target.windowId||typeof tab.url!=='string')fail('BROWSER_BINDING_STALE');check(tab.url);};
    await tabCheck();const result=await this.content.deliveryScan(target.tabId);check(result.documentUrl);await tabCheck();return result;
  }
}

export interface SiteMarkdownReadResultV3{assistantTurnId:string;observation:SiteMarkdownObservationV3}
export interface SiteMarkdownReaderV3{
  acquire(request:CocwinRbridgeEffectRequestV1,delivery:Extract<DeliveryObservationV3,{kind:'MATCHED'}>,prepareAdmission:()=>Promise<()=>void>):Promise<SiteMarkdownReadResultV3>;
}
interface PairProbeInputV3{documentUrl:string;userTurnId:string;userTextSha256:string}
type PairProbeV3={kind:'UNAVAILABLE'}|{kind:'READY';documentUrl:string;userTurnId:string;assistantTurnId:string;bodySha256:string};
export interface ChromeSiteScriptingApiV3{
  executeScript(details:{target:{tabId:number;frameIds?:number[];documentIds?:string[]};world:'ISOLATED'|'MAIN';func:typeof probeExactAssistantPairV3|typeof captureExactSiteCopyInMainWorldV3;args:[PairProbeInputV3]|[{assistantTurnId:string;documentUrl:string}]}):Promise<unknown>;
}

// This function is serialized into the extension's ISOLATED world. All runtime
// dependencies stay inside the body; page state supplies no authority fields.
export async function probeExactAssistantPairV3(input:PairProbeInputV3):Promise<PairProbeV3>{
  const unavailable=():PairProbeV3=>({kind:'UNAVAILABLE'});
  try{
    const {documentUrl,userTurnId,userTextSha256}=input;
    if(typeof documentUrl!=='string'||typeof userTurnId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(userTurnId)||!/^[a-f0-9]{64}$/.test(userTextSha256)||document.URL!==documentUrl)return unavailable();
    const mains=document.querySelectorAll('main');if(mains.length!==1)return unavailable();const main=mains[0]!;
    const users=[...main.querySelectorAll('[data-message-author-role="user"]')];if(users.length>500)return unavailable();
    const userId=(node:Element)=>node.getAttribute('data-message-id')??node.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid');
    const matches=users.filter(node=>userId(node)===userTurnId);if(matches.length!==1||users.at(-1)!==matches[0])return unavailable();
    const user=matches[0]!,userTurn=user.closest('[data-turn]');if(userTurn?.getAttribute('data-turn')!=='user')return unavailable();
    const turns=[...main.querySelectorAll('[data-turn]')].filter(node=>!node.parentElement?.closest('[data-turn]'));if(turns.length>1000)return unavailable();
    const index=turns.indexOf(userTurn),tail=turns.slice(index+1);if(index<0||tail.length!==1)return unavailable();
    const assistant=tail[0]!,assistantTurnId=assistant.getAttribute('data-turn-id');
    if(assistant.getAttribute('data-turn')!=='assistant'||assistant.getAttribute('data-turn-state')!=='complete'||!assistantTurnId||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(assistantTurnId))return unavailable();
    if([...main.querySelectorAll('[data-turn="assistant"][data-turn-id]')].filter(node=>node.getAttribute('data-turn-id')===assistantTurnId).length!==1)return unavailable();
    const bodies=assistant.querySelectorAll('[data-message-author-role="assistant"]');if(bodies.length!==1)return unavailable();
    const body=bodies[0]!,html=body.innerHTML,text=user.textContent??'',encoder=new TextEncoder(),htmlBytes=encoder.encode(html),userBytes=encoder.encode(text);
    if(htmlBytes.byteLength>4*1024*1024||userBytes.byteLength>48000)return unavailable();
    const hex=(bytes:ArrayBuffer)=>[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    const [userHash,bodyHash]=await Promise.all([crypto.subtle.digest('SHA-256',userBytes),crypto.subtle.digest('SHA-256',htmlBytes)]);
    if(hex(userHash)!==userTextSha256||document.URL!==documentUrl||!main.isConnected||!user.isConnected||!assistant.isConnected||!body.isConnected||user.textContent!==text||body.innerHTML!==html||assistant.getAttribute('data-turn-state')!=='complete')return unavailable();
    const afterUsers=[...main.querySelectorAll('[data-message-author-role="user"]')],afterTurns=[...main.querySelectorAll('[data-turn]')].filter(node=>!node.parentElement?.closest('[data-turn]'));
    if(afterUsers.length!==users.length||afterUsers.at(-1)!==user||afterTurns.length!==turns.length||afterTurns.some((node,i)=>node!==turns[i]))return unavailable();
    return {kind:'READY',documentUrl,userTurnId,assistantTurnId,bodySha256:hex(bodyHash)};
  }catch{return unavailable();}
}

export class ChromeSiteMarkdownReaderV3 implements SiteMarkdownReaderV3{
  private timedOut=false;
  constructor(private readonly tabs:ChromeAuthorityTabsApiV1,private readonly scripting:ChromeSiteScriptingApiV3,private readonly browserInstanceId:string,private readonly browserProfileId:string){identity(browserInstanceId,'RBRIDGE_BROWSER_INSTANCE_INVALID');identity(browserProfileId,'RBRIDGE_BROWSER_PROFILE_INVALID');}
  async acquire(input:CocwinRbridgeEffectRequestV1,observed:Extract<DeliveryObservationV3,{kind:'MATCHED'}>,prepareAdmission:()=>Promise<()=>void>):Promise<SiteMarkdownReadResultV3>{
    if(this.timedOut)fail('RBRIDGE_SITE_CAPTURE_TIMEOUT');
    let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
    const check=()=>{if(expired)fail('RBRIDGE_SITE_CAPTURE_TIMEOUT');};
    const work=this.acquireOnce(input,observed,prepareAdmission,check);
    const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{expired=true;this.timedOut=true;reject(new Error('RBRIDGE_SITE_CAPTURE_TIMEOUT'));},5000);});
    try{return await Promise.race([work,deadline]);}finally{if(timer!==undefined)clearTimeout(timer);}
  }
  private async acquireOnce(input:CocwinRbridgeEffectRequestV1,observed:Extract<DeliveryObservationV3,{kind:'MATCHED'}>,prepareAdmission:()=>Promise<()=>void>,check:()=>void):Promise<SiteMarkdownReadResultV3>{
    // A timeout cannot cancel Chrome's queued injection. Stop subsequent steps and
    // quarantine this reader; the egress shares that fence with other instances.
    const step=async<T>(run:()=>Promise<T>):Promise<T>=>{check();const value=await run();check();return value;};
    const request=await parseEffectRequest(snapshotEffectData(input),65536),delivery=snapshotEffectData(observed);
    if(request.effectKind!=='RBRIDGE_SEND'&&request.effectKind!=='RBRIDGE_RESULT_SEND')fail('RBRIDGE_SITE_CAPTURE_SEND_REQUIRED');
    const target=request.payload.target,documentUrl=target.origin+'/g/'+target.projectId+'/c/'+target.conversationId;
    if(target.browserInstanceId!==this.browserInstanceId||target.browserProfileId!==this.browserProfileId||delivery.kind!=='MATCHED'||delivery.conversationId!==target.conversationId||typeof delivery.userTurnId!=='string'||!ID.test(delivery.userTurnId)||delivery.textSha256!==await sha256Hex(request.payload.text))fail('RBRIDGE_SITE_CAPTURE_SCOPE_INVALID');
    const probe:PairProbeInputV3={documentUrl,userTurnId:delivery.userTurnId,userTextSha256:delivery.textSha256};
    await step(()=>this.checkTab(target));
    const first=this.frame(await step(()=>this.scripting.executeScript({target:{tabId:target.tabId,frameIds:[0]},world:'ISOLATED',func:probeExactAssistantPairV3,args:[probe]})));
    const before=this.probe(first.result,probe);await step(()=>this.checkTab(target));
    const admit=await step(prepareAdmission);check();admit();
    const copied=this.frame(await step(()=>this.scripting.executeScript({target:{tabId:target.tabId,documentIds:[first.documentId]},world:'MAIN',func:captureExactSiteCopyInMainWorldV3,args:[{assistantTurnId:before.assistantTurnId,documentUrl}]})),first.documentId);
    const after=this.frame(await step(()=>this.scripting.executeScript({target:{tabId:target.tabId,documentIds:[first.documentId]},world:'ISOLATED',func:probeExactAssistantPairV3,args:[probe]})),first.documentId);
    if(canonicalJson(before)!==canonicalJson(this.probe(after.result,probe)))fail('RBRIDGE_SITE_CAPTURE_CHANGED');
    await step(()=>this.checkTab(target));
    const row=resultObject(snapshotEffectData(copied.result));
    if(row.kind==='CAPTURED'){
      if(Object.keys(row).length!==3||row.assistantTurnId!==before.assistantTurnId||typeof row.markdown!=='string'||new TextEncoder().encode(row.markdown).byteLength>4*1024*1024)fail('RBRIDGE_SITE_CAPTURE_RESULT_INVALID');
    }else if(row.kind!=='UNAVAILABLE'||row.reason!=='UI_PROTOCOL_CHANGED'||Object.keys(row).length!==2)fail('RBRIDGE_SITE_CAPTURE_RESULT_INVALID');
    return {assistantTurnId:before.assistantTurnId,observation:row as unknown as SiteMarkdownObservationV3};
  }
  private async checkTab(target:ExactBrowserTargetV1):Promise<void>{
    const tab=await this.tabs.get(target.tabId);if(tab.id!==target.tabId||tab.windowId!==target.windowId||tab.url!==target.origin+'/g/'+target.projectId+'/c/'+target.conversationId)fail('BROWSER_BINDING_STALE');
    const parsed=requireExactProjectConversationUrl(tab.url);for(const key of ['origin','projectId','canonicalProjectId','conversationId']as const)if(parsed[key]!==target[key])fail('BROWSER_BINDING_STALE');
  }
  private frame(input:unknown,expectedDocument?:string):{documentId:string;result:unknown}{
    const rows=snapshotEffectData(input);if(!Array.isArray(rows)||rows.length!==1)fail('RBRIDGE_SITE_CAPTURE_FRAME_INVALID');const row=resultObject(rows[0]);
    if(Object.keys(row).length!==3||row.frameId!==0||typeof row.documentId!=='string'||!ID.test(row.documentId)||!Object.hasOwn(row,'result')||expectedDocument!==undefined&&row.documentId!==expectedDocument)fail('RBRIDGE_SITE_CAPTURE_FRAME_INVALID');
    return {documentId:row.documentId,result:row.result};
  }
  private probe(input:unknown,expected:PairProbeInputV3):Extract<PairProbeV3,{kind:'READY'}>{
    const row=resultObject(snapshotEffectData(input));if(Object.keys(row).length!==5||row.kind!=='READY'||row.documentUrl!==expected.documentUrl||row.userTurnId!==expected.userTurnId||typeof row.assistantTurnId!=='string'||!ID.test(row.assistantTurnId)||typeof row.bodySha256!=='string'||!/^[a-f0-9]{64}$/.test(row.bodySha256))fail('RBRIDGE_SITE_CAPTURE_NOT_READY');return row as unknown as Extract<PairProbeV3,{kind:'READY'}>;
  }
}
