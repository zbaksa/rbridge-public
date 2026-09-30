import {
  clickHighConfidenceSendButton,locateHighConfidenceSendButton,scanAssistantTurns,stageComposerText,startAssistantTurnObserver,
  type AssistantTurnObservationV1,
} from '../browser/chatgptDomAdapter.js';

export type ContentActionV1='STAGE_PROMPT'|'SEND_PREFLIGHT'|'SEND_CLICK'|'CAPTURE_START'|'CAPTURE_STOP'|'CAPTURE_SCAN';

export interface ContentRequestV1{
  schema:'RBRIDGE_CONTENT_REQUEST_V1';
  requestId:string;
  action:ContentActionV1;
  text?:string;
  captureToken?:string;
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
function fail(code:string):never{throw new Error(code);}
function parse(input:unknown):ContentRequestV1{
  if(input===null||typeof input!=='object'||Array.isArray(input))fail('RBRIDGE_CONTENT_REQUEST_INVALID');
  const row=input as Record<string,unknown>,action=row.action;
  const allowed=new Set(['schema','requestId','action','text','captureToken']);
  if(Object.keys(row).some(key=>!allowed.has(key))||row.schema!=='RBRIDGE_CONTENT_REQUEST_V1'||typeof row.requestId!=='string'||!REQUEST.test(row.requestId))fail('RBRIDGE_CONTENT_REQUEST_INVALID');
  if(action!=='STAGE_PROMPT'&&action!=='SEND_PREFLIGHT'&&action!=='SEND_CLICK'&&action!=='CAPTURE_START'&&action!=='CAPTURE_STOP'&&action!=='CAPTURE_SCAN')fail('RBRIDGE_CONTENT_ACTION_INVALID');
  if(action==='STAGE_PROMPT'&&typeof row.text!=='string')fail('RBRIDGE_CONTENT_PROMPT_REQUIRED');
  if(action==='CAPTURE_START'&&(typeof row.captureToken!=='string'||!REQUEST.test(row.captureToken)))fail('RBRIDGE_CONTENT_CAPTURE_TOKEN_INVALID');
  const exact=action==='STAGE_PROMPT'?['schema','requestId','action','text']:
    action==='CAPTURE_START'?['schema','requestId','action','captureToken']:['schema','requestId','action'];
  if(Object.keys(row).length!==exact.length||Object.keys(row).some(key=>!exact.includes(key)))fail('RBRIDGE_CONTENT_REQUEST_FIELDS_INVALID');
  return {
    schema:'RBRIDGE_CONTENT_REQUEST_V1',requestId:row.requestId,action,
    ...(action==='STAGE_PROMPT'?{text:row.text as string}:{}),
    ...(action==='CAPTURE_START'?{captureToken:row.captureToken as string}:{}),
  };
}

export class ChatgptContentRuntimeV1{
  private stopCapture:(()=>void)|null=null;
  private captureToken:string|null=null;

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
        const result=clickHighConfidenceSendButton(this.document);
        return {requestId:request.requestId,action:request.action,status:result.status,evidence:result.evidence,clicked:true};
      }
      case 'CAPTURE_SCAN':
        return {requestId:request.requestId,action:request.action,turns:scanAssistantTurns(this.document)};
      case 'CAPTURE_START':
        if(this.stopCapture)fail('RBRIDGE_CAPTURE_ALREADY_ACTIVE');
        this.captureToken=request.captureToken!;
        this.stopCapture=startAssistantTurnObserver(this.document,turns=>{void this.emit(turns);});
        return {requestId:request.requestId,action:request.action,status:'ACTIVE'};
      case 'CAPTURE_STOP':
        this.stopCapture?.();this.stopCapture=null;this.captureToken=null;
        return {requestId:request.requestId,action:request.action,status:'OFF'};
    }
  }

  stop():void{
    this.stopCapture?.();this.stopCapture=null;this.captureToken=null;
  }

  private async emit(turns:AssistantTurnObservationV1[]):Promise<void>{
    const token=this.captureToken;if(!token)return;
    try{await this.emitter.emit({schema:'RBRIDGE_CONTENT_CAPTURE_V1',captureToken:token,turns});}catch{}
  }
}
