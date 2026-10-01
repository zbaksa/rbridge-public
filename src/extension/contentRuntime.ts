import {
  attemptHighConfidenceSendClick,inspectResponseQuiescence,locateHighConfidenceSendButton,locateUniqueComposer,scanAssistantTurns,stageComposerText,startAssistantTurnObserver,
  type AssistantTurnObservationV1,
} from '../browser/chatgptDomAdapter.js';
import {sha256Hex} from '../domain/rbridgeEffectProtocol.js';
import type {DeliveryClickGuardV3,DeliverySurfaceV3} from '../browser/chatgptDeliveryAdapter.js';

export type ContentActionV1='STAGE_PROMPT'|'SEND_PREFLIGHT'|'SEND_CLICK'|'CAPTURE_START'|'CAPTURE_STOP'|'CAPTURE_SCAN'|'DELIVERY_SCAN'|'SEND_CLICK_V3';

export interface ContentRequestV1{
  schema:'RBRIDGE_CONTENT_REQUEST_V1';
  requestId:string;
  action:ContentActionV1;
  text?:string;
  captureToken?:string;
  guard?:DeliveryClickGuardV3;
}

export interface ContentCaptureFrameV1{
  schema:'RBRIDGE_CONTENT_CAPTURE_V1';
  captureToken:string;
  turns:AssistantTurnObservationV1[];
}

export interface ContentRuntimeEmitterV1{
  emit(frame:ContentCaptureFrameV1):void|Promise<void>;
}

const REQUEST=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TURN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const encoder=new TextEncoder();
function fail(code:string):never{throw new Error(code);}
function parseGuard(input:unknown):DeliveryClickGuardV3{
  if(!input||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_DELIVERY_GUARD_INVALID');
  const r=input as Record<string,unknown>,keys=['documentId','documentUrl','baselineUserTurnIds','text'];
  if(Object.keys(r).length!==keys.length||Object.keys(r).some(key=>!keys.includes(key))||typeof r.documentId!=='string'||!TURN.test(r.documentId)||typeof r.documentUrl!=='string'||r.documentUrl.length>2048||typeof r.text!=='string'||!r.text||r.text.includes('\0')||encoder.encode(r.text).byteLength>48000||!Array.isArray(r.baselineUserTurnIds)||r.baselineUserTurnIds.length>500)fail('RBRIDGE_DELIVERY_GUARD_INVALID');
  const ids=new Set<string>();for(const id of r.baselineUserTurnIds){if(typeof id!=='string'||!TURN.test(id)||ids.has(id))fail('RBRIDGE_DELIVERY_GUARD_INVALID');ids.add(id);}
  return {documentId:r.documentId,documentUrl:r.documentUrl,baselineUserTurnIds:[...ids],text:r.text};
}
function userTurns(document:Document):{userTurnId:string;text:string}[]{
  const roots=[...document.querySelectorAll('[data-message-author-role="user"]')];if(roots.length>500)fail('RBRIDGE_DELIVERY_SURFACE_TOO_LARGE');
  const ids=new Set<string>(),turns:{userTurnId:string;text:string}[]=[];let total=0;
  for(const root of roots){
    const id=root.getAttribute('data-message-id')??root.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid'),text=root.textContent??'',bytes=encoder.encode(text).byteLength;
    if(!id||!TURN.test(id)||ids.has(id)||bytes>48000)fail('RBRIDGE_DELIVERY_SURFACE_INVALID');total+=bytes;if(total>512000)fail('RBRIDGE_DELIVERY_SURFACE_TOO_LARGE');
    ids.add(id);turns.push({userTurnId:id,text});
  }return turns;
}
function parse(input:unknown):ContentRequestV1{
  if(input===null||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_CONTENT_REQUEST_INVALID');
  const row=input as Record<string,unknown>,action=row.action;
  const allowed=new Set(['schema','requestId','action','text','captureToken','guard']);
  if(Object.keys(row).some(key=>!allowed.has(key))||row.schema!=='RBRIDGE_CONTENT_REQUEST_V1'||typeof row.requestId!=='string'||!REQUEST.test(row.requestId))fail('RBRIDGE_CONTENT_REQUEST_INVALID');
  if(action!=='STAGE_PROMPT'&&action!=='SEND_PREFLIGHT'&&action!=='SEND_CLICK'&&action!=='CAPTURE_START'&&action!=='CAPTURE_STOP'&&action!=='CAPTURE_SCAN'&&action!=='DELIVERY_SCAN'&&action!=='SEND_CLICK_V3')fail('RBRIDGE_CONTENT_ACTION_INVALID');
  if(action==='STAGE_PROMPT'&&typeof row.text!=='string')fail('RBRIDGE_CONTENT_PROMPT_REQUIRED');
  if(action==='CAPTURE_START'&&(typeof row.captureToken!=='string'||!REQUEST.test(row.captureToken)))fail('RBRIDGE_CONTENT_CAPTURE_TOKEN_INVALID');
  const exact=action==='STAGE_PROMPT'?['schema','requestId','action','text']:
    action==='CAPTURE_START'?['schema','requestId','action','captureToken']:action==='SEND_CLICK_V3'?['schema','requestId','action','guard']:['schema','requestId','action'];
  if(Object.keys(row).length!==exact.length||Object.keys(row).some(key=>!exact.includes(key)))fail('RBRIDGE_CONTENT_REQUEST_FIELDS_INVALID');
  return {
    schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:row.requestId,action,
    ...(action==='STAGE_PROMPT'?{text:row.text as string}:{}),
    ...(action==='CAPTURE_START'?{captureToken:row.captureToken as string}:{}),
    ...(action==='SEND_CLICK_V3'?{guard:parseGuard(row.guard)}:{}),
  };
}

export class ChatgptContentRuntimeV1{
  private stopCapture:(()=>void)|null=null;
  private captureToken:string|null=null;
  private captureBaseline=new Map<string,string>();
  private readonly documentId='document:'+crypto.randomUUID();

  constructor(private readonly document:Document,private readonly emitter:ContentRuntimeEmitterV1){}

  get captureActive():boolean{return this.stopCapture!==null;}

  handle(input:unknown):unknown{
    const request=parse(input);
    switch(request.action){
      case 'STAGE_PROMPT':
        return {requestId:request.requestId,action:request.action,...stageComposerText(this.document,request.text!)};
      case 'SEND_PREFLIGHT':{
        const result=locateHighConfidenceSendButton(this.document);
        return {requestId:request.requestId,action:request.action,status:result.status,evidence:result.evidence};
      }
      case 'SEND_CLICK':{
        const result=attemptHighConfidenceSendClick(this.document);
        return {requestId:request.requestId,action:request.action,...result};
      }
      case 'DELIVERY_SCAN':return this.deliverySurface();
      case 'SEND_CLICK_V3':{
        const guard=request.guard!;
        // All DOM checks and the one click run in this same synchronous turn.
        try{
          const turns=userTurns(this.document),composer=locateUniqueComposer(this.document);
          const text=composer.element?.tagName==='TEXTAREA'?(composer.element as HTMLTextAreaElement).value:composer.element?.textContent;
          if(guard.documentId!==this.documentId||guard.documentUrl!==this.document.URL||JSON.stringify(turns.map(turn=>turn.userTurnId))!==JSON.stringify(guard.baselineUserTurnIds)||composer.status!=='FOUND'||text!==guard.text||!inspectResponseQuiescence(this.document).settled)return {outcome:'FAILED_BEFORE_CLICK',reason:'RBRIDGE_DELIVERY_GUARD_MISMATCH'};
        }catch{return {outcome:'FAILED_BEFORE_CLICK',reason:'RBRIDGE_DELIVERY_GUARD_UNAVAILABLE'};}
        return attemptHighConfidenceSendClick(this.document);
      }
      case 'CAPTURE_SCAN':
        return {requestId:request.requestId,action:request.action,turns:scanAssistantTurns(this.document)};
      case 'CAPTURE_START':
        if(this.stopCapture){
          if(this.captureToken===request.captureToken)return {requestId:request.requestId,action:request.action,status:'ACTIVE',baselineTurns:this.captureBaseline.size};
          fail('RBRIDGE_CAPTURE_ALREADY_ACTIVE');
        }
        this.captureToken=request.captureToken!;
        this.captureBaseline=this.snapshot(scanAssistantTurns(this.document));
        this.stopCapture=startAssistantTurnObserver(this.document,turns=>{void this.emitChanged(turns);},{deferInitialScan:true,debounceMs:250});
        return {requestId:request.requestId,action:request.action,status:'ACTIVE',baselineTurns:this.captureBaseline.size};
      case 'CAPTURE_STOP':
        this.stopCapture?.();this.stopCapture=null;this.captureToken=null;this.captureBaseline.clear();
        return {requestId:request.requestId,action:request.action,status:'OFF'};
    }
  }

  stop():void{
    this.stopCapture?.();this.stopCapture=null;this.captureToken=null;this.captureBaseline.clear();
  }

  private async deliverySurface():Promise<DeliverySurfaceV3>{
    const raw=userTurns(this.document),documentUrl=this.document.URL,observedAt=new Date().toISOString();
    const turns=await Promise.all(raw.map(async turn=>({userTurnId:turn.userTurnId,textSha256:await sha256Hex(turn.text)})));
    if(this.document.URL!==documentUrl||JSON.stringify(userTurns(this.document))!==JSON.stringify(raw))fail('RBRIDGE_DELIVERY_SURFACE_CHANGED');
    const result={documentId:this.documentId,documentUrl,observedAt,turns};if(encoder.encode(JSON.stringify(result)).byteLength>65536)fail('RBRIDGE_DELIVERY_SURFACE_TOO_LARGE');return result;
  }

  private fingerprint(turn:AssistantTurnObservationV1):string{
    return turn.textUtf8Bytes+'\0'+turn.text+'\0'+turn.codeBlocks.join('\0');
  }

  private snapshot(turns:AssistantTurnObservationV1[]):Map<string,string>{
    const out=new Map<string,string>();
    for(const turn of turns)out.set(turn.assistantTurnId,this.fingerprint(turn));
    return out;
  }

  private async emitChanged(turns:AssistantTurnObservationV1[]):Promise<void>{
    const token=this.captureToken;if(!token)return;
    if(!inspectResponseQuiescence(this.document).settled)return;
    const changed:AssistantTurnObservationV1[]=[];
    for(const turn of turns){
      const fingerprint=this.fingerprint(turn);
      if(this.captureBaseline.get(turn.assistantTurnId)!==fingerprint)changed.push(turn);
      this.captureBaseline.set(turn.assistantTurnId,fingerprint);
    }
    if(changed.length===0)return;
    try{await this.emitter.emit({schema:'RBRIDGE_CONTENT_CAPTURE_V1',captureToken:token,turns:changed});}catch{}
  }
}
