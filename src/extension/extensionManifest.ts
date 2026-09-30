export const RBRIDGE_EXTENSION_PUBLIC_KEY_B64='MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAy0OvK91SLE1iT6ecfyC/aTSPlc5CnJfuT695XVpmh0/+OU8UhVXntomf+cUdi6kITbl3KJCaygY1HfPraQSp1rRnn7RXZnUR5f2dBnU3BRmMnxZfKDwvvcs8vBZFYfCAbSftyXTMmgK0BmEyGOpQUhKG1qY8nivgTrbhu8HEeKFUCJYe0P0wu1pVr7ehtmkqaLdFfCo53Y61Bm3Q+MzD0TnWEyHZo+lhRIew3732/hli0AAeEWeSbxbSMHtA8+F+wxyGIgad68gQA2fTX6+QEHV3lba5bTegNrIWKsw1Ol4g3xliHHhhb0vNNziVLxT4JSRrx4Lzi4kG3zoG/16bbwIDAQAB';
export const RBRIDGE_EXTENSION_ID='ebibbijpegoankenmggdnehpoadcophk';

export interface RbridgeExtensionManifestV1{
  manifest_version:3;
  name:'COCWIN RBridge Chat';
  short_name:'RBridge Chat';
  version:string;
  description:'COCWIN RBridge browser authority adapter';
  key:string;
  background:{service_worker:'serviceWorker.js';type:'module'};
  permissions:['tabs','scripting','storage','nativeMessaging'];
  host_permissions:string[];
}

const VERSION=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function buildRbridgeExtensionManifest(version:string):RbridgeExtensionManifestV1{
  if(typeof version!=='string'||!VERSION.test(version))throw new Error('RBRIDGE_EXTENSION_VERSION_INVALID');
  return {
    manifest_version:3,
    name:'COCWIN RBridge Chat',
    short_name:'RBridge Chat',
    version,
    description:'COCWIN RBridge browser authority adapter',
    key:RBRIDGE_EXTENSION_PUBLIC_KEY_B64,
    background:{service_worker:'serviceWorker.js',type:'module'},
    permissions:['tabs','scripting','storage','nativeMessaging'],
    host_permissions:[
      'https://chatgpt.com/*',
      'https://www.chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://www.chat.openai.com/*',
    ],
  };
}
