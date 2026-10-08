import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {describe,expect,it} from 'vitest';
import {createRBridgeMcpSafeServer} from '../../src/server/rbridgeMcpSafe.js';
import {createFixtureSdkReadClient,type McpReadClient} from '../../src/installation/rbridge-installation-client.js';
import {readRBridgeMcpOutput} from '../../src/installation/readerQualification.js';
import {RBRIDGE_ENABLED_ACTIONS} from '../../src/domain/rbridgeCoreProtocol.js';
import {parseRBridgeInstallProfile} from '../../src/installation/types.js';
import {installHash} from '../../src/installation/gateContext.js';
import type {RBridgeExecutionReceiptV1} from '../../src/domain/rbridgeExecutionContract.js';
import {createMcpNegativeFixtureServer} from '../../src/installation/mcpNegativeFixture.js';

const source=JSON.parse(readFileSync(new URL('../fixtures/rbridge-artifact-preimages.json',import.meta.url),'utf8'));
const profile=parseRBridgeInstallProfile(source.profile),originals=source.artifact.receipts;
const binding={runtimeUid:profile.binding.uid,principalId:profile.binding.principal_id,targetInstanceId:profile.binding.target_instance_id};
async function producer(){
  let module;
  try{module=await import('../../src/installation/mcpArtifactFixture.js');}catch{/* Missing producer is the expected initial RED. */}
  expect(module?.produceMcpArtifactCases,'fixed MCP producer is absent').toBeTypeOf('function');
  return module!.produceMcpArtifactCases;
}
async function sdk(era:'legacy'|'modern',negative=false){
  const [wire,serverWire]=InMemoryTransport.createLinkedPair();
  const handle=serveStdio(()=>negative?createMcpNegativeFixtureServer(binding,profile.binding.policy_sha256,JSON.parse(originals[0].receiptJSON)):createRBridgeMcpSafeServer({binding:{authenticatedSubject:profile.binding.mcp_subject,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId},
    bindingProvider:async()=>({schema:'RBRIDGE_CORE_BINDING_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',...binding,policySha256:profile.binding.policy_sha256,enabledActions:RBRIDGE_ENABLED_ACTIONS}),
    core:{async submit(){throw new Error('FIXTURE_MUST_NOT_SUBMIT');},async requestCancel(){throw new Error('FIXTURE_MUST_NOT_CANCEL');},
      async status(id){const row=originals.find((r:{operationId:string})=>r.operationId===id);if(!row)throw new Error('UNKNOWN_FIXTURE_ID');return {status:'RECEIPT',receipt:JSON.parse(row.receiptJSON) as RBridgeExecutionReceiptV1};},
      async result(id,cursor,maxBytes){const row=originals.find((r:{operationId:string})=>r.operationId===id);if(!row)throw new Error('UNKNOWN_FIXTURE_ID');const bytes=Buffer.from(row.resultBase64,'base64'),part=bytes.subarray(cursor,cursor+maxBytes);return {status:'RESULT',receipt:JSON.parse(row.receiptJSON) as RBridgeExecutionReceiptV1,resultSha256:row.resultSHA256,cursor,nextCursor:cursor+part.length,eof:cursor+part.length===bytes.length,dataBase64:part.toString('base64')};}}}),{transport:serverWire,legacy:'serve'});
  const client=new Client({name:'mcp-producer-source-fixture',version:'source'},{versionNegotiation:{mode:era==='legacy'?'legacy':{pin:'2026-07-28'}}});
  await client.connect(wire);
  return {client:await createFixtureSdkReadClient(client),async close(){await client.close();await handle.close();}};
}
const input=(clients:readonly McpReadClient[])=>({binding,source_sha:profile.runtime.source_sha,policy_sha256:profile.binding.policy_sha256,
  originals,clients,deadline_ms:Math.min(profile.budget.acceptance_ms,180000)});

describe('fixed MCP original-artifact producer Source data',()=>{
  it('captures both real SDK negotiations and derives exact read verdicts without invoking the reader',async()=>{
    const produce=await producer(),legacy=await sdk('legacy'),modern=await sdk('modern'),negativeLegacy=await sdk('legacy',true),negativeModern=await sdk('modern',true),before=JSON.stringify(originals);
    try{
      const report=await produce({...input([legacy.client,modern.client]),negativeClients:[negativeLegacy.client,negativeModern.client]});
      expect(report.scope).toBe('ISOLATED_MCP_SOURCE_DATA_ONLY');
      expect(report.cases).toHaveLength(24);
      expect(report.cases.slice(0,2).map(c=>[c.case_id,c.era,c.expected.operationId])).toEqual([['C09','legacy','artifact-health'],['C09','modern','artifact-read']]);
      for(const [index,c] of report.cases.slice(0,2).entries()){
        const verdict=JSON.parse(c.expected_verdict_json);
        expect(verdict.status).toBe('RESULT');expect(verdict.scope).toBe('REFERENCE_MCP_READ');
        expect(verdict.receipt.operationId).toBe(index===0?'artifact-health':'artifact-read');
        expect(verdict.sdk_package_version).toBe('2.3.0');expect(verdict.protocol_era).toBe(index===0?'legacy':'modern');
        expect(verdict.query_evidence.map((q:{name:string})=>q.name)).toEqual(['rbridge_capabilities','rbridge_status','rbridge_result','rbridge_status','rbridge_capabilities']);
        expect(installHash(verdict)).toBe(c.expected_verdict_canonical_sha256);
        expect(JSON.stringify(await readRBridgeMcpOutput(index===0?legacy.client:modern.client,c.expected))).toBe(c.expected_verdict_json);
      }
      expect(JSON.parse(report.cases[1]!.expected_verdict_json).output.text).toBe('artifact read é\n');
      expect(JSON.stringify(originals)).toBe(before);
      const comparison=spawnSync('python3',['-I','-B','-c',[
        'import copy,hashlib,json,sys',
        'sys.path.insert(0,sys.argv[1])',
        'from rbridge_installation.profile import parse_profile',
        'from rbridge_installation.mcp_collector import compare_mcp_producer_output',
        'from rbridge_installation.models import encode_report,report_sha256',
        'v=json.load(sys.stdin)',
        'result=compare_mcp_producer_output(parse_profile(v["profile"]),v["report"],v["artifact"])',
        'for change in ("receipt","whole-output","missing-query","arguments","SDK-era","frame"):',
        ' r=copy.deepcopy(v["report"]);c=r["cases"][0];oracle=json.loads(c["expected_verdict_json"]);transcript=json.loads(c["sdk_transcript_json"])',
        ' if change=="receipt": oracle["receipt"]["principalId"]="foreign-principal"',
        ' elif change=="whole-output": oracle["output_sha256"]="f"*64',
        ' elif change=="missing-query": transcript["responses"].pop()',
        ' elif change=="arguments": transcript["responses"][1]["arguments"]["operationId"]="unrelated-operation"',
        ' elif change=="SDK-era": oracle["protocol_era"]="modern";transcript["protocol_era"]="modern"',
        ' else: transcript["responses"][0]["response"]["structuredContent"]["executionAvailable"]=False',
        ' c["expected_verdict_json"]=encode_report(oracle).decode();c["expected_verdict_sha256"]=hashlib.sha256(c["expected_verdict_json"].encode()).hexdigest()',
        ' c["expected_verdict_canonical_sha256"]=report_sha256(oracle);c["sdk_transcript_json"]=encode_report(transcript).decode()',
        ' try: compare_mcp_producer_output(parse_profile(v["profile"]),r,v["artifact"])',
        ' except ValueError: pass',
        ' else: raise AssertionError("rehashed MCP proof accepted: "+change)',
        'print(json.dumps({"scope":result["scope"],"cases":len(result["fixtures"]),"may_execute":result["may_execute"],"rehashed_refusals":6}))',
      ].join('\n'),fileURLToPath(new URL('../../ops/install',import.meta.url))],{
        input:JSON.stringify({profile,report,artifact:source.artifact}),encoding:'utf8',timeout:15000,maxBuffer:131072});
      expect(comparison.status,comparison.stderr).toBe(0);
      expect(JSON.parse(comparison.stdout)).toEqual({scope:'ISOLATED_MCP_SOURCE_DATA_ONLY',cases:24,may_execute:false,rehashed_refusals:6});
    }finally{await negativeModern.close();await negativeLegacy.close();await modern.close();await legacy.close();}
  });
  it('rejects drifted live output even when receipt and synthetic Source metadata still match',async()=>{
    const produce=await producer(),legacy=await sdk('legacy'),modern=await sdk('modern');
    const changed:McpReadClient={...modern.client,async callTool(args,options){
      const result=await modern.client.callTool(args,options);
      if(args.name!=='rbridge_result')return result;
      const frame=structuredClone(result) as {content:{text:string}[];structuredContent:{result:{dataBase64:string}}};
      frame.structuredContent.result.dataBase64=Buffer.from('changed original output').toString('base64');
      frame.content[0]!.text=JSON.stringify(frame.structuredContent);return frame;
    }};
    try{
      await expect(produce(input([legacy.client,changed]))).rejects.toThrow('MCP_FIXTURE_');
      await expect(produce(input([legacy.client,legacy.client]))).rejects.toThrow('MCP_FIXTURE_');
      await expect(produce({...input([legacy.client,modern.client]),source_sha:'f'.repeat(40)})).rejects.toThrow('MCP_FIXTURE_');
    }finally{await modern.close();await legacy.close();}
  });
});
