import {mkdirSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {parseFakeUnitWorkerArgs} from '../../src/installation/fakeUnitWorker.js';

describe('fixed isolated stop fixture worker',()=>{
  const unit='rbridge-install-fixture-'+'a'.repeat(32)+'.service',home='/home/rbridge/.rbridge-artifact-'+'b'.repeat(32),nonce='c'.repeat(64);
  it('parses only its fixed unit, allocated home, nonce and numeric directory identity',()=>{
    expect(parseFakeUnitWorkerArgs(['--unit-fixture',unit,home,nonce,'10','100'])).toEqual({unit,home,nonce,dev:'10',ino:'100'});
  });
  it('rejects production units, live homes, extra argv and inode or directive substitutions',()=>{
    for(const args of [['--unit-fixture','rbridge.service',home,nonce,'10','100'],['--unit-fixture',unit,'/home/rbridge',nonce,'10','100'],
      ['--unit-fixture',unit,home,nonce,'10','100','/bin/sh'],['--unit-fixture',unit,home,nonce,'10','0'],
      ['--unit-fixture',unit,home+'/../.local/state',nonce,'10','100'],['--unit-fixture',unit,home,nonce,'10','1\nExecStart=/bin/sh']]){
      expect(()=>parseFakeUnitWorkerArgs(args)).toThrow('FAKE_UNIT_WORKER_INVALID');
    }
  });
  it('a Source CLI cannot create readiness or hold a process before actual runtime qualification',()=>{
    const root=mkdtempSync(join(tmpdir(),'rbridge-unit-source-')),folder=join(root,'ready');mkdirSync(folder);
    try{
      const entry=new URL('../../src/installation/fakeUnitWorker.ts',import.meta.url).pathname;
      const result=spawnSync(process.execPath,['--import',import.meta.resolve('tsx'),entry,'--unit-fixture',unit,folder,nonce,'10','100'],
        {cwd:'/',env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:10000,maxBuffer:4096});
      expect(result.status).toBe(2);expect(result.stderr).toBe('FAKE_UNIT_WORKER_UNQUALIFIED\n');expect(readdirSync(folder)).toEqual([]);
    }finally{rmSync(root,{recursive:true,force:true});}
  },15000);
});
