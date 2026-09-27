import {createAppExecutionClient} from './appExecutionClient.js';

export const REMOTE_BRIDGE_CONTROLLER_SOCKET='/run/ai-tool-fabric/controller-broker.sock';

export interface RemoteBridgeControllerClient {
  submit(app:string,job:string,payload:unknown):Promise<Record<string,unknown>>;
  status(app:string,job:string):Promise<Record<string,unknown>>;
  result(app:string,job:string):Promise<Record<string,unknown>>;
}
export type RemoteBridgeControllerClientFactory=(options:{socketPath:string;timeoutMs?:number})=>RemoteBridgeControllerClient;
export interface ControllerExecRemoteBridgeOptions {
  client?:RemoteBridgeControllerClient;
  clientFactory?:RemoteBridgeControllerClientFactory;
  socketPath?:string;
  timeoutMs?:number;
}

const APP_RE=/^[a-z][a-z0-9_-]{0,31}$/;
const JOB_RE=/^[a-z0-9][a-z0-9._-]{0,63}$/;
function fail(code:string):never{throw new Error(code);}
function identity(app:string,job:string):void{
  if(!APP_RE.test(app))fail('CONTROLLER_EXEC_APP_INVALID');
  if(!JOB_RE.test(job))fail('CONTROLLER_EXEC_JOB_INVALID');
}
function errorMessage(error:unknown):string{
  return error instanceof Error&&error.message?error.message:'UNKNOWN';
}
function definitiveBlocked(error:unknown,app:string,job:string):Record<string,unknown>{
  const raw=errorMessage(error),prefix='APP_EXECUTION_BROKER_REJECTED:';
  if(!raw.startsWith(prefix))throw new Error(`CONTROLLER_EXEC_TRANSPORT_FAILED:${raw}`);
  const reason=raw.slice(prefix.length).replace(/\s+/g,' ').trim().slice(0,256)||'BROKER_REJECTED';
  return {schema:'COCWIN_APP_EXECUTION_STATUS_V1',app,job,state:'BLOCKED',reason};
}

export function createControllerExecRemoteBridge(options:ControllerExecRemoteBridgeOptions={}){
  const socketPath=options.socketPath??REMOTE_BRIDGE_CONTROLLER_SOCKET;
  const factory=options.clientFactory??((config:{socketPath:string;timeoutMs?:number})=>createAppExecutionClient(config));
  const config=options.timeoutMs===undefined?{socketPath}:{socketPath,timeoutMs:options.timeoutMs};
  const client=options.client??factory(config);

  async function call(app:string,job:string,action:'app-submit'|'app-status'|'app-result',payload?:unknown){
    identity(app,job);
    try{
      if(action==='app-submit')return await client.submit(app,job,payload);
      if(action==='app-status')return await client.status(app,job);
      return await client.result(app,job);
    }catch(error){
      return definitiveBlocked(error,app,job);
    }
  }

  return {
    submit:async(app:string,job:string,payload:unknown)=>await call(app,job,'app-submit',payload),
    status:async(app:string,job:string)=>await call(app,job,'app-status'),
    result:async(app:string,job:string)=>await call(app,job,'app-result'),
  };
}
