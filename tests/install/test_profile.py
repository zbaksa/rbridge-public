import dataclasses
import unittest
from _loader import toolkit
from _fixtures import profile_with, valid_profile

class ProfileTests(unittest.TestCase):
    def test_shared_helper_wire_golden_and_boolean_identity_rejection(self):
        toolkit()
        from rbridge_installation.models import validate_contract, encode_report, CONTRACT
        ready={'schema':'RBRIDGE_INSTALL_HELPER_READY_V1','pid':31337,'nonce':'a'*64}
        validate_contract(ready,'HelperReady')
        self.assertEqual(encode_report(ready),b'{"nonce":"'+b'a'*64+b'","pid":31337,"schema":"RBRIDGE_INSTALL_HELPER_READY_V1"}')
        for bad in ({**ready,'pid':True},{**ready,'pid':1},{**ready,'nonce':'wrong'},{**ready,'extra':True}):
            with self.assertRaises(ValueError):validate_contract(bad,'HelperReady')
        issue={'number':17,'state':'CLOSED','title':'fixture','body':'retained','author':'fixture-owner','url':'https://github.com/fixture-owner/fixture/issues/17','isPullRequest':False,'updatedAt':'2026-10-06T00:00:00.000Z','capture_sha256':'b'*64}
        validate_contract(issue,'IssueEvidence')
        for bad in ({**issue,'isPullRequest':0},{**issue,'number':2147483648},{**issue,'extra':True}):
            with self.assertRaises(ValueError):validate_contract(bad,'IssueEvidence')
        for name in ('LookupCapture','DiscoveryInput','AuditInput','DiscoveryResult','ProcessProbeTarget','AuditError'):self.assertIn(name,CONTRACT['$defs'])
    def setUp(self):
        try:
            toolkit()
        except FileNotFoundError:
            self.fail('Strict deployment profile implementation is not installed yet')
        from rbridge_installation.profile import parse_profile, ProfileError
        from rbridge_installation.models import encode_report
        self.parse = parse_profile
        self.error = ProfileError
        self.encode = encode_report

    def test_profile_rejects_identity_pin_or_extra_field(self):
        for changes in [{'uid': 0}, {'uid': True}, {'node_version': '24.0.0'}, {'source_sha': '0' * 40}, {'mcp_subject': 'uid:0'}, {'github_subject': 'forged'}]:
            with self.subTest(changes=changes), self.assertRaises(self.error):
                self.parse(profile_with(**changes))
        p = valid_profile()
        p['binding']['credential'] = 'must-not-leak'
        with self.assertRaises(self.error) as error:
            self.parse(p)
        self.assertNotIn('must-not-leak', str(error.exception))

    def test_profile_pins_are_immutable_and_complete(self):
        p = self.parse(valid_profile())
        self.assertEqual(p.runtime.source_sha, 'b5881fd8367b4249e82683f1f884f2392cb696d4')
        with self.assertRaises(dataclasses.FrozenInstanceError):
            p.binding.uid = 0
        self.assertEqual(p.binding.supplementary_gids, ())
    def test_file_canary_stays_inside_existing_core_read_root(self):
        p=valid_profile();p['paths']['canary_path']='/mnt/data/fixture-canary.txt'
        self.assertEqual(self.parse(p).paths.canary_path,'/mnt/data/fixture-canary.txt')
        for path in ('/home/rbridge/fixture-canary.txt','/mnt/data','/mnt/database/canary','/mnt/data/../canary'):
            p['paths']['canary_path']=path
            with self.subTest(path=path),self.assertRaises(self.error):self.parse(p)

    def test_unsafe_paths_tool_roles_and_bounds_are_rejected(self):
        for section, key, value in [('paths', 'state_root', '/home/rbridge/../other'), ('budget', 'lookup_batch', 26), ('budget', 'record_bytes', 65536), ('toolkit', 'python_version', '3.10.9')]:
            p = valid_profile()
            p[section][key] = value
            with self.subTest(key=key), self.assertRaises(self.error): self.parse(p)
        p = valid_profile()
        p['tools'].append(p['tools'][0])
        with self.assertRaises(self.error): self.parse(p)
        p = valid_profile()
        p['binding']['supplementary_gids'] = [3, 3]
        with self.assertRaises(self.error): self.parse(p)

    def test_schema_roundtrip_canonical_golden(self):
        self.assertEqual(self.encode({'status': 'PASS', 'checks': [{'status': 'PASS', 'name': 'fixture'}]}), b'{"checks":[{"name":"fixture","status":"PASS"}],"status":"PASS"}')
        for bad in [float('nan'), 1.5, 9007199254740992]:
            with self.assertRaises(ValueError): self.encode({'count': bad})

    def test_optional_report_fields_keep_absence_and_unicode_key_order(self):
        from rbridge_installation.models import record
        check = record('Check', {'name': 'fixture', 'status': 'PASS'})
        self.assertEqual(self.encode(check), b'{"name":"fixture","status":"PASS"}')
        self.assertEqual(self.encode({'😀': 2, '\ue000': 1}).decode(), '{"\ue000":1,"😀":2}')
