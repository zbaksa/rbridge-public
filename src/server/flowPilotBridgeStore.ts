import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { flowPilotAppIdentity, flowPilotOperationDigest, type FlowPilotBridgeOperation } from '../domain/flowPilotBridgeProtocol.js';
import type { FlowPilotBridgePhase, FlowPilotBridgeRecord, FlowPilotBridgeStore } from './flowPilotBridgeGateway.js';

interface PersistedRecord extends FlowPilotBridgeRecord {
  schema: 'COCWIN_FLOWPILOT_BRIDGE_STORE_V1';
  createdAt: string;
  updatedAt: string;
}

interface PersistedTombstone {
  schema: 'COCWIN_FLOWPILOT_BRIDGE_TOMBSTONE_V1';
  operation: FlowPilotBridgeOperation;
  digest: string;
  appId: string;
  jobId: string;
  completedAt: string;
}

export interface FlowPilotBridgeStoreOptions {
  maxPendingRecords?: number;
  pendingBatchSize?: number;
  maxCompletedRecords?: number;
  completedMinRetentionMs?: number;
  completedRetentionMs?: number;
}

const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,191}$/;
const JOB_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const PHASES = new Set<FlowPilotBridgePhase>(['CLAIMED', 'SUBMITTED', 'CALLBACK_PENDING', 'COMPLETED']);
const SECRET_KEY = /(authorization|bearer|token|secret|password|passwd|cookie)/i;
const OPERATION_FIELDS = new Set([
  'schema', 'operationId', 'runId', 'stepId', 'attempt', 'fencingToken',
  'idempotencyKey', 'appId', 'action', 'payload', 'timeoutSeconds', 'callbackUrl',
]);

function fail(code: string): never { throw new Error(code); }
function ownedByRuntime(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}
async function ensureRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const before = await lstat(root);
  if (!before.isDirectory() || before.isSymbolicLink() || !ownedByRuntime(before.uid)) fail('FLOWPILOT_BRIDGE_STORE_ROOT_INVALID');
  await chmod(root, 0o700);
  const after = await lstat(root);
  if (!after.isDirectory() || after.isSymbolicLink() || !ownedByRuntime(after.uid) || (after.mode & 0o777) !== 0o700) fail('FLOWPILOT_BRIDGE_STORE_ROOT_INVALID');
}
function pathFor(root: string, operationId: string): string {
  if (!ID_RE.test(operationId)) fail('FLOWPILOT_BRIDGE_OPERATION_ID_INVALID');
  return join(root, `${operationId}.json`);
}
function tombstonePathFor(root: string, operationId: string): string {
  if (!ID_RE.test(operationId)) fail('FLOWPILOT_BRIDGE_OPERATION_ID_INVALID');
  return join(root, `${operationId}.done`);
}
function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).some(([key, child]) => (key !== 'fencingToken' && SECRET_KEY.test(key)) || containsSecretKey(child));
  return false;
}
function validateOperation(value: unknown): FlowPilotBridgeOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  const operation = value as Record<string, unknown>;
  const keys = Object.keys(operation);
  if (keys.length !== OPERATION_FIELDS.size || keys.some((key) => !OPERATION_FIELDS.has(key))) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  if (operation.schema !== 'FLOWPILOT_REMOTE_BRIDGE_V1'
    || typeof operation.operationId !== 'string' || !ID_RE.test(operation.operationId)
    || typeof operation.runId !== 'string' || !ID_RE.test(operation.runId)
    || typeof operation.stepId !== 'string' || !ID_RE.test(operation.stepId)
    || typeof operation.idempotencyKey !== 'string' || !ID_RE.test(operation.idempotencyKey)
    || !operation.payload || typeof operation.payload !== 'object' || Array.isArray(operation.payload)
    || !Number.isInteger(operation.attempt) || Number(operation.attempt) < 1 || Number(operation.attempt) > 10
    || !Number.isInteger(operation.fencingToken) || Number(operation.fencingToken) < 1 || Number(operation.fencingToken) > Number.MAX_SAFE_INTEGER
    || !Number.isInteger(operation.timeoutSeconds) || Number(operation.timeoutSeconds) < 1 || Number(operation.timeoutSeconds) > 1800
    || typeof operation.callbackUrl !== 'string') fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  const payload = operation.payload as Record<string, unknown>;
  if (operation.appId === 'fpilot' && operation.action === 'APP_PROBE_V1') {
    if (Object.keys(payload).length !== 0) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  } else if (operation.appId === 'cocwin' && operation.action === 'COCWIN_MASTER_POLICY_HEALTH_V1') {
    if (Object.keys(payload).length !== 1 || typeof payload.expectedPolicySha256 !== 'string'
      || !SHA_RE.test(payload.expectedPolicySha256)) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  } else {
    fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  }
  let url: URL;
  try { url = new URL(operation.callbackUrl); } catch { fail('FLOWPILOT_BRIDGE_STORE_CORRUPT'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/api/v1/executor/callback' || url.search || url.hash) {
    fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  }
  return operation as unknown as FlowPilotBridgeOperation;
}
function validateCallback(value: unknown, operation: FlowPilotBridgeOperation): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || containsSecretKey(value)) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  const callback = value as Record<string, unknown>;
  if (callback.schema !== 'FLOWPILOT_CALLBACK_V1' || callback.operationId !== operation.operationId || callback.fencingToken !== operation.fencingToken) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  return callback;
}
function validate(value: unknown): PersistedRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  const row = value as Record<string, unknown>;
  const expected = new Set(['schema', 'operation', 'digest', 'appId', 'jobId', 'phase', 'createdAt', 'updatedAt', ...(row.callback === undefined ? [] : ['callback'])]);
  const keys = Object.keys(row);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) || containsSecretKey(row)) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  if (row.schema !== 'COCWIN_FLOWPILOT_BRIDGE_STORE_V1') fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  const operation = validateOperation(row.operation);
  let app: ReturnType<typeof flowPilotAppIdentity>;
  let digest: string;
  try { app = flowPilotAppIdentity(operation); digest = flowPilotOperationDigest(operation); }
  catch { fail('FLOWPILOT_BRIDGE_STORE_CORRUPT'); }
  if (typeof row.digest !== 'string' || !SHA_RE.test(row.digest) || row.digest !== digest || row.appId !== app.appId || row.jobId !== app.jobId || typeof row.jobId !== 'string' || !JOB_RE.test(row.jobId) || typeof row.phase !== 'string' || !PHASES.has(row.phase as FlowPilotBridgePhase) || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  const callback = validateCallback(row.callback, operation);
  if ((row.phase === 'CALLBACK_PENDING' || row.phase === 'COMPLETED') !== Boolean(callback)) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  return row as unknown as PersistedRecord;
}
function validateTombstone(value: unknown): PersistedTombstone {
  if (!value || typeof value !== 'object' || Array.isArray(value) || containsSecretKey(value)) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  const row = value as Record<string, unknown>;
  const expected = new Set(['schema', 'operation', 'digest', 'appId', 'jobId', 'completedAt']);
  const keys = Object.keys(row);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))
    || row.schema !== 'COCWIN_FLOWPILOT_BRIDGE_TOMBSTONE_V1') fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  const operation = validateOperation(row.operation);
  let app: ReturnType<typeof flowPilotAppIdentity>;
  let digest: string;
  try { app = flowPilotAppIdentity(operation); digest = flowPilotOperationDigest(operation); }
  catch { fail('FLOWPILOT_BRIDGE_STORE_CORRUPT'); }
  if (typeof row.digest !== 'string' || !SHA_RE.test(row.digest) || row.digest !== digest
    || row.appId !== app.appId || row.jobId !== app.jobId || typeof row.jobId !== 'string'
    || !JOB_RE.test(row.jobId) || typeof row.completedAt !== 'string') fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  return row as unknown as PersistedTombstone;
}
async function read(root: string, operationId: string): Promise<PersistedRecord | undefined> {
  const path = pathFor(root, operationId);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  }
  try {
    let info = await handle.stat();
    if (!info.isFile() || !ownedByRuntime(info.uid) || (info.mode & 0o777) !== 0o600) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
    if (info.nlink === 2) {
      const prefix = `${operationId}.json.`;
      const candidates: string[] = [];
      for (const name of await readdir(root)) {
        if (!name.startsWith(prefix) || !name.endsWith('.claim')) continue;
        try {
          const candidate = await lstat(join(root, name));
          if (candidate.isFile() && !candidate.isSymbolicLink() && ownedByRuntime(candidate.uid)
            && (candidate.mode & 0o777) === 0o600 && candidate.dev === info.dev && candidate.ino === info.ino) {
            candidates.push(name);
          }
        } catch { fail('FLOWPILOT_BRIDGE_STORE_CORRUPT'); }
      }
      if (candidates.length !== 1) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
      await unlink(join(root, candidates[0]!));
      await syncDirectory(root);
      info = await handle.stat();
    }
    if (info.nlink !== 1) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
    const raw = await handle.readFile('utf8');
    const record = validate(JSON.parse(raw));
    if (record.operation.operationId !== operationId) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
    return record;
  } catch { fail('FLOWPILOT_BRIDGE_STORE_CORRUPT'); }
  finally { await handle.close(); }
}
async function readTombstone(root: string, operationId: string): Promise<PersistedTombstone | undefined> {
  let handle;
  try { handle = await open(tombstonePathFor(root, operationId), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !ownedByRuntime(info.uid) || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
      fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
    }
    const value = validateTombstone(JSON.parse(await handle.readFile('utf8')));
    if (value.operation.operationId !== operationId) fail('FLOWPILOT_BRIDGE_STORE_CORRUPT');
    return value;
  } catch { fail('FLOWPILOT_BRIDGE_STORE_CORRUPT'); }
  finally { await handle.close(); }
}
function recordFromTombstone(value: PersistedTombstone): FlowPilotBridgeRecord {
  return {
    operation: value.operation,
    digest: value.digest,
    appId: value.appId,
    jobId: value.jobId,
    phase: 'COMPLETED',
  };
}
async function syncDirectory(root: string): Promise<void> {
  const directory = await open(root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function createOperationSerializer() {
  const tails = new Map<string, Promise<void>>();
  return async function run<T>(operationId: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    tails.set(operationId, tail);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (tails.get(operationId) === tail) tails.delete(operationId);
    }
  };
}
async function atomicWrite(root: string, record: PersistedRecord): Promise<void> {
  await ensureRoot(root);
  const final = pathFor(root, record.operation.operationId);
  const temp = `${final}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await rename(temp, final); await chmod(final, 0o600);
    await syncDirectory(root);
  } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}
async function atomicWriteTombstone(root: string, record: PersistedTombstone): Promise<void> {
  await ensureRoot(root);
  const final = tombstonePathFor(root, record.operation.operationId);
  const temp = `${final}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await rename(temp, final); await chmod(final, 0o600);
    await syncDirectory(root);
  } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}
async function atomicCreate(root: string, record: PersistedRecord): Promise<boolean> {
  await ensureRoot(root);
  const final = pathFor(root, record.operation.operationId);
  const temp = `${final}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.claim`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await link(temp, final); await chmod(final, 0o600);
    await syncDirectory(root);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
    await syncDirectory(root);
  }
}

export function createFlowPilotBridgeStore(
  root: string,
  now: () => Date = () => new Date(),
  options: FlowPilotBridgeStoreOptions = {},
): FlowPilotBridgeStore {
  const runExclusive = createOperationSerializer();
  const maxPendingRecords = options.maxPendingRecords ?? 10_000;
  const pendingBatchSize = options.pendingBatchSize ?? 100;
  const maxCompletedRecords = options.maxCompletedRecords ?? 10_000;
  const completedMinRetentionMs = options.completedMinRetentionMs ?? 24 * 60 * 60 * 1_000;
  const completedRetentionMs = options.completedRetentionMs ?? 30 * 24 * 60 * 60 * 1_000;
  async function current(operationId: string): Promise<PersistedRecord> {
    const value = await read(root, operationId); if (!value) fail('FLOWPILOT_BRIDGE_STORE_MISSING'); return value;
  }
  async function transition(operationId: string, expected: FlowPilotBridgePhase, phase: FlowPilotBridgePhase, callback?: Record<string, unknown>): Promise<void> {
    const value = await current(operationId);
    if (value.phase !== expected) fail('FLOWPILOT_BRIDGE_STORE_PHASE_INVALID');
    const next = { ...value, phase, updatedAt: now().toISOString(), ...(callback === undefined ? {} : { callback }) } as PersistedRecord;
    validate(next); await atomicWrite(root, next);
  }
  return {
    async claim(input: FlowPilotBridgeRecord) {
      return runExclusive(input.operation.operationId, async () => {
        if (input.phase !== 'CLAIMED' || input.callback !== undefined || !SHA_RE.test(input.digest)) fail('FLOWPILOT_BRIDGE_CLAIM_INVALID');
        const app = flowPilotAppIdentity(input.operation);
        if (input.digest !== flowPilotOperationDigest(input.operation) || input.appId !== app.appId || input.jobId !== app.jobId) fail('FLOWPILOT_BRIDGE_CLAIM_INVALID');
        await ensureRoot(root);
        const existing = await read(root, input.operation.operationId);
        if (existing) return existing.digest === input.digest ? { state: 'REPLAY' as const, record: existing } : { state: 'COLLISION' as const, record: existing };
        const tombstone = await readTombstone(root, input.operation.operationId);
        if (tombstone) {
          const completed = recordFromTombstone(tombstone);
          return tombstone.digest === input.digest
            ? { state: 'REPLAY' as const, record: completed }
            : { state: 'COLLISION' as const, record: completed };
        }
        const stamp = now().toISOString();
        const persisted: PersistedRecord = { schema: 'COCWIN_FLOWPILOT_BRIDGE_STORE_V1', ...input, createdAt: stamp, updatedAt: stamp };
        validate(persisted);
        if (await atomicCreate(root, persisted)) return { state: 'NEW' as const, record: persisted };
        const winner = await read(root, input.operation.operationId);
        if (!winner) fail('FLOWPILOT_BRIDGE_STORE_CLAIM_UNCERTAIN');
        return winner.digest === input.digest ? { state: 'REPLAY' as const, record: winner } : { state: 'COLLISION' as const, record: winner };
      });
    },
    async get(operationId: string) {
      return runExclusive(operationId, async () => {
        const value = await read(root, operationId);
        if (value) return value;
        const tombstone = await readTombstone(root, operationId);
        return tombstone ? recordFromTombstone(tombstone) : undefined;
      });
    },
    async markSubmitted(operationId: string) {
      await runExclusive(operationId, async () => {
        const value = await current(operationId);
        if (value.phase !== 'CLAIMED') return;
        await transition(operationId, 'CLAIMED', 'SUBMITTED');
      });
    },
    async markCallbackPending(operationId: string, callback: Record<string, unknown>) {
      await runExclusive(operationId, async () => {
        const value = await current(operationId); validateCallback(callback, value.operation);
        if (value.phase === 'CALLBACK_PENDING' || value.phase === 'COMPLETED') {
          if (JSON.stringify(value.callback) !== JSON.stringify(callback)) fail('FLOWPILOT_BRIDGE_CALLBACK_CONFLICT');
          return;
        }
        if (value.phase !== 'SUBMITTED') fail('FLOWPILOT_BRIDGE_STORE_PHASE_INVALID');
        await transition(operationId, 'SUBMITTED', 'CALLBACK_PENDING', callback);
      });
    },
    async markCompleted(operationId: string) {
      await runExclusive(operationId, async () => {
        const value = await current(operationId); if (value.phase === 'COMPLETED') return;
        if (value.phase !== 'CALLBACK_PENDING') fail('FLOWPILOT_BRIDGE_STORE_PHASE_INVALID');
        await transition(operationId, 'CALLBACK_PENDING', 'COMPLETED', value.callback);
      });
    },
    async pending() {
      await ensureRoot(root);
      const names = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();
      const rows: PersistedRecord[] = [];
      const completed: PersistedRecord[] = [];
      let failures = 0;
      for (const name of names) {
        const operationId = name.slice(0, -5);
        try {
          const value = await read(root, operationId);
          if (value?.phase === 'COMPLETED') completed.push(value);
          else if (value) rows.push(value);
        } catch { failures += 1; }
      }
      if (rows.length > maxPendingRecords) failures += 1;
      const oldestFirst = completed.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
        || left.operation.operationId.localeCompare(right.operation.operationId));
      const excess = Math.max(0, oldestFirst.length - maxCompletedRecords);
      const currentTime = now().getTime();
      for (const [index, value] of oldestFirst.entries()) {
        const updatedAt = Date.parse(value.updatedAt);
        const age = Number.isFinite(updatedAt) ? currentTime - updatedAt : Number.POSITIVE_INFINITY;
        if (age >= completedRetentionMs || (index < excess && age >= completedMinRetentionMs)) {
          try {
            await runExclusive(value.operation.operationId, async () => {
              const latest = await read(root, value.operation.operationId);
              if (!latest || latest.phase !== 'COMPLETED') return;
              const tombstone: PersistedTombstone = {
                schema: 'COCWIN_FLOWPILOT_BRIDGE_TOMBSTONE_V1',
                operation: latest.operation,
                digest: latest.digest,
                appId: latest.appId,
                jobId: latest.jobId,
                completedAt: latest.updatedAt,
              };
              validateTombstone(tombstone);
              await atomicWriteTombstone(root, tombstone);
              await unlink(pathFor(root, value.operation.operationId));
              await syncDirectory(root);
            });
          }
          catch { failures += 1; }
        }
      }
      return { records: rows.slice(0, pendingBatchSize), failures };
    },
  };
}
