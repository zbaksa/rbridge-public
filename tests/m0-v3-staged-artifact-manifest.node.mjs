import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {appendFile, chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {collectStagedArtifactFixtureInventory} from '../scripts/write-m0-v3-staged-artifact-manifest.mjs';

const RUNTIME_SHA = '905d2b3af74907b575003b634e572f126e647025';
const RUNTIME_TREE = '9dafef94d4ce32b526cc56b4413d1682c16ed4ad';
const COMPONENTS = ['LINUX_RUNTIME', 'EXTENSION', 'NATIVE_BUNDLE', 'WINDOWS_PACKAGE'];
// Expectations come from the frozen source tree, never from the collector registry.
const RUNTIME_PATHS = [
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
].map(path => `dist/src/${path}.js`).sort();
const PATHS = {
  LINUX_RUNTIME: RUNTIME_PATHS,
  EXTENSION: ['dist-extension/contentScript.js', 'dist-extension/manifest.json', 'dist-extension/serviceWorker.js'],
  NATIVE_BUNDLE: ['dist-native-host/rbridge-native-host.cjs'],
  WINDOWS_PACKAGE: ['dist-native-host/install-native-host-windows.ps1', 'dist-native-host/rbridge-native-host.exe', 'dist-native-host/rbridge-native-host.metadata.json'],
};
const ENTRIES = COMPONENTS.flatMap(component => PATHS[component].map(path => ({component, path, id: `${component}:${path}`})));
const CLI = 'LINUX_RUNTIME:dist/src/server/rbridgeChatPeerCli.js';
const DEPENDENCY = 'LINUX_RUNTIME:dist/src/nativeHost/privateLinuxFileGate.js';
const WORKER = 'EXTENSION:dist-extension/serviceWorker.js';
const MANIFEST = 'EXTENSION:dist-extension/manifest.json';
const BUNDLE = 'NATIVE_BUNDLE:dist-native-host/rbridge-native-host.cjs';
const EXE = 'WINDOWS_PACKAGE:dist-native-host/rbridge-native-host.exe';
const METADATA = 'WINDOWS_PACKAGE:dist-native-host/rbridge-native-host.metadata.json';
const INSTALLER = 'WINDOWS_PACKAGE:dist-native-host/install-native-host-windows.ps1';
const KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAy0OvK91SLE1iT6ecfyC/aTSPlc5CnJfuT695XVpmh0/+OU8UhVXntomf+cUdi6kITbl3KJCaygY1HfPraQSp1rRnn7RXZnUR5f2dBnU3BRmMnxZfKDwvvcs8vBZFYfCAbSftyXTMmgK0BmEyGOpQUhKG1qY8nivgTrbhu8HEeKFUCJYe0P0wu1pVr7ehtmkqaLdFfCo53Y61Bm3Q+MzD0TnWEyHZo+lhRIew3732/hli0AAeEWeSbxbSMHtA8+F+wxyGIgad68gQA2fTX6+QEHV3lba5bTegNrIWKsw1Ol4g3xliHHhhb0vNNziVLxT4JSRrx4Lzi4kG3zoG/16bbwIDAQAB';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function observation(id, bytes) { return {id, sha256: hash(bytes), bytes: bytes.length}; }
function fileState(value) {
  return Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink', 'uid', 'gid', 'mode'].map(key => [key, value[key]]).concat([['regular', value.isFile()]]));
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fail = code => { throw new Error(code); };

async function fixture(t, sourceObservation = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rbridge-inventory-fixture-'));
  const input = join(root, 'input'), originals = join(root, 'originals'), output = join(root, 'output');
  for (const path of [root, input, originals, output]) await mkdir(path, {recursive: true, mode: 0o700});
  const inputDirectory = await open(input, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const outputDirectory = await open(output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  t.after(async () => { await inputDirectory.close(); await outputDirectory.close(); await rm(root, {recursive: true, force: true}); });
  const sentinel = join(root, 'preserved-history');
  await writeFile(sentinel, 'original history\n', {mode: 0o600});
  const paths = new Map(), sourceBytes = new Map(), refs = new Map(), originalPaths = new Map();
  const hooks = {afterRead: null, failFileSync: false, directoryReadTarget: null};
  const events = {reads: [], publications: [], originalReads: new Map(), outputReads: 0, observedDirectoryReads: 0};
  const manifest = {manifest_version: 3, name: 'COCWIN RBridge Chat', short_name: 'RBridge Chat', version: '0.1.0', description: 'COCWIN RBridge browser authority adapter', key: KEY, background: {service_worker: 'serviceWorker.js', type: 'module'}, permissions: ['tabs', 'scripting', 'storage', 'nativeMessaging'], host_permissions: ['https://chatgpt.com/*', 'https://www.chatgpt.com/*', 'https://chat.openai.com/*', 'https://www.chat.openai.com/*']};
  const executable = Buffer.alloc(1024 * 1024);
  executable.write('MZ'); executable.writeUInt32LE(128, 0x3c); executable.write('PE\0\0', 128);
  executable.write('SOURCE_FIXTURE_ONLY', 256);
  const installer = await readFile(new URL('../scripts/install-native-host-windows.ps1', import.meta.url));
  const metadata = {schema: 'RBRIDGE_NATIVE_HOST_WINDOWS_SEA_V1', status: 'PASS', nodeVersion: 'v22.23.3', postjectVersion: '1.0.0-alpha.6', sha256: hash(executable), bytes: executable.length};
  for (const entry of ENTRIES) {
    let bytes = Buffer.from(`// independent emitted fixture ${entry.path}\nexport const fixture = true;\n`);
    if (entry.path === 'dist-extension/contentScript.js') bytes = Buffer.from('// RBRIDGE_CONTENT_REQUEST_V1 RBRIDGE_CONTENT_CAPTURE_V1\n');
    if (entry.id === MANIFEST) bytes = Buffer.from(canonical(manifest) + '\n');
    if (entry.id === WORKER) bytes = Buffer.from(`const release = '${RUNTIME_SHA}'; // RBRIDGE_CHAT_HELLO_V1 com.cocwin.rbridge_chat_v1\n`);
    if (entry.id === BUNDLE) bytes = Buffer.from('module.exports = {fixture: true};\n');
    if (entry.id === EXE) bytes = executable;
    if (entry.id === METADATA) bytes = Buffer.from(canonical(metadata) + '\n');
    if (entry.id === INSTALLER) bytes = installer;
    const path = join(input, entry.path);
    await mkdir(dirname(path), {recursive: true, mode: 0o700});
    await writeFile(path, bytes, {mode: 0o600});
    paths.set(entry.id, path); sourceBytes.set(entry.id, Buffer.from(bytes));
  }
  const archive = Buffer.from('independent retained archive fixture bytes\n');
  const archivePath = join(input, 'proof', 'windows-archive.fixture');
  await mkdir(dirname(archivePath), {mode: 0o700});
  await writeFile(archivePath, archive, {mode: 0o600});
  paths.set('WINDOWS_ARCHIVE', archivePath); sourceBytes.set('WINDOWS_ARCHIVE', archive);
  async function original(id, value) {
    const bytes = Buffer.from(canonical(value) + '\n');
    const path = join(originals, hash(Buffer.from(id)) + '.json');
    await writeFile(path, bytes, {mode: 0o600});
    const ref = observation(id, bytes); refs.set(id, ref); originalPaths.set(id, path); return ref;
  }
  const sourceManifestHash = hash(Buffer.from('independent runtime source-object fixture'));
  const lockHash = hash(Buffer.from('independent locked-dependency fixture'));
  const writerManifestHash = hash(Buffer.from('independent writer source-object fixture'));
  const runtimeSource = {repository: 'zbaksa/rbridge-public', sourceSha: RUNTIME_SHA, treeSha: RUNTIME_TREE, sourceObjectManifestSha256: sourceManifestHash, packageLockSha256: lockHash};
  const writerSource = {repository: 'zbaksa/rbridge-public', sourceSha: '1'.repeat(40), treeSha: '2'.repeat(40), sourceObjectManifestSha256: writerManifestHash};
  const runtimeRef = await original('fixture:source:runtime', {schema: 'RBRIDGE_STAGED_ARTIFACT_FIXTURE_SOURCE_V1', authority: 'SOURCE_FIXTURE', role: 'RUNTIME', ...runtimeSource, ...sourceObservation});
  const writerRef = await original('fixture:source:writer', {schema: 'RBRIDGE_STAGED_ARTIFACT_FIXTURE_SOURCE_V1', authority: 'SOURCE_FIXTURE', role: 'WRITER', ...writerSource, packageLockSha256: null});
  const tools = {};
  for (const [tool, version] of [['TYPESCRIPT', '6.0.3'], ['VITE', '8.2.2'], ['WINDOWS_NODE', '22.23.3'], ['POSTJECT', '1.0.0-alpha.6']]) {
    tools[tool] = await original(`fixture:tool:${tool}`, {schema: 'RBRIDGE_STAGED_ARTIFACT_FIXTURE_TOOL_V1', authority: 'SOURCE_FIXTURE', tool, version, binarySha256: hash(Buffer.from(`independent tool bytes ${tool}`)), packageLockSha256: tool === 'POSTJECT' ? null : lockHash});
  }
  const acquisitions = new Map();
  for (const entry of [...ENTRIES, {id: 'WINDOWS_ARCHIVE', component: 'WINDOWS_PACKAGE'}]) {
    const bytes = sourceBytes.get(entry.id);
    const archiveMemberPath = entry.component === 'WINDOWS_PACKAGE' && entry.id !== 'WINDOWS_ARCHIVE' ? 'retained/' + entry.id.split('/').at(-1) : null;
    acquisitions.set(entry.id, await original(`fixture:acquired:${hash(Buffer.from(entry.id))}`, {schema: 'RBRIDGE_STAGED_ARTIFACT_FIXTURE_ACQUISITION_V1', authority: 'SOURCE_FIXTURE', memberId: entry.id, sha256: hash(bytes), bytes: bytes.length, originId: `fixture:build:${entry.component}`, archiveMemberPath}));
  }
  const buildRefs = {};
  const commands = {LINUX_RUNTIME: 'BUILD_SERVER', EXTENSION: 'BUILD_EXTENSION', NATIVE_BUNDLE: 'BUILD_NATIVE_HOST', WINDOWS_PACKAGE: 'BUILD_WINDOWS_SEA'};
  const windows = {runId: 9001, jobId: 9002, artifactId: 9003, archiveRef: acquisitions.get('WINDOWS_ARCHIVE'), archiveMembers: ENTRIES.filter(e => e.component === 'WINDOWS_PACKAGE').map(entry => ({id: entry.id, archiveMemberPath: 'retained/' + entry.id.split('/').at(-1), memberRef: acquisitions.get(entry.id)}))};
  for (const component of COMPONENTS) {
    const toolchainRefs = [tools.TYPESCRIPT];
    if (component !== 'LINUX_RUNTIME') toolchainRefs.push(tools.VITE);
    if (component === 'WINDOWS_PACKAGE') toolchainRefs.push(tools.WINDOWS_NODE, tools.POSTJECT);
    const members = ENTRIES.filter(e => e.component === component).map(entry => ({id: entry.id, sha256: hash(sourceBytes.get(entry.id)), bytes: sourceBytes.get(entry.id).length, acquisitionRef: acquisitions.get(entry.id)}));
    buildRefs[component] = await original(`fixture:build:${component}`, {schema: 'RBRIDGE_STAGED_ARTIFACT_FIXTURE_BUILD_V1', authority: 'SOURCE_FIXTURE', component, runtimeSourceRef: runtimeRef, commandId: commands[component], toolchainRefs: toolchainRefs.sort((a, b) => a.id.localeCompare(b.id)), members, windows: component === 'WINDOWS_PACKAGE' ? windows : null});
  }
  async function pinnedDirectory(path, handle, code) {
    const current = await lstat(path), pinned = await handle.stat();
    if (!sameFile(current, pinned) || !current.isDirectory() || current.isSymbolicLink() || current.uid !== process.getuid() || (current.mode & 0o077) !== 0) fail(code);
  }
  async function safePath(path) {
    await pinnedDirectory(input, inputDirectory, 'STAGED_ARTIFACT_MEMBER_UNSAFE');
    const rel = relative(input, path);
    if (rel.startsWith('..') || rel.startsWith('/') || rel.includes('\\')) fail('STAGED_ARTIFACT_MEMBER_UNSAFE');
    let parent = dirname(path);
    while (parent !== input) {
      const state = await lstat(parent);
      if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid() || (state.mode & 0o022) !== 0) fail('STAGED_ARTIFACT_MEMBER_UNSAFE');
      parent = dirname(parent);
    }
    if (await realpath(dirname(path)) !== dirname(path)) fail('STAGED_ARTIFACT_MEMBER_UNSAFE');
  }
  async function inspectFixedSurface(component) {
    await pinnedDirectory(input, inputDirectory, 'STAGED_ARTIFACT_MEMBER_UNSAFE');
    const entries = [];
    for (const entry of ENTRIES.filter(e => e.component === component)) {
      let kind = 'REGULAR';
      try {
        await safePath(paths.get(entry.id));
        const value = await lstat(paths.get(entry.id));
        if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.uid !== process.getuid() || (value.mode & 0o022) !== 0) kind = 'UNSAFE';
      } catch (error) { kind = error.code === 'ENOENT' ? 'MISSING' : 'UNSAFE'; }
      entries.push({id: entry.id, emittedPath: entry.path, kind});
    }
    const roots = {LINUX_RUNTIME: 'dist/src', EXTENSION: 'dist-extension', NATIVE_BUNDLE: 'dist-native-host', WINDOWS_PACKAGE: 'dist-native-host'};
    const expectedInSharedRoot = new Set(ENTRIES.map(e => e.path));
    async function walk(directory) {
      if (directory === hooks.directoryReadTarget) events.observedDirectoryReads += 1;
      for (const child of await readdir(directory, {withFileTypes: true})) {
        const path = join(directory, child.name), emittedPath = relative(input, path).split('\\').join('/');
        if (child.isDirectory()) await walk(path);
        else if (!expectedInSharedRoot.has(emittedPath)) entries.push({id: `${component}:${emittedPath}`, emittedPath, kind: 'UNSAFE'});
      }
    }
    await walk(join(input, roots[component]));
    return {entries: entries.sort((a, b) => a.id.localeCompare(b.id))};
  }
  async function openFixedMember(id) {
    const path = paths.get(id); if (!path) fail('STAGED_ARTIFACT_INPUT_INVALID');
    await safePath(path);
    let before;
    try { before = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o022) !== 0) fail('STAGED_ARTIFACT_MEMBER_UNSAFE');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!sameFile(before, await file.stat())) { await file.close(); fail('STAGED_ARTIFACT_BYTES_CHANGED'); }
    let position = 0;
    const handle = {
      async stat() {
        await safePath(path);
        const state = await file.stat();
        if (!sameFile(await lstat(path), state)) fail('STAGED_ARTIFACT_BYTES_CHANGED');
        return fileState(state);
      },
      async read(maxBytes) {
        assert.ok(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= 65536);
        const bytes = Buffer.alloc(maxBytes);
        const got = await file.read(bytes, 0, maxBytes, position); position += got.bytesRead;
        events.reads.push(id);
        if (hooks.afterRead) await hooks.afterRead(id, path);
        return Uint8Array.from(bytes.subarray(0, got.bytesRead));
      },
      async close() { await file.close(); },
    };
    const entry = ENTRIES.find(e => e.id === id);
    return {handle, acquisitionRef: acquisitions.get(id), archiveMemberPath: entry?.component === 'WINDOWS_PACKAGE' ? 'retained/' + id.split('/').at(-1) : null};
  }
  async function readOriginal(ref) {
    const path = originalPaths.get(ref.id);
    if (!path) return null;
    events.originalReads.set(ref.id, (events.originalReads.get(ref.id) ?? 0) + 1);
    return Uint8Array.from(await readFile(path));
  }
  async function publish(bytes, digest) {
    await pinnedDirectory(output, outputDirectory, 'OUTPUT_UNSAFE');
    if (bytes.length > 262144 || !/^[0-9a-f]{64}$/.test(digest)) fail('STAGED_ARTIFACT_BOUNDS_EXCEEDED');
    const final = join(output, digest + '.json'), temporary = join(output, '.pending-' + randomUUID());
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(bytes);
      if (hooks.failFileSync) fail('OUTPUT_UNSAFE');
      await file.sync(); await file.close();
      try { await link(temporary, final); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await unlink(temporary);
      const current = await lstat(final);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid() || (current.mode & 0o777) !== 0o600) fail('OUTPUT_UNSAFE');
      const readback = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW);
      let actual;
      try {
        if (!sameFile(current, await readback.stat())) fail('OUTPUT_UNSAFE');
        events.outputReads += 1;
        actual = await readback.readFile();
      } finally { await readback.close(); }
      if (!Buffer.from(bytes).equals(actual)) fail('OUTPUT_COLLISION');
      await pinnedDirectory(output, outputDirectory, 'OUTPUT_UNSAFE');
      await outputDirectory.sync();
      const ref = observation('fixture:manifest:' + digest, actual);
      events.publications.push(ref); return ref;
    } catch (error) {
      await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error;
    }
  }
  const qualification = {runtimeSourceRef: runtimeRef, writerSourceRef: writerRef, buildRefs, windowsArtifact: {repository: 'zbaksa/rbridge-public', runId: 9001, jobId: 9002, artifactId: 9003, registryArchiveBytes: archive.length, registryArchiveSha256: hash(archive), archiveAcquisitionRef: acquisitions.get('WINDOWS_ARCHIVE'), archiveMeasuredBytes: null, archiveMeasuredSha256: null}};
  const binding = {observedAt: '2026-10-03T02:00:00.000Z', runtimeSource, writerSource, qualification, inspectFixedSurface, openFixedMember, readOriginal, publish};
  return {root, input, output, sentinel, paths, sourceBytes, refs, originalPaths, manifest, metadata, hooks, events, binding};
}
function member(record, id) { return Object.values(record.components).flatMap(value => value.files).find(file => file.id === id); }
function reasons(record) { return [...record.reasons, ...Object.values(record.components).flatMap(value => value.reasons), ...Object.values(record.components).flatMap(value => value.files.flatMap(file => file.reasons))]; }
async function noOutput(f) { assert.deepEqual(await readdir(f.output), []); assert.equal(await readFile(f.sentinel, 'utf8'), 'original history\n'); }

// Bug caught: empty/default collection or a caller-selected LIVE authority.
test('complete member bytes produce a private SOURCE_FIXTURE inventory', async t => {
  const f = await fixture(t);
  const result = await collectStagedArtifactFixtureInventory(f.binding), record = result.record;
  assert.equal(record.schema, 'RBRIDGE_M0_V3_STAGED_ARTIFACT_INVENTORY_V1');
  assert.equal(record.scope, 'SOURCE_ARTIFACT_INVENTORY_ONLY');
  assert.equal(record.producer.kind, 'SOURCE_FIXTURE');
  assert.equal(record.availabilityState, 'PASS');
  assert.equal(record.sourceToBytesState, 'BLOCKED');
  assert.ok(record.reasons.includes('SOURCE_FIXTURE_NOT_QUALIFICATION'));
  assert.equal(Object.values(record.components).flatMap(value => value.files).length, 51);
  for (const entry of ENTRIES) {
    assert.equal(member(record, entry.id).sha256, hash(f.sourceBytes.get(entry.id)));
    assert.equal(member(record, entry.id).bytes, f.sourceBytes.get(entry.id).length);
    assert.equal(record.components[entry.component].sourceToBytesState, 'BLOCKED');
  }
  const digestBody = {...record}; delete digestBody.manifestSha256;
  assert.equal(record.manifestSha256, hash(Buffer.from(canonical(digestBody))));
  const stored = await readFile(join(f.output, record.manifestSha256 + '.json'));
  assert.deepEqual(stored, Buffer.from(canonical(record) + '\n'));
  assert.equal(result.observationRef.sha256, hash(stored));
  assert.equal(result.observationRef.bytes, stored.length);
  assert.equal((await lstat(f.output)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(f.output, record.manifestSha256 + '.json'))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(f.output, record.manifestSha256 + '.json'))).nlink, 1);
  assert.equal(await readFile(f.sentinel, 'utf8'), 'original history\n');
});

// Bug caught: sampling an entrypoint or relabeling marker-only input as complete.
for (const id of [CLI, DEPENDENCY, WORKER, BUNDLE, EXE, METADATA, INSTALLER]) {
  test(`missing member retains a null byte proof: ${id}`, async t => {
    const f = await fixture(t); await unlink(f.paths.get(id));
    await writeFile(join(f.input, 'SOURCE_SHA'), RUNTIME_SHA + '\n', {mode: 0o600});
    const {record} = await collectStagedArtifactFixtureInventory(f.binding);
    assert.equal(record.availabilityState, 'BLOCKED');
    assert.equal(member(record, id).bytes, null); assert.equal(member(record, id).sha256, null);
    assert.equal(member(record, id).acquisitionRef, null);
    assert.ok(reasons(record).includes(id.startsWith('WINDOWS_PACKAGE:') ? 'WINDOWS_ARTIFACT_MEMBER_MISSING' : 'STAGED_ARTIFACT_MEMBER_MISSING'));
  });
}

// Bug caught: accepting labels/hashes instead of measuring current file bytes.
for (const id of [DEPENDENCY, WORKER, BUNDLE, INSTALLER]) {
  test(`an altered member cannot inherit its original byte association: ${id}`, async t => {
    const f = await fixture(t); await appendFile(f.paths.get(id), '\n// changed bytes\n');
    const {record} = await collectStagedArtifactFixtureInventory(f.binding);
    assert.equal(member(record, id).sha256, hash(await readFile(f.paths.get(id))));
    assert.notEqual(member(record, id).sha256, hash(f.sourceBytes.get(id)));
    assert.ok(reasons(record).includes('SOURCE_TO_BYTE_BINDING_MISMATCH'));
  });
}

test('broad extension permissions remain blocked despite a valid JSON manifest', async t => {
  const f = await fixture(t); const manifest = {...f.manifest, permissions: [...f.manifest.permissions, 'debugger']};
  await writeFile(f.paths.get(MANIFEST), canonical(manifest) + '\n');
  const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.ok(reasons(record).includes('STAGED_ARTIFACT_FORMAT_INVALID'));
});

test('wrong embedded worker release remains blocked', async t => {
  const f = await fixture(t); await writeFile(f.paths.get(WORKER), `const release = '${'7'.repeat(40)}';\n`);
  const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.ok(reasons(record).includes('STAGED_ARTIFACT_FORMAT_INVALID'));
});

test('an archive digest never substitutes for executable bytes', async t => {
  const f = await fixture(t); await unlink(f.paths.get(EXE));
  const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.equal(record.qualification.windowsArtifact.archiveMeasuredSha256, hash(f.sourceBytes.get('WINDOWS_ARCHIVE')));
  assert.equal(member(record, EXE).sha256, null);
  assert.notEqual(hash(f.sourceBytes.get('WINDOWS_ARCHIVE')), hash(f.sourceBytes.get(EXE)));
});

test('missing archive acquisition remains explicit while executable bytes are measurable', async t => {
  const f = await fixture(t); await unlink(f.paths.get('WINDOWS_ARCHIVE'));
  const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.equal(record.qualification.windowsArtifact.archiveMeasuredSha256, null);
  assert.equal(member(record, EXE).sha256, hash(f.sourceBytes.get(EXE)));
  assert.ok(reasons(record).includes('WINDOWS_ARTIFACT_BYTES_UNAVAILABLE'));
});

test('metadata PASS cannot conceal an executable digest mismatch', async t => {
  const f = await fixture(t); await writeFile(f.paths.get(METADATA), canonical({...f.metadata, sha256: 'a'.repeat(64)}) + '\n');
  const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.ok(reasons(record).includes('WINDOWS_EXECUTABLE_METADATA_MISMATCH'));
});

test('an MZ prefix without a valid PE signature remains blocked', async t => {
  const f = await fixture(t), bytes = Buffer.from(f.sourceBytes.get(EXE)); bytes.write('NOPE', 128);
  await writeFile(f.paths.get(EXE), bytes);
  const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.ok(reasons(record).includes('STAGED_ARTIFACT_FORMAT_INVALID'));
});

test('a mismatched original runtime tree cannot qualify measured bytes', async t => {
  const f = await fixture(t, {treeSha: '3'.repeat(40)});
  const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.equal(record.runtimeSource.treeSha, RUNTIME_TREE);
  assert.ok(reasons(record).includes('SOURCE_TO_BYTE_BINDING_MISMATCH'));
});

for (const [name, change] of [
  ['writer source', f => { f.binding.writerSource.sourceSha = '4'.repeat(40); }],
  ['source lock', f => { f.binding.runtimeSource.packageLockSha256 = '5'.repeat(64); }],
  ['Windows job', f => { f.binding.qualification.windowsArtifact.jobId = 9999; }],
]) {
  test(`a supplied ${name} cannot replace original provenance`, async t => {
    const f = await fixture(t); change(f);
    const {record} = await collectStagedArtifactFixtureInventory(f.binding);
    assert.ok(reasons(record).includes('SOURCE_TO_BYTE_BINDING_MISMATCH'));
    assert.equal(record.sourceToBytesState, 'BLOCKED');
  });
}

test('altered original qualification bytes are checked before parsing', async t => {
  const f = await fixture(t); await appendFile(f.originalPaths.get('fixture:build:LINUX_RUNTIME'), ' ');
  const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.ok(reasons(record).includes('ORIGINAL_QUALIFICATION_UNAVAILABLE'));
});

for (const [name, change] of [
  ['symlink', async f => { await unlink(f.paths.get(DEPENDENCY)); await symlink(f.sentinel, f.paths.get(DEPENDENCY)); }],
  ['hardlink', async f => { await unlink(f.paths.get(DEPENDENCY)); await link(f.sentinel, f.paths.get(DEPENDENCY)); }],
  ['writable ancestor', async f => { await chmod(dirname(f.paths.get(DEPENDENCY)), 0o770); }],
  ['unexpected member', async f => { await writeFile(join(f.input, 'dist/src/server/unknown.js'), 'foreign', {mode: 0o600}); }],
]) {
  test(`unsafe ${name} is rejected before publication`, async t => {
    const f = await fixture(t); await change(f);
    await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), error => error.message === 'STAGED_ARTIFACT_MEMBER_UNSAFE' || error.message === 'STAGED_ARTIFACT_INPUT_INVALID');
    await noOutput(f);
  });
}

test('a member changed during its actual stream produces no published receipt', async t => {
  const f = await fixture(t); let changed = false;
  f.hooks.afterRead = async (id, path) => { if (id === DEPENDENCY && !changed) { changed = true; await appendFile(path, 'changed during read'); } };
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_BYTES_CHANGED'});
  await noOutput(f);
});

test('oversized compiled member is rejected before reading that member', async t => {
  const f = await fixture(t); const file = await open(f.paths.get(DEPENDENCY), 'r+');
  try { await file.truncate(2 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_BOUNDS_EXCEEDED'});
  assert.equal(f.events.reads.includes(DEPENDENCY), false); await noOutput(f);
});

test('a LIVE field is rejected rather than acquiring a production binding', async t => {
  const f = await fixture(t); f.binding.mode = 'LIVE';
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_INPUT_INVALID'}); await noOutput(f);
});

for (const [name, change] of [
  ['repository', f => { f.binding.runtimeSource.repository = 'foreign/public'; }],
  ['app', f => { f.binding.appId = 'foreign-app'; }],
  ['path', f => { f.binding.path = '/srv/foreign'; }],
  ['process', f => { f.binding.pid = 1; }],
  ['author', f => { f.binding.author = 'foreign-author'; }],
  ['owner', f => { f.binding.uid = 0; }],
]) {
  test(`caller-selected ${name} cannot expand the fixture authority`, async t => {
    const f = await fixture(t); change(f);
    await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_INPUT_INVALID'});
    await noOutput(f);
  });
}

test('duplicate member IDs are rejected before opening any member', async t => {
  const f = await fixture(t), inspect = f.binding.inspectFixedSurface;
  f.binding.inspectFixedSurface = async component => {
    const value = await inspect(component);
    return component === 'LINUX_RUNTIME' ? {entries: [...value.entries, value.entries[0]]} : value;
  };
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_INPUT_INVALID'});
  assert.deepEqual(f.events.reads, []); await noOutput(f);
});

test('accessors are rejected without invoking a supplied getter', async t => {
  const f = await fixture(t); let called = 0;
  Object.defineProperty(f.binding, 'mode', {enumerable: true, get() { called += 1; return 'LIVE'; }});
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_INPUT_INVALID'});
  assert.equal(called, 0); await noOutput(f);
});

test('a conflicting original reference is rejected before member reads', async t => {
  const f = await fixture(t); f.binding.qualification.writerSourceRef = {...f.binding.qualification.runtimeSourceRef, sha256: '6'.repeat(64)};
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_INPUT_INVALID'});
  assert.deepEqual(f.events.reads, []); await noOutput(f);
});

test('identical replay preserves the immutable private output', async t => {
  const f = await fixture(t); const first = await collectStagedArtifactFixtureInventory(f.binding);
  const second = await collectStagedArtifactFixtureInventory(f.binding);
  assert.deepEqual(second.observationRef, first.observationRef);
  assert.deepEqual(await readdir(f.output), [first.record.manifestSha256 + '.json']);
});

test('changed existing output is a collision and is never overwritten', async t => {
  const f = await fixture(t); const first = await collectStagedArtifactFixtureInventory(f.binding);
  const path = join(f.output, first.record.manifestSha256 + '.json'); await writeFile(path, 'foreign retained bytes');
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'OUTPUT_COLLISION'});
  assert.equal(await readFile(path, 'utf8'), 'foreign retained bytes');
});

test('unsafe output ownership mode prevents publication', async t => {
  const f = await fixture(t); await chmod(f.output, 0o770);
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'OUTPUT_UNSAFE'}); await noOutput(f);
});

test('file sync failure cannot produce a published receipt', async t => {
  const f = await fixture(t); f.hooks.failFileSync = true;
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'OUTPUT_UNSAFE'}); await noOutput(f);
});

test('missing host proof stays NOT_INSPECTED in a complete fixture inventory', async t => {
  const f = await fixture(t); const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.deepEqual(record.hostPrerequisites, {state: 'NOT_INSPECTED', reason: 'HOST_RUNTIME_BINDING_UNVERIFIED', bindings: {NODE: null, FLOCK: null, SHARED_LIBRARIES_ENVIRONMENT: null}});
  assert.equal(record.availabilityState, 'PASS'); assert.equal(record.sourceToBytesState, 'BLOCKED');
});

test('the public entry without a fixture binding remains inert and unavailable', async () => {
  await assert.rejects(collectStagedArtifactFixtureInventory(), {message: 'SOURCE_ARTIFACT_ACQUISITION_BINDING_UNAVAILABLE'});
});

// Review regression: a post-read limit does not prevent an oversized sparse
// original from being acquired through the actual private fixture adapter.
test('an oversized retained original is rejected before its byte read', async t => {
  const f = await fixture(t), id = 'fixture:source:runtime';
  const file = await open(f.originalPaths.get(id), 'r+');
  try { await file.truncate(1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_BOUNDS_EXCEEDED'});
  await noOutput(f);
  assert.equal(f.events.originalReads.get(id) ?? 0, 0);
});

// Review regression: each acquisition is individually <=1MiB, but the next
// declared original must fit the remaining16MiB before the adapter reads it.
test('the aggregate original budget is checked before the next byte read', async t => {
  const f = await fixture(t), buildId = 'fixture:build:LINUX_RUNTIME';
  const buildPath = f.originalPaths.get(buildId), build = JSON.parse(await readFile(buildPath, 'utf8'));
  for (const member of build.members.slice(0, 17)) {
    const path = f.originalPaths.get(member.acquisitionRef.id), raw = await readFile(path);
    const padded = Buffer.alloc(1024 * 1024, 0x20); raw.copy(padded);
    await writeFile(path, padded);
    member.acquisitionRef = observation(member.acquisitionRef.id, padded);
  }
  const bytes = Buffer.from(canonical(build) + '\n');
  await writeFile(buildPath, bytes);
  f.binding.qualification.buildRefs.LINUX_RUNTIME = observation(buildId, bytes);
  // Noncanonical padded originals remain unavailable; those acquired bytes
  // still consume the hard budget and cannot exempt the next original.
  const nextBeyondBudget = build.members[15].acquisitionRef.id;
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_BOUNDS_EXCEEDED'});
  await noOutput(f);
  assert.equal(f.events.originalReads.get(nextBeyondBudget) ?? 0, 0);
});

// Review regression: a large existing collision must not be read, overwritten
// or reported as a new publication. The oversized tail is created sparsely.
test('an oversized existing output collision is rejected before readback', async t => {
  const f = await fixture(t), first = await collectStagedArtifactFixtureInventory(f.binding);
  const path = join(f.output, first.record.manifestSha256 + '.json'), beforeReads = f.events.outputReads;
  const file = await open(path, 'r+');
  try { await file.truncate(262144 + 1); } finally { await file.close(); }
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'OUTPUT_COLLISION'});
  assert.equal((await lstat(path)).size, 262144 + 1);
  assert.deepEqual(await readdir(f.output), [first.record.manifestSha256 + '.json']);
  assert.equal(f.events.publications.length, 1);
  assert.equal(await readFile(f.sentinel, 'utf8'), 'original history\n');
  assert.equal(f.events.outputReads, beforeReads);
});

// Review regression: per-stream stability is insufficient if a later actual
// stream replaces a path whose earlier stream has already closed.
test('a later member cannot replace an earlier closed member before publication', async t => {
  const f = await fixture(t); let replaced = false;
  f.hooks.afterRead = async id => {
    if (id === BUNDLE && !replaced) {
      assert.ok(f.events.reads.includes(DEPENDENCY)); replaced = true;
      await unlink(f.paths.get(DEPENDENCY));
      await writeFile(f.paths.get(DEPENDENCY), 'replacement after earlier stream closed\n', {mode: 0o600});
    }
  };
  await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_BYTES_CHANGED'});
  assert.equal(replaced, true); await noOutput(f);
});

for (const [name, writable] of [['empty', false], ['writable', true]]) {
  // Review regression: unknown directories are namespace entries even when
  // empty. Reject before recursively reading them or opening any member.
  test(`an unknown ${name} directory is rejected before member or directory reads`, async t => {
    const f = await fixture(t), extra = join(f.input, 'dist/src/foreign-empty-directory');
    await mkdir(extra, {mode: 0o700});
    if (writable) await chmod(extra, 0o770);
    f.hooks.directoryReadTarget = extra;
    await assert.rejects(collectStagedArtifactFixtureInventory(f.binding), {message: 'STAGED_ARTIFACT_MEMBER_UNSAFE'});
    assert.deepEqual(f.events.reads, []); assert.equal(f.events.observedDirectoryReads, 0);
    await noOutput(f);
  });
}

// Review regression: safe absence of a complete component root must preserve
// all fixed member IDs and emit missing placeholders instead of walk ENOENT.
test('a missing extension root emits all three null proofs and BLOCKED availability', async t => {
  const f = await fixture(t); await rm(join(f.input, 'dist-extension'), {recursive: true});
  const {record} = await collectStagedArtifactFixtureInventory(f.binding);
  assert.equal(record.availabilityState, 'BLOCKED');
  assert.equal(record.components.EXTENSION.availabilityState, 'BLOCKED');
  assert.equal(record.components.EXTENSION.files.length, 3);
  assert.equal(Object.values(record.components).flatMap(value => value.files).length, 51);
  for (const path of PATHS.EXTENSION) {
    const proof = member(record, `EXTENSION:${path}`);
    assert.equal(proof.bytes, null); assert.equal(proof.sha256, null); assert.equal(proof.acquisitionRef, null);
    assert.deepEqual(proof.reasons, ['STAGED_ARTIFACT_MEMBER_MISSING']);
  }
  assert.equal(record.sourceToBytesState, 'BLOCKED');
  assert.equal(record.producer.kind, 'SOURCE_FIXTURE');
  assert.ok(record.reasons.includes('SOURCE_FIXTURE_NOT_QUALIFICATION'));
});
