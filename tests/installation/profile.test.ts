import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {encodeInstallReport,parseRBridgeInstallProfile} from '../../src/installation/types.js';
import {INSTALL_CONTRACT_SCHEMA} from '../../src/installation/contractSchema.js';

const profile=()=>JSON.parse(readFileSync(new URL('../fixtures/rbridge-install-profile.json',import.meta.url),'utf8')) as Record<string,unknown>;
describe('strict installation profile',()=>{
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
