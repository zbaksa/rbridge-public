import {readFileSync} from 'node:fs';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {describe,expect,it} from 'vitest';
import {RBRIDGE_ENABLED_ACTIONS,type RBridgeCorePort} from '../../src/domain/rbridgeCoreProtocol.js';
import {createRBridgeMcpSafeServer} from '../../src/server/rbridgeMcpSafe.js';
import {createFixtureSdkReadClient,isInstalledMcpReadClient} from '../../src/installation/rbridge-installation-client.js';
import {produceMcpArtifactCases} from '../../src/installation/mcpArtifactFixture.js';
import type {captureArtifactOperation} from '../../src/installation/artifactEvidence.js';

const source=JSON.parse(readFileSync(new URL('../fixtures/rbridge-artifact-preimages.json',import.meta.url),'utf8'));
const binding={runtimeUid:source.profile.binding.uid,principalId:source.profile.binding.principal_id,targetInstanceId:source.profile.binding.target_instance_id};
const originals=source.artifact.receipts as Array<ReturnType<typeof captureArtifactOperation>>;
describe('official SDK MCP negative producer Source fixtures',()=>{
  it('covers the full fixed matrix in both eras while preserving the original preimages',async()=>{
    expect(source.scope).toBe('SYNTHETIC_SOURCE_DATA_ONLY');
    const before=JSON.stringify(originals),closing:Array<()=>Promise<void>>=[],clients=[];
    const core:RBridgeCorePort={
      async submit(){throw new Error('SOURCE_FIXTURE_SUBMIT_FORBIDDEN');},
      async requestCancel(){throw new Error('SOURCE_FIXTURE_CANCEL_FORBIDDEN');},
      async status(id){const r=originals.find(o=>o.operationId===id);return r?{status:'RECEIPT',receipt:JSON.parse(r.receiptJSON)}:{status:'NOT_FOUND'};},
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
      }
      const report=await produceMcpArtifactCases({binding,source_sha:source.profile.runtime.source_sha,
        policy_sha256:source.profile.binding.policy_sha256,originals,clients,deadline_ms:15000});
      expect(report.cases).toHaveLength(24);
      expect(JSON.stringify(originals)).toBe(before);
    }finally{for(const close of closing.reverse())await close();}
  },30000);
});
