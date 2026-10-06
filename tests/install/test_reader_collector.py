"""Named reader producer boundaries; Source labels never grant physical origin."""
import copy
import json
import unittest
from unittest.mock import patch
from _loader import toolkit,ROOT


class ReaderCollectorTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.reader_collector import collect_root_reader_invocations,verify_root_reader_observation,_prepare_reader_input
        except ImportError:self.fail('Concrete protected Root reader producer is not implemented')
        from rbridge_installation.models import report_sha256
        from rbridge_installation.profile import parse_profile
        self.collect,self.verify,self.prepare=collect_root_reader_invocations,verify_root_reader_observation,_prepare_reader_input
        self.fixture=json.loads((ROOT/'tests/fixtures/rbridge-artifact-preimages.json').read_text())
        self.assertEqual(self.fixture['scope'],'SYNTHETIC_SOURCE_DATA_ONLY')
        p=self.fixture['profile'];entry=p['paths']['release_parent']+'/toolkit-'+p['toolkit']['source_sha']+'/dist/server/cli/rbridgeReadResult.js'
        self.adoptions=[];self.readers=[]
        for transport in ('GITHUB','MCP'):
            ident='source-'+transport.lower();adoption={'schema':'RBRIDGE_READER_ADOPTION_V1','reader_id':ident,
                'owner':'fixture-owner','workflow':'fixture-source-only','entrypoint':entry,'source_sha256':'a'*64,
                'version':'1','trusted_context_sha256':'c'*64,'fixture_set_sha256':'f'*64,'adopted_at':'2026-10-06T00:00:00.000Z'}
            self.adoptions.append(adoption);self.readers.append({'reader_id':ident,'entrypoint':entry,'source_sha256':'a'*64,
                'version':'1','transport':transport,'trusted_context_sha256':'c'*64,
                'qualification_sha256':'f'*64,'adoption_sha256':report_sha256(adoption)})
        p['readers']=self.readers;self.profile=parse_profile(p);self.registry={'readers':self.readers,'adoptions':self.adoptions}
        self.home=self.profile.binding.home+'/.rbridge-artifact-'+'a'*32
        url='https://github.com/'+self.profile.binding.repository+'/issues/17'
        base={'schema':'RBRIDGE_GITHUB_CARRIER_CAPTURE_V1','scope':'AUTHENTICATED_GITHUB_READ','context_sha256':'c'*64,
            'repository':self.profile.binding.repository,'viewer':self.profile.binding.author,
            'issue':{'number':17,'title':'[COCWIN BRIDGE REQUEST] source-fixture','body':'{}','author':self.profile.binding.author,
                'url':url,'state':'CLOSED','isPullRequest':False},'comments':[],'complete':True}
        self.capture={**base,'capture_sha256':report_sha256(base)}
        self.cases=[{'fixture_id':'source-C01','case_id':'C01','provenance':'AUTHENTIC_ARCHIVE','expected_verdict_sha256':'b'*64,
            'transport':'GITHUB','capture':self.capture,'expected':{'capture_sha256':self.capture['capture_sha256'],'capture_context_sha256':'c'*64}}]
        self.cases.extend({'fixture_id':'source-'+era,'case_id':'C09','provenance':'SYNTHETIC','expected_verdict_sha256':'b'*64,
            'transport':'MCP','era':era,'expected':{}} for era in ('legacy','modern'))

    def test_source_packet_comparison_preserves_inputs_but_cannot_authenticate_a_scope_label(self):
        value=self.prepare(self.profile,self.registry,{'cases':self.cases},[self.capture],self.fixture['artifact'],self.home)
        self.assertEqual(value['operation'],'QUALIFY_INSTALLED_ARCHIVED_ARTIFACT')
        self.assertEqual(value['artifact_fixture'],self.fixture['artifact'])
        self.assertEqual(value['fixtures']['cases'][0]['capture'],self.capture)
        self.assertEqual(value['isolated_home'],self.home)
        self.assertRaises(ValueError,self.prepare,self.profile,self.registry,{'cases':self.cases},[],self.fixture['artifact'],self.home)
        for change in ('body','adoption','foreign-reader','missing-era','live-root','caller-root','source-producer-label'):
            registry=copy.deepcopy(self.registry);cases=copy.deepcopy(self.cases);home=self.home
            if change=='body':cases[0]['capture']['issue']['body']='forged'
            elif change=='adoption':registry['adoptions'][0]['workflow']='unknown-workflow'
            elif change=='foreign-reader':registry['readers'][0]['reader_id']='unregistered'
            elif change=='missing-era':cases.pop()
            elif change=='live-root':home=self.profile.paths.state_root
            elif change=='caller-root':cases[1]['isolated_root']=self.profile.paths.state_root+'/execution-v2'
            else:cases[1]['provenance']='SOURCE_PRODUCER'
            with self.subTest(change=change):self.assertRaises(ValueError,self.prepare,self.profile,registry,{'cases':cases},[self.capture],self.fixture['artifact'],home)

    def test_source_context_rejects_before_root_open_artifact_lookup_or_launch(self):
        with patch('rbridge_installation.reader_collector.os.open',side_effect=AssertionError('Source Root open')), \
             patch('rbridge_installation.reader_collector.verify_root_artifact_for_reader_profile',side_effect=AssertionError('Source artifact origin')):
            self.assertRaisesRegex(ValueError,'READER_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',self.collect,
                self.profile,None,None,self.registry,{'cases':self.cases},[],None,{'python_closure_sha256':'d'*64})

    def test_caller_pass_and_constructed_token_never_become_reader_origin(self):
        from rbridge_installation.reader_collector import _RootReaderObservation
        token=_RootReaderObservation('a'*64,'{}','{}','{}')
        for value in (token,{'status':'PASS','scope':'ROOT_INSTALLED_READER_INVOCATIONS'}):
            with patch('rbridge_installation.reader_collector.os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'READER_COLLECTOR_ORIGIN_UNQUALIFIED',self.verify,
                    self.profile,value,{'python_closure_sha256':'d'*64})

    def test_later_reader_metadata_can_only_extend_the_exact_original_artifact_profile(self):
        from rbridge_installation.profile import assert_reader_profile_extension,parse_profile
        original=copy.deepcopy(self.fixture['profile']);original['readers']=[]
        self.assertEqual(assert_reader_profile_extension(parse_profile(original),self.profile)[1],self.profile)
        for section,field,value in (('binding','principal_id','changed-owner'),('runtime','tree_sha','e'*40),
                ('toolkit','manifest_sha256','e'*64),('paths','canary_path','/mnt/data/changed-fixture'),
                ('service','canary_sha256','e'*64)):
            changed=copy.deepcopy(self.fixture['profile']);changed[section][field]=value
            with self.subTest(section=section),self.assertRaises(ValueError):
                assert_reader_profile_extension(parse_profile(original),parse_profile(changed))

    def test_cross_profile_root_rechecks_still_reject_source_constructed_artifact_and_archive_origins(self):
        from rbridge_installation.artifact_collector import _RootArtifactObservation,verify_root_artifact_for_reader_profile
        from rbridge_installation.archive_collector import _RootArchiveObservation,verify_root_archive_for_reader_profile
        artifact=_RootArtifactObservation('a'*64,'{}','{}',self.home)
        archive=_RootArchiveObservation('a'*64,'{}','{}','{}','{}')
        with patch('rbridge_installation.artifact_collector.os.open',side_effect=AssertionError('Caller Root open')):
            self.assertRaisesRegex(ValueError,'ARTIFACT_COLLECTOR_ORIGIN_UNQUALIFIED',verify_root_artifact_for_reader_profile,self.profile,artifact,{})
        with patch('rbridge_installation.archive_collector.os.open',side_effect=AssertionError('Caller Root open')):
            self.assertRaisesRegex(ValueError,'ARCHIVE_COLLECTOR_ORIGIN_UNQUALIFIED',verify_root_archive_for_reader_profile,self.profile,archive,None,None,{})


if __name__=='__main__':unittest.main()
