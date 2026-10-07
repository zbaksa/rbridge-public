"""Full synthetic process/IO data comparisons never grant kernel origin."""
import copy
import hashlib
import json
import unittest
from _loader import toolkit,ROOT

toolkit()
from rbridge_installation.artifact import ArtifactEntry,_manifest
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


def source_case_data():
    fixture=json.loads((ROOT/'tests/fixtures/rbridge-artifact-preimages.json').read_text())
    value=fixture['profile'];entry=ArtifactEntry('source-only.txt','FILE',1,0o644,hashlib.sha256(b'x').hexdigest(),'')
    manifests={kind:_manifest(kind,value[section]['source_sha'],value[section]['tree_sha'],value['runtime']['node_sha256'],(entry,))
               for kind,section in [('RUNTIME','runtime'),('TOOLKIT','toolkit')]}
    value['runtime']['manifest_sha256']=manifests['RUNTIME'].sha256
    value['toolkit']['manifest_sha256']=manifests['TOOLKIT'].sha256;p=parse_profile(value)
    receipts=fixture['artifact'];report={'schema':'RBRIDGE_INSTALL_ARTIFACT_QUALIFICATION_V1','status':'PASS','reason_codes':[],
        'runtimeVersion':p.runtime.node_version,'actualNodeSHA256':p.runtime.node_sha256,
        'runtimeManifestSHA256':p.runtime.manifest_sha256,'toolkitManifestSHA256':p.toolkit.manifest_sha256,
        'sourceSHA':p.runtime.source_sha,'toolkitSHA':p.toolkit.source_sha,
        'scope':'ISOLATED_FINAL_ARTIFACT_OWNER_IPC_MCP_HELPER','ownerBoot':'PASS','mcpBoot':'PASS',
        'executedFixture':True,'fixtureReceiptsSHA256':report_sha256(receipts)}
    artifact={'report':report,'receipts':receipts};home=p.binding.home+'/.rbridge-artifact-'+'a'*32
    root=p.paths.release_parent+'/toolkit-'+p.toolkit.source_sha;runuser=next(t for t in p.tools if t.role=='runuser')
    node=[p.runtime.node_path,root+'/dist/server/cli/rbridgeArtifactQualification.js']
    parent=[runuser.path,'--user',p.binding.account,'--',*node]
    binding={'runtimeUid':p.binding.uid,'principalId':p.binding.principal_id,'targetInstanceId':p.binding.target_instance_id}
    sdk=[p.runtime.node_path,root+'/dist/server/installation/artifactFixture.js','--stdio-client',
         p.paths.release_parent+'/'+p.runtime.source_sha,home+'/.local/state/rbridge/execution-v2',json.dumps(binding,separators=(',',':'))]
    rows=[{'pid':20,'start_ticks':'100','ppid':10,'session':20,'uid':[0]*4,'gid':[0]*4,'groups':[0],
           'exe':runuser.path,'argv':parent},
          {'pid':21,'start_ticks':'101','ppid':20,'session':20,'uid':[1027]*4,'gid':[1027]*4,'groups':[1027],
           'exe':p.runtime.node_path,'argv':node},
          {'pid':22,'start_ticks':'102','ppid':21,'session':20,'uid':[1027]*4,'gid':[1027]*4,'groups':[1027],
           'exe':p.runtime.node_path,'argv':sdk}]
    packet={'schema':'RBRIDGE_INSTALL_ARTIFACT_INPUT_V1','profile':p,'runtime_manifest':manifests['RUNTIME'],
            'toolkit_manifest':manifests['TOOLKIT'],'isolated_home':home}
    evidence={'artifact':artifact,'input_json':encode_report(packet).decode(),'output_json':encode_report(artifact).decode()+'\n',
              'ready_json':json.dumps({'schema':'RBRIDGE_INSTALL_HELPER_READY_V1','pid':21,'nonce':'b'*64},separators=(',',':'))+'\n',
              'node_sha256':p.runtime.node_sha256,'runtime_manifest_sha256':p.runtime.manifest_sha256,
              'toolkit_manifest_sha256':p.toolkit.manifest_sha256}
    session={'schema':'RBRIDGE_OWNED_HELPER_SESSION_V1','scope':'ROOT_FIXED_PROCESS_OBSERVATION','status':'PASS',
             'pid':20,'argv':parent,'start_ticks':'100','executable_sha256':runuser.sha256,
             'input_sha256':hashlib.sha256(evidence['input_json'].encode()).hexdigest(),
             'output_sha256':hashlib.sha256(evidence['output_json'].encode()).hexdigest(),'processes':rows,'exit_code':0,'live_helpers':[]}
    return p,evidence,session,home


class HelperFamilyCaseTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.helper_family_case import capture_helper_family_case,compare_helper_family_case
        except ImportError:self.fail('Full original-artifact helper-family comparison is absent')
        self.capture,self.compare=capture_helper_family_case,compare_helper_family_case
        self.profile,self.evidence,self.session,self.home=source_case_data()

    def test_full_original_raw_io_and_three_role_roster_are_preserved_as_source_data(self):
        case=self.capture(self.profile,self.evidence,self.session,self.home)
        self.assertEqual(case['scope'],'ORIGINAL_ARTIFACT_HELPER_FAMILY_DATA_ONLY')
        self.assertEqual(json.loads(case['evidence_json']),self.evidence)
        self.assertEqual(json.loads(case['session_json']),self.session)
        comparison=self.compare(self.profile,case)
        self.assertEqual(comparison['status'],'PASS');self.assertEqual(comparison['observed_roles'],['ROOT_RUNUSER','RUNTIME_OWNER','RUNTIME_SDK'])
        self.assertFalse(comparison['may_execute']);self.assertEqual(comparison['physical_origin'],'UNQUALIFIED')

    def test_rehashed_missing_extra_detached_root_child_or_unknown_argv_is_rejected(self):
        mutations=[lambda s:s['processes'].pop(),
                   lambda s:s['processes'].append({**s['processes'][2],'pid':23,'start_ticks':'103'}),
                   lambda s:s['processes'][2].update(session=30),
                   lambda s:s['processes'][2].update(ppid=1),
                   lambda s:s['processes'][2].update(uid=[0]*4),
                   lambda s:s['processes'][2].update(groups=[0,1027]),
                   lambda s:s['processes'][2].update(argv=['/usr/bin/node','/unreviewed.js'])]
        for mutate in mutations:
            session=copy.deepcopy(self.session);mutate(session)
            self.assertRaises(ValueError,self.capture,self.profile,self.evidence,session,self.home)

    def test_rehashed_io_ready_packet_profile_and_live_helpers_do_not_pass(self):
        for field in ('input','output','ready','manifest','profile','live','exit'):
            evidence=copy.deepcopy(self.evidence);session=copy.deepcopy(self.session)
            if field=='input':session['input_sha256']='c'*64
            elif field=='output':
                evidence['output_json']='{}\n';session['output_sha256']=hashlib.sha256(evidence['output_json'].encode()).hexdigest()
            elif field=='ready':evidence['ready_json']=evidence['ready_json'].replace('"pid":21','"pid":22')
            elif field in ('manifest','profile'):
                packet=json.loads(evidence['input_json'])
                if field=='manifest':packet['toolkit_manifest']['entries'][0]['sha256']='c'*64
                else:packet['profile']['binding']['principal_id']='foreign-principal'
                evidence['input_json']=encode_report(packet).decode();session['input_sha256']=hashlib.sha256(evidence['input_json'].encode()).hexdigest()
            elif field=='live':session['live_helpers']=[22]
            else:session['exit_code']=False
            with self.subTest(field=field):self.assertRaises(ValueError,self.capture,self.profile,evidence,session,self.home)

    def test_rehashed_boolean_or_float_process_identity_cannot_substitute_integers(self):
        for key,value in [('uid',[False]*4),('gid',[False]*4),('groups',[False]),('ppid',10.0),('session',20.0)]:
            session=copy.deepcopy(self.session);session['processes'][0][key]=value
            with self.subTest(key=key):self.assertRaises(ValueError,self.capture,self.profile,self.evidence,session,self.home)

    def test_self_rehashed_scope_or_live_path_never_completes_privileged_origin(self):
        from rbridge_installation.qualification import build_qualification,QualificationProofs
        case=self.capture(self.profile,self.evidence,self.session,self.home)
        assessment=build_qualification(self.profile,QualificationProofs(privileged=case))
        self.assertEqual(assessment.status,'BLOCKED');self.assertEqual(assessment.checks['privileged'],'FAIL')
        case['scope']='ISOLATED_ROOT_FIXTURES_ONLY';self.assertRaises(ValueError,self.compare,self.profile,case)
        self.assertRaises(ValueError,self.capture,self.profile,self.evidence,self.session,self.profile.paths.state_root)


if __name__=='__main__':unittest.main()
