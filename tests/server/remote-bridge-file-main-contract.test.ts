import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';

describe('remote bridge main FILE runtime wiring',()=>{
  it('constructs FILE ops from the source-controlled host profile and passes them to the worker',async()=>{
    const source=await readFile('src/server/remoteBridgeMain.ts','utf8');
    expect(source).toContain("createRemoteBridgeFileOps");
    expect(source).toContain("resolveHostProfile");
    expect(source).toMatch(/resolveHostProfile\(\{kind:'FILE'/);
    expect(source).toMatch(/createRemoteBridgeFileOps\(\{[^}]*allowedRoots:/s);
    expect(source).toMatch(/createRemoteBridgeWorker\(\{[^}]*fileOps/s);
  });
});
