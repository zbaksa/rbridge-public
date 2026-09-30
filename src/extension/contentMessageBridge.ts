import {ChatgptContentRuntimeV1} from './contentRuntime.js';

export interface ContentMessageEventV1{
  addListener(listener:(message:unknown,sender:unknown,sendResponse:(response:unknown)=>void)=>boolean|void):void;
}
export interface ContentMessageRuntimeApiV1{
  onMessage:ContentMessageEventV1;
}
export type ContentReplyV1=
  |{schema:'RBRIDGE_CONTENT_REPLY_V1';requestId:string;ok:true;result:unknown}
  |{schema:'RBRIDGE_CONTENT_REPLY_V1';requestId:string;ok:false;errorCode:string};

function code(error:unknown):string{
  const value=error instanceof Error?error.message:String(error);
  return /^[A-Z][A-Z0-9_:-]{0,127}$/u.test(value)?value:'RBRIDGE_CONTENT_RUNTIME_ERROR';
}
function requestId(input:unknown):string{
  if(input&&typeof input==='object'&&!Array.isArray(input)){
    const value=(input as Record<string,unknown>).requestId;
    if(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value))return value;
  }
  return 'invalid';
}
export function installContentMessageBridgeV1(api:ContentMessageRuntimeApiV1,runtime:ChatgptContentRuntimeV1):void{
  api.onMessage.addListener((message,_sender,sendResponse)=>{
    const id=requestId(message);
    Promise.resolve().then(()=>runtime.handle(message)).then(
      result=>sendResponse({schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:id,ok:true,result} satisfies ContentReplyV1),
      error=>sendResponse({schema:'RBRIDGE_CONTENT_REPLY_V1',requestId:id,ok:false,errorCode:code(error)} satisfies ContentReplyV1),
    );
    return true;
  });
}
