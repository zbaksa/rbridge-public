"""Synthetic raw unit/kernel observations are data, never actual systemd proof."""
import copy
import hashlib
import json
import unittest
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


def synthetic_unit_data(render,argv,profile=None):
    p=parse_profile(valid_profile()) if profile is None else profile;unit='rbridge-install-fixture-'+'a'*32+'.service'
    file='/root/.rbridge-fake-unit-'+'a'*32+'/'+unit;home=p.binding.home+'/.rbridge-artifact-'+'b'*32;nonce='c'*64
    home_identity={'dev':'10','ino':'100'};command=argv(p,unit,home,nonce,home_identity)
    rows={'Id':unit,'LoadState':'loaded','ActiveState':'active','SubState':'running','MainPID':'42',
        'ControlGroup':'/system.slice/'+unit,'FragmentPath':file,'DropInPaths':'',
        'ExecStart':'{ path='+p.runtime.node_path+' ; argv[]='+' '.join(command)+' ; ignore_errors=no ; pid=42 ; }',
        'User':p.binding.account,'Group':p.binding.account,'Restart':'no','KillMode':'control-group','SendSIGKILL':'yes',
        'NoNewPrivileges':'yes','ProtectSystem':'strict','ProtectHome':'read-only','ReadWritePaths':home,
        'InvocationID':'d'*32}
    def raw(value):return ''.join(k+'='+v+'\n' for k,v in value.items())
    stopped={**rows,'ActiveState':'inactive','SubState':'dead','MainPID':'0','ControlGroup':''}
    capture={'scope':'QUALIFIED_HOST_PAUSE','identity_sha256':p.service.identity_sha256,'config_sha256':'e'*64,'invocation_sha256':'f'*64}
    prod={'service':capture,'current_release':p.paths.release_parent+'/'+p.runtime.old_sha,'pointer_identity_sha256':'1'*64}
    ready={'schema':'RBRIDGE_FAKE_UNIT_READY_V1','pid':42,'uid':1027,'euid':1027,'gid':1027,'unit':unit,'nonce':nonce}
    receipt={**ready,'schema':'RBRIDGE_FAKE_UNIT_STOPPED_V1','signal':'SIGTERM','elapsed_ms':100}
    facts={'Uid':[1027]*4,'Gid':[1027]*4,'Groups':[1027],'PPid':[1],
        'identity':{'pid':42,'exe':p.runtime.node_path,'cmdlineSha256':hashlib.sha256(('\0'.join(command)+'\0').encode()).hexdigest(),'startTimeTicks':'100'},
        'cgroup_sha256':hashlib.sha256(('0::/system.slice/'+unit+'\n').encode()).hexdigest()}
    output={'active_show':raw(rows),'stopped_show':[raw(stopped),raw(stopped)],'active_cgroup_pids':[42],
        'stopped_cgroup_pids':[[],[]],'ready_json':encode_report(ready).decode()+'\n','ready_uid':1027,'ready_mode':0o600,
        'ready_nlink':1,'worker_facts':facts,'pidfd_settled':True,'stop_exit_code':0,
        'stopped_json':encode_report(receipt).decode()+'\n','stopped_uid':1027,'stopped_mode':0o600,'stopped_nlink':1,
        'production_before':prod,'production_after':copy.deepcopy(prod)}
    return p,unit,file,home,nonce,home_identity,render(p,unit,home,nonce,home_identity),output


class FakeUnitCaseTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.fake_unit_case import render_fake_unit,fake_unit_argv,capture_fake_unit_case,compare_fake_unit_case
        except ImportError:self.fail('Fixed fake-unit stop data comparison is absent')
        self.render,self.argv,self.capture,self.compare=render_fake_unit,fake_unit_argv,capture_fake_unit_case,compare_fake_unit_case
        self.p,self.unit,self.file,self.home,self.nonce,self.home_identity,self.text,self.output=synthetic_unit_data(self.render,self.argv)

    def case(self,output=None):return self.capture(self.p,self.unit,self.file,self.home,self.nonce,self.home_identity,self.text,self.output if output is None else output)

    def test_complete_stop_data_preserves_original_unit_frames_and_kernel_preimages(self):
        case=self.case();self.assertEqual(case['scope'],'ISOLATED_FAKE_UNIT_STOP_DATA_ONLY')
        self.assertEqual(json.loads(case['output_json']),self.output)
        self.assertEqual(json.loads(case['input_json'])['unit_text'],self.text)
        result=self.compare(self.p,case);self.assertEqual(result['status'],'PASS');self.assertFalse(result['may_execute'])
        self.assertEqual(result['physical_origin'],'UNQUALIFIED')
        self.assertIn('RuntimeMaxSec=30s\n',self.text);self.assertIn('KillMode=control-group\n',self.text)

    def test_zero_command_exit_cannot_replace_process_and_cgroup_settlement(self):
        for key,value in [('pidfd_settled',False),('stopped_cgroup_pids',[[42],[]]),
                          ('stopped_show',[self.output['active_show']]*2),('stop_exit_code',False)]:
            output=copy.deepcopy(self.output);output[key]=value
            with self.subTest(key=key):self.assertRaises(ValueError,self.case,output)

    def test_rehashed_foreign_executable_identity_nonce_or_production_drift_is_rejected(self):
        for field in ('argv','uid','group','pid','ready','production','unit','dropin','expiry'):
            output=copy.deepcopy(self.output)
            if field=='argv':output['worker_facts']['identity']['cmdlineSha256']='e'*64
            elif field=='uid':output['worker_facts']['Uid']=[0]*4
            elif field=='group':output['worker_facts']['Groups']=[0,1027]
            elif field=='pid':output['worker_facts']['PPid']=[True]
            elif field=='ready':output['ready_json']=output['ready_json'].replace('c'*64,'e'*64)
            elif field=='production':output['production_after']['current_release']=self.p.paths.release_parent+'/'+self.p.runtime.source_sha
            elif field=='unit':output['active_show']=output['active_show'].replace('Id='+self.unit,'Id=rbridge.service')
            elif field=='dropin':output['active_show']=output['active_show'].replace('DropInPaths=\n','DropInPaths=/unexpected.conf\n')
            else:output['stopped_json']=output['stopped_json'].replace('"elapsed_ms":100','"elapsed_ms":30000')
            with self.subTest(field=field):self.assertRaises(ValueError,self.case,output)

    def test_renderer_rejects_production_unit_live_home_and_directive_injection(self):
        for unit,home,nonce in [('rbridge.service',self.home,self.nonce),(self.unit,self.p.binding.home,self.nonce),
                                (self.unit,self.home+'\nExecStart=/bin/sh',self.nonce),(self.unit,self.home,'invalid')]:
            self.assertRaises(ValueError,self.render,self.p,unit,home,nonce,self.home_identity)

    def test_source_case_cannot_claim_six_case_privilege_or_root_origin_after_rehash(self):
        from rbridge_installation.qualification import QualificationProofs,build_qualification
        case=self.case();assessment=build_qualification(self.p,QualificationProofs(privileged=case))
        self.assertEqual(assessment.status,'BLOCKED');self.assertEqual(assessment.checks['privileged'],'FAIL')
        case['scope']='ISOLATED_ROOT_FIXTURES_ONLY';self.assertRaises(ValueError,self.compare,self.p,case)


if __name__=='__main__':unittest.main()
