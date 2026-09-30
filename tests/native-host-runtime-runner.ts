import {verifyNativeHostRuntimeFlow} from './native-host-runtime-case.js';

try{
  await verifyNativeHostRuntimeFlow();
  console.log('PASS Native Host runtime preserves HELLO-first durable replay ordering');
}catch(error){
  console.error('FAIL Native Host runtime preserves HELLO-first durable replay ordering: '+(error instanceof Error?error.stack:String(error)));
  process.exitCode=1;
}
