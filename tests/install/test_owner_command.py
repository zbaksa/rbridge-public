"""Whole command byte comparisons are Source data until actual Root review."""
import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from _loader import toolkit,ROOT
from _fixtures import valid_profile

toolkit()
from rbridge_installation.models import encode_report,report_sha256
from rbridge_installation.profile import parse_profile


def command_input():
    p=parse_profile(valid_profile());request={'python_closure_sha256':'a'*64}
    custody={'schema':'RBRIDGE_QUALIFICATION_CUSTODY_LOCATOR_V1','directory':'/root/.rbridge-privileged-'+'b'*32,
        'profile_sha256':report_sha256(p),'bundle_pin':'c'*64,'evidence_sha256':'d'*64,
        'capsule_sha256':'e'*64,'request_sha256':report_sha256(request)}
    payload=(ROOT/'ops/install/rbridge_bootstrap.py').read_bytes()
    manifest={'schema':'RBRIDGE_BOOTSTRAP_MANIFEST_V1','source_sha':p.toolkit.source_sha,'tree_sha':p.toolkit.tree_sha,
        'payload_bytes':len(payload),'payload_sha256':hashlib.sha256(payload).hexdigest(),
        'toolkit_manifest_sha256':p.toolkit.manifest_sha256,'python_closure_sha256':request['python_closure_sha256']}
    return p,{'profile':json.loads(encode_report(p)),'qualification':{**request,'custody':custody},
        'bootstrap':{'issue_number':17,'manifest':manifest},'command_review_issue':18}


class OwnerCommandDataTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import owner_command as c
        except ImportError:self.fail('Exact reviewed owner command implementation is absent')
        self.c=c;self.p,self.value=command_input();self.recipe=c.owner_command_recipe(self.p,'prepare',self.value)
        body={'schema':'RBRIDGE_OWNER_EXACT_COMMAND_REVIEW_V1','decision':'APPROVED_EXACT_COMMAND',
            'scope':'REVIEWED_BOOTSTRAP_COMMAND_ONLY','pins':self.recipe['pins'],'switch_authorized':False}
        self.capture={'schema':'RBRIDGE_OWNER_COMMAND_REVIEW_CAPTURE_V1','repository':self.p.binding.repository,
            'viewer':self.p.binding.author,'author':self.p.binding.author,'issue_number':18,'is_pull_request':False,
            'url':'https://github.com/'+self.p.binding.repository+'/issues/18','body':encode_report(body).decode()}

    def test_whole_command_and_input_pins_are_data_only_with_valid_shell_syntax(self):
        recipe=self.recipe
        self.assertEqual(recipe['pins']['input_sha256'],hashlib.sha256(encode_report(self.value)).hexdigest())
        self.assertEqual(recipe['pins']['command_sha256'],hashlib.sha256(recipe['script'].encode()).hexdigest())
        self.assertEqual(recipe['pins']['command_bytes'],len(recipe['script'].encode()))
        self.assertEqual(subprocess.run(['/bin/bash','-n'],input=recipe['script'],text=True,capture_output=True,timeout=5).returncode,0)
        result=self.c.compare_owner_command_review(self.p,'prepare',self.value,self.capture)
        self.assertEqual(result['scope'],'OWNER_COMMAND_REVIEW_DATA_ONLY');self.assertEqual(result['physical_origin'],'UNQUALIFIED')
        self.assertFalse(result['may_execute']);self.assertFalse(result['service_action_authorized'])

    def test_every_reviewed_pin_decision_and_identity_is_exact(self):
        for field in self.recipe['pins']:
            capture=copy.deepcopy(self.capture);body=json.loads(capture['body'])
            value=body['pins'][field];body['pins'][field]=19 if type(value) is int else 'changed'
            capture['body']=encode_report(body).decode()
            with self.subTest(pin=field):self.assertRaises(ValueError,self.c.compare_owner_command_review,self.p,'prepare',self.value,capture)
        for field,value in [('viewer','foreign'),('author','foreign'),('repository','foreign/repo'),
                ('issue_number',True),('is_pull_request',True),('url','https://attacker.invalid')]:
            with self.subTest(field=field):self.assertRaises(ValueError,self.c.compare_owner_command_review,self.p,'prepare',self.value,{**self.capture,field:value})
        for field,value in [('decision','SOURCE_PASS'),('scope','SWITCH_AUTHORIZED'),('switch_authorized',True)]:
            body=json.loads(self.capture['body']);body[field]=value
            self.assertRaises(ValueError,self.c.compare_owner_command_review,self.p,'prepare',self.value,{**self.capture,'body':encode_report(body).decode()})

    def test_full_input_change_cannot_reuse_review_even_with_recomputed_recipe(self):
        for section,field,value in [('qualification','custody',dict(self.value['qualification']['custody'],capsule_sha256='f'*64)),
                ('bootstrap','issue_number',19)]:
            changed=copy.deepcopy(self.value);changed[section][field]=value
            self.assertRaises(ValueError,self.c.compare_owner_command_review,self.p,'prepare',changed,self.capture)
        self.assertRaises(ValueError,self.c.compare_owner_command_review,self.p,'check',self.value,self.capture)

    def test_unknown_or_extra_inputs_and_numeric_aliases_refuse_before_root_io(self):
        with patch('os.open',side_effect=AssertionError('Source recipe Root IO')):
            for value in ({**self.value,'extra':True},{**self.value,'command_review_issue':True},
                    {**self.value,'qualification':{'status':'PASS'}},
                    {**self.value,'bootstrap':{**self.value['bootstrap'],'issue_number':17.0}}):
                self.assertRaises(ValueError,self.c.owner_command_recipe,self.p,'prepare',value)
            self.assertRaises(ValueError,self.c.owner_command_recipe,self.p,'exec',self.value)

    def test_apply_authorization_and_resume_status_identity_are_explicit(self):
        for operation in ('apply','resume','status'):
            self.assertRaises(ValueError,self.c.owner_command_recipe,self.p,operation,self.value)
        self.assertRaises(ValueError,self.c.owner_command_recipe,self.p,'prepare',{**self.value,'authorization':{}})
        for transaction in (True,'../old','a'*31):
            self.assertRaises(ValueError,self.c.owner_command_recipe,self.p,'resume',{**self.value,'transaction_id':transaction})
        for operation in ('resume','status'):
            result=self.c.owner_command_recipe(self.p,operation,{**self.value,'transaction_id':'f'*32})
            self.assertFalse(result['may_execute'])

    def test_actual_source_shell_mechanics_preserve_sudo_failure_exit_and_parent(self):
        # Replace only the invocation with a Source stub. No sudo, Root program,
        # toolkit or installation action runs; the reviewed surrounding wrapper
        # and full here-document remain byte-identical.
        for code in (0,2,3,4,5):
            with tempfile.TemporaryDirectory() as directory:
                from pathlib import Path
                helper=Path(directory)/'source-sudo-stub'
                helper.write_text('#!/bin/sh\n/bin/cat >/dev/null\nexit '+str(code)+'\n');helper.chmod(0o700)
                script=self.recipe['script'].replace('/usr/bin/sudo',str(helper),1)
                run=subprocess.run(['/bin/bash'],input='set -euo pipefail\n'+script+'printf "SOURCE_PARENT_ALIVE:%s\\n" "$?"\n',
                    text=True,capture_output=True,timeout=5)
                self.assertEqual(run.returncode,0);self.assertIn('RBRIDGE_OUTER_EXIT='+str(code),run.stdout)
                self.assertIn('SOURCE_PARENT_ALIVE:'+str(code),run.stdout)


class OwnerCommandOriginTests(unittest.TestCase):
    def setUp(self):
        try:from rbridge_installation import owner_command as c
        except ImportError:self.fail('Protected authenticated owner command collector is absent')
        self.c=c;self.p,self.value=command_input()

    def test_source_collector_refuses_before_qualification_lookup_or_root_io(self):
        with patch('os.open',side_effect=AssertionError('Source command Root open')), \
             patch.object(self.c,'verify_qualification_bundle',side_effect=AssertionError('Source command qualification')), \
             patch.object(self.c,'lookup_issues',side_effect=AssertionError('Source authenticated lookup')):
            self.assertRaisesRegex(ValueError,'OWNER_COMMAND_ROOT_CONTEXT_UNQUALIFIED',
                self.c.collect_root_owner_command_review,self.p,None,None,'prepare',self.value)

    def test_serialized_or_constructed_command_never_grants_private_origin(self):
        token=self.c._RootOwnerCommandObservation(report_sha256(self.p),'{}','/root/.rbridge-privileged-'+'a'*32)
        for token in (token,{'status':'PASS','scope':'ROOT_EXACT_REVIEWED_COMMAND','may_execute':True}):
            with patch('os.open',side_effect=AssertionError('Caller command Root open')):
                self.assertRaisesRegex(ValueError,'OWNER_COMMAND_ORIGIN_UNQUALIFIED',
                    self.c.verify_root_owner_command,self.p,token)

    def test_private_source_metadata_is_still_context_blocked_and_original_bundle_is_literal(self):
        bundle=object();bootstrap=object()
        token=self.c._RootOwnerCommandObservation(report_sha256(self.p),'{}','/root/.rbridge-privileged-'+'a'*32)
        self.c._observations[token]=(report_sha256(token),bundle,bootstrap,self.p,'prepare',encode_report(self.value).decode())
        try:
            with patch('os.open',side_effect=AssertionError('Staged Source Root open')):
                self.assertRaisesRegex(ValueError,'OWNER_COMMAND_BUNDLE_ORIGIN_CHANGED',
                    self.c.verify_root_owner_command,self.p,token,bundle=object())
                self.assertRaisesRegex(ValueError,'OWNER_COMMAND_ROOT_CONTEXT_UNQUALIFIED',
                    self.c.verify_root_owner_command,self.p,token,bundle=bundle)
                object.__setattr__(token,'evidence_json','{"scope":"ROOT_EXACT_REVIEWED_COMMAND"}')
                self.assertRaisesRegex(ValueError,'OWNER_COMMAND_OBSERVATION_CHANGED',self.c.verify_root_owner_command,self.p,token)
        finally:del self.c._observations[token]

    def test_entry_refuses_forged_command_token_before_custody_factory(self):
        spec=importlib.util.spec_from_file_location('owner_command_source_entry',ROOT/'ops/install/rbridge_install.py')
        entry=importlib.util.module_from_spec(spec);spec.loader.exec_module(entry)
        from rbridge_installation import qualification_custody as custody
        with patch.object(custody,'open_root_qualification_custody',side_effect=AssertionError('Forged command cold factory')):
            self.assertRaisesRegex(ValueError,'OWNER_COMMAND_ORIGIN_UNQUALIFIED',entry.dispatch,'prepare',
                self.c.entry_input(self.value),reviewed_command={'status':'PASS','may_execute':True})


class StandaloneOwnerCommandTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('owner_command_source_bootstrap',ROOT/'ops/install/rbridge_bootstrap.py')
        self.bootstrap=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.bootstrap)

    def test_source_driver_refuses_before_input_root_read_import_or_exec(self):
        for argv in ([str(ROOT/'ops/install/rbridge_bootstrap.py'),'--retrieve','prepare'],
                [str(ROOT/'ops/install/rbridge_bootstrap.py'),'--dispatch','prepare','/root/.rbridge-privileged-'+'a'*32+'/evidence.json']):
            with patch.object(sys,'argv',argv),patch('os.open',side_effect=AssertionError('Source Root input')), \
                 patch('os.execve',side_effect=AssertionError('Source Root exec')):
                self.assertRaisesRegex(ValueError,'BOOTSTRAP_OWNER_CONTEXT_UNQUALIFIED',self.bootstrap._run_owner_command)

    def test_actual_source_cli_remains_blocked_for_retrieval_and_internal_dispatch(self):
        for args in (['--retrieve','prepare'],['--dispatch','prepare','/root/.rbridge-privileged-'+'a'*32+'/evidence.json']):
            run=subprocess.run([sys.executable,'-I','-S','-B',str(ROOT/'ops/install/rbridge_bootstrap.py'),*args],
                input='{"status":"PASS","may_execute":true}',text=True,capture_output=True,timeout=5,cwd='/')
            self.assertEqual(run.returncode,2);value=json.loads(run.stdout)
            self.assertEqual(value['status'],'BLOCKED');self.assertFalse(value['may_execute'])
            self.assertIn('BOOTSTRAP_OWNER_CONTEXT_UNQUALIFIED',value['reason_codes'])


if __name__=='__main__':unittest.main()
