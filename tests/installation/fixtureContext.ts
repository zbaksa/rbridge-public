import {readFile} from 'node:fs/promises';
import {parseRBridgeInstallProfile} from '../../src/installation/types.js';
import {openFixtureReadonlySnapshot} from '../../src/installation/readonlySnapshot.js';
import {installHash,type GateContext} from '../../src/installation/gateContext.js';

export async function fixtureGateContext(root:string):Promise<GateContext>{
  const profile=parseRBridgeInstallProfile(JSON.parse(await readFile(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')));
  const snapshot=await openFixtureReadonlySnapshot(root,process.getuid!());
  const token={transaction_id:'a'.repeat(32),state_root_identity_sha256:'1'.repeat(64),tree_sha256:snapshot.treeSHA256,entries:snapshot.entries.length,bytes:snapshot.bytes,pause_sha256:'2'.repeat(64),captured_at:'2026-10-06T00:00:00.000Z'};
  return {profile,snapshot,token,issues:[],lookup:{scope:'FIXTURE_AUTHORITY_ONLY',status:'PASS',viewer:profile.binding.author,repository:profile.binding.repository,profile_sha256:installHash(profile),snapshot_sha256:installHash(token),capture_sha256:installHash([])}};
}
