import {parseStrictJson} from './strictJson.js';
/** Raw protocol bytes stay separate from parsed producer JSON number semantics. */
export function parseRBridgeCarrierJson(raw:Uint8Array,limit:number):unknown{
  if(!(raw instanceof Uint8Array)||!Number.isSafeInteger(limit)||limit<1||limit>67108864||raw.byteLength>limit)throw new Error('CARRIER_JSON_LIMIT');
  try{return parseStrictJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw),{depth:64});}
  catch{throw new Error('CARRIER_JSON_INVALID');}
}
