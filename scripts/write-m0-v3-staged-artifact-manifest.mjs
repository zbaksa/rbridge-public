import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const REPOSITORY = 'zbaksa/rbridge-public';
const RUNTIME_SHA = '905d2b3af74907b575003b634e572f126e647025';
const RUNTIME_TREE = '9dafef94d4ce32b526cc56b4413d1682c16ed4ad';
const SCHEMA = 'RBRIDGE_M0_V3_STAGED_ARTIFACT_INVENTORY_V1';
const FIXTURE = 'SOURCE_FIXTURE_NOT_QUALIFICATION';
const MiB = 1024 * 1024;
const COMPONENTS = ['LINUX_RUNTIME', 'EXTENSION', 'NATIVE_BUNDLE', 'WINDOWS_PACKAGE'];
const SOURCE_STEMS = [
  'browser/chatgptAssistantMarkdownCapture', 'browser/chatgptConversationIdentity',
  'browser/chatgptDeliveryAdapter', 'browser/chatgptDomAdapter', 'browser/chatgptRolloverAdapter',
  'domain/browserInventory', 'domain/browserQuotaRollover', 'domain/rbridgeChatCommand',
  'domain/rbridgeChatCore', 'domain/rbridgeEffectProtocol',
  'extension/browserAuthorityRuntime', 'extension/browserAuthorityStore', 'extension/chromeAuthorityAdapters',
  'extension/chromeTabInventory', 'extension/contentMessageBridge', 'extension/contentRuntime',
  'extension/contentScriptEntry', 'extension/extensionManifest', 'extension/nativePortServiceWorker',
  'extension/rbridgeCaptureEgress', 'extension/rbridgeCommandDispatcher', 'extension/rbridgeEffectDispatcher',
  'extension/rbridgeEffectExecutor', 'extension/rbridgeEffectStore', 'extension/serviceWorkerEntry',
  'nativeHost/nativeHostCli', 'nativeHost/nativeHostConfig', 'nativeHost/nativeHostInvocation',
  'nativeHost/nativeHostMain', 'nativeHost/nativeHostManifest', 'nativeHost/nativeHostProtocol',
  'nativeHost/nativeHostRelay', 'nativeHost/nativeHostRuntime', 'nativeHost/nativeV3PeerAuthority',
  'nativeHost/persistentSshSession', 'nativeHost/privateLinuxFileGate', 'nativeHost/rbridgeEffectResultStore',
  'server/rbridgeChatEventStore', 'server/rbridgeChatPeerCli', 'server/rbridgeChatPeerStore',
  'server/rbridgeChatStdio', 'server/rbridgeReceiptStore', 'transport/nativeMessaging', 'transport/sshStdio',
];
const PATHS = {
  LINUX_RUNTIME: SOURCE_STEMS.map(stem => `dist/src/${stem}.js`).sort(),
  EXTENSION: ['dist-extension/contentScript.js', 'dist-extension/manifest.json', 'dist-extension/serviceWorker.js'],
  NATIVE_BUNDLE: ['dist-native-host/rbridge-native-host.cjs'],
  WINDOWS_PACKAGE: ['dist-native-host/install-native-host-windows.ps1', 'dist-native-host/rbridge-native-host.exe', 'dist-native-host/rbridge-native-host.metadata.json'],
};
const REGISTRY = COMPONENTS.flatMap(component => PATHS[component].map(emittedPath => ({component, emittedPath, id: `${component}:${emittedPath}`})));
const BY_ID = new Map(REGISTRY.map(entry => [entry.id, entry]));
const MANIFEST = 'EXTENSION:dist-extension/manifest.json';
const WORKER = 'EXTENSION:dist-extension/serviceWorker.js';
const EXE = 'WINDOWS_PACKAGE:dist-native-host/rbridge-native-host.exe';
const METADATA = 'WINDOWS_PACKAGE:dist-native-host/rbridge-native-host.metadata.json';
const INSTALLER = 'WINDOWS_PACKAGE:dist-native-host/install-native-host-windows.ps1';
const PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAy0OvK91SLE1iT6ecfyC/aTSPlc5CnJfuT695XVpmh0/+OU8UhVXntomf+cUdi6kITbl3KJCaygY1HfPraQSp1rRnn7RXZnUR5f2dBnU3BRmMnxZfKDwvvcs8vBZFYfCAbSftyXTMmgK0BmEyGOpQUhKG1qY8nivgTrbhu8HEeKFUCJYe0P0wu1pVr7ehtmkqaLdFfCo53Y61Bm3Q+MzD0TnWEyHZo+lhRIew3732/hli0AAeEWeSbxbSMHtA8+F+wxyGIgad68gQA2fTX6+QEHV3lba5bTegNrIWKsw1Ol4g3xliHHhhb0vNNziVLxT4JSRrx4Lzi4kG3zoG/16bbwIDAQAB';
const EXPECTED_MANIFEST = {
  manifest_version: 3, name: 'COCWIN RBridge Chat', short_name: 'RBridge Chat', version: '0.1.0',
  description: 'COCWIN RBridge browser authority adapter', key: PUBLIC_KEY,
  background: {service_worker: 'serviceWorker.js', type: 'module'},
  permissions: ['tabs', 'scripting', 'storage', 'nativeMessaging'],
  host_permissions: ['https://chatgpt.com/*', 'https://www.chatgpt.com/*', 'https://chat.openai.com/*', 'https://www.chat.openai.com/*'],
};
const TOOLS = {TYPESCRIPT: '6.0.3', VITE: '8.2.2', WINDOWS_NODE: '22.23.3', POSTJECT: '1.0.0-alpha.6'};
const COMMANDS = {LINUX_RUNTIME: 'BUILD_SERVER', EXTENSION: 'BUILD_EXTENSION', NATIVE_BUNDLE: 'BUILD_NATIVE_HOST', WINDOWS_PACKAGE: 'BUILD_WINDOWS_SEA'};
const SHA40 = /^[0-9a-f]{40}$/, SHA256 = /^[0-9a-f]{64}$/;
const INVALID = 'STAGED_ARTIFACT_INPUT_INVALID';
const fail = code => { throw new Error(code); };
const requireValue = (ok, code = INVALID) => { if (!ok) fail(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = values => [...new Set(values)].sort();
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function ownObject(value, keys) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value));
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === Object.prototype || prototype === null);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key => Object.hasOwn(descriptors, key)));
  for (const key of keys) requireValue(Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable);
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function snapshot(value, seen = new Set(), depth = 0) {
  requireValue(depth <= 16);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { requireValue(value.length <= 262144); return value; }
  if (typeof value === 'number') { requireValue(Number.isSafeInteger(value)); return value; }
  requireValue(value && typeof value === 'object' && !seen.has(value));
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    requireValue(Object.getPrototypeOf(value) === Array.prototype && value.length <= 256);
    requireValue(Reflect.ownKeys(value).length === value.length + 1);
    result = Array.from({length: value.length}, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      requireValue(descriptor && Object.hasOwn(descriptor, 'value'));
      return snapshot(descriptor.value, seen, depth + 1);
    });
  } else {
    const prototype = Object.getPrototypeOf(value);
    requireValue(prototype === Object.prototype || prototype === null);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireValue(Reflect.ownKeys(descriptors).every(key => typeof key === 'string'));
    result = {};
    for (const key of Object.keys(descriptors)) {
      requireValue(Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable);
      Object.defineProperty(result, key, {value: snapshot(descriptors[key].value, seen, depth + 1), enumerable: true});
    }
  }
  seen.delete(value); return result;
}
const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const nullableHash = (value, pattern = SHA256) => value === null || (typeof value === 'string' && pattern.test(value));
function refValue(value) {
  const ref = ownObject(value, ['id', 'sha256', 'bytes']);
  requireValue(typeof ref.id === 'string' && /^fixture:[A-Za-z0-9._:-]{1,184}$/.test(ref.id));
  requireValue(typeof ref.sha256 === 'string' && SHA256.test(ref.sha256));
  requireValue(count(ref.bytes, MiB), 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
  return ref;
}
function archivePath(value) {
  requireValue(typeof value === 'string' && /^[ -~]{1,256}$/.test(value));
  requireValue(!value.startsWith('/') && !value.includes('\\') && !value.includes(':'));
  requireValue(value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'));
  return value;
}
function parseJson(bytes, original = false) {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const value = JSON.parse(text);
  const stack = [];
  for (const token of text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? []) {
    const current = stack.at(-1);
    if (token === '{') stack.push({object: true, key: true, names: new Set()});
    else if (token === '[') stack.push({object: false});
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && current?.object) current.key = true;
    else if (token.startsWith('"') && current?.object && current.key) {
      const key = JSON.parse(token); requireValue(!current.names.has(key)); current.names.add(key); current.key = false;
    }
  }
  const owned = snapshot(value);
  if (original) requireValue(Buffer.from(canonical(owned) + '\n').equals(Buffer.from(bytes)));
  return owned;
}
function validateContext(binding) {
  const input = ownObject(binding, ['observedAt', 'runtimeSource', 'writerSource', 'qualification', 'inspectFixedSurface', 'openFixedMember', 'readOriginal', 'publish']);
  for (const key of ['inspectFixedSurface', 'openFixedMember', 'readOriginal', 'publish']) requireValue(typeof input[key] === 'function');
  const runtime = snapshot(input.runtimeSource), writer = snapshot(input.writerSource), qualification = snapshot(input.qualification);
  ownObject(runtime, ['repository', 'sourceSha', 'treeSha', 'sourceObjectManifestSha256', 'packageLockSha256']);
  requireValue(runtime.repository === REPOSITORY && runtime.sourceSha === RUNTIME_SHA && runtime.treeSha === RUNTIME_TREE);
  requireValue(nullableHash(runtime.sourceObjectManifestSha256) && nullableHash(runtime.packageLockSha256));
  ownObject(writer, ['repository', 'sourceSha', 'treeSha', 'sourceObjectManifestSha256']);
  requireValue(writer.repository === REPOSITORY && nullableHash(writer.sourceSha, SHA40) && nullableHash(writer.treeSha, SHA40) && nullableHash(writer.sourceObjectManifestSha256));
  requireValue((writer.sourceSha === null) === (writer.treeSha === null));
  requireValue(writer.sourceSha === null || writer.sourceSha !== RUNTIME_SHA);
  ownObject(qualification, ['runtimeSourceRef', 'writerSourceRef', 'buildRefs', 'windowsArtifact']);
  ownObject(qualification.buildRefs, COMPONENTS);
  ownObject(qualification.windowsArtifact, ['repository', 'runId', 'jobId', 'artifactId', 'registryArchiveBytes', 'registryArchiveSha256', 'archiveAcquisitionRef', 'archiveMeasuredBytes', 'archiveMeasuredSha256']);
  const windows = qualification.windowsArtifact;
  requireValue(windows.repository === REPOSITORY);
  for (const key of ['runId', 'jobId', 'artifactId']) requireValue(windows[key] === null || (Number.isSafeInteger(windows[key]) && windows[key] > 0));
  requireValue(windows.registryArchiveBytes === null || count(windows.registryArchiveBytes, 128 * MiB), 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
  requireValue(nullableHash(windows.registryArchiveSha256));
  requireValue(windows.archiveMeasuredBytes === null && windows.archiveMeasuredSha256 === null);
  requireValue(typeof input.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.observedAt));
  requireValue(Number.isFinite(Date.parse(input.observedAt)) && new Date(input.observedAt).toISOString() === input.observedAt);
  return {...input, runtimeSource: runtime, writerSource: writer, qualification};
}
function limit(entry) {
  if (entry.id === 'WINDOWS_ARCHIVE' || entry.id === EXE) return 128 * MiB;
  if (entry.id === MANIFEST || entry.id === INSTALLER) return 65536;
  if (entry.id === METADATA) return 16384;
  if (entry.component === 'EXTENSION') return 512 * 1024;
  return 2 * MiB;
}
function stateValue(value) {
  const state = ownObject(value, ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink', 'uid', 'gid', 'mode', 'regular']);
  for (const key of ['dev', 'ino', 'size', 'nlink', 'uid', 'gid', 'mode']) requireValue(count(state[key], Number.MAX_SAFE_INTEGER), 'STAGED_ARTIFACT_MEMBER_UNSAFE');
  for (const key of ['mtimeMs', 'ctimeMs']) requireValue(typeof state[key] === 'number' && Number.isFinite(state[key]) && state[key] >= 0, 'STAGED_ARTIFACT_MEMBER_UNSAFE');
  requireValue(state.regular === true && state.nlink === 1 && (state.mode & 0o170000) === 0o100000 && (state.mode & 0o022) === 0, 'STAGED_ARTIFACT_MEMBER_UNSAFE');
  requireValue(typeof process.getuid === 'function' && state.uid === process.getuid() && state.gid === process.getgid(), 'STAGED_ARTIFACT_MEMBER_UNSAFE');
  return state;
}

// This entry accepts only sealed test capabilities. No supplied record/callback
// can change the producer or grant a production source-to-byte PASS.
export async function collectStagedArtifactFixtureInventory(fixtureBinding) {
  if (fixtureBinding === undefined || fixtureBinding === null) fail('SOURCE_ARTIFACT_ACQUISITION_BINDING_UNAVAILABLE');
  const input = validateContext(fixtureBinding);
  const references = new Map(), originalCache = new Map(), builds = new Map(), acquisitions = new Map();
  const componentReasons = Object.fromEntries(COMPONENTS.map(component => [component, new Set([FIXTURE])]));
  const globalReasons = new Set([FIXTURE, 'HOST_RUNTIME_BINDING_UNVERIFIED']);
  let observationBytes = 0, measuredBytes = 0;
  function addReason(reason, component) { (component ? componentReasons[component] : globalReasons).add(reason); }
  function addRef(value) {
    if (value === null) return null;
    const ref = refValue(value), existing = references.get(ref.id);
    requireValue(!existing || canonical(existing) === canonical(ref));
    if (!existing) {
      requireValue(references.size < 64, 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
      references.set(ref.id, ref);
    }
    return ref;
  }
  const q = input.qualification;
  addRef(q.runtimeSourceRef); addRef(q.writerSourceRef);
  for (const component of COMPONENTS) addRef(q.buildRefs[component]);
  addRef(q.windowsArtifact.archiveAcquisitionRef);

  async function inspect(component) {
    const surface = ownObject(await input.inspectFixedSurface(component), ['entries']);
    const supplied = snapshot(surface.entries);
    requireValue(Array.isArray(supplied) && supplied.length === PATHS[component].length);
    const seen = new Set(), entries = [];
    for (const value of supplied) {
      const entry = ownObject(value, ['id', 'emittedPath', 'kind']);
      const expected = BY_ID.get(entry.id);
      requireValue(expected?.component === component && expected.emittedPath === entry.emittedPath && !seen.has(entry.id));
      requireValue(['REGULAR', 'MISSING', 'UNSAFE'].includes(entry.kind));
      requireValue(entry.kind !== 'UNSAFE', 'STAGED_ARTIFACT_MEMBER_UNSAFE');
      seen.add(entry.id); entries.push(entry);
    }
    return entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  const before = new Map();
  for (const component of COMPONENTS) before.set(component, await inspect(component));

  async function readOriginal(value, component) {
    const ref = addRef(value);
    if (ref === null) { addReason('ORIGINAL_QUALIFICATION_UNAVAILABLE', component); return null; }
    if (originalCache.has(ref.id)) {
      const cached = originalCache.get(ref.id);
      if (cached === null) addReason('ORIGINAL_QUALIFICATION_UNAVAILABLE', component);
      return cached;
    }
    requireValue(ref.bytes <= 16 * MiB - observationBytes, 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
    let parsed = null;
    let supplied = null;
    try { supplied = await input.readOriginal({...ref}); } catch (error) {
      if (error instanceof Error && ['STAGED_ARTIFACT_BOUNDS_EXCEEDED', 'STAGED_ARTIFACT_MEMBER_UNSAFE', 'STAGED_ARTIFACT_BYTES_CHANGED'].includes(error.message)) throw error;
      supplied = null;
    }
    if (supplied instanceof Uint8Array) {
      requireValue(supplied.byteLength <= MiB && observationBytes + supplied.byteLength <= 16 * MiB, 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
      const raw = Uint8Array.from(supplied); observationBytes += raw.byteLength;
      if (raw.byteLength === ref.bytes && digest(raw) === ref.sha256) {
        try { parsed = parseJson(raw, true); } catch { parsed = null; }
      }
    }
    if (parsed === null) addReason('ORIGINAL_QUALIFICATION_UNAVAILABLE', component);
    originalCache.set(ref.id, parsed); return parsed;
  }
  function validOriginal(value, keys, schema) {
    if (value === null) return false;
    try { ownObject(value, keys); } catch { return false; }
    return value.schema === schema && value.authority === 'SOURCE_FIXTURE';
  }
  async function sourceOriginal(ref, expected, role) {
    const source = await readOriginal(ref);
    if (!validOriginal(source, ['schema', 'authority', 'role', 'repository', 'sourceSha', 'treeSha', 'sourceObjectManifestSha256', 'packageLockSha256'], 'RBRIDGE_STAGED_ARTIFACT_FIXTURE_SOURCE_V1')) {
      addReason('ORIGINAL_QUALIFICATION_UNAVAILABLE'); return;
    }
    if (!['RUNTIME', 'WRITER'].includes(source.role) || typeof source.repository !== 'string' || !nullableHash(source.sourceSha, SHA40) || !nullableHash(source.treeSha, SHA40) || (source.sourceSha === null) !== (source.treeSha === null) || !nullableHash(source.sourceObjectManifestSha256) || !nullableHash(source.packageLockSha256) || (source.role === 'WRITER' && source.packageLockSha256 !== null)) {
      addReason('ORIGINAL_QUALIFICATION_UNAVAILABLE'); return;
    }
    if (source.role !== role || source.repository !== expected.repository || source.sourceSha !== expected.sourceSha || source.treeSha !== expected.treeSha || source.sourceObjectManifestSha256 !== expected.sourceObjectManifestSha256 || (role === 'RUNTIME' && source.packageLockSha256 !== expected.packageLockSha256)) addReason('SOURCE_TO_BYTE_BINDING_MISMATCH');
  }
  await sourceOriginal(q.runtimeSourceRef, input.runtimeSource, 'RUNTIME');
  await sourceOriginal(q.writerSourceRef, input.writerSource, 'WRITER');
  if (input.runtimeSource.sourceObjectManifestSha256 === null) addReason('SOURCE_OBJECT_BYTES_UNAVAILABLE');
  if (input.runtimeSource.packageLockSha256 === null) addReason('SOURCE_LOCK_BYTES_UNAVAILABLE');
  if (input.writerSource.sourceSha === null || input.writerSource.sourceObjectManifestSha256 === null) addReason('WRITER_SOURCE_BINDING_UNPROVED');

  for (const component of COMPONENTS) {
    const build = await readOriginal(q.buildRefs[component], component);
    if (!validOriginal(build, ['schema', 'authority', 'component', 'runtimeSourceRef', 'commandId', 'toolchainRefs', 'members', 'windows'], 'RBRIDGE_STAGED_ARTIFACT_FIXTURE_BUILD_V1')) {
      addReason('ORIGINAL_QUALIFICATION_UNAVAILABLE', component); builds.set(component, null); continue;
    }
    requireValue(COMPONENTS.includes(build.component) && Object.values(COMMANDS).includes(build.commandId));
    addRef(build.runtimeSourceRef);
    if (build.component !== component || build.commandId !== COMMANDS[component] || canonical(build.runtimeSourceRef) !== canonical(q.runtimeSourceRef)) addReason('SOURCE_TO_BYTE_BINDING_MISMATCH', component);
    if (!Array.isArray(build.members) || build.members.length !== PATHS[component].length || !Array.isArray(build.toolchainRefs)) {
      addReason('ORIGINAL_QUALIFICATION_UNAVAILABLE', component); builds.set(component, null); continue;
    }
    const memberMap = new Map();
    for (const member of build.members) {
      ownObject(member, ['id', 'sha256', 'bytes', 'acquisitionRef']);
      requireValue(BY_ID.get(member.id)?.component === component && !memberMap.has(member.id));
      requireValue(typeof member.sha256 === 'string' && SHA256.test(member.sha256));
      requireValue(count(member.bytes, limit(BY_ID.get(member.id))), 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
      requireValue(member.acquisitionRef !== null);
      addRef(member.acquisitionRef); memberMap.set(member.id, member);
    }
    builds.set(component, {original: build, members: memberMap});
    const requiredTools = component === 'LINUX_RUNTIME' ? ['TYPESCRIPT'] : component === 'WINDOWS_PACKAGE' ? Object.keys(TOOLS) : ['TYPESCRIPT', 'VITE'];
    const observedTools = new Set();
    for (const toolRef of build.toolchainRefs) {
      const tool = await readOriginal(toolRef, component);
      if (!validOriginal(tool, ['schema', 'authority', 'tool', 'version', 'binarySha256', 'packageLockSha256'], 'RBRIDGE_STAGED_ARTIFACT_FIXTURE_TOOL_V1')) { addReason('ORIGINAL_QUALIFICATION_UNAVAILABLE', component); continue; }
      requireValue(Object.hasOwn(TOOLS, tool.tool) && !observedTools.has(tool.tool) && typeof tool.version === 'string' && typeof tool.binarySha256 === 'string' && SHA256.test(tool.binarySha256) && nullableHash(tool.packageLockSha256));
      if (!requiredTools.includes(tool.tool) || tool.version !== TOOLS[tool.tool] || (tool.tool !== 'POSTJECT' && tool.packageLockSha256 !== input.runtimeSource.packageLockSha256) || (tool.tool === 'POSTJECT' && tool.packageLockSha256 !== null)) addReason('SOURCE_TO_BYTE_BINDING_MISMATCH', component);
      observedTools.add(tool.tool);
    }
    if (observedTools.size !== requiredTools.length || !requiredTools.every(tool => observedTools.has(tool))) addReason('SOURCE_TO_BYTE_BINDING_UNPROVED', component);
    if (component === 'WINDOWS_PACKAGE' && build.windows !== null) {
      ownObject(build.windows, ['runId', 'jobId', 'artifactId', 'archiveRef', 'archiveMembers']);
      for (const key of ['runId', 'jobId', 'artifactId']) requireValue(Number.isSafeInteger(build.windows[key]) && build.windows[key] > 0);
      requireValue(build.windows.archiveRef !== null);
      for (const key of ['runId', 'jobId', 'artifactId']) if (build.windows[key] !== q.windowsArtifact[key]) addReason('SOURCE_TO_BYTE_BINDING_MISMATCH', component);
      addRef(build.windows.archiveRef);
      if (canonical(build.windows.archiveRef) !== canonical(q.windowsArtifact.archiveAcquisitionRef)) addReason('SOURCE_TO_BYTE_BINDING_MISMATCH', component);
      requireValue(Array.isArray(build.windows.archiveMembers) && build.windows.archiveMembers.length === 3);
      const names = new Set(), ids = new Set();
      for (const mapping of build.windows.archiveMembers) {
        ownObject(mapping, ['id', 'archiveMemberPath', 'memberRef']);
        requireValue(BY_ID.get(mapping.id)?.component === component && !ids.has(mapping.id));
        const path = archivePath(mapping.archiveMemberPath);
        requireValue(!names.has(path) && mapping.memberRef !== null); names.add(path); ids.add(mapping.id); addRef(mapping.memberRef);
        if (canonical(mapping.memberRef) !== canonical(memberMap.get(mapping.id).acquisitionRef)) addReason('SOURCE_TO_BYTE_BINDING_MISMATCH', component);
      }
    } else if ((component === 'WINDOWS_PACKAGE') !== (build.windows !== null)) addReason('SOURCE_TO_BYTE_BINDING_UNPROVED', component);
  }

  async function acquisition(value, id, component) {
    const ref = addRef(value);
    const original = await readOriginal(ref, component);
    if (!validOriginal(original, ['schema', 'authority', 'memberId', 'sha256', 'bytes', 'originId', 'archiveMemberPath'], 'RBRIDGE_STAGED_ARTIFACT_FIXTURE_ACQUISITION_V1')) {
      addReason('ORIGINAL_QUALIFICATION_UNAVAILABLE', component); return null;
    }
    requireValue(BY_ID.has(original.memberId) || original.memberId === 'WINDOWS_ARCHIVE');
    requireValue(typeof original.originId === 'string' && /^fixture:[A-Za-z0-9._:-]{1,184}$/.test(original.originId));
    requireValue(typeof original.sha256 === 'string' && SHA256.test(original.sha256));
    requireValue(count(original.bytes, limit(id === 'WINDOWS_ARCHIVE' ? {id} : BY_ID.get(id))), 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
    if (original.archiveMemberPath !== null) archivePath(original.archiveMemberPath);
    if (original.memberId !== id || original.originId !== q.buildRefs[component]?.id) addReason('SOURCE_TO_BYTE_BINDING_MISMATCH', component);
    return original;
  }
  // Resolve the complete sealed original graph before opening member streams.
  for (const component of COMPONENTS) {
    const build = builds.get(component);
    if (build) for (const member of build.members.values()) acquisitions.set(member.id, await acquisition(member.acquisitionRef, member.id, component));
  }
  if (q.windowsArtifact.archiveAcquisitionRef !== null) acquisitions.set('WINDOWS_ARCHIVE', await acquisition(q.windowsArtifact.archiveAcquisitionRef, 'WINDOWS_ARCHIVE', 'WINDOWS_PACKAGE'));

  const measured = new Map(), captures = new Map(), observedArchiveNames = new Set();
  async function measure(entry) {
    const supplied = await input.openFixedMember(entry.id);
    if (supplied === null) return null;
    const opened = ownObject(supplied, ['handle', 'acquisitionRef', 'archiveMemberPath']);
    const handle = ownObject(opened.handle, ['stat', 'read', 'close']);
    for (const method of ['stat', 'read', 'close']) requireValue(typeof handle[method] === 'function');
    try {
      const ref = addRef(opened.acquisitionRef);
      requireValue(ref !== null);
      if (opened.archiveMemberPath !== null) archivePath(opened.archiveMemberPath);
      requireValue(entry.component === 'WINDOWS_PACKAGE' || opened.archiveMemberPath === null);
      if (entry.id === 'WINDOWS_ARCHIVE') requireValue(opened.archiveMemberPath === null);
      if (opened.archiveMemberPath !== null) {
        requireValue(!observedArchiveNames.has(opened.archiveMemberPath));
        observedArchiveNames.add(opened.archiveMemberPath);
      }
      const expected = builds.get(entry.component)?.members.get(entry.id);
      const expectedRef = entry.id === 'WINDOWS_ARCHIVE' ? q.windowsArtifact.archiveAcquisitionRef : expected?.acquisitionRef;
      if (expectedRef !== null && expectedRef !== undefined) requireValue(canonical(ref) === canonical(expectedRef));
      // An unavailable build remains blocked, but any opened acquisition claim
      // is independently reread before that member's first byte is consumed.
      if (!acquisitions.has(entry.id)) acquisitions.set(entry.id, await acquisition(ref, entry.id, entry.component));
      const initial = stateValue(await handle.stat());
      requireValue(initial.size <= limit(entry) && measuredBytes + initial.size <= 256 * MiB, 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
      const hash = createHash('sha256'), installerHash = entry.id === INSTALLER ? createHash('sha1').update(`blob ${initial.size}\0`) : null;
      const decoder = entry.id === EXE || entry.id === 'WINDOWS_ARCHIVE' ? null : new TextDecoder('utf-8', {fatal: true});
      const chunks = [], retain = [MANIFEST, WORKER, METADATA].includes(entry.id) ? limit(entry) : entry.id === EXE ? MiB : 0;
      let bytes = 0, kept = 0, textValid = true;
      for (;;) {
        const value = await handle.read(65536);
        requireValue(value instanceof Uint8Array && value.byteLength <= 65536, 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
        const chunk = Uint8Array.from(value);
        if (chunk.byteLength === 0) break;
        bytes += chunk.byteLength;
        requireValue(bytes <= initial.size, 'STAGED_ARTIFACT_BYTES_CHANGED');
        requireValue(bytes <= limit(entry) && measuredBytes + bytes <= 256 * MiB, 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
        hash.update(chunk); installerHash?.update(chunk);
        if (decoder && textValid) { try { decoder.decode(chunk, {stream: true}); } catch { textValid = false; } }
        if (kept < retain) { const captured = Buffer.from(chunk.subarray(0, retain - kept)); chunks.push(captured); kept += captured.length; }
      }
      if (decoder && textValid) { try { decoder.decode(); } catch { textValid = false; } }
      const final = stateValue(await handle.stat());
      requireValue(bytes === initial.size && canonical(initial) === canonical(final), 'STAGED_ARTIFACT_BYTES_CHANGED');
      measuredBytes += bytes;
      const proof = {bytes, sha256: hash.digest('hex'), acquisitionRef: ref, archiveMemberPath: opened.archiveMemberPath, reasons: []};
      if (!textValid) proof.reasons.push('STAGED_ARTIFACT_FORMAT_INVALID');
      if (installerHash && installerHash.digest('hex') !== 'a5ef049e2b6776618612b8ff16c0cd1c20a64277') proof.reasons.push('SOURCE_TO_BYTE_BINDING_MISMATCH');
      const original = acquisitions.get(entry.id);
      if (entry.id === 'WINDOWS_ARCHIVE' && canonical(ref) !== canonical(q.windowsArtifact.archiveAcquisitionRef)) proof.reasons.push('SOURCE_TO_BYTE_BINDING_MISMATCH');
      if (!original || (entry.id !== 'WINDOWS_ARCHIVE' && !expected)) proof.reasons.push('SOURCE_TO_BYTE_BINDING_UNPROVED');
      else if (proof.sha256 !== original.sha256 || proof.bytes !== original.bytes || proof.archiveMemberPath !== original.archiveMemberPath || (entry.id !== 'WINDOWS_ARCHIVE' && (proof.sha256 !== expected.sha256 || proof.bytes !== expected.bytes || canonical(ref) !== canonical(expected.acquisitionRef)))) proof.reasons.push('SOURCE_TO_BYTE_BINDING_MISMATCH');
      if (entry.component === 'WINDOWS_PACKAGE' && entry.id !== 'WINDOWS_ARCHIVE') {
        const mapping = builds.get(entry.component)?.original.windows?.archiveMembers.find(member => member.id === entry.id);
        if (!mapping || mapping.archiveMemberPath !== opened.archiveMemberPath || canonical(mapping.memberRef) !== canonical(ref)) proof.reasons.push('WINDOWS_SOURCE_TO_BYTE_BINDING_UNPROVED');
      }
      if (retain) captures.set(entry.id, Buffer.concat(chunks));
      proof.reasons = sorted(proof.reasons); return proof;
    } finally { await handle.close(); }
  }
  for (const entry of REGISTRY) {
    const declared = before.get(entry.component).find(member => member.id === entry.id);
    measured.set(entry.id, declared.kind === 'MISSING' ? null : await measure(entry));
  }
  const archiveClaimed = q.windowsArtifact.archiveAcquisitionRef !== null || q.windowsArtifact.artifactId !== null;
  let archive = null;
  if (archiveClaimed) archive = await measure({id: 'WINDOWS_ARCHIVE', component: 'WINDOWS_PACKAGE'});
  for (const component of COMPONENTS) requireValue(canonical(before.get(component)) === canonical(await inspect(component)), 'STAGED_ARTIFACT_BYTES_CHANGED');
  function fileReason(id, reason) { const proof = measured.get(id); if (proof) proof.reasons = sorted([...proof.reasons, reason]); }
  if (measured.get(MANIFEST)) {
    try {
      if (canonical(parseJson(captures.get(MANIFEST))) !== canonical(EXPECTED_MANIFEST)) fileReason(MANIFEST, 'STAGED_ARTIFACT_FORMAT_INVALID');
      const keyDigest = createHash('sha256').update(Buffer.from(PUBLIC_KEY, 'base64')).digest().subarray(0, 16);
      const alphabet = 'abcdefghijklmnop';
      const extensionId = [...keyDigest].map(byte => alphabet[byte >> 4] + alphabet[byte & 15]).join('');
      if (extensionId !== 'ebibbijpegoankenmggdnehpoadcophk') fileReason(MANIFEST, 'STAGED_ARTIFACT_FORMAT_INVALID');
    } catch { fileReason(MANIFEST, 'STAGED_ARTIFACT_FORMAT_INVALID'); }
  }
  if (measured.get(WORKER) && !new TextDecoder().decode(captures.get(WORKER)).includes(RUNTIME_SHA)) fileReason(WORKER, 'STAGED_ARTIFACT_FORMAT_INVALID');
  if (measured.get(EXE)) {
    const prefix = captures.get(EXE);
    let valid = prefix.length >= 64 && prefix[0] === 0x4d && prefix[1] === 0x5a;
    if (valid) {
      const offset = prefix.readUInt32LE(0x3c);
      valid = offset >= 64 && offset <= MiB - 4 && offset + 4 <= prefix.length && prefix.subarray(offset, offset + 4).equals(Buffer.from('PE\0\0'));
    }
    if (!valid) fileReason(EXE, 'STAGED_ARTIFACT_FORMAT_INVALID');
  }
  if (measured.get(METADATA)) {
    try {
      const metadata = ownObject(parseJson(captures.get(METADATA)), ['schema', 'status', 'nodeVersion', 'postjectVersion', 'sha256', 'bytes']);
      const executable = measured.get(EXE);
      if (metadata.schema !== 'RBRIDGE_NATIVE_HOST_WINDOWS_SEA_V1' || metadata.status !== 'PASS' || metadata.nodeVersion !== 'v22.23.3' || metadata.postjectVersion !== TOOLS.POSTJECT || typeof metadata.sha256 !== 'string' || !SHA256.test(metadata.sha256) || !count(metadata.bytes, 128 * MiB) || metadata.bytes < MiB || !executable || metadata.sha256 !== executable.sha256 || metadata.bytes !== executable.bytes) fileReason(METADATA, 'WINDOWS_EXECUTABLE_METADATA_MISMATCH');
    } catch { fileReason(METADATA, 'WINDOWS_EXECUTABLE_METADATA_MISMATCH'); }
  }
  if (archive) {
    if (archive.sha256 !== q.windowsArtifact.registryArchiveSha256 || archive.bytes !== q.windowsArtifact.registryArchiveBytes) addReason('SOURCE_TO_BYTE_BINDING_MISMATCH', 'WINDOWS_PACKAGE');
    for (const reason of archive.reasons) addReason(reason, 'WINDOWS_PACKAGE');
  } else if (archiveClaimed) addReason('WINDOWS_ARTIFACT_BYTES_UNAVAILABLE', 'WINDOWS_PACKAGE');
  const components = {};
  for (const component of COMPONENTS) {
    const files = REGISTRY.filter(entry => entry.component === component).map(entry => {
      const proof = measured.get(entry.id);
      const file = {id: entry.id, emittedPath: entry.emittedPath, archiveMemberPath: proof?.archiveMemberPath ?? null, bytes: proof?.bytes ?? null, sha256: proof?.sha256 ?? null, acquisitionRef: proof?.acquisitionRef ?? null, reasons: proof?.reasons ?? [component === 'WINDOWS_PACKAGE' ? 'WINDOWS_ARTIFACT_MEMBER_MISSING' : 'STAGED_ARTIFACT_MEMBER_MISSING']};
      for (const reason of file.reasons) addReason(reason, component);
      return file;
    });
    const available = files.every(file => file.bytes !== null) && !(component === 'WINDOWS_PACKAGE' && archiveClaimed && !archive);
    const qualificationRefs = [q.runtimeSourceRef, q.writerSourceRef, q.buildRefs[component]].filter(Boolean);
    const acquisitionRefs = files.map(file => file.acquisitionRef).filter(Boolean);
    if (component === 'WINDOWS_PACKAGE' && archive) acquisitionRefs.push(archive.acquisitionRef);
    const uniqueRefs = values => [...new Map(values.map(value => [value.id, value])).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    components[component] = {expectedMembers: files.map(file => file.id), files, qualificationRefs: uniqueRefs(qualificationRefs), acquisitionRefs: uniqueRefs(acquisitionRefs), availabilityState: available ? 'PASS' : 'BLOCKED', sourceToBytesState: 'BLOCKED', reasons: sorted(componentReasons[component])};
  }
  for (const component of COMPONENTS) for (const reason of components[component].reasons) globalReasons.add(reason);
  const windowsArtifact = {...q.windowsArtifact, archiveAcquisitionRef: archive?.acquisitionRef ?? null, archiveMeasuredBytes: archive?.bytes ?? null, archiveMeasuredSha256: archive?.sha256 ?? null};
  const record = {
    schema: SCHEMA, scope: 'SOURCE_ARTIFACT_INVENTORY_ONLY', observedAt: input.observedAt,
    runtimeSource: input.runtimeSource, writerSource: input.writerSource,
    producer: {kind: 'SOURCE_FIXTURE', observerRef: null},
    qualification: {...q, windowsArtifact},
    hostPrerequisites: {state: 'NOT_INSPECTED', reason: 'HOST_RUNTIME_BINDING_UNVERIFIED', bindings: {NODE: null, FLOCK: null, SHARED_LIBRARIES_ENVIRONMENT: null}},
    components, structuralState: 'PASS', availabilityState: COMPONENTS.every(component => components[component].availabilityState === 'PASS') ? 'PASS' : 'BLOCKED',
    sourceToBytesState: 'BLOCKED', reasons: sorted(globalReasons),
  };
  record.manifestSha256 = digest(Buffer.from(canonical(record)));
  const bytes = Buffer.from(canonical(record) + '\n');
  requireValue(bytes.length <= 262144, 'STAGED_ARTIFACT_BOUNDS_EXCEEDED');
  const observationRef = refValue(await input.publish(Uint8Array.from(bytes), record.manifestSha256));
  requireValue(!references.has(observationRef.id) || canonical(references.get(observationRef.id)) === canonical(observationRef), 'OUTPUT_UNSAFE');
  requireValue(observationRef.bytes === bytes.length && observationRef.sha256 === digest(bytes), 'OUTPUT_UNSAFE');
  return {record, observationRef};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stderr.write('SOURCE_ARTIFACT_ACQUISITION_BINDING_UNAVAILABLE\n');
  process.exitCode = 70;
}
