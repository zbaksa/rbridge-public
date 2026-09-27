import {describe,expect,it,vi} from 'vitest';
import {
  REMOTE_BRIDGE_CONTROLLER_SOCKET,
  createControllerExecRemoteBridge,
  type RemoteBridgeControllerClient,
  type RemoteBridgeControllerClientFactory,
} from '../../src/adapters/controllerExecRemoteBridge.js';

const payload={tool:'probe',cwd:'/home/bai/backend',args:[],timeout_ms:30000,max_bytes:262144};
const queued={schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'bridge-probe-1',state:'QUEUED'};
const running={schema:'COCWIN_APP_EXECUTION_STATUS_V1',app:'bai',job:'bridge-probe-1',state:'RUNNING'};
const succeeded={schema:'COCWIN_APP_EXECUTION_RESULT_V1',app:'bai',job:'bridge-probe-1',state:'SUCCEEDED',returncode:0,stdout:'ok\n',stderr:'',timed_out:false,truncated:false};

function fakeClient(){
  const submit=vi.fn<RemoteBridgeControllerClient['submit']>(async()=>queued);
  const status=vi.fn<RemoteBridgeControllerClient['status']>(async()=>running);
  const result=vi.fn<RemoteBridgeControllerClient['result']>(async()=>succeeded);
  return {client:{submit,status,result} satisfies RemoteBridgeControllerClient,submit,status,result};
}

describe('controller-exec remote bridge adapter',()=>{
  it('binds Stage2 app execution to the global controller bridge socket',async()=>{
    const c=fakeClient();
    const factory=vi.fn<RemoteBridgeControllerClientFactory>(()=>c.client);
    const bridge=createControllerExecRemoteBridge({clientFactory:factory});
    expect(REMOTE_BRIDGE_CONTROLLER_SOCKET).toBe('/run/ai-tool-fabric/controller-broker.sock');
    expect(REMOTE_BRIDGE_CONTROLLER_SOCKET).not.toBe('/run/ai-tool-fabric/cocwin-control-broker.sock');
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({socketPath:REMOTE_BRIDGE_CONTROLLER_SOCKET});
    await expect(bridge.submit('bai','bridge-probe-1',payload)).resolves.toMatchObject({state:'QUEUED'});
  });

  it('delegates exact submit status and result identities without shell or CLI routing',async()=>{
    const c=fakeClient(),bridge=createControllerExecRemoteBridge({client:c.client});
    await expect(bridge.submit('bai','bridge-probe-1',payload)).resolves.toEqual(queued);
    await expect(bridge.status('bai','bridge-probe-1')).resolves.toEqual(running);
    await expect(bridge.result('bai','bridge-probe-1')).resolves.toEqual(succeeded);
    expect(c.submit).toHaveBeenCalledWith('bai','bridge-probe-1',payload);
    expect(c.status).toHaveBeenCalledWith('bai','bridge-probe-1');
    expect(c.result).toHaveBeenCalledWith('bai','bridge-probe-1');
  });

  it('surfaces a definitive broker rejection as an identity-bound BLOCKED state',async()=>{
    const c=fakeClient();
    c.submit.mockRejectedValueOnce(new Error('APP_EXECUTION_BROKER_REJECTED:CONTROLLER_PEER_NOT_AUTHORIZED'));
    const bridge=createControllerExecRemoteBridge({client:c.client});
    await expect(bridge.submit('bai','bridge-probe-1',payload)).resolves.toEqual({
      schema:'COCWIN_APP_EXECUTION_STATUS_V1',
      app:'bai',
      job:'bridge-probe-1',
      state:'BLOCKED',
      reason:'CONTROLLER_PEER_NOT_AUTHORIZED',
    });
  });

  it('keeps transport and protocol failures non-definitive',async()=>{
    const c=fakeClient();
    c.status.mockRejectedValueOnce(new Error('ECONNRESET'));
    const bridge=createControllerExecRemoteBridge({client:c.client});
    await expect(bridge.status('bai','bridge-probe-1')).rejects.toThrow('CONTROLLER_EXEC_TRANSPORT_FAILED:ECONNRESET');
  });

  it('passes an explicit bounded timeout to the bridge socket client factory',()=>{
    const c=fakeClient();
    const factory=vi.fn<RemoteBridgeControllerClientFactory>(()=>c.client);
    createControllerExecRemoteBridge({clientFactory:factory,timeoutMs:12345});
    expect(factory).toHaveBeenCalledWith({socketPath:REMOTE_BRIDGE_CONTROLLER_SOCKET,timeoutMs:12345});
  });

  it('rejects unsafe app and job identifiers before invoking the client',async()=>{
    const c=fakeClient(),bridge=createControllerExecRemoteBridge({client:c.client});
    await expect(bridge.status('Bad App','bridge-probe-1')).rejects.toThrow('CONTROLLER_EXEC_APP_INVALID');
    await expect(bridge.status('bai','Bad Job')).rejects.toThrow('CONTROLLER_EXEC_JOB_INVALID');
    expect(c.submit).not.toHaveBeenCalled();
    expect(c.status).not.toHaveBeenCalled();
    expect(c.result).not.toHaveBeenCalled();
  });
});
