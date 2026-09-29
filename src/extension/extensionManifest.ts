export interface RbridgeExtensionManifestV1{
  manifest_version:3;
  name:'COCWIN RBridge Chat';
  short_name:'RBridge Chat';
  version:string;
  description:'COCWIN RBridge browser authority adapter';
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
