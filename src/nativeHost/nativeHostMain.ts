import {NativeHostRuntimeV1,type NativeHostRuntimeDependenciesV1} from './nativeHostRuntime.js';
import {loadNativeHostConfigV1} from './nativeHostConfig.js';

export interface NativeHostMainIoV1{
  onData(listener:(chunk:Uint8Array)=>void):void;
  onEnd(listener:()=>void):void;
  onError(listener:(error:Error)=>void):void;
  writeStdout(data:Uint8Array):void;
  writeStderr(text:string):void;
  setExitCode(code:number):void;
}
export interface NativeHostMainEnvironmentV1{
  RBRIDGE_NATIVE_HOST_CONFIG?:string;
}
function error(value:unknown):Error{return value instanceof Error?value:new Error(String(value));}
function codeOf(value:unknown):string{
  const message=error(value).message;
  return /^[A-Z][A-Z0-9_:-]{0,127}$/u.test(message)?message:'RBRIDGE_NATIVE_HOST_FATAL';
}
export async function startNativeHostMainV1(
  invocationArgs:readonly string[],
  environment:NativeHostMainEnvironmentV1,
  io:NativeHostMainIoV1,
  dependencies:NativeHostRuntimeDependenciesV1={},
):Promise<NativeHostRuntimeV1>{
  const configPath=environment.RBRIDGE_NATIVE_HOST_CONFIG;
  if(typeof configPath!=='string'||configPath.length===0)throw new Error('RBRIDGE_NATIVE_CONFIG_ENV_REQUIRED');
  const config=await loadNativeHostConfigV1(configPath);
  let fatal=false;
  const runtime=new NativeHostRuntimeV1(
    config,
    {write:data=>io.writeStdout(data)},
    {
      onTransportError:cause=>{io.writeStderr('RBRIDGE_NATIVE_TRANSPORT='+codeOf(cause)+'\n');},
      onProtocolError:cause=>{io.writeStderr('RBRIDGE_NATIVE_PROTOCOL='+codeOf(cause)+'\n');},
    },
    dependencies,
  );
  const failFatal=(cause:unknown)=>{
    if(fatal)return;
    fatal=true;runtime.stop();
    io.writeStderr('RBRIDGE_NATIVE_FATAL='+codeOf(cause)+'\n');
    io.setExitCode(70);
  };
  io.onData(chunk=>{if(!fatal)void runtime.acceptNativeChunk(chunk).catch(failFatal);});
  io.onEnd(()=>{if(!fatal)runtime.stop();});
  io.onError(failFatal);
  try{runtime.start(invocationArgs);}catch(cause){failFatal(cause);throw cause;}
  return runtime;
}
