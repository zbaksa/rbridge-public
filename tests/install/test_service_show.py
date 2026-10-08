"""Source parsing of systemctl's repeated array-property output; no Root proof."""
import unittest
from _loader import toolkit
from _fixtures import valid_profile


SHOW = b'''Restart=on-failure
MainPID=0
ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/fixture/current/main.js ; ignore_errors=no ; start_time=[n/a] ; }
ControlGroup=/system.slice/rbridge.service
CPUQuotaPerSecUSec=150ms
Environment=FIXTURE_ONLY=1
EnvironmentFiles=/srv/fixture/runtime.env (ignore_errors=no)
EnvironmentFiles=/srv/fixture/flowpilot.env (ignore_errors=no)
UnsetEnvironment=
User=rbridge
Group=rbridge
ReadWritePaths=/srv/fixture/state
ProtectHome=read-only
ProtectSystem=strict
NoNewPrivileges=yes
ActiveState=inactive
SubState=dead
FragmentPath=/srv/fixture/rbridge.service
DropInPaths=
InvocationID=
'''


class ServiceShowTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        from rbridge_installation.host_backend import QualifiedHostBackend
        from rbridge_installation.profile import parse_profile
        self.backend = object.__new__(QualifiedHostBackend)
        self.backend.profile = parse_profile(valid_profile())
        self.backend.cgroups = {}

    def show(self, raw):
        # Only the external protected-tool boundary is replaced. The real parser
        # and cgroup consistency checks still consume the complete wire response.
        self.backend._run = lambda _args, _timeout: raw
        return self.backend._show('rbridge.service')

    def test_repeated_environment_files_preserve_effective_precedence(self):
        try:
            rows = self.show(SHOW)
        except ValueError as error:
            self.fail('Valid repeated EnvironmentFiles was refused: ' + str(error))
        self.assertEqual(rows['EnvironmentFiles'],
            '/srv/fixture/runtime.env (ignore_errors=no) /srv/fixture/flowpilot.env (ignore_errors=no)')
        self.assertEqual(rows['CPUQuotaPerSecUSec'], '150ms')
        self.assertEqual(self.backend.cgroups, {'rbridge.service': '/system.slice/rbridge.service'})

    def test_single_line_environment_files_remain_supported(self):
        combined = SHOW.replace(
            b'EnvironmentFiles=/srv/fixture/runtime.env (ignore_errors=no)\nEnvironmentFiles=',
            b'EnvironmentFiles=/srv/fixture/runtime.env (ignore_errors=no) ')
        self.assertEqual(self.show(combined)['EnvironmentFiles'],
            '/srv/fixture/runtime.env (ignore_errors=no) /srv/fixture/flowpilot.env (ignore_errors=no)')

    def test_repeated_scalar_properties_still_refuse(self):
        combined = SHOW.replace(
            b'EnvironmentFiles=/srv/fixture/runtime.env (ignore_errors=no)\nEnvironmentFiles=',
            b'EnvironmentFiles=/srv/fixture/runtime.env (ignore_errors=no) ')
        for extra in (b'User=rbridge\n', b'MainPID=0\n', b'ExecStart=\n', b'DropInPaths=\n'):
            with self.subTest(extra=extra):
                self.assertRaisesRegex(ValueError, 'HOST_SERVICE_OBSERVATION_INVALID', self.show, combined + extra)

    def test_empty_repeated_environment_property_still_refuses(self):
        for raw in (SHOW + b'EnvironmentFiles=\n', SHOW.replace(
                b'EnvironmentFiles=/srv/fixture/runtime.env (ignore_errors=no)', b'EnvironmentFiles=')):
            with self.subTest(raw=raw):
                self.assertRaisesRegex(ValueError, 'HOST_SERVICE_OBSERVATION_INVALID', self.show, raw)


if __name__ == '__main__':
    unittest.main()
