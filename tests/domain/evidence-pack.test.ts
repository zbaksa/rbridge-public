import {describe,expect,it} from 'vitest';
import {createEvidencePack,verifyEvidencePack} from '../../src/domain/evidencePack.js';
const SHA='a'.repeat(40),H='b'.repeat(64);
const base=()=>({requestId:'rbridge.evidence.0001',appId:'rbridge',subject:'qualification',startedAt:'2026-09-27T12:00:00.000Z',completedAt:'2026-09-27T12:00:01.000Z',appSourceSha:SHA,evidence:[{id:'health',state:'PASS' as const,sha256:H}]});
describe('RBridge evidence pack',()=>{
 it('is deterministic and verifies its own receipt',()=>{const a=createEvidencePack(base()),b=createEvidencePack(base());expect(a).toEqual(b);expect(a.receiptSha256).toMatch(/^[0-9a-f]{64}$/);expect(verifyEvidencePack(a)).toBe(true);});
 it('derives the worst evidence state instead of trusting a caller outcome',()=>{expect(createEvidencePack({...base(),evidence:[{id:'ok',state:'PASS'},{id:'stale',state:'STALE'},{id:'blocked',state:'BLOCKED'}]}).outcome).toBe('BLOCKED');expect(createEvidencePack({...base(),evidence:[{id:'unknown',state:'UNKNOWN'},{id:'fail',state:'FAIL'}]}).outcome).toBe('FAIL');});
 it('keeps uncertain distinct from unknown and stale',()=>{expect(createEvidencePack({...base(),evidence:[{id:'x',state:'UNKNOWN'},{id:'y',state:'UNCERTAIN'}]}).outcome).toBe('UNCERTAIN');});
 it('rejects invalid time order, duplicate ids and bad hashes',()=>{expect(()=>createEvidencePack({...base(),completedAt:'2026-09-27T11:59:59.000Z'})).toThrow('EVIDENCE_TIME_ORDER_INVALID');expect(()=>createEvidencePack({...base(),evidence:[{id:'x',state:'PASS'},{id:'x',state:'PASS'}]})).toThrow('EVIDENCE_ID_DUPLICATE');expect(()=>createEvidencePack({...base(),evidence:[{id:'x',state:'PASS',sha256:'bad'}]})).toThrow('EVIDENCE_SHA256_INVALID');});
 it('bounds evidence size and detail',()=>{expect(()=>createEvidencePack({...base(),evidence:[]})).toThrow('EVIDENCE_COUNT_INVALID');expect(()=>createEvidencePack({...base(),evidence:[{id:'x',state:'PASS',detail:'x'.repeat(1025)}]})).toThrow('EVIDENCE_DETAIL_INVALID');});
 it('detects tampering',()=>{const pack=createEvidencePack(base());expect(verifyEvidencePack({...pack,subject:'changed'})).toBe(false);expect(verifyEvidencePack({...pack,outcome:'FAIL'})).toBe(false);});
});
