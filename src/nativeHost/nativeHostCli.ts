import {dirname,join} from 'node:path';
import {startNativeHostMainV1,type NativeHostMainIoV1} from './nativeHostMain.js';

function codeOf(value:unknown):string{
  const message=value instanceof Error?value.message:String(value);
  return /^[A-Z][A-Z0-9_:-]{0,127}$/u.test(message)?message:'RBRIDGE_NATIVE_HOST_BOOTSTRAP_FATAL';
}

const configured=(process.env.RBRIDGE_NATIVE_HOST_CONFIG??'').trim();
const configPath=configured||join(dirname(process.execPath),'rbridge-native-host.config.json');

const io:NativeHostMainIoV1={
  onData(listener){process.stdin.on('data',(chunk:Buffer)=>listener(new Uint8Array(chunk.buffer,chunk.byteOffset,chunk.byteLength)));},
  onEnd(listener){process.stdin.on('end',listener);},
  onError(listener){process.stdin.on('error',listener);},
  writeStdout(data){process.stdout.write(Buffer.from(data));},
  writeStderr(text){process.stderr.write(text);},
  setExitCode(code){process.exitCode=code;},
};

void startNativeHostMainV1(
  process.argv.slice(2),
  {RBRIDGE_NATIVE_HOST_CONFIG:configPath},
  io,
).catch(error=>{
  if(process.exitCode===undefined||process.exitCode===0){
    process.stderr.write('RBRIDGE_NATIVE_BOOTSTRAP='+codeOf(error)+'\n');
    process.exitCode=70;
  }
});
