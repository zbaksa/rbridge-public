import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const main=readFileSync(
  new URL('../../src/server/remoteBridgeMain.ts',import.meta.url),
  'utf8'
);

describe('standalone RBridge FlowPilot main integration',()=>{
  it('wires ingress, reconciliation and shutdown into the locked runtime',()=>{
    for(const row of [
      "createFlowPilotBridgeRuntime({root,controller,env:process.env})",
      "onLocked:async()=>{",
      "await flowPilot?.start()",
      "runFlowPilotBridgeTick({",
      "reconcile:async()=>await flowPilot.reconcile()",
      "await flowPilot?.stop()"
    ]) expect(main).toContain(row);
  });
});
