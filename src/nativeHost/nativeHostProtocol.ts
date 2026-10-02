import {parseHello,validateEventEnvelope,type RbridgeChatEventV1,type RbridgeChatHelloV1} from '../domain/rbridgeChatCore.js';
import {
  parseRbridgeChatCommandResultV1,parseRbridgeChatCommandV1,
  type RbridgeChatCommandResultV1,type RbridgeChatCommandV1,
} from '../domain/rbridgeChatCommand.js';
import {parseEffectCommand,type RbridgeChatEffectCommandV1} from '../domain/rbridgeEffectProtocol.js';

export type BrowserToNativeMessageV1=
  | {kind:'HELLO';value:RbridgeChatHelloV1}
  | {kind:'EVENT';value:RbridgeChatEventV1}
  | {kind:'COMMAND_RESULT';value:RbridgeChatCommandResultV1};

export type ServerToNativeMessageV1=
  | {kind:'HELLO';value:RbridgeChatHelloV1}
  | {kind:'COMMAND';value:RbridgeChatCommandV1};
export type ServerToNativeMessageV3=ServerToNativeMessageV1|{kind:'EFFECT_COMMAND';value:RbridgeChatEffectCommandV1};

export function snapshotNativeMessage(input:unknown,maxBytes:number):unknown{
  const visit=(value:unknown,depth:number):void=>{
    if(depth>32)throw Error('RBRIDGE_NATIVE_INPUT_INVALID');
    if(value===null||['string','boolean'].includes(typeof value))return;
    if(typeof value==='number'&&Number.isFinite(value))return;
    if(!value||typeof value!=='object')throw Error('RBRIDGE_NATIVE_INPUT_INVALID');
    const proto=Object.getPrototypeOf(value);
    if(proto!==Object.prototype&&proto!==null&&proto!==Array.prototype)throw Error('RBRIDGE_NATIVE_INPUT_INVALID');
    for(const key of Reflect.ownKeys(value)){
      const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=='string'||!('value' in descriptor))throw Error('RBRIDGE_NATIVE_INPUT_INVALID');
      visit(descriptor.value,depth+1);
    }
  };
  visit(input,0);const copy:unknown=structuredClone(input);
  if(new TextEncoder().encode(JSON.stringify(copy)).length>maxBytes)throw Error('OUTPUT_BUDGET_EXCEEDED');
  return copy;
}

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

/** Async V3 validation is separate from the frozen synchronous V1 parser. */
export async function routeServerToNativeV3(input:unknown,maxBytes:number):Promise<ServerToNativeMessageV3>{
  if(schemaOf(input)==='RBRIDGE_CHAT_EFFECT_COMMAND_V1')return {kind:'EFFECT_COMMAND',value:await parseEffectCommand(input,maxBytes)};
  return routeServerToNative(input);
}
