import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {encodeInstallReport,parseRBridgeInstallProfile,validateInstallContract} from '../../src/installation/types.js';
import {INSTALL_CONTRACT_SCHEMA} from '../../src/installation/contractSchema.js';

const profile=()=>JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')) as Record<string,unknown>;
describe('strict installation profile',()=>{
  it('binds the FILE canary to the existing Core read root',()=>{
    const p=profile();(p.paths as Record<string,unknown>).canary_path='/mnt/data/fixture-canary.txt';expect(parseRBridgeInstallProfile(p).paths.canary_path).toBe('/mnt/data/fixture-canary.txt');
    for(const path of ['/home/rbridge/fixture-canary.txt','/mnt/data','/mnt/database/canary','/mnt/data/../canary']){(p.paths as Record<string,unknown>).canary_path=path;expect(()=>parseRBridgeInstallProfile(p)).toThrow();}
  });
  it('shares readiness, discovery and complete audit wire contracts with Python',()=>{
    const ready={schema:'RBRIDGE_INSTALL_HELPER_READY_V1',pid:31337,nonce:'a'.repeat(64)};
    expect(()=>validateInstallContract(ready,'HelperReady')).not.toThrow();
    for(const bad of [{...ready,pid:true},{...ready,pid:1},{...ready,nonce:'wrong'},{...ready,extra:true}])expect(()=>validateInstallContract(bad,'HelperReady')).toThrow();
    const issue={number:17,state:'CLOSED',title:'fixture',body:'retained',author:'fixture-owner',url:'https://github.com/fixture-owner/fixture/issues/17',isPullRequest:false,updatedAt:'2026-10-06T00:00:00.000Z',capture_sha256:'b'.repeat(64)};
    expect(()=>validateInstallContract(issue,'IssueEvidence')).not.toThrow();
    for(const bad of [{...issue,isPullRequest:0},{...issue,number:2147483648},{...issue,extra:true}])expect(()=>validateInstallContract(bad,'IssueEvidence')).toThrow();
    expect(Buffer.from(encodeInstallReport(ready)).toString()).toBe('{"nonce":"'+ 'a'.repeat(64)+'","pid":31337,"schema":"RBRIDGE_INSTALL_HELPER_READY_V1"}');
    for(const name of ['LookupCapture','DiscoveryInput','AuditInput','DiscoveryResult','ProcessProbeTarget','AuditError'])expect(Object.hasOwn(INSTALL_CONTRACT_SCHEMA.$defs,name)).toBe(true);
  });
  it('ships exactly the shared contract used by Python',()=>{
    expect(INSTALL_CONTRACT_SCHEMA).toEqual(JSON.parse(readFileSync(new URL('../../docs/contracts/P2A_INSTALLATION_TOOLKIT_V1.json',import.meta.url),'utf8')));
  });
  it('pins the runtime and rejects forged identity, extras, paths and budgets',()=>{
    expect(parseRBridgeInstallProfile(profile()).runtime.source_sha).toBe('b5881fd8367b4249e82683f1f884f2392cb696d4');
    for(const [section,key,value] of [['binding','uid',0],['binding','credential','secret'],['runtime','node_version','24.0.0'],['paths','state_root','/tmp/../other'],['budget','lookup_batch',26]] as const){
      const p=profile();(p[section] as Record<string,unknown>)[key]=value;
      expect(()=>parseRBridgeInstallProfile(p)).toThrow();
    }
  });
  it('emits the independent Python golden bytes and rejects noncanonical numbers',()=>{
    expect(Buffer.from(encodeInstallReport({status:'PASS',checks:[{status:'PASS',name:'fixture'}]})).toString()).toBe('{"checks":[{"name":"fixture","status":"PASS"}],"status":"PASS"}');
    for(const value of [NaN,1.5,9007199254740992])expect(()=>encodeInstallReport({count:value})).toThrow();
    expect(Buffer.from(encodeInstallReport({'😀':2,'\ue000':1})).toString()).toBe('{"\ue000":1,"😀":2}');
    expect(()=>encodeInstallReport({value:'\ud800'})).toThrow();
  });
});
