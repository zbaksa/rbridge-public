import { join } from 'node:path';
import { createFlowPilotBridgeGateway } from './flowPilotBridgeGateway.js';
import { createFlowPilotBridgeIngress } from './flowPilotBridgeIngress.js';
import { createFlowPilotBridgeStore } from './flowPilotBridgeStore.js';
import { createFlowPilotCallbackClient, validateFlowPilotCallbackUrl } from './flowPilotCallbackClient.js';

interface ControllerPort {
  submit(app: string, job: string, payload: unknown): Promise<Record<string, unknown>>;
  status(app: string, job: string): Promise<Record<string, unknown>>;
  result(app: string, job: string): Promise<Record<string, unknown>>;
}

export interface FlowPilotBridgeRuntimeOptions {
  root: string;
  controller: ControllerPort;
  env: Record<string, string | undefined>;
  host?: string;
  port?: number;
}

function secret(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length < 32 || /\s/.test(value)) {
    throw new Error('FLOWPILOT_INGRESS_SECRET_MISSING');
  }
  return value;
}

function loopbackHost(value: string): string {
  if (!['127.0.0.1', '::1'].includes(value)) {
    throw new Error('FLOWPILOT_INGRESS_HOST_INVALID');
  }
  return value;
}

function ingressPort(value: number, allowEphemeral: boolean): number {
  if (!Number.isInteger(value) || value < (allowEphemeral ? 0 : 1) || value > 65_535) {
    throw new Error('FLOWPILOT_INGRESS_PORT_INVALID');
  }
  return value;
}

export function createFlowPilotBridgeRuntime(options: FlowPilotBridgeRuntimeOptions) {
  if (options.env.COCWIN_FLOWPILOT_INGRESS_ENABLED !== 'true') return undefined;

  const remoteBridgeToken = secret(options.env, 'FLOWPILOT_REMOTE_BRIDGE_TOKEN');
  const callbackToken = secret(options.env, 'FLOWPILOT_CALLBACK_TOKEN');
  if (remoteBridgeToken === callbackToken) throw new Error('FLOWPILOT_INGRESS_SECRETS_MUST_DIFFER');

  const callbackUrl = validateFlowPilotCallbackUrl(options.env.COCWIN_FLOWPILOT_CALLBACK_URL
    ?? 'http://127.0.0.1:8097/api/v1/executor/callback');
  const host = loopbackHost(options.host ?? options.env.COCWIN_FLOWPILOT_INGRESS_HOST ?? '127.0.0.1');
  const configuredPort = options.port
    ?? (options.env.COCWIN_FLOWPILOT_INGRESS_PORT === undefined
      ? 8098
      : Number(options.env.COCWIN_FLOWPILOT_INGRESS_PORT));
  const port = ingressPort(configuredPort, options.port === 0);
  const store = createFlowPilotBridgeStore(join(options.root, 'flowpilot'));
  const callback = createFlowPilotCallbackClient();
  const cocwinPolicyUrl = options.env.RBRIDGE_COCWIN_POLICY_URL;
  const gateway = createFlowPilotBridgeGateway({
    store,
    controller: options.controller,
    callback,
    callbackToken,
    ...(cocwinPolicyUrl === undefined ? {} : { cocwinPolicyUrl }),
  });
  const server = createFlowPilotBridgeIngress({
    remoteBridgeToken,
    callbackToken,
    callbackUrl,
    maxBodyBytes: 64 * 1024,
    gateway,
  });
  let listening = false;

  return {
    async start(): Promise<{ host: string; port: number }> {
      if (!listening) {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, host);
        });
        listening = true;
      }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('FLOWPILOT_INGRESS_ADDRESS_INVALID');
      return { host, port: address.port };
    },

    async reconcile(): Promise<{ pending: number; completed: number }> {
      return gateway.reconcile();
    },

    async stop(): Promise<void> {
      if (!listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => error ? reject(error) : resolve());
      });
      listening = false;
    },
  };
}
