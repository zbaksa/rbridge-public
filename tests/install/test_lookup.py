import json
from unittest.mock import patch
import unittest
from _loader import toolkit
from _fixtures import valid_profile


class FixtureGitHub:
    scope = 'FIXTURE_AUTHORITY_ONLY'

    def __init__(self, change=None):
        self.calls = []
        self.change = change

    def read_graphql(self, query, variables, timeout_ms, response_limit):
        self.calls.append((query, variables, timeout_ms, response_limit))
        repo = {'nameWithOwner': 'zbaksa/rbridge-public'}
        for key, number in variables.items():
            if not key.startswith('n') or key == 'name':
                continue
            repo['i' + key[1:]] = {
                '__typename': 'Issue', 'number': number,
                'title': '[COCWIN BRIDGE REQUEST] fixture-' + str(number),
                'body': '{}', 'author': {'login': 'zbaksa'},
                'url': 'https://github.com/zbaksa/rbridge-public/issues/' + str(number),
                'state': 'CLOSED', 'updatedAt': '2026-10-05T00:01:01Z',
            }
        result = {'data': {
            'viewer': {'login': 'zbaksa'}, 'repository': repo,
            'rateLimit': {'limit': 5000, 'cost': 1, 'remaining': 4999,
                          'used': 1, 'resetAt': '2026-10-06T00:00:00Z'},
        }}
        if self.change:
            replacement = self.change(result, len(self.calls))
            if replacement is not None:
                return replacement
        return json.dumps(result).encode()


class LookupTests(unittest.TestCase):
    def setUp(self):
        toolkit()
        try:
            from rbridge_installation.github_lookup import lookup_issues, LookupError
        except ImportError:
            self.fail('Authenticated bounded GitHub lookup is not implemented')
        from rbridge_installation.profile import parse_profile
        self.lookup, self.error = lookup_issues, LookupError
        self.profile = parse_profile(valid_profile())

    def test_fixed_query_batches_twenty_five_and_reuses_duplicate_numbers(self):
        backend = FixtureGitHub()
        issues = self.lookup(self.profile, [*range(1, 28), 17], backend)
        self.assertEqual([i.number for i in issues], list(range(1, 28)))
        self.assertEqual(len(backend.calls), 2)
        for query, variables, timeout, limit in backend.calls:
            self.assertTrue(query.startswith('query('))
            self.assertNotIn('mutation', query)
            self.assertIn('followRenames:false', query)
            self.assertIn('viewer{login}', query)
            self.assertIn('rateLimit{limit cost remaining used resetAt}', query)
            self.assertLessEqual(len(variables) - 2, 25)
            self.assertEqual((timeout, limit), (15000, 2097152))
        self.assertEqual(issues[0].updatedAt, '2026-10-05T00:01:01.000Z')
        self.assertEqual(len(backend.rate_observations), 2)
        self.assertEqual(backend.rate_observations[0].remaining, 4999)
        self.assertEqual(backend.capture_scope, 'FIXTURE_AUTHORITY_ONLY')

    def test_empty_history_still_verifies_viewer_repository_and_rate_budget(self):
        backend = FixtureGitHub()
        self.assertEqual(self.lookup(self.profile, [], backend), ())
        self.assertEqual(len(backend.calls), 1)

    def test_auth_omissions_pr_null_errors_and_changed_identity_never_return_partial(self):
        def viewer(r, _): r['data']['viewer']['login'] = 'other'
        def omission(r, _): del r['data']['repository']['i0']
        def null(r, _): r['data']['repository']['i0'] = None
        def pr(r, _): r['data']['repository']['i0'] = {'__typename': 'PullRequest'}
        def errors(r, _): r['errors'] = [{'message': 'rate budget unavailable'}]
        def identity(r, _): r['data']['repository']['i0']['number'] = 999
        def repository(r, _): r['data']['repository']['nameWithOwner'] = 'other/repo'
        def author(r, _): r['data']['repository']['i0']['author']['login'] = 'other'
        for change in (viewer, omission, null, pr, errors, identity, repository, author):
            with self.subTest(change=change.__name__), self.assertRaises(self.error):
                self.lookup(self.profile, [17], FixtureGitHub(change))

    def test_body_and_response_limits_are_complete_not_truncating(self):
        for size in (65536, 65537):
            def change(r, _, size=size): r['data']['repository']['i0']['body'] = 'x' * size
            if size == 65536:
                self.assertEqual(len(self.lookup(self.profile, [17], FixtureGitHub(change))[0].body), size)
            else:
                with self.assertRaises(self.error): self.lookup(self.profile, [17], FixtureGitHub(change))
        with self.assertRaises(self.error):
            self.lookup(self.profile, [17], FixtureGitHub(lambda *_: b' ' * 2097153))

    def test_exhausted_rate_budget_and_second_batch_failure_return_no_partial_capture(self):
        def exhausted(r, _): r['data']['rateLimit'].update(remaining=0, used=5000)
        backend = FixtureGitHub(exhausted)
        with self.assertRaises(self.error): self.lookup(self.profile, range(1, 27), backend)
        self.assertEqual(len(backend.calls), 1)
        self.assertEqual(backend.capture_status, 'UNKNOWN')
        def partial(r, call):
            if call == 2: r['errors'] = [{'message': 'secondary rate limit'}]
        backend = FixtureGitHub(partial)
        with self.assertRaises(self.error): self.lookup(self.profile, range(1, 27), backend)
        self.assertEqual(backend.capture_status, 'UNKNOWN')

    def test_deadline_duplicate_json_and_spoofed_qualification_never_pass(self):
        for elapsed in (16, 601):
            with patch('rbridge_installation.github_lookup.time.monotonic', side_effect=[0, 0, elapsed]):
                with self.assertRaises(self.error): self.lookup(self.profile, [17], FixtureGitHub())
        backend = FixtureGitHub(lambda *_: b'{"data":{},"data":{}}')
        with self.assertRaises(self.error): self.lookup(self.profile, [17], backend)
        backend = FixtureGitHub(); backend.scope = 'QUALIFIED_GITHUB_READ'
        with self.assertRaises(self.error): self.lookup(self.profile, [17], backend)
        self.assertFalse(backend.calls)

    def test_invalid_numbers_are_refused_before_any_query(self):
        for numbers in ([True], [0], [2147483648], ['17']):
            backend = FixtureGitHub()
            with self.assertRaises(self.error): self.lookup(self.profile, numbers, backend)
            self.assertFalse(backend.calls)
