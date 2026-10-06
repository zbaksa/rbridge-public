"""Kernel/process observations under the maintained pause; no signalling or IPC."""
from datetime import datetime, timezone
import hashlib
import json
import os
import re
import time
from .host_backend import QualifiedHostBackend, _kernel_bytes, _assert_process_view
from .models import InstallationError, encode_report, record, report_sha256
from .pause_backup import PauseLease


class ProcessObservationError(InstallationError):
    pass


def _stat_identity(raw, pid):
    try:
        value = raw.decode('utf-8', errors='strict')
        close = value.rfind(')')
        fields = value[close + 2:].split()
        if (close < 0 or not value.startswith(str(pid) + ' (') or len(fields) < 20
                or not re.fullmatch(r'[1-9][0-9]{0,31}', fields[19])):
            raise ValueError()
        return fields[19]
    except (ValueError, UnicodeError):
        raise ProcessObservationError('PROCESS_KERNEL_IDENTITY_INVALID') from None


def probe_kernel_process(pid):
    """Return an actual stable identity, or twice-observed absence. Partial loss is unknown."""
    if type(pid) is not int or not 2 <= pid <= 2147483647:
        raise ProcessObservationError('PROCESS_PROBE_PID_INVALID')
    _assert_process_view()
    root = '/proc/' + str(pid)
    try:
        try:
            before = _kernel_bytes(root + '/stat')
        except FileNotFoundError:
            try:
                _kernel_bytes(root + '/stat')
            except FileNotFoundError:
                return None
            raise ProcessObservationError('PROCESS_KERNEL_IDENTITY_CHANGED') from None
        ticks = _stat_identity(before, pid)
        command = _kernel_bytes(root + '/cmdline', 65536)
        executable = os.readlink(root + '/exe')
        if not command or not executable.startswith('/') or '\x00' in executable:
            raise ProcessObservationError('PROCESS_KERNEL_IDENTITY_INVALID')
        if (ticks != _stat_identity(_kernel_bytes(root + '/stat'), pid)
                or command != _kernel_bytes(root + '/cmdline', 65536)
                or executable != os.readlink(root + '/exe')):
            raise ProcessObservationError('PROCESS_KERNEL_IDENTITY_CHANGED')
        return {'pid': pid, 'startTimeTicks': ticks, 'exe': executable,
                'cmdlineSha256': hashlib.sha256(command).hexdigest()}
    except OSError:
        raise ProcessObservationError('PROCESS_KERNEL_OBSERVATION_UNAVAILABLE') from None


def collect_process_observations(lease, token, targets):
    """All sessions are captured completely, with pause checks before and after each."""
    if lease.scope == 'QUALIFIED_HOST_PAUSE':
        if (type(lease) is not PauseLease or type(lease.backend) is not QualifiedHostBackend
                or os.getuid() != 0 or os.geteuid() != 0):
            raise ProcessObservationError('PROCESS_OBSERVER_NOT_QUALIFIED')
        scope = 'QUALIFIED_HOST_PROCESS'
    elif lease.scope == 'FIXTURE_AUTHORITY_ONLY' and lease.backend.scope == 'FIXTURE_AUTHORITY_ONLY':
        scope = 'FIXTURE_AUTHORITY_ONLY'
    else:
        raise ProcessObservationError('PROCESS_OBSERVER_NOT_QUALIFIED')
    try:
        token = record('SnapshotToken', json.loads(encode_report(token)))
        if scope == 'QUALIFIED_HOST_PROCESS' and token.pause_sha256 != lease.pause_sha256:
            raise ProcessObservationError('PROCESS_PAUSE_TOKEN_CHANGED')
        checked, ids = [], set()
        for index, target in enumerate(targets):
            if (index >= lease.profile.budget.state_entries or type(target) is not dict
                    or set(target) != {'session_id', 'pid', 'start_ticks', 'identity_sha256'}
                    or type(target['session_id']) is not str
                    or not re.fullmatch(r'[0-9a-f]{32}', target['session_id'])
                    or target['session_id'] in ids or type(target['pid']) is not int
                    or (target['pid'] != 0 and not 2 <= target['pid'] <= 2147483647)
                    or type(target['start_ticks']) is not str
                    or not re.fullmatch(r'0|[1-9][0-9]{0,31}', target['start_ticks'])
                    or type(target['identity_sha256']) is not str
                    or not re.fullmatch(r'[0-9a-f]{64}', target['identity_sha256'])):
                raise ProcessObservationError('PROCESS_PROBE_TARGET_INVALID')
            ids.add(target['session_id']); checked.append(dict(target))
        deadline = time.monotonic() + lease.profile.budget.scan_ms / 1000
        result = []
        for target in checked:
            if time.monotonic() >= deadline:
                raise ProcessObservationError('PROCESS_OBSERVATION_DEADLINE')
            lease.check()
            unit = lease.backend.observe_process_unit(lease.profile, target['session_id'])
            if (type(unit) is not dict or set(unit) != {'unit', 'cgroup', 'settled', 'invocation_sha256'}
                    or unit['unit'] != 'cocwin-remote-bridge-process-' + target['session_id'] + '.service'
                    or type(unit['cgroup']) is not str or type(unit['settled']) is not bool
                    or type(unit['invocation_sha256']) is not str
                    or not re.fullmatch(r'[0-9a-f]{64}', unit['invocation_sha256'])):
                raise ProcessObservationError('PROCESS_UNIT_OBSERVATION_INVALID')
            actual = None if target['pid'] == 0 else lease.backend.probe_process(target['pid'])
            state = ('ABSENT' if actual is None else
                     'MATCHING' if report_sha256(actual) == target['identity_sha256']
                     and actual.get('startTimeTicks') == target['start_ticks'] else 'REUSED')
            lease.check()
            if time.monotonic() >= deadline:
                raise ProcessObservationError('PROCESS_OBSERVATION_DEADLINE')
            result.append(record('ProcessObservation', {
                'scope': scope, **target, 'cgroup': unit['cgroup'],
                'cgroup_settled': unit['settled'], 'settled': state == 'ABSENT' and unit['settled'],
                'process_state': state, 'snapshot_sha256': report_sha256(token),
                'unit_sha256': unit['invocation_sha256'],
                'observed_identity_sha256': report_sha256(actual),
                'profile_sha256': report_sha256(lease.profile),
                'observed_at': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            }))
        lease.check()
        return tuple(result)
    except ProcessObservationError:
        raise
    except (ValueError, TypeError, KeyError, AttributeError, OSError):
        raise ProcessObservationError('PROCESS_OBSERVATION_INVALID') from None
