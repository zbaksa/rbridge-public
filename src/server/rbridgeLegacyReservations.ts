import {join} from 'node:path';
import type {RBridgeLegacyClaimGuard,RBridgeOperationSerializer} from './rbridgeOperationSerializer.js';
import {createRBridgeStateFiles} from './rbridgeStateFiles.js';
export interface RBridgeLegacyReservationOptions{requestRoot:string;flowPilotRoot:string;uid:number;}
const legacyId=/^[a-z0-9][a-z0-9._:-]{0,191}$/;
function assertId(id:string){if(typeof id!=='string'||!legacyId.test(id))throw new Error('RBRIDGE_CORE_LEGACY_ID_INVALID');}
export function createRBridgeLegacyReservations(options:RBridgeLegacyReservationOptions){
  const files=createRBridgeStateFiles();
  return Object.freeze({async isReserved(id:string):Promise<boolean>{
    assertId(id);
    const candidates=[...(id.length<=128?[join(options.requestRoot,`${id}.json`)]:[]),join(options.flowPilotRoot,`${id}.json`),join(options.flowPilotRoot,`${id}.done`)];
    for(const path of candidates){
      try{const handle=await files.file(path,options.uid,Number.MAX_SAFE_INTEGER);await handle.close();return true;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    return false;
  }});
}
export function createRBridgeLegacyClaimGuard(options:{serializer:RBridgeOperationSerializer;core:{has(id:string):Promise<boolean>}}):RBridgeLegacyClaimGuard{
  return Object.freeze({async run<T>(id:string,task:()=>Promise<T>):Promise<T>{
    assertId(id);
    return options.serializer.run(id,async()=>{
      // Longer FlowPilot IDs cannot be valid core keys; keep their original engine.
      if(id.length<=128&&await options.core.has(id))throw new Error('RBRIDGE_CORE_LEGACY_ID_RESERVED');
      return task();
    });
  }});
}
