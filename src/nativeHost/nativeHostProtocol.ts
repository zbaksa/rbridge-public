import {parseHello,validateEventEnvelope,type RbridgeChatEventV1,type RbridgeChatHelloV1} from '../domain/rbridgeChatCore.js';

export type BrowserToNativeMessageV1=
  | {kind:'HELLO';value:RbridgeChatHelloV1}
  | {kind:'EVENT';value:RbridgeChatEventV1};

export type ServerToNativeMessageV1=
  | {kind:'HELLO';value:RbridgeChatHelloV1};

function schemaOf(input:unknown):string{
  if(input===null||typeof input!=='object'||Array.isArray(input))return '';
  const schema=(input as Record<string,unknown>).schema;
  return typeof schema==='string'?schema:'';
}

export async function routeBrowserToNative(input:unknown):Promise<BrowserToNativeMessageV1>{
  const schema=schemaOf(input);
  if(schema==='RBRIDGE_CHAT_HELLO_V1')return {kind:'HELLO',value:parseHello(input)};
  if(schema==='RBRIDGE_CHAT_EVENT_V1')return {kind:'EVENT',value:await validateEventEnvelope(input)};
  throw new Error('RBRIDGE_NATIVE_MESSAGE_SCHEMA_DENIED');
}

export function routeServerToNative(input:unknown):ServerToNativeMessageV1{
  const schema=schemaOf(input);
  if(schema==='RBRIDGE_CHAT_HELLO_V1')return {kind:'HELLO',value:parseHello(input)};
  throw new Error('RBRIDGE_COMMAND_CONTRACT_UNAVAILABLE');
}
