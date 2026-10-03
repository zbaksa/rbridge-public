export interface FlowPilotCallbackClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function validateFlowPilotCallbackUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('FLOWPILOT_CALLBACK_URL_INVALID'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/api/v1/executor/callback' || url.search || url.hash) throw new Error('FLOWPILOT_CALLBACK_URL_INVALID');
  return url.toString();
}

export function createFlowPilotCallbackClient(options: FlowPilotCallbackClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error('FLOWPILOT_CALLBACK_TIMEOUT_INVALID');
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async send(urlValue: string, token: string, callback: Record<string, unknown>): Promise<void> {
      const url = validateFlowPilotCallbackUrl(urlValue);
      if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw new Error('FLOWPILOT_CALLBACK_TOKEN_INVALID');
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(callback),
        });
        if (!response.ok) throw new Error(`FLOWPILOT_CALLBACK_REJECTED:${response.status}`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('FLOWPILOT_CALLBACK_REJECTED:')) throw error;
        throw new Error('FLOWPILOT_CALLBACK_UNAVAILABLE');
      } finally { clearTimeout(timer); }
    },
  };
}
