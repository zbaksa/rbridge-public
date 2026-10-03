export interface FlowPilotBridgeTickOptions<T> {
  runPrimary: () => Promise<T>;
  reconcile?: () => Promise<unknown>;
  log: (value: Record<string, unknown>) => void;
  now?: () => Date;
}

function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return 'FLOWPILOT_BRIDGE_RECONCILE_FAILED';
  const code = error.message.split('\n')[0]?.trim() ?? '';
  return (/^FLOWPILOT_[A-Z0-9_]{1,100}$/.test(code) || /^FLOWPILOT_CALLBACK_REJECTED:[1-5][0-9]{2}$/.test(code))
    ? code
    : 'FLOWPILOT_BRIDGE_RECONCILE_FAILED';
}

export async function runFlowPilotBridgeTick<T>(options: FlowPilotBridgeTickOptions<T>): Promise<T> {
  const auxiliary = options.reconcile
    ? Promise.resolve().then(options.reconcile)
    : Promise.resolve();
  const [primaryResult, auxiliaryResult] = await Promise.allSettled([
    Promise.resolve().then(options.runPrimary),
    auxiliary,
  ]);
  if (auxiliaryResult.status === 'rejected') {
    options.log({
      schema: 'COCWIN_FLOWPILOT_BRIDGE_RECONCILE_V1',
      status: 'ERROR',
      at: (options.now ?? (() => new Date()))().toISOString(),
      reason: safeReason(auxiliaryResult.reason),
    });
  }
  if (primaryResult.status === 'rejected') throw primaryResult.reason;
  return primaryResult.value;
}
