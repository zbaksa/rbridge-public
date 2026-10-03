import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseFlowPilotBridgeEnvelope, type FlowPilotBridgeOperation } from '../domain/flowPilotBridgeProtocol.js';

interface GatewayPort { accept(operation: FlowPilotBridgeOperation): Promise<{ status: 'ACCEPTED'; operationId: string }>; }
export interface FlowPilotBridgeIngressOptions {
  remoteBridgeToken: string;
  callbackToken: string;
  callbackUrl: string;
  maxBodyBytes: number;
  gateway: GatewayPort;
}
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

function tokenEqual(header: unknown, expected: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const left = createHash('sha256').update(header.slice(7)).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}
async function readJson(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new HttpError(415, 'FLOWPILOT_CONTENT_TYPE_INVALID');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length; if (size > maxBodyBytes) throw new HttpError(413, 'FLOWPILOT_BODY_TOO_LARGE');
    chunks.push(data);
  }
  if (size === 0) throw new HttpError(400, 'FLOWPILOT_BODY_EMPTY');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new HttpError(400, 'FLOWPILOT_BODY_JSON_INVALID'); }
}
function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  });
  response.end(body);
}
function classify(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = error instanceof Error ? error.message.split('\n')[0]!.slice(0, 128) : 'FLOWPILOT_INGRESS_UNAVAILABLE';
  if (code === 'FLOWPILOT_OPERATION_COLLISION') return new HttpError(409, code);
  if (code === 'FLOWPILOT_CALLBACK_AUTH_INVALID') return new HttpError(403, code);
  if (['FLOWPILOT_ACTION_NOT_ALLOWED', 'FLOWPILOT_PAYLOAD_NOT_ALLOWED', 'FLOWPILOT_APP_NOT_ALLOWED'].includes(code)) return new HttpError(422, code);
  if (code.startsWith('FLOWPILOT_') && (code.endsWith('_INVALID') || code.endsWith('_FIELDS_INVALID'))) return new HttpError(400, code);
  return new HttpError(503, 'FLOWPILOT_INGRESS_UNAVAILABLE');
}

export function createFlowPilotBridgeIngress(options: FlowPilotBridgeIngressOptions): Server {
  if (!Number.isInteger(options.maxBodyBytes) || options.maxBodyBytes < 4096 || options.maxBodyBytes > 1_048_576) throw new Error('FLOWPILOT_INGRESS_BODY_LIMIT_INVALID');
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/v1/execute' || url.search || url.hash) throw new HttpError(404, 'FLOWPILOT_INGRESS_NOT_FOUND');
      if (String(request.method ?? '').toUpperCase() !== 'POST') throw new HttpError(405, 'FLOWPILOT_INGRESS_METHOD_NOT_ALLOWED');
      if (!tokenEqual(request.headers.authorization, options.remoteBridgeToken)) throw new HttpError(401, 'FLOWPILOT_INGRESS_UNAUTHORIZED');
      const raw = await readJson(request, options.maxBodyBytes);
      const operation = parseFlowPilotBridgeEnvelope(raw, { callbackToken: options.callbackToken, callbackUrl: options.callbackUrl });
      send(response, 202, await options.gateway.accept(operation));
    } catch (error) {
      const failure = classify(error); send(response, failure.status, { error: { code: failure.code } });
    }
  });
}
