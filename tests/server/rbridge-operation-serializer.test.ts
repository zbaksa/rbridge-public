import {describe,expect,it} from 'vitest';
import {createRBridgeOperationSerializer} from '../../src/server/rbridgeOperationSerializer.js';

describe('owner operation serializer',()=>{
  it('serializes the same ID while independent IDs can progress',async()=>{
    const serializer=createRBridgeOperationSerializer(),events:string[]=[];let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});
    const first=serializer.run('same',async()=>{events.push('first');await gate;events.push('first-done');});
    const second=serializer.run('same',async()=>{events.push('second');});
    await serializer.run('other',async()=>{events.push('other');});expect(events).toEqual(['first','other']);release();await Promise.all([first,second]);expect(events).toEqual(['first','other','first-done','second']);
  });
  it('revokes a released lease from inherited asynchronous callbacks',async()=>{
    const serializer=createRBridgeOperationSerializer();let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});let later!:Promise<boolean>;
    await serializer.run('read-1',async()=>{expect(serializer.isHeld('read-1')).toBe(true);later=gate.then(()=>serializer.isHeld('read-1'));});
    release();expect(await later).toBe(false);
  });
  it('rejects active reentry and releases the lease after failure',async()=>{
    const serializer=createRBridgeOperationSerializer();await expect(serializer.run('same',()=>serializer.run('other',async()=>true))).rejects.toThrow('RBRIDGE_CORE_SERIALIZER_REENTRANT');
    expect(await serializer.run('same',async()=>serializer.isHeld('same'))).toBe(true);expect(serializer.isHeld('same')).toBe(false);
  });
});
