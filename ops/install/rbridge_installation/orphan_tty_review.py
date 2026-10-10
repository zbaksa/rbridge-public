"""Owner-presence TTY challenge, with no Root disposition or admission grant.

No subprocess, network request, journal write, service action or privilege
extension is performed. A local TTY claim is NOT a cryptographic owner receipt.
"""
import hashlib
import hmac
import os
import re
import secrets
import select
import sys
import termios

from .models import InstallationError,report_sha256
from .orphan_intent_review_packet import build_orphan_review_packet

class OrphanTTYReviewError(InstallationError):pass
def _fail(reason):raise OrphanTTYReviewError(reason)

_PREFIX=b'ACKNOWLEDGE UNKNOWN '
def _token(value):
    return (type(value) is str and
            re.fullmatch('[0-9a-f]{32}',value) is not None and value!='0'*32)

def compare_tty_review_response(nonce,response):
    """Pure exact-byte predicate; does not authenticate the human."""
    if not _token(nonce) or type(response) is not bytes or len(response)>128:
        _fail('ORPHAN_TTY_RESPONSE_INVALID')
    expected=_PREFIX+nonce.encode('ascii')+b'\n'
    if not hmac.compare_digest(response,expected):
        _fail('ORPHAN_TTY_RESPONSE_MISMATCH')
    return {'schema':'RBRIDGE_ORPHAN_TTY_COMPARISON_V1',
            'status':'BYTE_MATCH_ONLY',
            'challenge_sha256':hashlib.sha256(nonce.encode('ascii')).hexdigest(),
            'owner_authenticated':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}

def collect_root_tty_review_data(observation,claim):
    """Direct foreground TTY, NO spawned helper; return non-authorizing data.

    Root origin/namespace checks are necessary but NOT sufficient to trust
    an owner receipt. This routine neither reads nor clears the orphan.
    """
    if (os.getuid(),os.geteuid(),os.getgid(),os.getegid())!=(0,0,0,0):
        _fail('ORPHAN_TTY_ROOT_REQUIRED')
    if (not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'):
        _fail('ORPHAN_TTY_RUNTIME_UNQUALIFIED')
    from .host_backend import _assert_kernel_namespace
    _assert_kernel_namespace()
    packet=build_orphan_review_packet(observation,claim)
    if not all(os.isatty(i) for i in (0,1,2)):
        _fail('ORPHAN_TTY_DIRECT_TERMINAL_REQUIRED')
    fd=None
    try:
        fd=os.open('/dev/tty',os.O_RDWR|os.O_NOCTTY|os.O_CLOEXEC)
        path=os.ttyname(fd)
        if (not os.isatty(fd) or os.ttyname(0)!=path or
                os.ttyname(1)!=path or os.ttyname(2)!=path or
                os.tcgetpgrp(fd)!=os.getpgrp() or
                not (termios.tcgetattr(fd)[3]&termios.ICANON) or
                os.stat(path,follow_symlinks=False).st_uid!=1027):
            _fail('ORPHAN_TTY_FOREGROUND_UNQUALIFIED')
        nonce=secrets.token_hex(16)
        challenge=(_PREFIX+nonce.encode('ascii')+b'\n')
        message=(b'REVIEW ONLY - historical process outcome UNKNOWN.\n'
                 b'No service change or qualification permission.\n'
                 b'Type exactly: '+challenge)
        if os.write(fd,message)!=len(message):
            _fail('ORPHAN_TTY_CHALLENGE_WRITE_FAILED')
        readable,_,_=select.select([fd],[],[],60)
        if not readable:_fail('ORPHAN_TTY_CHALLENGE_TIMEOUT')
        response=os.read(fd,129)
        outcome=compare_tty_review_response(nonce,response)
        return {'schema':'RBRIDGE_ORPHAN_ROOT_TTY_REVIEW_DATA_V1',
                'status':'ATTENDED_DATA_ONLY',
                'review_packet_sha256':report_sha256(packet),
                'challenge_sha256':outcome['challenge_sha256'],
                'local_tty_present':True,
                'owner_authenticated':False,
                'original_process_outcome':'UNKNOWN',
                'root_disposition_written':False,
                'may_settle':False,'may_launch':False,
                'may_resume_qualification':False,'may_change_production':False}
    except (OSError,ValueError,UnicodeError):
        _fail('ORPHAN_TTY_UNQUALIFIED')
    finally:
        if fd is not None:os.close(fd)
