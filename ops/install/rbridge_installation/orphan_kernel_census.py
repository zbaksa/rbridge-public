"""Two fresh bounded Root kernel snapshots, without helper launches.

No historical process PID was recorded for orphan INTENT; zero current
matches CANNOT mean that the original process never started or succeeded.
This data never authorizes settlement, admission or a production change.
"""
import os
import re
import stat
import time

from .models import InstallationError

class OrphanKernelCensusError(InstallationError):pass
def _fail(reason):raise OrphanKernelCensusError(reason)

def classify_process_snapshot(rows):
    """Pure negative gate, not a Root-origin observation."""
    if type(rows) is not list or not 1<=len(rows)<=131072:
        _fail('ORPHAN_CENSUS_ROSTER_INVALID')
    seen=set();candidate=[]
    for row in rows:
        if (type(row) is not dict
                or set(row)!={'pid','state','ppid','session','start_ticks','exe'}
                or type(row['pid']) is not int or not 2<=row['pid']<=2147483647
                or row['pid'] in seen or type(row['ppid']) is not int
                or not 0<=row['ppid']<=2147483647
                or type(row['session']) is not int or row['session']<0
                or type(row['start_ticks']) is not str
                or re.fullmatch('[1-9][0-9]{0,31}',row['start_ticks']) is None
                or type(row['state']) is not str or len(row['state'])!=1
                or type(row['exe']) is not str or not row['exe'].startswith('/')):
            _fail('ORPHAN_CENSUS_PROCESS_UNCLASSIFIED')
        seen.add(row['pid'])
        if row['state']=='Z':continue
        path=row['exe'].removesuffix(' (deleted)')
        if os.path.basename(path)=='systemctl':
            candidate.append(row['pid'])
    return {'count':len(rows),'candidates':sorted(candidate)}

def _scan(sequence,boot,deadline):
    from .helper_journal import _boot_id
    from .owned_process import _stat
    if _boot_id()!=boot:_fail('ORPHAN_CENSUS_BOOT_CHANGED')
    names=os.listdir('/proc')
    if len(names)>131072:_fail('ORPHAN_CENSUS_ROSTER_TOO_LARGE')
    rows=[]
    for item in names:
        if not item.isascii() or not item.isdecimal() or int(item)<2:continue
        if time.monotonic()>=deadline:_fail('ORPHAN_CENSUS_DEADLINE')
        pid=int(item)
        try:
            token=_stat(pid)
        except FileNotFoundError:
            continue
        except (OSError,ValueError,UnicodeError):
            _fail('ORPHAN_CENSUS_PROCESS_UNCLASSIFIED')
        if token['state']=='Z':continue
        try:
            exe=os.readlink('/proc/'+item+'/exe')
        except FileNotFoundError:
            # Kernel threads have no userspace executable; never admit
            # unknown ordinary userspace processes through this exception.
            if token['ppid']==2:continue
            _fail('ORPHAN_CENSUS_EXE_UNAVAILABLE')
        except (OSError,ValueError):
            _fail('ORPHAN_CENSUS_EXE_UNAVAILABLE')
        try:
            after=_stat(pid)
        except (OSError,ValueError,UnicodeError):
            _fail('ORPHAN_CENSUS_PROCESS_RACE')
        if (after['start_ticks']!=token['start_ticks']
                or after['session']!=token['session']
                or after['ppid']!=token['ppid']
                or after['state']=='Z'):
            _fail('ORPHAN_CENSUS_PROCESS_RACE')
        rows.append({**token,'exe':exe})
    result=classify_process_snapshot(rows)
    if result['candidates']:_fail('ORPHAN_CENSUS_LIVE_SYSTEMCTL')
    if _boot_id()!=boot:_fail('ORPHAN_CENSUS_BOOT_CHANGED')
    return {'sequence':sequence,'count':result['count'],
            'live_systemctl':[],'unclassified':[]}

def collect_root_kernel_census():
    """No subprocess or storage. Fail on unstable/unknown host processes."""
    import sys
    if (os.getuid(),os.geteuid(),os.getgid(),os.getegid())!=(0,0,0,0):
        _fail('ORPHAN_CENSUS_ROOT_REQUIRED')
    if (not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.dont_write_bytecode or os.getcwd()!='/'):
        _fail('ORPHAN_CENSUS_RUNTIME_UNQUALIFIED')
    from .host_backend import _assert_kernel_namespace
    from .helper_journal import _boot_id
    _assert_kernel_namespace()
    boot=_boot_id()
    deadline=time.monotonic()+30
    samples=[_scan(1,boot,deadline),_scan(2,boot,deadline)]
    if any(x['count']<1 for x in samples):
        _fail('ORPHAN_CENSUS_EMPTY')
    return {'schema':'RBRIDGE_ORPHAN_KERNEL_CENSUS_V1',
            'status':'NO_CURRENT_SYSTEMCTL_MATCH',
            'boot_id':boot,'samples':samples,
            'may_resume_qualification':False,
            'may_launch':False,'may_change_production':False}
