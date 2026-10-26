import {startProvisionedExtensionServiceWorkerV3,type ProvisionedV3WorkerChromeApi} from './serviceWorkerStartupV3.js';

declare const __RBRIDGE_RELEASE_SHA__:string;
declare const __RBRIDGE_V3_STARTUP_CONFIG_SHA256__:string;
declare const chrome:ProvisionedV3WorkerChromeApi|undefined;

if(typeof chrome!=='undefined'){
  void startProvisionedExtensionServiceWorkerV3(chrome,__RBRIDGE_RELEASE_SHA__,__RBRIDGE_V3_STARTUP_CONFIG_SHA256__).catch(error=>{
    const message=error instanceof Error?error.message:'';
    console.error('RBRIDGE_V3_STARTUP='+(/^[A-Z][A-Z0-9_:-]{0,127}$/.test(message)?message:'RBRIDGE_V3_STARTUP_BLOCKED'));
  });
}
