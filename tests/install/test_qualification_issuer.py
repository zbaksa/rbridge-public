"""Private issuer origin cannot be created by Source metadata or registries."""
import copy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import report_sha256
from rbridge_installation.profile import parse_profile


class QualificationIssuerTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import qualification_issuer as issuer
        except ImportError:self.fail('Genuine private complete bundle issuer is absent')
        from rbridge_installation import qualification as q
        self.issuer=issuer;self.q=q;self.p=parse_profile(valid_profile())
        p=self.p
        runtime=SimpleNamespace(kind='RUNTIME',sha256=p.runtime.manifest_sha256,source_sha=p.runtime.source_sha,
            tree_sha=p.runtime.tree_sha,node_sha256=p.runtime.node_sha256)
        toolkit_manifest=SimpleNamespace(kind='TOOLKIT',sha256=p.toolkit.manifest_sha256,source_sha=p.toolkit.source_sha,
            tree_sha=p.toolkit.tree_sha,node_sha256=p.runtime.node_sha256)
        artifact=SimpleNamespace(path=Path(p.paths.release_parent)/p.runtime.source_sha,
            manifest_sha256=p.runtime.manifest_sha256,source_sha=p.runtime.source_sha,scope='ROOT_DESCRIPTOR_PUBLICATION')
        self.bundle=q._QualifiedBundle(p,artifact,runtime,toolkit_manifest,'a'*64,'b'*64,'c'*64,b'Source canary',
            'd'*64,'e'*64)

    def stage_source_negatives(self):
        # Deliberately false private Source staging exercises guards only. No
        # Root positive, producer, filesystem or service context is simulated.
        from rbridge_installation import qualification_collector as c,material_review_collector as r
        from rbridge_installation.privileged_collector import PrivilegedFixtureOrigins
        origins=c.QualificationOrigins(None,None,None,None,None,PrivilegedFixtureOrigins(*([None]*7)),None,None)
        material=c._RootQualificationMaterialObservation(report_sha256(self.p),report_sha256(self.p),
            report_sha256(origins),'{}','/root/.rbridge-privileged-'+'a'*32)
        c._observations[material]=(report_sha256(material),origins,c._snapshot(origins),self.p,self.p,
            self.bundle.runtime_manifest,self.bundle.toolkit_manifest,'{}')
        review=r._RootMaterialReviewObservation(report_sha256(self.p),report_sha256(material),'{}','[]')
        r._observations[review]=(report_sha256(review),material,self.bundle.runtime_manifest,self.bundle.toolkit_manifest,self.p,'{}')
        self.issuer._origins[self.bundle]=(self.q._bundle_pin(self.bundle),material,review,self.p,
            self.bundle.runtime_manifest,self.bundle.toolkit_manifest,self.bundle.runtime_artifact,'{}','{}',
            '/root/.rbridge-privileged-'+'b'*32)
        self.q._qualified[self.bundle]=self.q._bundle_pin(self.bundle)
        self.addCleanup(lambda:c._observations.pop(material,None));self.addCleanup(lambda:r._observations.pop(review,None))
        self.addCleanup(lambda:self.issuer._origins.pop(self.bundle,None));self.addCleanup(lambda:self.q._qualified.pop(self.bundle,None))
        return c,r,origins,material,review

    def test_source_issuance_refuses_before_root_material_review_lookup_or_write(self):
        with patch('os.open',side_effect=AssertionError('Source Root write')), \
             patch.object(self.issuer,'verify_root_qualification_material',side_effect=AssertionError('Source material producer')), \
             patch.object(self.issuer,'verify_root_material_review',side_effect=AssertionError('Source owner review')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_ISSUER_ROOT_CONTEXT_UNQUALIFIED',
                self.issuer.issue_root_qualification_bundle,self.p,None,None,{})

    def test_constructed_bundle_or_root_pass_labels_have_no_issuer_origin(self):
        for value in (self.bundle,{'scope':'ROOT_COMPLETE_QUALIFICATION_BUNDLE','status':'PASS'}):
            with patch('os.open',side_effect=AssertionError('Caller Root open')):
                self.assertRaisesRegex(ValueError,'QUALIFICATION_ISSUER_ORIGIN_UNQUALIFIED',
                    self.issuer.verify_root_bundle_origin,self.p,value)

    def test_legacy_metadata_registry_alone_cannot_prepare_or_open_root_state(self):
        self.q._qualified[self.bundle]=self.q._bundle_pin(self.bundle)
        try:
            with patch('os.open',side_effect=AssertionError('Metadata-only Root open')):
                self.assertRaisesRegex(ValueError,'QUALIFICATION_ISSUER_ORIGIN_UNQUALIFIED',
                    self.q.verify_qualification_bundle,self.p,self.bundle)
        finally:del self.q._qualified[self.bundle]

    def test_complete_false_source_staging_still_stops_at_actual_root_context(self):
        self.stage_source_negatives()
        with patch('os.open',side_effect=AssertionError('False Source Root open')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_ISSUER_ROOT_CONTEXT_UNQUALIFIED',
                self.q.verify_qualification_bundle,self.p,self.bundle)

    def test_equal_metadata_runtime_artifact_or_manifest_cannot_replace_original_object(self):
        self.stage_source_negatives()
        for field in ('runtime_artifact','runtime_manifest','toolkit_manifest'):
            original=getattr(self.bundle,field);substitute=copy.copy(original)
            object.__setattr__(self.bundle,field,substitute)
            try:
                with patch('os.open',side_effect=AssertionError('Substituted Root open')):
                    self.assertRaisesRegex(ValueError,'QUALIFICATION_ISSUER_ORIGIN_CHANGED',
                        self.issuer.verify_root_bundle_origin,self.p,self.bundle)
            finally:object.__setattr__(self.bundle,field,original)

    def test_changed_complete_bundle_pin_cannot_reuse_original_issuer(self):
        self.stage_source_negatives()
        for field,value in (('reader_context_sha256','f'*64),('canary_bytes',b'changed Source canary'),
                ('python_closure_sha256','f'*64),('evidence_sha256','f'*64)):
            original=getattr(self.bundle,field);object.__setattr__(self.bundle,field,value)
            try:
                with patch('os.open',side_effect=AssertionError('Changed Root open')):
                    self.assertRaisesRegex(ValueError,'QUALIFICATION_ISSUER_ORIGIN_CHANGED',
                        self.issuer.verify_root_bundle_origin,self.p,self.bundle)
            finally:object.__setattr__(self.bundle,field,original)

    def test_review_must_refer_to_identical_original_material_even_with_equal_bytes(self):
        c,_r,_origins,material,_review=self.stage_source_negatives();substitute=copy.copy(material)
        c._observations[substitute]=c._observations[material]
        self.addCleanup(lambda:c._observations.pop(substitute,None))
        row=list(self.issuer._origins[self.bundle]);row[1]=substitute;self.issuer._origins[self.bundle]=tuple(row)
        with patch('os.open',side_effect=AssertionError('Mixed material Root open')):
            self.assertRaisesRegex(ValueError,'MATERIAL_REVIEW_MATERIAL_ORIGIN_CHANGED',
                self.issuer.verify_root_bundle_origin,self.p,self.bundle)

    def test_mutated_original_material_cannot_reuse_issued_origin_before_io(self):
        _c,_r,_origins,material,_review=self.stage_source_negatives()
        object.__setattr__(material,'evidence_json','{"status":"PASS"}')
        with patch('os.open',side_effect=AssertionError('Changed original Root open')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_COLLECTOR_OBSERVATION_CHANGED',
                self.issuer.verify_root_bundle_origin,self.p,self.bundle)

    def test_post_issue_preservation_never_repeats_original_production_fixture_baseline(self):
        self.stage_source_negatives()
        with patch('os.open',side_effect=AssertionError('Source Root open')), \
             patch.object(self.issuer,'verify_root_qualification_material',side_effect=AssertionError('Fresh pre-switch recapture')), \
             patch.object(self.issuer,'verify_root_material_review',side_effect=AssertionError('Fresh pre-switch review')):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_ISSUER_ROOT_CONTEXT_UNQUALIFIED',
                self.issuer.verify_root_bundle_origin,self.p,self.bundle)


if __name__=='__main__':unittest.main()
