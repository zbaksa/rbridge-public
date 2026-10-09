"""Original complete qualification materials, never Source-minted Root origin."""
import copy
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile
from rbridge_installation.artifact_collector import _RootArtifactObservation
from rbridge_installation.privileged_collector import PrivilegedFixtureOrigins


class QualificationCollectorTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import qualification_collector as c
        except ImportError:self.fail('Complete original qualification material collector is absent')
        self.c=c;self.p=parse_profile(valid_profile())
        self.artifact=_RootArtifactObservation(report_sha256(self.p),'{}','{}','/home/rbridge/.rbridge-artifact-'+'a'*32)
        self.privileged=PrivilegedFixtureOrigins(self.artifact,None,None,None,None,None,None)
        self.origins=c.QualificationOrigins(None,self.artifact,None,None,None,self.privileged,None,None)

    def registered_source_negative(self):
        c=self.c;token=c._RootQualificationMaterialObservation(report_sha256(self.p),report_sha256(self.p),
            report_sha256(self.origins),'{}','/root/.rbridge-privileged-'+'b'*32)
        c._observations[token]=(report_sha256(token),self.origins,c._snapshot(self.origins),self.p,self.p,None,None,'{}')
        self.addCleanup(lambda:c._observations.pop(token,None))
        return token

    def test_source_context_blocks_all_root_origins_artifacts_canary_or_writes(self):
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch.object(self.c,'_observe',side_effect=AssertionError('Source physical producers')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',
                self.c.collect_root_qualification_material,self.p,self.p,None,None,self.origins,{})

    def test_constructed_tokens_or_complete_pass_labels_cannot_register_material_origin(self):
        token=self.c._RootQualificationMaterialObservation('a'*64,'b'*64,'c'*64,'{}','/root/.rbridge-privileged-'+'d'*32)
        for value in (token,{'schema':'RBRIDGE_ROOT_QUALIFICATION_MATERIAL_V1','status':'PASS','scope':'ROOT_COMPLETE_QUALIFICATION_MATERIAL'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_ORIGIN_UNQUALIFIED',
                    self.c.verify_root_qualification_material,self.p,value,{})

    def test_equal_metadata_cannot_replace_original_set_or_any_nested_object_before_io(self):
        token=self.registered_source_negative();duplicate=copy.copy(self.origins)
        with patch('os.open',side_effect=AssertionError('Source Root open')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_ORIGIN_SET_CHANGED',
                self.c.verify_root_qualification_material,self.p,token,{},origins=duplicate)
        clone=copy.copy(self.artifact)
        self.assertEqual(report_sha256(clone),report_sha256(self.artifact))
        object.__setattr__(self.privileged,'artifact',clone)
        with patch('os.open',side_effect=AssertionError('Nested Root open')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_ORIGIN_SET_CHANGED',
                self.c.verify_root_qualification_material,self.p,token,{})

    def test_same_original_false_source_registry_still_reaches_root_context_refusal(self):
        token=self.registered_source_negative()
        with patch('os.open',side_effect=AssertionError('Source Root open')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',
                self.c.verify_root_qualification_material,self.p,token,{},origins=self.origins)

    def test_mutated_token_profile_request_or_original_metadata_refuses_before_io(self):
        token=self.registered_source_negative()
        with patch('os.open',side_effect=AssertionError('Wrong profile Root open')):
            changed=valid_profile();changed['binding']['principal_id']='different-source-owner'
            self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_OBSERVATION_CHANGED',
                self.c.verify_root_qualification_material,parse_profile(changed),token,{})
            self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_OBSERVATION_CHANGED',
                self.c.verify_root_qualification_material,self.p,token,{'python_closure_sha256':'e'*64})
            object.__setattr__(self.artifact,'evidence_json','{"status":"PASS"}')
            self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_OBSERVATION_CHANGED',
                self.c.verify_root_qualification_material,self.p,token,{})

    def test_origin_preservation_is_not_a_new_baseline_production_observation(self):
        token=self.registered_source_negative()
        # False private Source staging still cannot reach Root. The preservation
        # boundary retains historical fixture facts, never repeats stop/start or
        # requires production's pre-switch fingerprint after our own switch.
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch.object(self.c,'_observe',side_effect=AssertionError('Historical production recapture')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',
                self.c.preserve_root_qualification_material,self.p,token,{})

    def test_fresh_verified_import_growth_preserves_full_original_observation_but_not_changed_pins(self):
        # Replay the current collector's literal full-byte equality until its
        # dedicated comparison exists; the first failure must be semantic.
        compare=getattr(self.c,'_same_evidence',lambda a,b:encode_report(a)==encode_report(b))
        original={'observations':{'artifact':{'original_raw':'SOURCE_DATA_ONLY'}},'canary_base64':'eA==',
            'canary_observation':{'schema':'SOURCE_DATA_ONLY','identity':['1','2'],'ancestors':[{'identity':['3','4']}]},
            'import_closure':{'schema':'RBRIDGE_PYTHON_CLOSURE_BYTES_V1','status':'PASS','manifest_sha256':'a'*64,
                'profile_sha256':report_sha256(self.p),'execution_qualified':False,'service_action_authorized':False,
                'imports':[{'module':'qualification_collector','path':'/protected/qualification_collector.py'}],
                'mapped_files':['/protected/python']}}
        current=copy.deepcopy(original);current['import_closure']['imports'].append(
            {'module':'later_reviewed_owner_module','path':'/protected/later_reviewed_owner_module.py'})
        current['import_closure']['mapped_files'].append('/protected/another-pinned-stdlib-file')
        self.assertTrue(compare(original,current));self.assertEqual(len(original['import_closure']['imports']),1)
        for field in ('pin','artifact','canary','canary_identity','canary_ancestor','permission'):
            changed=copy.deepcopy(current)
            if field=='pin':changed['import_closure']['manifest_sha256']='b'*64
            elif field=='artifact':changed['observations']['artifact']['original_raw']='changed source preimage'
            elif field=='canary':changed['canary_base64']='eQ=='
            elif field=='canary_identity':changed['canary_observation']['identity']=['1','5']
            elif field=='canary_ancestor':changed['canary_observation']['ancestors'][0]['identity']=['3','5']
            else:changed['import_closure']['service_action_authorized']=True
            with self.subTest(field=field):self.assertFalse(compare(original,changed))


class ReaderOriginalArtifactTests(unittest.TestCase):
    def test_bundle_cannot_mix_equal_metadata_artifact_and_reader_originals(self):
        from rbridge_installation import reader_collector as c
        p=parse_profile(valid_profile());original=_RootArtifactObservation(report_sha256(p),'{}','{}',
            '/home/rbridge/.rbridge-artifact-'+'a'*32);substitute=copy.copy(original)
        token=c._RootReaderObservation(report_sha256(p),'{}','{}','{}')
        c._observations[token]=(report_sha256(token),None,None,(),original,None,None)
        try:
            with patch('os.open',side_effect=AssertionError('Cross-origin Root open')):
                self.assertRaisesRegex(ValueError,'READER_COLLECTOR_ARTIFACT_ORIGIN_CHANGED',
                    c.verify_root_reader_observation,p,token,{},artifact_observation=substitute)
                self.assertRaisesRegex(ValueError,'READER_COLLECTOR_ROOT_CONTEXT_UNQUALIFIED',
                    c.verify_root_reader_observation,p,token,{},artifact_observation=original)
        finally:del c._observations[token]


if __name__=='__main__':unittest.main()
