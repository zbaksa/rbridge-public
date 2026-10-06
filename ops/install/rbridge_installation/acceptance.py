"""Two fixed read canaries and preserved, read-only post-restart acceptance.

The source constructor can exercise orchestration but cannot accept an installation.
Actual construction requires the privately qualified Root transport bundle; missing
physical qualification blocks before a canary file, submission or restart occurs.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import re
import time
import weakref
from typing import Protocol
from .models import InstallationError, encode_report, report_sha256


class AcceptanceError(InstallationError): pass
class AcceptanceNotReady(AcceptanceError): pass


@dataclass(frozen=True, eq=False)
class AcceptanceContext:
    prepared: object
    invocation: dict
    profile_sha256: str
    runtime_manifest_sha256: str
    readers_sha256: str
    canary_bytes: bytes
    operation_ids: tuple
    scope: str
    deadline: float


class AcceptanceBackend(Protocol):
    scope: str
    def verify_installed(self, context): ...
    def reserve(self, context, requests): ...
    def prepare_canary(self, context): ...
    def submit_once(self, context, request): ...
    def read_results(self, context, requests, carriers, stage, original=None): ...
    def settle_helpers(self, context): ...
    def restart_candidate(self, context): ...
    def now_ms(self): ...
    def wait_ms(self, delay): ...


class AcceptanceReport(dict):
    """The private completion registry binds the exact report to its preparation."""


_contexts = weakref.WeakKeyDictionary()
_completed = {}


def _fail(reason): raise AcceptanceError(reason)


def _pin(context):
    return report_sha256({'invocation': context.invocation,
        'profile_sha256': context.profile_sha256,
        'runtime_manifest_sha256': context.runtime_manifest_sha256,
        'readers_sha256': context.readers_sha256,
        'canary_sha256': hashlib.sha256(context.canary_bytes).hexdigest(),
        'operation_ids': context.operation_ids, 'scope': context.scope})


def _validate_preparation(prepared):
    from .transaction import PreparedInstallation, _prepared, _preparation_pin, _preparation_pins
    if (type(prepared) is not PreparedInstallation or prepared not in _prepared
            or prepared.poisoned or prepared.status != 'READY'
            or prepared.profile_sha256 != report_sha256(prepared.profile)
            or _preparation_pin(prepared) != _preparation_pins[prepared]):
        _fail('ACCEPTANCE_PREPARATION_UNQUALIFIED')


def _invocation(context, value):
    expected = 'FIXTURE_AUTHORITY_ONLY' if context.scope == 'FIXTURE_AUTHORITY_ONLY' else 'QUALIFIED_INSTALLED_INVOCATION'
    if (type(value) is not dict or value.get('scope') != expected or value.get('status') != 'PASS'
            or value.get('profile_sha256') != context.profile_sha256
            or value.get('runtime_manifest_sha256') != context.runtime_manifest_sha256
            or not re.fullmatch('[0-9a-f]{64}', str(value.get('invocation_sha256', '')))):
        _fail('ACCEPTANCE_INSTALLED_INVOCATION_UNQUALIFIED')
    return value


def _context(prepared, invocation, canary, source):
    _validate_preparation(prepared)
    if (type(canary) is not bytes or not 0 < len(canary) <= 4096
            or hashlib.sha256(canary).hexdigest() != prepared.profile.service.canary_sha256):
        _fail('ACCEPTANCE_CANARY_INVALID')
    try: canary.decode('utf-8', errors='strict')
    except UnicodeError: _fail('ACCEPTANCE_CANARY_INVALID')
    scope = 'FIXTURE_AUTHORITY_ONLY' if source else 'QUALIFIED_INSTALLED_ACCEPTANCE'
    if source != (prepared.scope == 'FIXTURE_AUTHORITY_ONLY'):
        _fail('ACCEPTANCE_CONTEXT_UNQUALIFIED')
    transaction = prepared.ledger.transaction_id
    if not re.fullmatch('[0-9a-f]{32}', transaction): _fail('ACCEPTANCE_IDENTITY_INVALID')
    # IDs are declared once, recorded before network submission and never replaced.
    prefix = 'install.' + transaction + '.' + prepared.profile_sha256[:16]
    result = AcceptanceContext(prepared, json.loads(encode_report(invocation)),
        prepared.profile_sha256, prepared.runtime_manifest.sha256,
        prepared.readers_sha256, canary, (prefix + '.health', prefix + '.file'),
        scope, time.monotonic() + prepared.profile.budget.acceptance_ms / 1000)
    _invocation(result, result.invocation)
    _contexts[result] = _pin(result)
    return result


def _make_fixture_acceptance_context(prepared, invocation, canary):
    """Source-only; never called by the fixed Root CLI."""
    return _context(prepared, invocation, canary, True)


def make_acceptance_context(prepared, invocation):
    _validate_preparation(prepared)
    if prepared.scope != 'QUALIFIED_PREPARED_INSTALLATION': _fail('ACCEPTANCE_CONTEXT_UNQUALIFIED')
    from .transaction import _validate, _authorization
    from .host_backend import QualifiedHostBackend
    from .qualification import verify_qualification_bundle
    backend = prepared.lease.backend
    if type(backend) is not QualifiedHostBackend or prepared.evidence is None:
        _fail('ACCEPTANCE_CONTEXT_UNQUALIFIED')
    _validate(prepared, backend); _authorization(prepared, prepared.authorization)
    bundle = verify_qualification_bundle(prepared.profile, prepared.bundle)
    if prepared.ledger.read().entries[-1].marker != 'ACCEPTING': _fail('ACCEPTANCE_CONTEXT_UNQUALIFIED')
    if report_sha256(backend.observe_candidate(prepared)) != report_sha256(invocation):
        _fail('ACCEPTANCE_INSTALLED_INVOCATION_CHANGED')
    return _context(prepared, invocation, bundle.canary_bytes, False)


def _check(context):
    if type(context) is not AcceptanceContext or context not in _contexts or _pin(context) != _contexts[context]:
        _fail('ACCEPTANCE_CONTEXT_UNQUALIFIED')
    _validate_preparation(context.prepared)
    if time.monotonic() >= context.deadline: _fail('ACCEPTANCE_DEADLINE')
    if context.scope != 'FIXTURE_AUTHORITY_ONLY': context.prepared.lease.check_exclusion()


def _stamp(milliseconds):
    if type(milliseconds) is not int or not 0 <= milliseconds <= 253402300799999:
        _fail('ACCEPTANCE_TIME_INVALID')
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _requests(context, backend):
    created = backend.now_ms(); ttl = context.prepared.profile.budget.canary_ttl_ms
    operations = ({'kind': 'HEALTH', 'action': 'STATUS'},
        {'kind': 'FILE', 'action': 'READ', 'target': context.prepared.profile.paths.canary_path, 'args': {}})
    return tuple({'schema': 'COCWIN_REMOTE_BRIDGE_REQUEST_V2', 'requestId': operation_id,
        'createdAt': _stamp(created), 'expiresAt': _stamp(created + ttl), 'operation': operation}
        for operation_id, operation in zip(context.operation_ids, operations))


def _reader_report(context, value, requests, stage, original=None):
    keys = {'schema', 'scope', 'status', 'accepted', 'actual_mcp_readers', 'profile_sha256',
        'stage', 'captured_at', 'operations', 'reason_codes', 'sha256'}
    if (type(value) is not dict or set(value) != keys
            or value['schema'] != 'RBRIDGE_INSTALL_READER_ACCEPTANCE_V1'
            or value['scope'] != 'REFERENCE_ACCEPTANCE_ONLY' or value['accepted'] is not False
            or value['status'] != 'PASS' or value['reason_codes'] != []
            or value['profile_sha256'] != context.profile_sha256 or value['stage'] != stage
            or value['sha256'] != report_sha256({**value, 'sha256': ''})
            or type(value['operations']) is not list or len(value['operations']) != 2
            or (context.scope != 'FIXTURE_AUTHORITY_ONLY' and value['actual_mcp_readers'] is not True)):
        _fail('ACCEPTANCE_READERS_NOT_PASS')
    try:
        captured = datetime.fromisoformat(value['captured_at'].replace('Z', '+00:00'))
        if captured.tzinfo is None or captured.isoformat(timespec='milliseconds').replace('+00:00', 'Z') != value['captured_at']: raise ValueError()
    except (ValueError, TypeError, AttributeError): _fail('ACCEPTANCE_TIME_INVALID')
    for index, (operation, request) in enumerate(zip(value['operations'], requests)):
        row_keys = {'operation_id', 'kind', 'receipt_sha256', 'output_sha256', 'comment_id',
            'request_sha256', 'input_json', 'github_verdict_json', 'mcp_verdict_json'}
        if (type(operation) is not dict or set(operation) != row_keys
                or operation['operation_id'] != request['requestId']
                or operation['kind'] != request['operation']['kind']
                or operation['request_sha256'] != hashlib.sha256(encode_report(request)).hexdigest()
                or any(not re.fullmatch('[0-9a-f]{64}', str(operation[k])) for k in ('receipt_sha256', 'output_sha256'))
                or type(operation['comment_id']) is not int or not 1 <= operation['comment_id'] <= 9007199254740991
                or any(type(operation[k]) is not str or not operation[k] for k in ('input_json', 'github_verdict_json', 'mcp_verdict_json'))):
            _fail('ACCEPTANCE_READER_EVIDENCE_INVALID')
        if original:
            pin = original['operations'][index]
            if any(operation[k] != pin[k] for k in ('operation_id', 'kind', 'receipt_sha256', 'output_sha256', 'comment_id', 'request_sha256')):
                _fail('ACCEPTANCE_ORIGINAL_TRUTH_CHANGED')
            if value['captured_at'] <= request['expiresAt']: _fail('ACCEPTANCE_REPLAY_BEFORE_TTL')
    if len(encode_report(value)) > 67108864: _fail('ACCEPTANCE_EVIDENCE_BYTE_LIMIT')
    return value


def _poll(context, backend, requests, carriers, stage, original=None):
    while True:
        _check(context)
        try: return _reader_report(context, backend.read_results(context, requests, carriers, stage, original), requests, stage, original)
        except AcceptanceNotReady:
            backend.wait_ms(min(context.prepared.profile.budget.poll_ms,
                max(1, int((context.deadline - time.monotonic()) * 1000))))


def accept_installation(context: AcceptanceContext, backend: AcceptanceBackend):
    report = AcceptanceReport(schema='RBRIDGE_INSTALL_ACCEPTANCE_V1', status='UNKNOWN',
        accepted=False, scope='UNQUALIFIED', reason_codes=[], evidence=[], sha256='')
    def evidence(label, value):
        _check(context)
        if len(encode_report(value)) > 67108864: _fail('ACCEPTANCE_EVIDENCE_BYTE_LIMIT')
        row = {'label': label, 'sha256': report_sha256(value), 'value': value}
        if len(encode_report([*report['evidence'], row])) > 33554432: _fail('ACCEPTANCE_EVIDENCE_BYTE_LIMIT')
        report['evidence'].append(row)
        if context.scope != 'FIXTURE_AUTHORITY_ONLY': context.prepared.evidence.write('accept-' + label, value)
    try:
        _check(context); report['scope'] = context.scope
        if context.scope == 'FIXTURE_AUTHORITY_ONLY':
            if getattr(backend, 'scope', None) != 'FIXTURE_AUTHORITY_ONLY': _fail('ACCEPTANCE_BACKEND_UNQUALIFIED')
        else:
            # This constructor verifies the complete physical bundle and creates
            # fixed authenticated transports. A caller cannot inject a backend.
            from .acceptance_transport import QualifiedAcceptanceBackend
            from .host_backend import QualifiedHostBackend
            if type(backend) is not QualifiedHostBackend or backend is not context.prepared.lease.backend:
                _fail('ACCEPTANCE_BACKEND_UNQUALIFIED')
            backend = QualifiedAcceptanceBackend(context, backend)
        initial = _invocation(context, backend.verify_installed(context))
        if report_sha256(initial) != report_sha256(context.invocation): _fail('ACCEPTANCE_INSTALLED_INVOCATION_CHANGED')
        evidence('installed-before', initial)
        requests = _requests(context, backend); evidence('identities', requests)
        reservation = backend.reserve(context, requests)
        if reservation.get('status') != 'PASS' or reservation.get('ids') != list(context.operation_ids): _fail('ACCEPTANCE_IDENTITIES_NOT_RESERVED')
        evidence('reservation', reservation)
        canary = backend.prepare_canary(context)
        if canary.get('sha256') != hashlib.sha256(context.canary_bytes).hexdigest(): _fail('ACCEPTANCE_CANARY_CHANGED')
        evidence('canary', canary)
        carriers = []
        for index, request in enumerate(requests):
            _check(context)
            evidence('submit-intent-' + str(index), request)
            try: carrier = backend.submit_once(context, request)
            except (InstallationError, OSError, ValueError): _fail('ACCEPTANCE_SUBMISSION_UNCERTAIN')
            if (type(carrier) is not dict or type(carrier.get('number')) is not int
                    or not 1 <= carrier['number'] <= 2147483647
                    or carrier.get('request_id') != request['requestId']
                    or carrier.get('request_sha256') != report_sha256(request)
                    or any(c['number'] == carrier['number'] for c in carriers)):
                _fail('ACCEPTANCE_SUBMISSION_UNCERTAIN')
            carriers.append(carrier); evidence('submitted-' + str(index), carrier)
        original = _poll(context, backend, requests, carriers, 'ORIGINAL'); evidence('original', original)
        settled = backend.settle_helpers(context)
        if settled.get('scope') != context.scope or settled.get('status') != 'PASS' or settled.get('live_helpers') != []:
            _fail('ACCEPTANCE_HELPERS_UNSETTLED')
        evidence('helpers-before-restart', settled)
        _check(context); evidence('restart-intent', {'candidate_manifest_sha256': context.runtime_manifest_sha256,
            'previous_invocation_sha256': report_sha256(initial)})
        restarted = _invocation(context, backend.restart_candidate(context))
        if restarted['invocation_sha256'] == initial['invocation_sha256']: _fail('ACCEPTANCE_RESTART_NOT_OBSERVED')
        evidence('restarted', restarted)
        expires = max(int(datetime.fromisoformat(r['expiresAt'].replace('Z', '+00:00')).timestamp() * 1000) for r in requests)
        while backend.now_ms() <= expires:
            _check(context); backend.wait_ms(min(1000, expires - backend.now_ms() + 1))
        replay = _poll(context, backend, requests, carriers, 'REPLAY', original); evidence('replay', replay)
        settled = backend.settle_helpers(context)
        if settled.get('scope') != context.scope or settled.get('status') != 'PASS' or settled.get('live_helpers') != []:
            _fail('ACCEPTANCE_HELPERS_UNSETTLED')
        evidence('helpers-final', settled)
        final = _invocation(context, backend.verify_installed(context))
        if report_sha256(final) != report_sha256(restarted): _fail('ACCEPTANCE_FINAL_INVOCATION_CHANGED')
        evidence('installed-final', final)
        report.update(status='PASS', accepted=context.scope != 'FIXTURE_AUTHORITY_ONLY',
            profile_sha256=context.profile_sha256, original=original, replay=replay,
            initial_invocation_sha256=report_sha256(initial), final_invocation_sha256=report_sha256(final),
            final_invocation=final)
        if len(encode_report(dict(report))) > 67108864: _fail('ACCEPTANCE_EVIDENCE_BYTE_LIMIT')
        _check(context)
    except (InstallationError, OSError, ValueError, ImportError, AttributeError, TypeError) as error:
        report.update(status='UNKNOWN', accepted=False,
            reason_codes=[error.reason if isinstance(error, InstallationError) else 'ACCEPTANCE_STEP_UNCERTAIN'])
    report['sha256'] = report_sha256({**report, 'sha256': ''})
    if report['accepted']:
        key = id(report)
        _completed[key] = (weakref.ref(report, lambda _ref: _completed.pop(key, None)), context, report['sha256'])
    return report


def validated_acceptance_invocation(prepared, report):
    """Only a complete report from this actual invocation can commit ACCEPTED."""
    entry = _completed.get(id(report))
    if (type(report) is not AcceptanceReport or entry is None or entry[0]() is not report
            or entry[1].prepared is not prepared or report.get('accepted') is not True
            or report.get('status') != 'PASS' or report.get('scope') != 'QUALIFIED_INSTALLED_ACCEPTANCE'
            or report.get('sha256') != entry[2]
            or report_sha256({**report, 'sha256': ''}) != entry[2]):
        _fail('ACCEPTANCE_COMPLETION_UNQUALIFIED')
    _check(entry[1])
    return report['final_invocation']
