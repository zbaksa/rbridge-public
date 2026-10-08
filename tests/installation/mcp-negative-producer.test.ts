import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {describe,expect,it} from 'vitest';
import {RBRIDGE_ENABLED_ACTIONS,type RBridgeCorePort} from '../../src/domain/rbridgeCoreProtocol.js';
import {createRBridgeMcpSafeServer} from '../../src/server/rbridgeMcpSafe.js';
import {createFixtureSdkReadClient,createInstalledMcpFixtureSession,isInstalledMcpReadClient,isInstalledMcpFixtureReadClient,type McpReadClient} from '../../src/installation/rbridge-installation-client.js';
import {produceMcpArtifactCases} from '../../src/installation/mcpArtifactFixture.js';
import {createMcpNegativeFixtureServer} from '../../src/installation/mcpNegativeFixture.js';
import {MCP_NEGATIVE_VARIANTS} from '../../src/installation/mcpNegativeCases.js';
import {readRBridgeMcpOutput,qualifyRBridgeReaders,createReferenceReaderRunner,type ReaderFixture} from '../../src/installation/readerQualification.js';
import {installHash} from '../../src/installation/gateContext.js';
import type {captureArtifactOperation} from '../../src/installation/artifactEvidence.js';

const source=JSON.parse(readFileSync(new URL('../fixtures/rbridge-artifact-preimages.json',import.meta.url),'utf8'));
const binding={runtimeUid:source.profile.binding.uid,principalId:source.profile.binding.principal_id,targetInstanceId:source.profile.binding.target_instance_id};
const originals=source.artifact.receipts as Array<ReturnType<typeof captureArtifactOperation>>;
function comparePython(output:unknown){
  const code=String.raw`import importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('source_loader',pathlib.Path('tests/install/_loader.py'))
loader=importlib.util.module_from_spec(spec);spec.loader.exec_module(loader);loader.toolkit()
from rbridge_installation.profile import parse_profile
from rbridge_installation.mcp_collector import compare_mcp_producer_output
packet=json.load(sys.stdin)
try:
 result=compare_mcp_producer_output(parse_profile(packet['profile']),packet['output'],packet['artifact'])
 print(json.dumps({'scope':result['scope'],'may_execute':result['may_execute'],'cases':len(result['fixtures'])}))
except ValueError as error:print(json.dumps({'refusal':str(error)}))`;
  const child=spawnSync('python3',['-I','-B','-c',code],{cwd:fileURLToPath(new URL('../../',import.meta.url)),input:JSON.stringify({profile:source.profile,artifact:source.artifact,output}),encoding:'utf8',timeout:10000,maxBuffer:65536});
  expect(child.status,child.stderr).toBe(0);return JSON.parse(child.stdout) as {scope?:string;may_execute?:boolean;cases?:number;refusal?:string};
}
describe('official SDK MCP negative producer Source fixtures',()=>{
  it('covers the full fixed matrix in both eras while preserving the original preimages',async()=>{
    expect(source.scope).toBe('SYNTHETIC_SOURCE_DATA_ONLY');
    const before=JSON.stringify(originals),closing:Array<()=>Promise<void>>=[],clients:McpReadClient[]=[],negativeClients:McpReadClient[]=[];
    const core:RBridgeCorePort={
      async submit(){throw new Error('SOURCE_FIXTURE_SUBMIT_FORBIDDEN');},
      async requestCancel(){throw new Error('SOURCE_FIXTURE_CANCEL_FORBIDDEN');},
      async status(id){const r=originals.find(o=>o.operationId===id);return r?{status:'RECEIPT',receipt:JSON.parse(r.receiptJSON)}:{status:'NOT_FOUND',operationId:id,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId};},
      async result(id,cursor){const r=originals.find(o=>o.operationId===id),page=r?.pagesJSON.map(raw=>JSON.parse(raw)).find(p=>p.cursor===cursor);if(!page)throw new Error('SOURCE_FIXTURE_PAGE_UNKNOWN');return page;},
    };
    try{
      for(const era of ['legacy','modern'] as const){
        const [wire,serverWire]=InMemoryTransport.createLinkedPair(),handle=serveStdio(()=>createRBridgeMcpSafeServer({
          binding:{authenticatedSubject:'uid:'+binding.runtimeUid,principalId:binding.principalId,targetInstanceId:binding.targetInstanceId},core,
          bindingProvider:async()=>({schema:'RBRIDGE_CORE_BINDING_V1',journalSchema:'RBRIDGE_EXECUTION_JOURNAL_V1',...binding,
            policySha256:source.profile.binding.policy_sha256,enabledActions:RBRIDGE_ENABLED_ACTIONS}),
        }),{transport:serverWire,legacy:'serve'});
        const sdk=new Client({name:'source-negative-matrix-regression',version:'source'},{versionNegotiation:{mode:era==='legacy'?'legacy':{pin:'2026-07-28'}}});
        closing.push(async()=>{await sdk.close();await handle.close();});await sdk.connect(wire);
        const client=await createFixtureSdkReadClient(sdk);expect(isInstalledMcpReadClient(client)).toBe(false);clients.push(client);
        const [negativeWire,negativeServerWire]=InMemoryTransport.createLinkedPair(),negativeHandle=serveStdio(()=>createMcpNegativeFixtureServer(binding,source.profile.binding.policy_sha256,JSON.parse(originals[0]!.receiptJSON)),{transport:negativeServerWire,legacy:'serve'});
        const negativeSdk=new Client({name:'source-negative-fixture',version:'source'},{versionNegotiation:{mode:era==='legacy'?'legacy':{pin:'2026-07-28'}}});
        closing.push(async()=>{await negativeSdk.close();await negativeHandle.close();});await negativeSdk.connect(negativeWire);
        const negativeClient=await createFixtureSdkReadClient(negativeSdk);expect(isInstalledMcpReadClient(negativeClient)).toBe(false);expect(isInstalledMcpFixtureReadClient(negativeClient)).toBe(false);negativeClients.push(negativeClient);
        await expect(async()=>negativeClient.callTool({name:'rbridge_submit',arguments:{}} as never,{signal:new AbortController().signal})).rejects.toThrow('READER_READ_ONLY_TOOL_REQUIRED');
      }
      const report=await produceMcpArtifactCases({binding,source_sha:source.profile.runtime.source_sha,
        policy_sha256:source.profile.binding.policy_sha256,originals,clients,negativeClients,deadline_ms:source.profile.budget.acceptance_ms});
      expect(report.cases).toHaveLength(24);
      expect(report.cases.slice(2).map(c=>c.fixture_id)).toEqual(['legacy','modern'].flatMap(era=>MCP_NEGATIVE_VARIANTS.map(v=>'mcp-producer-'+era+'-'+v)));
      for(const [index,c] of report.cases.entries()){
        const client=index<2?clients[index]!:negativeClients[c.era==='legacy'?0:1]!;
        const verdict=await readRBridgeMcpOutput(client,c.expected);expect(JSON.stringify(verdict)).toBe(c.expected_verdict_json);
        expect(installHash(verdict)).toBe(c.expected_verdict_canonical_sha256);
        if(index>=2)expect(verdict).not.toHaveProperty('output');
      }
      const registration={reader_id:'mcp-source-matrix',source_sha256:'d'.repeat(64),entrypoint:'/srv/fixture/rbridgeReadResult.js',version:'1',transport:'MCP' as const,
        trusted_context_sha256:'c'.repeat(64),qualification_sha256:'f'.repeat(64),adoption_sha256:'f'.repeat(64)};
      const cases:ReaderFixture[]=report.cases.map((c,index)=>({fixture_id:c.fixture_id,case_id:'C09',provenance:'SOURCE_PRODUCER',expected_verdict_sha256:c.expected_verdict_sha256,
        transport:'MCP',expected:c.expected,client:index<2?clients[index]!:negativeClients[c.era==='legacy'?0:1]!}));
      const qualification=await qualifyRBridgeReaders({readers:[registration],adoptions:[]},{cases},createReferenceReaderRunner());
      expect(qualification.referenceAcceptance).toBe('PASS');expect(qualification.actualAcceptance).toBe('UNKNOWN');
      expect(qualification.reason_codes).not.toContain('READER_SEMANTIC_MATRIX_INCOMPLETE');expect(qualification.invocations).toHaveLength(24);
      const comparison=comparePython(report);expect(comparison).toEqual({scope:'ISOLATED_MCP_SOURCE_DATA_ONLY',may_execute:false,cases:24});
      const incomplete=structuredClone(report);incomplete.cases=incomplete.cases.slice(0,2);expect(comparePython(incomplete).refusal).toBe('MCP_COLLECTOR_OUTPUT_INVALID');
      const wrongEra=structuredClone(report);wrongEra.cases[2]!.era='modern';expect(comparePython(wrongEra).refusal).toBe('MCP_COLLECTOR_CASE_INVALID');
      const rehashed=structuredClone(report),forged=rehashed.cases[3]!,verdict=JSON.parse(forged.expected_verdict_json);verdict.receipt.principalId='foreign-principal';
      forged.expected_verdict_json=JSON.stringify(verdict);forged.expected_verdict_sha256=createHash('sha256').update(forged.expected_verdict_json).digest('hex');forged.expected_verdict_canonical_sha256=installHash(verdict);
      expect(comparePython(rehashed).refusal).toBe('MCP_COLLECTOR_ORACLE_CHANGED');
      expect(JSON.stringify(originals)).toBe(before);
    }finally{for(const close of closing.reverse())await close();}
  },30000);
  it('refuses caller-made installed fixture origin before launching any SDK helper',async()=>{
    await expect(createInstalledMcpFixtureSession({profile:source.profile} as never,{} as never,'modern','/tmp/caller-root')).rejects.toThrow('READER_RUNTIME_UNQUALIFIED');
    expect(isInstalledMcpFixtureReadClient({scope:'FIXTURE_AUTHORITY_ONLY'})).toBe(false);
    expect(isInstalledMcpReadClient({scope:'QUALIFIED_INSTALLED_MCP_CLIENT'})).toBe(false);
  });
});
