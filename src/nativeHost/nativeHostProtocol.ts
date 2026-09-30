import {parseHello,validateEventEnvelope,type RbridgeChatEventV1,type RbridgeChatHelloV1} from '../domain/rbridgeChatCore.js';
import {
  parseRbridgeChatCommandResultV1,parseRbridgeChatCommandV1,
  type RbridgeChatCommandResultV1,type RbridgeChatCommandV1,
} from '../domain/rbridgeChatCommand.js';

export type BrowserToNativeMessageV1=
  | {kind:'HELLO';value:RbridgeChatHelloV1}
  | {kind:'EVENT';value:RbridgeChatEventV1}
  | {kind:'COMMAND_RESULT';value:RbridgeChatCommandResultV1};

export type ServerToNativeMessageV1=
  | {kind:'HELLO';value:RbridgeChatHelloV1}
  | {kind:'COMMAND';value:RbridgeChatCommandV1};

function schemaOf(input:unknown):string{
  if(input===null||typeof input!=='object'||Array.isArray(input))return '';
  const schema=(input as Record<string,unknown>).schema;
  return typeof schema==='string'?schema:'';
}

export async function routeBrowserToNative(input:unknown):Promise<BrowserToNativeMessageV1>{
  const schema=schemaOf(input);
  if(schema==='RBRIDGE_CHAT_HELLO_V1')return {kind:'HELLO',value:parseHello(input)};
  if(schema==='RBRIDGE_CHAT_EVENT_V1')return {kind:'EVENT',value:await validateEventEnvelope(input)};
  if(schema==='RBRIDGE_CHAT_COMMAND_RESULT_V1')return {kind:'COMMAND_RESULT',value:parseRbridgeChatCommandResultV1(input)};
  throw new Error('RBRIDGE_NATIVE_MESSAGE_SCHEMA_DENIED');
}

export function routeServerToNative(input:unknown):ServerToNativeMessageV1{
  const schema=schemaOf(input);
  if(schema==='RBRIDGE_CHAT_HELLO_V1')return {kind:'HELLO',value:parseHello(input)};
  if(schema==='RBRIDGE_CHAT_COMMAND_V1')return {kind:'COMMAND',value:parseRbridgeChatCommandV1(input)};
  throw new Error('RBRIDGE_COMMAND_SCHEMA_DENIED');
}
