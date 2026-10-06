import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {prepareArchivedReaderInput,runArchivedCoreProducer} from '../../src/installation/archivedReaderFixture.js';
import {parseRBridgeInstallProfile} from '../../src/installation/types.js';

const source=JSON.parse(readFileSync(new URL('../fixtures/rbridge-artifact-preimages.json',import.meta.url),'utf8'));
const profile=parseRBridgeInstallProfile(source.profile),home=profile.binding.home+'/.rbridge-artifact-'+'a'.repeat(32);
const fixture=structuredClone(source.artifact),original=fixture.receipts[0],receipt=JSON.parse(original.receiptJSON);
const mcp=(era:'legacy'|'modern')=>({fixture_id:'source-'+era,case_id:'C09',provenance:'SYNTHETIC',
  expected_verdict_sha256:'b'.repeat(64),transport:'MCP',era,expected:{operationId:'artifact-health',
    principalId:profile.binding.principal_id,targetInstanceId:profile.binding.target_instance_id,runtime_uid:profile.binding.uid,
    intent_sha256:receipt.intentSha256,policy_sha256:profile.binding.policy_sha256,
    receipt_sha256:original.receiptSHA256,output_sha256:original.resultSHA256,deadline_ms:15000}});

describe('archived isolated reader fixture Source data',()=>{
  it('refuses a caller-made installed authority before opening the original owner',async()=>{
    await expect(runArchivedCoreProducer({profile} as never,{} as never,home,fixture,'c'.repeat(64))).rejects.toThrow('READER_');
  });
  it('binds both real SDK eras to original known operation receipts and one isolated home',()=>{
    expect(source.scope).toBe('SYNTHETIC_SOURCE_DATA_ONLY');
    const cases=[mcp('legacy'),mcp('modern')],result=prepareArchivedReaderInput(profile,{cases},fixture,home);
    expect(result.root).toBe(home+'/.local/state/rbridge/execution-v2');
    expect(result.fixtures.cases.map(row=>row.isolated_root)).toEqual([result.root,result.root]);
    expect(cases[0]).not.toHaveProperty('isolated_root');
  });
  it('rejects live roots, unknown operations, replaced receipts and missing or repeated eras',()=>{
    const cases=[mcp('legacy'),mcp('modern')];
    for(const path of [profile.binding.home,home+'/child','/tmp/source-fixture'])
      expect(()=>prepareArchivedReaderInput(profile,{cases},fixture,path)).toThrow();
    for(const changed of [{...cases[0]!,expected:{...cases[0]!.expected,operationId:'unrelated-production-id'}},
      {...cases[0]!,expected:{...cases[0]!.expected,receipt_sha256:'f'.repeat(64)}},
      {...cases[0]!,isolated_root:profile.paths.state_root+'/execution-v2'}])
      expect(()=>prepareArchivedReaderInput(profile,{cases:[changed,cases[1]]},fixture,home)).toThrow();
    for(const rows of [[],[cases[0]],[cases[0],cases[0]],cases.concat(cases[0]!)])
      expect(()=>prepareArchivedReaderInput(profile,{cases:rows},fixture,home)).toThrow();
    const changed=structuredClone(fixture);changed.receipts[0].resultBase64=Buffer.from('{}').toString('base64');
    expect(()=>prepareArchivedReaderInput(profile,{cases},changed,home)).toThrow();
  });
});
