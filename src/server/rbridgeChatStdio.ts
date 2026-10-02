import {encodeStdioFrame,StdioFrameDecoder} from '../transport/sshStdio.js';
import type {VerifiedPeerV3} from '../domain/rbridgeEffectProtocol.js';
import type {RbridgeChatPeerStoreV3} from './rbridgeChatPeerStore.js';

/** One fixed authenticated channel. Frames cannot choose an executable, root, host or app owner. */
export async function runRbridgeChatStdio(input:NodeJS.ReadableStream,output:NodeJS.WritableStream,store:RbridgeChatPeerStoreV3):Promise<void>{
  const decoder=new StdioFrameDecoder();let peer:VerifiedPeerV3|null=null,closed=false,ending=false,pollQueued=false,pending=0,lastHeartbeat=0;
  let tail:Promise<void>=Promise.resolve();const writers=new Set<(error:Error)=>void>();
  let resolveEnd:()=>void=()=>undefined,rejectEnd:(error:Error)=>void=()=>undefined;
  const finished=new Promise<void>((resolve,reject)=>{resolveEnd=resolve;rejectEnd=reject;});
  const asError=(error:unknown)=>error instanceof Error?error:Error('RBRIDGE_STDIO_CHANNEL_FAILED');
  const settle=(error?:Error)=>{if(closed)return;closed=true;ending=true;clearInterval(timer);for(const reject of writers)reject(error??Error('RBRIDGE_STDIO_CHANNEL_CLOSED'));if(error)rejectEnd(error);else resolveEnd();};
  const write=async(value:unknown)=>{
    if(closed)throw Error('RBRIDGE_STDIO_CHANNEL_CLOSED');const frame=encodeStdioFrame(value,peer?.maxMessageBytes??65536);
    await new Promise<void>((resolve,reject)=>{
      let done=false;const finish=(error?:Error|null)=>{if(done)return;done=true;clearTimeout(timeout);writers.delete(abort);if(error)reject(error);else resolve();};
      const abort=(error:Error)=>finish(error),timeout=setTimeout(()=>finish(Error('RBRIDGE_STDIO_OUTPUT_TIMEOUT')),5000);writers.add(abort);
      try{output.write(Buffer.from(frame),(error?:Error|null)=>finish(error));}catch(error){finish(asError(error));}
    });
  };
  const queue=(fn:()=>Promise<void>)=>{
    if(closed)return;if(pending>=128){settle(Error('RBRIDGE_STDIO_BACKPRESSURE_EXCEEDED'));return;}pending++;
    tail=tail.then(async()=>{if(!closed)await fn();}).catch(error=>settle(asError(error))).finally(()=>{pending--;});
  };
  const poll=async()=>{
    if(!peer||closed)return;
    if(Date.now()-lastHeartbeat>=1000){await store.heartbeat();lastHeartbeat=Date.now();}
    const command=await store.takeForDispatch();if(command)await write(command);
  };
  const accept=async(message:unknown)=>{
    const schema=(message as {schema?:unknown})?.schema;
    if(!peer){if(schema!=='RBRIDGE_CHAT_HELLO_V1')throw Error('RBRIDGE_PEER_HELLO_REQUIRED');peer=await store.acceptHello(message);lastHeartbeat=Date.now();await write(message);return;}
    if(schema==='RBRIDGE_CHAT_HELLO_V1')throw Error('RBRIDGE_PEER_HELLO_DUPLICATE');
    await store.recordIncoming(message,peer);
  };
  const onData=(data:unknown)=>{
    if(closed||ending)return;
    try{if(!(data instanceof Uint8Array)||data.byteLength>262144)throw Error('RBRIDGE_STDIO_INPUT_BUDGET_EXCEEDED');for(const message of decoder.push(data))queue(()=>accept(message));}catch(error){settle(asError(error));}
  };
  const onEnd=()=>{if(closed||ending)return;ending=true;clearInterval(timer);void tail.then(()=>{if(decoder.pendingBytes())settle(Error('RBRIDGE_STDIO_FRAME_INCOMPLETE'));else settle();});};
  const onClose=()=>{if(!ending)settle(Error('RBRIDGE_STDIO_INPUT_DISCONNECTED'));};
  const onError=(error:unknown)=>settle(asError(error));
  const onOutputClose=()=>settle(Error('RBRIDGE_STDIO_OUTPUT_DISCONNECTED'));
  const timer=setInterval(()=>{if(closed||ending||pollQueued||!peer)return;pollQueued=true;queue(async()=>{try{await poll();}finally{pollQueued=false;}});},100);
  input.on('data',onData);input.once('end',onEnd);input.once('close',onClose);input.on('error',onError);output.on('error',onError);output.once('close',onOutputClose);
  try{await finished;}finally{
    clearInterval(timer);closed=true;await tail;
    input.off('data',onData);input.off('end',onEnd);input.off('close',onClose);input.off('error',onError);output.off('error',onError);output.off('close',onOutputClose);
    await store.disconnect();
  }
}
