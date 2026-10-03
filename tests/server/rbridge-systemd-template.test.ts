import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const unit=readFileSync(new URL('../../ops/systemd/rbridge.service.in',import.meta.url),'utf8');

describe('standalone RBridge systemd template',()=>{
 it('keeps deployment identity/config explicit and host-neutral',()=>{
   expect(unit).toContain('User=@RBRIDGE_USER@');
   expect(unit).toContain('Group=@RBRIDGE_GROUP@');
   expect(unit).toContain('SupplementaryGroups=@CONTROLLER_GROUP@');
   expect(unit).toContain('Environment=RBRIDGE_RUNTIME_USER=@RBRIDGE_USER@');
   expect(unit).toContain('EnvironmentFile=@RBRIDGE_ENV_FILE@');
   expect(unit).toContain('EnvironmentFile=/etc/rbridge/flowpilot.env');
   expect(unit).not.toContain('/etc/cocwin-remote-bridge-stage2-flowpilot.env');
   expect(unit).toContain('ReadWritePaths=@RBRIDGE_STATE_ROOT@');
   expect(unit).not.toContain('bai');
   expect(unit).not.toContain('cocwin-private');
   expect(unit).not.toContain(['aether','engine'].join('-'));
 });
 it('runs only the immutable current RBridge release entrypoint with hardening',()=>{
   expect(unit).toContain('ExecStart=/opt/ai-tool-fabric/runtime/node /usr/local/libexec/rbridge/current/dist/server/server/remoteBridgeMain.js');
   for(const row of ['NoNewPrivileges=yes','PrivateTmp=yes','ProtectSystem=strict','ProtectHome=read-only','PrivateDevices=yes','ProtectKernelTunables=yes','ProtectKernelModules=yes','ProtectControlGroups=yes','LockPersonality=yes','RestrictRealtime=yes','RestrictSUIDSGID=yes','CapabilityBoundingSet=','AmbientCapabilities=','UMask=0077'])expect(unit).toContain(row);
 });
});
