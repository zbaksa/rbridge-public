"""Qualification completeness comparisons; source predicates grant no Root action."""
import hashlib
import copy
import json
import importlib.util
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from _loader import toolkit,ROOT
from _fixtures import valid_profile


class QualificationTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.qualification import build_qualification,QualificationProofs,verify_qualification_bundle
        except ImportError:self.fail('Concrete qualification boundary is not implemented')
        from rbridge_installation.profile import parse_profile
        self.build,self.Proofs,self.verify=build_qualification,QualificationProofs,verify_qualification_bundle
        self.profile=parse_profile(valid_profile())

    def test_no_proof_or_pass_labels_never_prepare_a_root_transaction(self):
        result=self.build(self.profile,self.Proofs())
        self.assertEqual(result.status,'BLOCKED');self.assertFalse(result.command_ready)
        self.assertIn('QUALIFICATION_ACTUAL_READERS_UNKNOWN',result.reason_codes)
        for value in (result,{'status':'READY','scope':'QUALIFIED_ROOT_BUNDLE'},
                      {'status':'PASS','profile_sha256':result.profile_sha256}):
            self.assertRaises(ValueError,self.verify,self.profile,value)

    def test_non_json_or_cyclic_whole_proofs_are_rejected_before_assessment(self):
        cycle={};cycle['cycle']=cycle
        for value in (object(),cycle,{'number':float('nan')},{'text':'\ud800'}):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_EVIDENCE_INVALID',self.build,self.profile,self.Proofs(imports=value))

    def test_aggregate_proof_budget_includes_all_seven_sections(self):
        from rbridge_installation import qualification
        fragment={'text':'x'*40}
        with patch.object(qualification,'EVIDENCE_BYTES_LIMIT',160):
            self.assertRaisesRegex(ValueError,'QUALIFICATION_EVIDENCE_BYTE_LIMIT',self.build,self.profile,
                self.Proofs(**{name:fragment for name in ('source','artifact','readers','privileged','imports','review','bootstrap')}))

    def test_unqualified_bundle_cannot_create_or_reopen_a_root_ledger(self):
        from rbridge_installation.qualification import open_qualified_transaction_ledger,open_qualified_resume_ledger
        values=(self.build(self.profile,self.Proofs()),{'status':'PASS','scope':'QUALIFIED_ROOT_BUNDLE'})
        with patch('rbridge_installation.ledger.os.open',side_effect=AssertionError('Unqualified ledger filesystem access')):
            for value in values:
                self.assertRaises(ValueError,open_qualified_transaction_ledger,value,object())
                self.assertRaises(ValueError,open_qualified_resume_ledger,value,'a'*32)

    def test_source_ci_is_pinned_to_full_log_commit_tree_and_required_steps(self):
        log=b'full fixture CI log\n'
        source={'schema':'RBRIDGE_SOURCE_QUALIFICATION_V1','scope':'SOURCE_QUALIFICATION_ONLY',
            'commit':self.profile.toolkit.source_sha,'tree':self.profile.toolkit.tree_sha,
            'run_id':17,'conclusion':'success','node_version':'22.23.3',
            'steps':{name:'success' for name in ('installation_tests','tests','typecheck','lint','build','public_scrub','tracked_clean')},
            'log_base64':__import__('base64').b64encode(log).decode(),'log_sha256':hashlib.sha256(log).hexdigest()}
        result=self.build(self.profile,self.Proofs(source=source))
        self.assertEqual(result.checks['source'],'PASS');self.assertEqual(result.status,'BLOCKED')
        for change in ({'commit':'a'*40},{'tree':'b'*40},{'log_sha256':'f'*64},
                       {'steps':{**source['steps'],'tests':'skipped'}},{'scope':'QUALIFIED_INSTALLED_ARTIFACT'}):
            self.assertEqual(self.build(self.profile,self.Proofs(source={**source,**change})).checks['source'],'FAIL')

    def test_synthetic_archive_reference_parser_or_ci_runtime_does_not_qualify_readers_or_artifact(self):
        result=self.build(self.profile,self.Proofs(
            readers={'status':'PASS','actualAcceptance':'PASS','scope':'REFERENCE_PARSER_ONLY'},
            artifact={'status':'PASS','runtimeVersion':'22.23.3','uid':1027},
            privileged={'status':'PASS','scope':'FIXTURE_AUTHORITY_ONLY'}))
        self.assertEqual(result.status,'BLOCKED');self.assertFalse(result.command_ready)
        self.assertNotEqual(result.checks['readers'],'PASS');self.assertNotEqual(result.checks['artifact'],'PASS')
        self.assertNotEqual(result.checks['privileged'],'PASS')

    def test_rehashed_artifact_summary_without_full_operation_preimages_is_incomplete(self):
        from rbridge_installation.models import report_sha256
        p=self.profile;receipts={'only_summary_hash':'f'*64}
        report={'schema':'RBRIDGE_INSTALL_ARTIFACT_QUALIFICATION_V1','status':'PASS','reason_codes':[],
            'runtimeVersion':p.runtime.node_version,'actualNodeSHA256':p.runtime.node_sha256,
            'runtimeManifestSHA256':p.runtime.manifest_sha256,'toolkitManifestSHA256':p.toolkit.manifest_sha256,
            'sourceSHA':p.runtime.source_sha,'toolkitSHA':p.toolkit.source_sha,
            'scope':'ISOLATED_FINAL_ARTIFACT_OWNER_IPC_MCP_HELPER','ownerBoot':'PASS','mcpBoot':'PASS',
            'executedFixture':True,'fixtureReceiptsSHA256':report_sha256(receipts)}
        result=self.build(p,self.Proofs(artifact={'report':report,'receipts':receipts}))
        self.assertEqual(result.checks['artifact'],'FAIL');self.assertFalse(result.command_ready)

    def test_source_preimage_fixture_is_complete_data_but_never_physical_authority(self):
        from rbridge_installation.models import report_sha256
        from rbridge_installation.profile import parse_profile
        fixture=json.loads((ROOT/'tests/fixtures/rbridge-artifact-preimages.json').read_text())
        self.assertEqual(fixture['scope'],'SYNTHETIC_SOURCE_DATA_ONLY')
        p=parse_profile(fixture['profile'])
        def assess(receipts):
            report={'schema':'RBRIDGE_INSTALL_ARTIFACT_QUALIFICATION_V1','status':'PASS','reason_codes':[],
                'runtimeVersion':p.runtime.node_version,'actualNodeSHA256':p.runtime.node_sha256,
                'runtimeManifestSHA256':p.runtime.manifest_sha256,'toolkitManifestSHA256':p.toolkit.manifest_sha256,
                'sourceSHA':p.runtime.source_sha,'toolkitSHA':p.toolkit.source_sha,
                'scope':'ISOLATED_FINAL_ARTIFACT_OWNER_IPC_MCP_HELPER','ownerBoot':'PASS','mcpBoot':'PASS',
                'executedFixture':True,'fixtureReceiptsSHA256':report_sha256(receipts)}
            return self.build(p,self.Proofs(artifact={'report':report,'receipts':receipts}))
        result=assess(fixture['artifact'])
        self.assertEqual(result.checks['artifact'],'PASS');self.assertFalse(result.command_ready)
        self.assertEqual(result.scope,'QUALIFICATION_COMPLETENESS_ONLY')
        for mutation in ('missing','page','receipt','bytes','intent'):
            value=copy.deepcopy(fixture['artifact']);row=value['receipts'][0]
            if mutation=='missing':row.pop('receiptJSON')
            elif mutation=='page':row['pagesJSON']=[]
            elif mutation=='bytes':row['resultBase64']='Y2hhbmdlZA=='
            else:
                receipt=json.loads(row['receiptJSON']);receipt['principalId' if mutation=='receipt' else 'intentSha256']='attacker' if mutation=='receipt' else 'f'*64
                row['receiptJSON']=json.dumps(receipt,ensure_ascii=False,sort_keys=True,separators=(',',':'));row['receiptSHA256']=hashlib.sha256(row['receiptJSON'].encode()).hexdigest()
            self.assertEqual(assess(value).checks['artifact'],'FAIL')

    def test_root_entry_refuses_site_startup_before_any_toolkit_import(self):
        path=ROOT/'ops/install/rbridge_install.py';spec=importlib.util.spec_from_file_location('entry_source_site_fixture',path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with patch.object(module.os,'getuid',return_value=0),patch.object(module.os,'geteuid',return_value=0), \
             patch.object(module.sys,'flags',SimpleNamespace(isolated=True,no_site=False)), \
             patch.object(module.os,'open',side_effect=AssertionError('site-enabled entry must not open toolkit')):
            self.assertRaisesRegex(module.EntryError,'ROOT_ISOLATED_INTERPRETER_REQUIRED',module.import_protected_toolkit,{})

    def test_actual_closure_cannot_use_a_source_checkout_or_unpinned_digest(self):
        from rbridge_installation.qualification import verify_import_closure
        self.assertRaises(ValueError,verify_import_closure,ROOT,self.profile,{})


if __name__=='__main__':unittest.main()
