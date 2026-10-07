"""Fixed isolated copy/crash producer, distinct from Root qualification."""
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
from _loader import toolkit
from _fixtures import valid_profile

toolkit()
from rbridge_installation.profile import parse_profile
from rbridge_installation.models import encode_report,report_sha256


class CopyLedgerFixtureTests(unittest.TestCase):
    def setUp(self):
        try:
            from rbridge_installation.copy_ledger_fixture import produce_copy_ledger_cases,compare_copy_ledger_cases
        except ImportError:self.fail('Fixed isolated copy and ledger crash producer is absent')
        self.produce,self.compare=produce_copy_ledger_cases,compare_copy_ledger_cases
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.root.chmod(0o700);self.profile=parse_profile(valid_profile())

    def test_actual_copy_and_crash_mechanics_preserve_complete_preimages(self):
        report=self.produce(self.root,self.profile)
        self.assertEqual(report['scope'],'ISOLATED_COPY_LEDGER_SOURCE_DATA_ONLY')
        self.assertEqual(report['runtime_uid'],os.getuid())
        self.assertEqual(set(report['cases']),{'copy','ledger_crash'})
        comparison=self.compare(self.profile,report)
        self.assertEqual(comparison['status'],'PASS');self.assertFalse(comparison['may_execute'])
        copy=json.loads(report['cases']['copy']['output_json'])
        self.assertEqual(copy['publication']['scope'],'FIXTURE_AUTHORITY_ONLY')
        self.assertEqual(copy['verification']['status'],'PASS')
        self.assertEqual(copy['confined_link'],'fixture-dependency/index.js')
        self.assertEqual(copy['collision_reason'],'COPY_DESTINATION_EXISTS')
        self.assertEqual(copy['unmanifested_reason'],'COPY_UNMANIFESTED_OBJECT')
        self.assertTrue(copy['collision_unchanged']);self.assertTrue(copy['tamper_rejected'])
        self.assertEqual((self.root/'copy/releases'/self.profile.runtime.source_sha/'node_modules/link').readlink(),Path('fixture-dependency/index.js'))
        crash=json.loads(report['cases']['ledger_crash']['output_json'])
        self.assertEqual(crash['pre_start']['exit_signal'],9)
        self.assertEqual(crash['post_start']['exit_signal'],9)
        self.assertEqual(crash['pre_start']['read_reason'],'LEDGER_PENDING_OR_UNKNOWN_OBJECT')
        self.assertEqual(crash['post_start']['action'],'HOLD_POST_START')
        self.assertFalse(crash['post_start']['may_start_old'])
        for key in ('pre_start','post_start'):
            row=crash[key];raw=base64.b64decode(row['ledger_base64'],validate=True)
            self.assertEqual(hashlib.sha256(raw).hexdigest(),row['ledger_sha256'])
            self.assertEqual(raw,(self.root/'ledger'/row['transaction_id']/'ledger.json').read_bytes())
        self.assertTrue((self.root/'ledger'/crash['pre_start']['transaction_id']/'pending.json').is_file())

    def test_occupied_or_unprotected_parent_refuses_before_copy_or_fork(self):
        (self.root/'keep').write_bytes(b'untouched')
        with patch('os.fork',side_effect=AssertionError('unexpected child')):
            self.assertRaisesRegex(ValueError,'COPY_LEDGER_FIXTURE_PARENT_NOT_EMPTY',self.produce,self.root,self.profile)
        self.assertEqual((self.root/'keep').read_bytes(),b'untouched')
        (self.root/'keep').unlink();self.root.chmod(0o777)
        with patch('os.fork',side_effect=AssertionError('unexpected child')):
            self.assertRaisesRegex(ValueError,'COPY_LEDGER_FIXTURE_PARENT_UNPROTECTED',self.produce,self.root,self.profile)

    def test_rehashed_raw_record_or_crash_claim_cannot_pass_comparison(self):
        report=self.produce(self.root,self.profile)
        for case,mutate in [('copy',lambda v:v.update(collision_unchanged=False)),
                            ('ledger_crash',lambda v:v['post_start'].update(may_start_old=True)),
                            ('ledger_crash',lambda v:v['pre_start'].update(ledger_base64=base64.b64encode(b'{}').decode()))]:
            forged=json.loads(encode_report(report));row=forged['cases'][case];out=json.loads(row['output_json']);mutate(out)
            row['output_json']=encode_report(out).decode();row['output_sha256']=hashlib.sha256(row['output_json'].encode()).hexdigest()
            self.assertRaises(ValueError,self.compare,self.profile,forged)
        forged=json.loads(encode_report(report));forged['scope']='ISOLATED_ROOT_FIXTURES_ONLY'
        self.assertRaises(ValueError,self.compare,self.profile,forged)

    def test_source_data_does_not_complete_six_case_privileged_qualification(self):
        from rbridge_installation.qualification import QualificationProofs,build_qualification
        report=self.produce(self.root,self.profile)
        assessment=build_qualification(self.profile,QualificationProofs(privileged=report))
        self.assertEqual(assessment.status,'BLOCKED');self.assertEqual(assessment.checks['privileged'],'FAIL')

    def test_rehashed_manifest_with_an_extra_directory_is_not_the_fixed_fixture(self):
        from rbridge_installation.artifact import ArtifactEntry,_manifest
        report=self.produce(self.root,self.profile);row=report['cases']['copy']
        inputs=json.loads(row['input_json']);output=json.loads(row['output_json']);old=inputs['manifest']
        entries=[ArtifactEntry(**e) for e in old['entries']]+[ArtifactEntry('unused','DIRECTORY',0,0o755,'','')]
        manifest=_manifest(old['kind'],old['source_sha'],old['tree_sha'],old['node_sha256'],tuple(sorted(entries,key=lambda e:e.path.encode())))
        inputs['manifest']=json.loads(encode_report(manifest));output['publication']['manifest_sha256']=manifest.sha256
        output['verification'].update(manifest_sha256=manifest.sha256,observed_sha256=manifest.sha256)
        row['input_json']=encode_report(inputs).decode();row['output_json']=encode_report(output).decode()
        row['input_sha256']=hashlib.sha256(row['input_json'].encode()).hexdigest();row['output_sha256']=hashlib.sha256(row['output_json'].encode()).hexdigest()
        self.assertRaisesRegex(ValueError,'COPY_LEDGER_FIXTURE_MANIFEST_CHANGED',self.compare,self.profile,report)

    def test_missing_pidfd_authority_prevents_child_ledger_mutation(self):
        from rbridge_installation.copy_ledger_fixture import _crash
        from rbridge_installation.ledger import _open_fixture_ledger,MARKERS
        fd=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY);self.addCleanup(os.close,fd)
        tx='a'*32;evidence={'profile_sha256':'1'*64};ledger=_open_fixture_ledger(fd,tx)
        try:
            for marker in MARKERS[:10]:ledger.append(marker,evidence)
        finally:ledger.close()
        before=(self.root/tx/'ledger.json').read_bytes();children=[];actual=os.fork
        def fork():
            pid=actual()
            if pid>0:children.append(pid)
            return pid
        try:
            with patch('os.fork',side_effect=fork),patch('os.pidfd_open',side_effect=OSError('fixture missing pidfd')):
                self.assertRaises((OSError,ValueError),_crash,fd,tx,evidence,False)
            for pid in children:
                deadline=time.monotonic()+2
                while time.monotonic()<deadline:
                    try:child,_=os.waitpid(pid,os.WNOHANG)
                    except ChildProcessError:break
                    if child==pid:break
                    time.sleep(0.01)
                else:self.fail('The producer left its fixed child unsettled')
            self.assertEqual((self.root/tx/'ledger.json').read_bytes(),before)
            self.assertFalse((self.root/tx/'pending.json').exists())
        finally:
            for pid in children:
                try:os.kill(pid,9);os.waitpid(pid,0)
                except (ProcessLookupError,ChildProcessError):pass


if __name__=='__main__':unittest.main()
