import {isAbsolute,resolve} from 'node:path';

export interface NativeHostManifestConfigV1{
  executablePath:string;
  extensionId:string;
}

export interface NativeHostManifestV1{
  name:'com.cocwin.rbridge_chat_v1';
  description:'COCWIN RBridge Chat Native Host V1';
  path:string;
  type:'stdio';
  allowed_origins:[string];
}

const EXTENSION_ID=/^[a-p]{32}$/;
function fail(code:string):never{throw new Error(code);}

export function buildNativeHostManifest(config:NativeHostManifestConfigV1):NativeHostManifestV1{
  if(typeof config.executablePath!=='string'||!isAbsolute(config.executablePath)||resolve(config.executablePath)!==config.executablePath||
    config.executablePath.includes('\0')||/[\r\n]/u.test(config.executablePath))fail('RBRIDGE_NATIVE_HOST_PATH_INVALID');
  if(typeof config.extensionId!=='string'||!EXTENSION_ID.test(config.extensionId))fail('RBRIDGE_EXTENSION_ID_INVALID');
  return {
    name:'com.cocwin.rbridge_chat_v1',
    description:'COCWIN RBridge Chat Native Host V1',
    path:config.executablePath,
    type:'stdio',
    allowed_origins:['chrome-extension://'+config.extensionId+'/'],
  };
}
