"""Fresh bounded issue reads. Query structure and executable are fixed here."""
from dataclasses import dataclass
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import selectors
import subprocess
import time
from typing import Protocol
from .host_backend import _protected_bytes
from .models import InstallationError, encode_report, report_sha256
from .profile import parse_profile


class LookupError(InstallationError):
    pass


@dataclass(frozen=True)
class IssueEvidence:
    number: int
    state: str
    title: str
    body: str
    author: str
    url: str
    isPullRequest: bool
    updatedAt: str
    capture_sha256: str


@dataclass(frozen=True)
class RateObservation:
    limit: int
    cost: int
    remaining: int
    used: int
    reset_at: str
    captured_at: str
    response_sha256: str


class GitHubReadBackend(Protocol):
    scope: str
    def read_graphql(self, query: str, variables: dict, timeout_ms: int,
                     response_limit: int) -> bytes: ...


def _query(count):
    if type(count) is not int or not 0 <= count <= 25:
        raise LookupError('LOOKUP_BATCH_INVALID')
    declarations = ','.join('$n' + str(i) + ':Int!' for i in range(count))
    args = '$owner:String!,$name:String!' + (',' + declarations if count else '')
    issues = ' '.join(
        'i' + str(i) + ':issueOrPullRequest(number:$n' + str(i) + '){'
        '__typename ... on Issue{number title body author{login} url state updatedAt}}'
        for i in range(count))
    return ('query(' + args + '){viewer{login} '
            'rateLimit{limit cost remaining used resetAt} '
            'repository(owner:$owner,name:$name,followRenames:false){nameWithOwner '
            + issues + '}}')


def _fields(value, required, reason='LOOKUP_RESPONSE_INVALID'):
    if type(value) is not dict or set(value) != set(required):
        raise LookupError(reason)
    return value


def _timestamp(value):
    # GitHub DateTime commonly omits milliseconds; the shared Node contract does not.
    if type(value) is not str or not re.fullmatch(
            r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z', value):
        raise LookupError('LOOKUP_TIMESTAMP_INVALID')
    try:
        parsed = datetime.fromisoformat(value[:-1] + '+00:00')
        return parsed.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    except ValueError:
        raise LookupError('LOOKUP_TIMESTAMP_INVALID') from None


def _text(value, maximum):
    if type(value) is not str or '\x00' in value:
        raise LookupError('LOOKUP_TEXT_INVALID')
    try:
        if len(value.encode('utf-8', errors='strict')) > maximum:
            raise LookupError('LOOKUP_TEXT_LIMIT')
    except UnicodeError:
        raise LookupError('LOOKUP_TEXT_INVALID') from None
    return value


def _response(raw, maximum):
    if type(raw) is not bytes or len(raw) > maximum:
        raise LookupError('LOOKUP_RESPONSE_LIMIT')
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise LookupError('LOOKUP_DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    try:
        result = json.loads(raw.decode('utf-8', errors='strict'), object_pairs_hook=pairs,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        stack = [(result, 0)]
        while stack:
            value, depth = stack.pop()
            if depth > 64:
                raise LookupError('LOOKUP_RESPONSE_DEPTH')
            if type(value) is dict:
                stack.extend((v, depth + 1) for v in value.values())
            elif type(value) is list:
                stack.extend((v, depth + 1) for v in value)
        if type(result) is dict and 'errors' in result:
            raise LookupError('LOOKUP_GRAPHQL_ERRORS')
        return _fields(result, ('data',))['data']
    except LookupError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise LookupError('LOOKUP_RESPONSE_INVALID') from None


def lookup_issues(profile, numbers, backend: GitHubReadBackend):
    """Return a complete immutable capture, or raise; never return a partial batch."""
    backend.capture_status = 'UNKNOWN'
    backend.rate_observations = ()
    scope = getattr(backend, 'scope', None)
    if scope == 'QUALIFIED_GITHUB_READ' and type(backend) is not QualifiedGitHubReadBackend:
        raise LookupError('LOOKUP_BACKEND_NOT_QUALIFIED')
    if scope not in ('QUALIFIED_GITHUB_READ', 'FIXTURE_AUTHORITY_ONLY'):
        raise LookupError('LOOKUP_BACKEND_NOT_QUALIFIED')
    backend.capture_scope = scope
    profile = parse_profile(json.loads(encode_report(profile)))
    if scope == 'QUALIFIED_GITHUB_READ' and report_sha256(profile) != report_sha256(backend.profile):
        raise LookupError('LOOKUP_PROFILE_CHANGED')
    unique = set()
    for index, number in enumerate(numbers):
        if index >= profile.budget.state_entries:
            raise LookupError('LOOKUP_ISSUE_COUNT_LIMIT')
        if type(number) is not int or not 1 <= number <= 2147483647:
            raise LookupError('LOOKUP_ISSUE_NUMBER_INVALID')
        unique.add(number)
        if len(unique) > profile.budget.state_entries:
            raise LookupError('LOOKUP_ISSUE_COUNT_LIMIT')
    ordered = sorted(unique)
    batches = [ordered[i:i + profile.budget.lookup_batch]
               for i in range(0, len(ordered), profile.budget.lookup_batch)] or [[]]
    started = time.monotonic()
    deadline = started + profile.budget.lookup_overall_ms / 1000
    observations, issues = [], []
    owner, name = profile.binding.repository.split('/')
    for batch_index, batch in enumerate(batches):
        call_started = time.monotonic()
        if call_started >= deadline:
            raise LookupError('LOOKUP_OVERALL_DEADLINE')
        if observations and observations[-1].remaining < 1:
            raise LookupError('LOOKUP_RATE_BUDGET_EXHAUSTED')
        variables = {'owner': owner, 'name': name,
                     **{'n' + str(i): number for i, number in enumerate(batch)}}
        try:
            raw = backend.read_graphql(_query(len(batch)), variables,
                                       profile.budget.lookup_ms,
                                       profile.budget.lookup_response_bytes)
        except LookupError:
            raise
        except Exception:
            raise LookupError('LOOKUP_COMMAND_UNAVAILABLE') from None
        call_finished = time.monotonic()
        if call_finished >= deadline:
            raise LookupError('LOOKUP_OVERALL_DEADLINE')
        if (call_finished - call_started) * 1000 > profile.budget.lookup_ms:
            raise LookupError('LOOKUP_COMMAND_DEADLINE')
        data = _fields(_response(raw, profile.budget.lookup_response_bytes),
                       ('viewer', 'repository', 'rateLimit'))
        if _fields(data['viewer'], ('login',))['login'] != profile.binding.author:
            raise LookupError('LOOKUP_VIEWER_MISMATCH')
        repo = _fields(data['repository'], ('nameWithOwner', *('i' + str(i) for i in range(len(batch)))))
        if repo['nameWithOwner'] != profile.binding.repository:
            raise LookupError('LOOKUP_REPOSITORY_MISMATCH')
        rate = _fields(data['rateLimit'], ('limit', 'cost', 'remaining', 'used', 'resetAt'))
        if (any(type(rate[k]) is not int or not 0 <= rate[k] <= 9007199254740991
                for k in ('limit', 'cost', 'remaining', 'used'))
                or rate['limit'] < 1 or rate['cost'] < 1
                or rate['cost'] > rate['limit'] or rate['remaining'] > rate['limit']
                or rate['used'] > rate['limit']):
            raise LookupError('LOOKUP_RATE_OBSERVATION_INVALID')
        observation = RateObservation(
            rate['limit'], rate['cost'], rate['remaining'], rate['used'],
            _timestamp(rate['resetAt']),
            datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            hashlib.sha256(raw).hexdigest())
        observations.append(observation)
        # Observations survive a later omission/error; capture_status remains UNKNOWN.
        backend.rate_observations = tuple(observations)
        for i, number in enumerate(batch):
            row = _fields(repo['i' + str(i)], ('__typename', 'number', 'title', 'body',
                          'author', 'url', 'state', 'updatedAt'), 'LOOKUP_ISSUE_MISSING_OR_PR')
            if (row['__typename'] != 'Issue' or type(row['number']) is not int
                    or row['number'] != number or row['state'] not in ('OPEN', 'CLOSED')
                    or _fields(row['author'], ('login',))['login'] != profile.binding.author
                    or row['url'] != f'https://github.com/{profile.binding.repository}/issues/{number}'):
                raise LookupError('LOOKUP_ISSUE_IDENTITY_MISMATCH')
            base = {'number': number, 'state': row['state'],
                    'title': _text(row['title'], 1024), 'body': _text(row['body'], 65536),
                    'author': profile.binding.author, 'url': row['url'], 'isPullRequest': False,
                    'updatedAt': _timestamp(row['updatedAt'])}
            issues.append(IssueEvidence(**base, capture_sha256=report_sha256(base)))
        if batch_index + 1 < len(batches) and observation.remaining < 1:
            raise LookupError('LOOKUP_RATE_BUDGET_EXHAUSTED')
    backend.capture_sha256 = report_sha256(tuple(issues))
    backend.profile_sha256 = report_sha256(profile)
    backend.rate_sha256 = report_sha256(tuple(observations))
    backend.capture_status = 'PASS'
    return tuple(issues)


class QualifiedGitHubReadBackend:
    scope = 'QUALIFIED_GITHUB_READ'

    def __init__(self, profile, retain_queries=False):
        if os.getuid() != 0 or os.geteuid() != 0:
            raise LookupError('LOOKUP_ROOT_REQUIRED')
        if type(retain_queries) is not bool:raise LookupError('LOOKUP_EVIDENCE_MODE_INVALID')
        self.retain_queries=retain_queries;self.query_evidence=[];self.query_evidence_bytes=0
        self.profile = parse_profile(json.loads(encode_report(profile)))
        self.tool = next(t for t in self.profile.tools if t.role == 'gh')
        self._qualify()
        version = self._run(('--version',), b'', 5000, 16384).decode('utf-8').splitlines()[0]
        if version != self.tool.version:
            raise LookupError('LOOKUP_TOOL_VERSION_MISMATCH')

    def _qualify(self):
        try:
            digest = hashlib.sha256(_protected_bytes(self.tool.path, 16777216)).hexdigest()
            if digest != self.tool.sha256:
                raise LookupError('LOOKUP_TOOL_BYTES_MISMATCH')
        except (OSError, InstallationError):
            raise LookupError('LOOKUP_TOOL_UNQUALIFIED') from None

    def _run(self, args, input_bytes, timeout_ms, limit):
        from .owned_process import run_owned_process
        self._qualify()
        raw,errors,proof=run_owned_process(self.tool,args,timeout_ms,limit,
            input_bytes=input_bytes,
            env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/root',
                 'LC_ALL':'C','GH_PROMPT_DISABLED':'1'},guard=self._qualify)
        if not hasattr(self,'helper_sessions'):self.helper_sessions=[]
        self.helper_sessions.append(proof)
        if proof['status']!='PASS' or proof['exit_code']!=0:
            raise LookupError('LOOKUP_COMMAND_FAILED')
        if self.retain_queries:
            evidence={'argv':[self.tool.path,*args],
                'input_base64':base64.b64encode(input_bytes).decode(),
                'output_base64':base64.b64encode(raw).decode(),'stderr_base64':base64.b64encode(errors).decode(),
                'session':proof}
            size=len(encode_report(evidence))
            if self.query_evidence_bytes+size>self.profile.budget.carrier_bytes:raise LookupError('LOOKUP_EVIDENCE_BYTE_LIMIT')
            self.query_evidence.append(evidence);self.query_evidence_bytes+=size
        return raw

    def read_graphql(self, query, variables, timeout_ms, response_limit):
        numbers = [v for k, v in variables.items() if re.fullmatch(r'n\d+', k)]
        expected = {'owner': self.profile.binding.repository.split('/')[0],
                    'name': self.profile.binding.repository.split('/')[1],
                    **{'n' + str(i): n for i, n in enumerate(numbers)}}
        if (variables != expected or query != _query(len(numbers))
                or any(type(n) is not int or not 1 <= n <= 2147483647 for n in numbers)
                or timeout_ms != self.profile.budget.lookup_ms
                or response_limit != self.profile.budget.lookup_response_bytes):
            raise LookupError('LOOKUP_FIXED_QUERY_REQUIRED')
        return self._run(('api', '--hostname', 'github.com', 'graphql', '--input', '-'),
                         encode_report({'query': query, 'variables': variables}),
                         timeout_ms, response_limit)
