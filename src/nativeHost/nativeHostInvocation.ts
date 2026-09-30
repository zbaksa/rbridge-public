import {assertApprovedExtensionOrigin} from '../transport/nativeMessaging.js';

export interface NativeHostInvocationV1{
  origin:string;
  parentWindow:number|null;
}

export function parseNativeHostInvocation(args:readonly string[],expectedExtensionId:string):NativeHostInvocationV1{
  if(!Array.isArray(args)||args.length<1||args.length>2)throw new Error('RBRIDGE_NATIVE_INVOCATION_ARGS_INVALID');
  const origin=args[0]??'';
  assertApprovedExtensionOrigin(origin,expectedExtensionId);
  let parentWindow:number|null=null;
  if(args.length===2){
    const raw=args[1]??'';
    const match=/^--parent-window=([0-9]+)$/u.exec(raw);
    if(!match)throw new Error('RBRIDGE_NATIVE_PARENT_WINDOW_INVALID');
    const value=Number(match[1]);
    if(!Number.isSafeInteger(value)||value<0)throw new Error('RBRIDGE_NATIVE_PARENT_WINDOW_INVALID');
    parentWindow=value;
  }
  return {origin,parentWindow};
}
