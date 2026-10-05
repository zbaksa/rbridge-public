import {AsyncLocalStorage} from 'node:async_hooks';
export interface RBridgeOperationSerializer{run<T>(id:string,task:()=>Promise<T>):Promise<T>;isHeld(id:string):boolean;}
export interface RBridgeLegacyClaimGuard{run<T>(id:string,task:()=>Promise<T>):Promise<T>;}
export function createRBridgeOperationSerializer():RBridgeOperationSerializer{
  const tails=new Map<string,Promise<void>>(),held=new AsyncLocalStorage<{id:string;active:boolean}>();
  return {
    isHeld(id){const lease=held.getStore();return lease?.active===true&&lease.id===id;},
    async run<T>(id:string,task:()=>Promise<T>):Promise<T>{
      if(held.getStore()?.active===true)throw new Error('RBRIDGE_CORE_SERIALIZER_REENTRANT');
      const before=tails.get(id)??Promise.resolve();let release!:()=>void;const current=new Promise<void>(done=>{release=done;});tails.set(id,current);
      await before;const lease={id,active:true};
      try{return await held.run(lease,task);}finally{lease.active=false;release();if(tails.get(id)===current)tails.delete(id);}
    },
  };
}
