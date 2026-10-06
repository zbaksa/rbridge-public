import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {qualifyRBridgeArtifact,validateArtifactManifest} from '../../src/installation/artifactQualification.js';
import {encodeInstallReport,parseRBridgeInstallProfile} from '../../src/installation/types.js';

describe('final artifact qualification',()=>{
  it('never turns missing final artifact or wrong runtime into boot qualification',async()=>{
    const profile=parseRBridgeInstallProfile(JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')));
    const result=await qualifyRBridgeArtifact({profile,runtimeRoot:'/missing/final-artifact',manifestSHA256:'1'.repeat(64),isolatedHome:'/missing/isolated-home'});
    expect(result.status).not.toBe('PASS');
    expect(result.ownerBoot).toBe('NOT_PERFORMED');
    expect(result.mcpBoot).toBe('NOT_PERFORMED');
  });
  it('binds actual executable bytes independently of environment version labels',async()=>{
    const raw=JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8'));
    raw.runtime.node_path=process.execPath;
    raw.runtime.node_sha256=createHash('sha256').update(readFileSync(process.execPath)).digest('hex');
    const result=await qualifyRBridgeArtifact({profile:parseRBridgeInstallProfile(raw),runtimeRoot:'/missing/final-artifact',manifestSHA256:'1'.repeat(64),isolatedHome:'/missing/isolated-home'});
    expect(result.status).not.toBe('PASS');
    expect(result.runtimeVersion).toBe(process.versions.node);
    expect(result.executedFixture).toBe(false);
  });
  it('rejects self-consistent manifests containing traversal, unsorted names or incompatible schema',()=>{
    const base={schema:'RBRIDGE_INSTALL_ARTIFACT_V1',kind:'RUNTIME',source_sha:'1'.repeat(40),tree_sha:'2'.repeat(40),node_sha256:'3'.repeat(64),uid_policy:'ROOT_IMMUTABLE_RUNTIME_READABLE',entries:[{path:'../outside',kind:'FILE',size:0,mode:420,sha256:'4'.repeat(64),target:''}]};
    const hash=(v:unknown)=>createHash('sha256').update(encodeInstallReport(v)).digest('hex');
    expect(()=>validateArtifactManifest({...base,sha256:hash(base)})).toThrow();
    for(const entries of [[{...base.entries[0],path:'b'},{...base.entries[0],path:'a'}],[{...base.entries[0],path:'a',mode:438}]]){
      const value={...base,entries};expect(()=>validateArtifactManifest({...value,sha256:hash(value)})).toThrow();
    }
    const value={...base,schema:'RBRIDGE_INSTALL_TOOLKIT_V1',entries:[]};expect(()=>validateArtifactManifest({...value,sha256:hash(value)})).toThrow();
  });
});
