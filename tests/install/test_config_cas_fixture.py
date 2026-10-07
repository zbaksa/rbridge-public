"""Actual isolated configuration filesystem mechanics remain Source evidence."""
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.profile import parse_profile
from rbridge_installation.models import encode_report


class ConfigCasFixtureTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.config_cas_fixture import produce_config_cas_cases,compare_config_cas_cases
        except ImportError:self.fail('Fixed isolated configuration CAS producer is absent')
        self.produce,self.compare=produce_config_cas_cases,compare_config_cas_cases
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.root.chmod(0o700);self.profile=parse_profile(valid_profile())

    def test_actual_owned_config_pointer_and_durable_ledger_match_fixed_cases(self):
        report=self.produce(self.root,self.profile);comparison=self.compare(self.profile,report)
        self.assertEqual(report['scope'],'ISOLATED_CONFIG_CAS_SOURCE_DATA_ONLY');self.assertFalse(comparison['may_execute'])
        self.assertEqual(list(report['cases']),['success','occupied','drift','post_start'])
        rows={k:json.loads(v['output_json']) for k,v in report['cases'].items()}
        success=rows['success'];self.assertEqual(success['restore_status'],'PASS');self.assertTrue(success['may_start_old'])
        self.assertEqual(success['before_originals'],success['after_originals']);self.assertFalse(success['binding_remains'])
        self.assertEqual(success['installed_modes'],{'binding':0o600,'dropin':0o644})
        self.assertEqual(success['environment_order'],['env/first','env/second','env/binding'])
        self.assertEqual(success['cpu_quota'],'150ms');self.assertEqual(success['hardening']['ProtectSystem'],'strict')
        self.assertEqual(rows['occupied']['refusal_reason'],'CONFIG_UNOWNED_PATH_EXISTS')
        self.assertEqual(rows['drift']['refusal_reason'],'CONFIG_FILE_CHANGED')
        self.assertEqual(rows['post_start']['refusal_reason'],'CONFIG_RESTORE_START_ATTEMPTED')
        self.assertEqual(rows['post_start']['restore_status'],'REFUSED')
        self.assertEqual(rows['post_start']['last_marker'],'START_ATTEMPTED');self.assertFalse(rows['post_start']['may_start_old'])
        self.assertTrue(rows['drift']['binding_remains']);self.assertTrue(rows['post_start']['binding_remains'])
        for name,row in rows.items():
            self.assertFalse(row['old_start_called']);self.assertEqual(row['fake_stop_calls'],1)
            raw=base64.b64decode(row['ledger']['base64'],validate=True)
            self.assertEqual(hashlib.sha256(raw).hexdigest(),row['ledger']['sha256'])
            self.assertEqual(raw,(self.root/name/'ledger'/row['transaction_id']/'ledger.json').read_bytes())

    def test_existing_parent_is_preserved_and_no_source_data_grants_root_permission(self):
        (self.root/'keep').write_bytes(b'preserve')
        self.assertRaisesRegex(ValueError,'COPY_LEDGER_FIXTURE_PARENT_NOT_EMPTY',self.produce,self.root,self.profile)
        self.assertEqual((self.root/'keep').read_bytes(),b'preserve')

    def test_full_rehash_cannot_hide_original_drift_or_post_start_restore(self):
        report=self.produce(self.root,self.profile)
        for case,mutate in [('success',lambda v:v.update(cpu_quota='100%')),
                            ('drift',lambda v:v.update(after_originals=v['before_originals'])),
                            ('post_start',lambda v:v.update(may_start_old=True)),
                            ('occupied',lambda v:v.update(binding_remains=False))]:
            forged=json.loads(encode_report(report));row=forged['cases'][case];out=json.loads(row['output_json']);mutate(out)
            row['output_json']=encode_report(out).decode();row['output_sha256']=hashlib.sha256(row['output_json'].encode()).hexdigest()
            self.assertRaises(ValueError,self.compare,self.profile,forged)

    def test_source_report_cannot_complete_physical_privileged_qualification(self):
        from rbridge_installation.qualification import QualificationProofs,build_qualification
        report=self.produce(self.root,self.profile)
        self.assertEqual(build_qualification(self.profile,QualificationProofs(privileged=report)).status,'BLOCKED')
        report['scope']='ISOLATED_ROOT_FIXTURES_ONLY'
        self.assertRaises(ValueError,self.compare,self.profile,report)

    def test_boolean_uid_is_not_a_zero_identity_after_full_input_rehash(self):
        report=self.produce(self.root,self.profile);report.update(uid=0,euid=0,gid=0,runtime_uid=0,runtime_gid=0)
        for row in report['cases'].values():
            inputs=json.loads(row['input_json']);inputs.update(runtime_uid=False,runtime_gid=False)
            row['input_json']=encode_report(inputs).decode();row['input_sha256']=hashlib.sha256(row['input_json'].encode()).hexdigest()
        self.assertRaises(ValueError,self.compare,self.profile,report)


if __name__=='__main__':unittest.main()
