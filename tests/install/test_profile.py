import dataclasses
import unittest
from _loader import toolkit
from _fixtures import profile_with, valid_profile

class ProfileTests(unittest.TestCase):
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
