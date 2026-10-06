"""Source orchestration fixtures: no root transport or installed-reader claim."""
from dataclasses import replace
import copy
import hashlib
import unittest
from _loader import toolkit
import test_transaction


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.acceptance import (
                _make_fixture_acceptance_context, accept_installation,
                make_acceptance_context)
        except ImportError:
            self.fail('Installation acceptance orchestration is not implemented')
        from rbridge_installation.models import report_sha256
        from rbridge_installation.transaction import _prepare_fixture_installation
        self.hash = report_sha256
        self.accept = accept_installation
        self.make_actual = make_acceptance_context
        self.fixture = test_transaction.TransactionTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.canary = b'installation source canary\n'
        profile = replace(f.profile, service=replace(f.profile.service,
            canary_sha256=hashlib.sha256(self.canary).hexdigest()))
        self.prepared = _prepare_fixture_installation(
            profile, f.ledger, f.artifact, f.host.runtime_manifest)
        f.host.current_installation = self.prepared
        self.invocation = f.host.observe_candidate(self.prepared)
        self.context = _make_fixture_acceptance_context(
            self.prepared, self.invocation, self.canary)
        self.backend = FixtureAcceptanceBackend(self.hash, self.invocation)

    def test_source_replay_preserves_original_truth_and_never_claims_installed(self):
        result = self.accept(self.context, self.backend)
        self.assertEqual(result['status'], 'PASS', result['reason_codes'])
        self.assertFalse(result['accepted'])
        self.assertEqual(result['scope'], 'FIXTURE_AUTHORITY_ONLY')
        self.assertEqual(len(self.backend.submitted), 2)
        self.assertEqual(self.backend.original_ids, self.backend.replay_ids)
        self.assertEqual(result['original']['operations'], result['replay']['operations'])
        self.assertNotEqual(result['initial_invocation_sha256'], result['final_invocation_sha256'])
        self.assertFalse(self.backend.old_started)

    def test_health_environment_sha_without_installed_bytes_is_refused_before_submission(self):
        self.backend.installed = False
        result = self.accept(self.context, self.backend)
        self.assertNotEqual(result['status'], 'PASS')
        self.assertEqual(self.backend.submitted, [])

    def test_lost_submit_ack_never_resubmits_or_creates_another_identity(self):
        self.backend.lost_ack = True
        result = self.accept(self.context, self.backend)
        self.assertNotEqual(result['status'], 'PASS')
        self.assertEqual(len(self.backend.submitted), 1)
        self.assertEqual(self.backend.restarts, 0)
        self.assertIn('ACCEPTANCE_SUBMISSION_UNCERTAIN', result['reason_codes'])

    def test_changed_replay_receipt_or_canary_and_partial_pages_cannot_pass(self):
        for problem in ('receipt', 'canary', 'pages', 'author', 'policy'):
            with self.subTest(problem=problem):
                self.backend = FixtureAcceptanceBackend(self.hash, self.invocation)
                self.backend.problem = problem
                result = self.accept(self.context, self.backend)
                self.assertNotEqual(result['status'], 'PASS')
                self.assertFalse(result['accepted'])

    def test_helper_or_restart_uncertainty_stops_acceptance_without_old_restart(self):
        for problem in ('helpers', 'restart', 'stale_invocation'):
            with self.subTest(problem=problem):
                self.backend = FixtureAcceptanceBackend(self.hash, self.invocation)
                self.backend.problem = problem
                result = self.accept(self.context, self.backend)
                self.assertNotEqual(result['status'], 'PASS')
                self.assertFalse(self.backend.old_started)

    def test_pass_strings_cannot_mint_actual_context_or_acceptance(self):
        self.assertRaises(ValueError, self.make_actual, self.prepared, self.invocation)
        self.backend.scope = 'QUALIFIED_INSTALLED_ACCEPTANCE'
        self.assertNotEqual(self.accept(self.context, self.backend)['status'], 'PASS')

    def test_reference_or_rehashed_report_cannot_commit_actual_acceptance(self):
        from rbridge_installation.acceptance import validated_acceptance_invocation
        report = self.accept(self.context, self.backend)
        self.assertEqual(report['status'], 'PASS')
        report.update(scope='QUALIFIED_INSTALLED_ACCEPTANCE', accepted=True)
        report['sha256'] = self.hash({**report, 'sha256': ''})
        self.assertRaises(ValueError, validated_acceptance_invocation, self.prepared, report)

    def test_occupied_identity_and_changed_preparation_are_refused_before_submission(self):
        self.backend.occupied = True
        self.assertNotEqual(self.accept(self.context, self.backend)['status'], 'PASS')
        self.assertEqual(self.backend.submitted, [])
        self.prepared.readers_sha256 = '9' * 64
        self.backend.occupied = False
        self.assertNotEqual(self.accept(self.context, self.backend)['status'], 'PASS')
        self.assertEqual(self.backend.submitted, [])


class FixtureAcceptanceBackend:
    scope = 'FIXTURE_AUTHORITY_ONLY'

    def __init__(self, digest, invocation):
        self.hash = digest
        self.invocation = copy.deepcopy(invocation)
        self.installed = True
        self.occupied = False
        self.lost_ack = False
        self.old_started = False
        self.problem = ''
        self.submitted = []
        self.original_ids = []
        self.replay_ids = []
        self.restarts = 0
        self.now = 1000000000

    def now_ms(self): return self.now
    def wait_ms(self, delay): self.now += delay
    def verify_installed(self, context):
        if not self.installed: raise ValueError('env metadata only')
        return copy.deepcopy(self.invocation)
    def reserve(self, context, requests):
        if self.occupied: raise ValueError('reserved')
        return {'status': 'PASS', 'ids': [r['requestId'] for r in requests]}
    def prepare_canary(self, context):
        return {'sha256': hashlib.sha256(context.canary_bytes).hexdigest()}
    def submit_once(self, context, request):
        self.submitted.append(copy.deepcopy(request))
        if self.lost_ack: raise OSError('lost ACK after remote create')
        return {'number': len(self.submitted), 'request_id': request['requestId'],
                'request_sha256': self.hash(request)}
    def read_results(self, context, requests, carriers, stage, original=None):
        ids = [r['requestId'] for r in requests]
        if stage == 'ORIGINAL': self.original_ids = ids
        else: self.replay_ids = ids
        operations = [{'operation_id': r['requestId'], 'kind': r['operation']['kind'],
            'receipt_sha256': self.hash({'receipt': r['requestId']}),
            'output_sha256': self.hash({'output': r['requestId']}),
            'comment_id': i + 10, 'request_sha256': self.hash(r),
            'input_json': '{}', 'github_verdict_json': '{}', 'mcp_verdict_json': '{}'}
            for i, r in enumerate(requests)]
        if self.problem == 'receipt' and stage == 'REPLAY': operations[0]['receipt_sha256'] = 'f' * 64
        failed = self.problem in ('canary', 'pages', 'author', 'policy')
        row = {'schema': 'RBRIDGE_INSTALL_READER_ACCEPTANCE_V1',
            'scope': 'REFERENCE_ACCEPTANCE_ONLY', 'accepted': False,
            'actual_mcp_readers': False, 'status': 'FAIL' if failed else 'PASS',
            'profile_sha256': context.profile_sha256, 'stage': stage,
            'captured_at': '2001-09-09T01:46:40.000Z', 'operations': operations,
            'reason_codes': ['ACCEPTANCE_READER_BINDING_INVALID'] if failed else [], 'sha256': ''}
        row['sha256'] = self.hash(row)
        return row
    def settle_helpers(self, context):
        if self.problem == 'helpers': raise OSError('helper family still live')
        return {'scope': self.scope, 'status': 'PASS', 'live_helpers': []}
    def restart_candidate(self, context):
        self.restarts += 1
        if self.problem == 'restart': raise OSError('lost restart ACK')
        if self.problem != 'stale_invocation': self.invocation['invocation_sha256'] = 'd' * 64
        return copy.deepcopy(self.invocation)


if __name__ == '__main__': unittest.main()
