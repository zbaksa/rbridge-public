import {M0_LIMITS,canonicalJson} from '../domain/rbridgeChatCore.js';

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
function fail(code:string):never{throw new Error(code);}

export function assertApprovedExtensionOrigin(origin:string,expectedExtensionId:string):void{
  if(typeof expectedExtensionId!=='string'||!/^[a-p]{32}$/.test(expectedExtensionId))fail('RBRIDGE_EXTENSION_ID_INVALID');
  if(origin!=='chrome-extension://'+expectedExtensionId+'/')fail('RBRIDGE_NATIVE_ORIGIN_DENIED');
}

export function encodeNativeMessage(value:unknown,maxBytes=M0_LIMITS.maxRbridgeControlMessageUtf8Bytes):Uint8Array{
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>M0_LIMITS.maxRbridgeControlMessageUtf8Bytes)fail('RBRIDGE_NATIVE_LIMIT_INVALID');
  const body=encoder.encode(canonicalJson(value));
  if(body.byteLength===0||body.byteLength>maxBytes)fail('RBRIDGE_NATIVE_MESSAGE_TOO_LARGE');
  const out=new Uint8Array(4+body.byteLength),view=new DataView(out.buffer);
  view.setUint32(0,body.byteLength,true);out.set(body,4);return out;
}

export class NativeMessageDecoder{
  private buffer=new Uint8Array(0);
  constructor(private readonly maxBytes=M0_LIMITS.maxRbridgeControlMessageUtf8Bytes){
    if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>M0_LIMITS.maxRbridgeControlMessageUtf8Bytes)fail('RBRIDGE_NATIVE_LIMIT_INVALID');
  }
  push(chunk:Uint8Array):unknown[]{
    if(!(chunk instanceof Uint8Array))fail('RBRIDGE_NATIVE_CHUNK_INVALID');
    const merged=new Uint8Array(this.buffer.byteLength+chunk.byteLength);merged.set(this.buffer);merged.set(chunk,this.buffer.byteLength);this.buffer=merged;
    const out:unknown[]=[];
    while(this.buffer.byteLength>=4){
      const size=new DataView(this.buffer.buffer,this.buffer.byteOffset,this.buffer.byteLength).getUint32(0,true);
      if(size===0||size>this.maxBytes)fail('RBRIDGE_NATIVE_MESSAGE_TOO_LARGE');
      if(this.buffer.byteLength<4+size)break;
      const body=this.buffer.slice(4,4+size);let parsed:unknown;
      try{parsed=JSON.parse(decoder.decode(body));}catch{fail('RBRIDGE_NATIVE_MESSAGE_INVALID');}
      out.push(parsed);this.buffer=this.buffer.slice(4+size);
    }
    if(this.buffer.byteLength>this.maxBytes+4)fail('RBRIDGE_NATIVE_MESSAGE_TOO_LARGE');
    return out;
  }
  pendingBytes():number{return this.buffer.byteLength;}
}
