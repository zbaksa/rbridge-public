"""Root-launched fixed helper sessions with bounded IO and observed settlement.

Child specifications come from the immutable launcher, never from stdin. They
describe the reviewed non-detached spawn closure (runuser, one reader, at most
two SDK stdio children). Unknown ancestry or session changes remain UNKNOWN.
"""
import hashlib
import os
import re
import selectors
import signal
import subprocess
import time
from .models import InstallationError
from .host_backend import _assert_kernel_namespace, _kernel_bytes, _protected_bytes


class OwnedProcessError(InstallationError): pass

_pending_sessions = {}


def assert_owned_helpers_settled():
    """Live foreground registry; a cold process must independently reconstruct it."""
    if _pending_sessions: _fail('OWNED_HELPER_FAMILY_UNSETTLED')


def _fail(reason): raise OwnedProcessError(reason)


def validate_owned_session(parent, rows, child_specs):
    """Pure predicate, not a process-origin or kernel-observation authority."""
    if type(rows) is not list or len(rows) > 8: _fail('OWNED_HELPER_FAMILY_UNCLASSIFIED')
    by_id = {}
    for row in rows:
        if (type(row) is not dict or set(row) != {'pid','start_ticks','ppid','session','uid','gid','groups','exe','argv'}
                or type(row['pid']) is not int or row['pid'] < 2 or row['pid'] in by_id
                or type(row['start_ticks']) is not str or not re.fullmatch('[1-9][0-9]*', row['start_ticks'])
                or row['session'] != parent['pid'] or int(row['start_ticks']) < int(parent['start_ticks'])):
            _fail('OWNED_HELPER_FAMILY_UNCLASSIFIED')
        by_id[row['pid']] = row
    if not rows: return []
    if by_id.get(parent['pid']) != parent: _fail('OWNED_HELPER_PARENT_CHANGED')
    counts = [0] * len(child_specs)
    for pid, row in by_id.items():
        if pid == parent['pid']: continue
        ancestor = by_id.get(row['ppid'])
        if ancestor is None or row['ppid'] == pid: _fail('OWNED_HELPER_ANCESTRY_UNCLASSIFIED')
        seen = {pid}; current = row
        while current['pid'] != parent['pid']:
            current = by_id.get(current['ppid'])
            if current is None or current['pid'] in seen: _fail('OWNED_HELPER_ANCESTRY_UNCLASSIFIED')
            seen.add(current['pid'])
        matches = [i for i,spec in enumerate(child_specs)
            if row['exe'] == spec['exe'] and row['argv'] == spec['argv']
            and ancestor['argv'] == spec['parent_argv']
            and row['uid'] == [spec['uid']] * 4 and row['gid'] == [spec['gid']] * 4
            and sorted(set(row['groups']) - {spec['gid']}) == spec['groups']
            and 0 not in row['groups']]
        if len(matches) != 1: _fail('OWNED_HELPER_CHILD_UNQUALIFIED')
        index = matches[0]; counts[index] += 1
        if counts[index] > child_specs[index]['max_count']: _fail('OWNED_HELPER_FAMILY_UNCLASSIFIED')
    return sorted(by_id)


def _stat(pid):
    raw = _kernel_bytes('/proc/' + str(pid) + '/stat', 65536)
    end = raw.rfind(b') ')
    if end < 0 or raw.split(b' ',1)[0] != str(pid).encode(): _fail('OWNED_HELPER_KERNEL_UNCLASSIFIED')
    values = raw[end + 2:].split()
    if len(values) < 20 or any(not re.fullmatch(rb'[0-9]+', values[i]) for i in (1,2,3,19)):
        _fail('OWNED_HELPER_KERNEL_UNCLASSIFIED')
    return {'pid': pid, 'state': values[0].decode('ascii'), 'ppid': int(values[1]),
        'session': int(values[3]), 'start_ticks': values[19].decode('ascii')}


def _row(pid, token):
    raw = _kernel_bytes('/proc/' + str(pid) + '/status'); result = {}
    for field in ('Uid','Gid','Groups'):
        match = re.search(('^' + field + r':\s*([0-9 \t]*)$').encode(), raw, re.M)
        if not match: _fail('OWNED_HELPER_KERNEL_UNCLASSIFIED')
        result[field.lower()] = [int(v) for v in match[1].split()]
    if len(result['uid']) != 4 or len(result['gid']) != 4: _fail('OWNED_HELPER_KERNEL_UNCLASSIFIED')
    argv = _kernel_bytes('/proc/' + str(pid) + '/cmdline', 65536)
    if not argv or not argv.endswith(b'\0'): _fail('OWNED_HELPER_KERNEL_UNCLASSIFIED')
    result.update(pid=pid, start_ticks=token['start_ticks'], ppid=token['ppid'], session=token['session'],
        exe=os.readlink('/proc/' + str(pid) + '/exe'), argv=argv[:-1].decode('utf-8',errors='strict').split('\0'))
    if _stat(pid) != token: _fail('OWNED_HELPER_KERNEL_CHANGED')
    return result


def _session_rows(session, deadline):
    _assert_kernel_namespace(); result = []
    names = os.listdir('/proc')
    if len(names) > 131072: _fail('OWNED_HELPER_KERNEL_LIMIT')
    for name in names:
        if not name.isascii() or not name.isdecimal() or int(name) < 2: continue
        if time.monotonic() >= deadline: _fail('OWNED_HELPER_DEADLINE')
        try:
            token = _stat(int(name))
            if token['session'] == session and token['state'] != 'Z': result.append(_row(int(name), token))
        except FileNotFoundError: continue
        except (PermissionError, UnicodeError): _fail('OWNED_HELPER_KERNEL_UNCLASSIFIED')
    return result


def run_owned_process(pin, args, timeout_ms, limit, input_bytes=b'', env=None,
                      child_specs=(), guard=None, ready=None):
    """Private fixed launch primitive; no shell, ambient credentials or name kills.

    Returned output is accompanied by launch/settlement facts. Missing namespace,
    pidfd or child-family classification blocks rather than implying a clean exit.
    """
    if os.getuid() != 0 or os.geteuid() != 0: _fail('OWNED_HELPER_ROOT_REQUIRED')
    _assert_kernel_namespace()
    if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'): _fail('OWNED_HELPER_PIDFD_UNAVAILABLE')
    if (type(args) not in (tuple,list) or any(type(a) is not str or '\0' in a for a in args)
            or type(input_bytes) is not bytes or len(input_bytes)>67108864
            or type(timeout_ms) is not int or not 1 <= timeout_ms <= 600000
            or type(limit) is not int or not 1 <= limit <= 67108864): _fail('OWNED_HELPER_INPUT_INVALID')
    def qualify():
        if guard: guard()
        if hashlib.sha256(_protected_bytes(pin.path,268435456)).hexdigest()!=pin.sha256:
            _fail('OWNED_HELPER_EXECUTABLE_CHANGED')
    qualify()
    child = subprocess.Popen([pin.path,*args],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,cwd='/',start_new_session=True,
        env=env if env is not None else {'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':'/root','LC_ALL':'C'})
    _pending_sessions[child.pid]={'argv':[pin.path,*args],'executable_sha256':pin.sha256}
    selector=selectors.DefaultSelector(); handles={}; observed={}; out=bytearray(); errors=bytearray()
    deadline=time.monotonic()+timeout_ms/1000; parent=None; released=ready is None; pending=memoryview(input_bytes)
    proof={'schema':'RBRIDGE_OWNED_HELPER_SESSION_V1','scope':'ROOT_FIXED_PROCESS_OBSERVATION',
        'status':'UNKNOWN','pid':child.pid,'argv':[pin.path,*args],
        'executable_sha256':pin.sha256,'input_sha256':hashlib.sha256(input_bytes).hexdigest(),'processes':[]}
    def census():
        rows=_session_rows(child.pid,min(deadline,time.monotonic()+5))
        if rows:
            nonlocal parent
            actual=next((r for r in rows if r['pid']==child.pid),None)
            if parent is None:
                if (actual is None or actual['ppid']!=os.getpid() or actual['session']!=child.pid
                        or actual['uid']!=[0]*4 or actual['exe']!=pin.path or actual['argv']!=[pin.path,*args]):
                    _fail('OWNED_HELPER_PARENT_UNQUALIFIED')
                parent=actual
            validate_owned_session(parent,rows,child_specs)
            for row in rows:
                pid=row['pid']
                if pid in observed and observed[pid]!=row: _fail('OWNED_HELPER_IDENTITY_CHANGED')
                if pid not in observed:
                    existing=pid in handles
                    handle=handles[pid] if existing else os.pidfd_open(pid)
                    try:
                        token=_stat(pid)
                        if token['start_ticks']!=row['start_ticks'] or _row(pid,token)!=row: _fail('OWNED_HELPER_IDENTITY_CHANGED')
                    except BaseException:
                        if not existing: os.close(handle)
                        raise
                    handles[pid]=handle; observed[pid]=row
        return rows
    try:
        # Retain a pidfd even for a very short command which is already a zombie.
        handles[child.pid]=os.pidfd_open(child.pid)
        token=_stat(child.pid)
        if token['session']!=child.pid or token['ppid']!=os.getpid(): _fail('OWNED_HELPER_PARENT_UNQUALIFIED')
        proof['start_ticks']=token['start_ticks']
        for stream in (child.stdin,child.stdout,child.stderr): os.set_blocking(stream.fileno(),False)
        for stream in (child.stdout,child.stderr): selector.register(stream,selectors.EVENT_READ)
        if released and pending: selector.register(child.stdin,selectors.EVENT_WRITE)
        elif released: child.stdin.close()
        while selector.get_map():
            census()
            remaining=deadline-time.monotonic()
            if remaining<=0: _fail('OWNED_HELPER_DEADLINE')
            for key,_ in selector.select(min(remaining,0.1)):
                if key.fileobj is child.stdin:
                    count=os.write(key.fd,pending)
                    if count<=0: _fail('OWNED_HELPER_INPUT_UNCERTAIN')
                    pending=pending[count:]
                    if not pending: selector.unregister(child.stdin);child.stdin.close()
                    continue
                chunk=os.read(key.fd,65536)
                if not chunk: selector.unregister(key.fileobj);continue
                target=out if key.fileobj is child.stdout else errors;target.extend(chunk)
                if len(out)+len(errors)>limit: _fail('OWNED_HELPER_OUTPUT_LIMIT')
                if ready is not None and not released and key.fileobj is child.stderr:
                    if len(errors)>4096: _fail('OWNED_HELPER_READY_INVALID')
                    if b'\n' in errors:
                        census();ready(bytes(errors), observed)
                        released=True
                        if pending:selector.register(child.stdin,selectors.EVENT_WRITE)
                        else:child.stdin.close()
        code=child.wait(timeout=max(0.001,deadline-time.monotonic()))
        if not released or pending: _fail('OWNED_HELPER_INPUT_UNCERTAIN')
        if census() or census(): _fail('OWNED_HELPER_FAMILY_UNSETTLED')
        qualify()
        proof.update(status='PASS',exit_code=code,output_sha256=hashlib.sha256(out).hexdigest(),
            processes=[observed[pid] for pid in sorted(observed)],live_helpers=[])
        return bytes(out),bytes(errors),proof
    except (OSError,subprocess.TimeoutExpired): _fail('OWNED_HELPER_COMMAND_UNCERTAIN')
    finally:
        selector.close()
        # Signal only processes whose exact identities this launch retained.
        for handle in reversed(list(handles.values())):
            try: signal.pidfd_send_signal(handle,signal.SIGKILL)
            except ProcessLookupError: pass
        try: child.wait(timeout=5)
        except subprocess.TimeoutExpired: _fail('OWNED_HELPER_FAMILY_UNSETTLED')
        finally:
            settled=selectors.DefaultSelector();settlement_deadline=time.monotonic()+5
            try:
                for handle in handles.values():settled.register(handle,selectors.EVENT_READ)
                while settled.get_map():
                    remaining=settlement_deadline-time.monotonic()
                    if remaining<=0:_fail('OWNED_HELPER_FAMILY_UNSETTLED')
                    for key,_ in settled.select(min(remaining,0.1)):settled.unregister(key.fileobj)
            finally:
                settled.close()
                for handle in handles.values():os.close(handle)
                for stream in (child.stdin,child.stdout,child.stderr):stream.close()
        # No successful result can survive a live/unclassified descendant.
        settled_deadline=time.monotonic()+5
        if _session_rows(child.pid,settled_deadline) or _session_rows(child.pid,settled_deadline):
            _fail('OWNED_HELPER_FAMILY_UNSETTLED')
        _pending_sessions.pop(child.pid,None)
