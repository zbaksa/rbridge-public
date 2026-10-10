"""Strict, non-authorizing preimage for orphan Root review evidence.

The *serialized* observation, TTY claim and census are NOT trusted origins.
This module does not read Root files, authenticate owners or grant admission.
"""
import re
from .models import InstallationError,report_sha256
from .orphan_intent_review_packet import build_orphan_review_packet

class OrphanRootDispositionError(InstallationError):pass
def _fail(reason):raise OrphanRootDispositionError(reason)

_NAME='helper-0b84e8af62a287a283eabcd4eef1cdb7'
_INTENT='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'
_TTY_KEYS={'schema','status','review_packet_sha256','challenge_sha256',
           'local_tty_present','owner_authenticated','original_process_outcome',
           'root_disposition_written','may_settle','may_launch',
           'may_resume_qualification','may_change_production'}
_SCAN_KEYS={'schema','status','boot_id','samples','may_resume_qualification',
            'may_launch','may_change_production'}
_ITEM_KEYS={'sequence','count','live_systemctl','unclassified'}
_ALLOWED_FLAGS=('may_settle','may_launch','may_resume_qualification','may_change_production')

def _sha(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None

def disposition_preimage(observation,owner_claim,tty_review,kernel_census):
    """Compare data and issue a NON-AUTHORIZING canonical evidence preimage."""
    packet=build_orphan_review_packet(observation,owner_claim)
    if (observation['scope']!='ROOT_READONLY_DATA_OBSERVATION_ONLY'
            or observation['name']!=_NAME or observation['intent_sha256']!=_INTENT):
        _fail('ORPHAN_ROOT_DISPOSITION_TARGET_UNQUALIFIED')
    if (type(tty_review) is not dict or set(tty_review)!=_TTY_KEYS
            or tty_review['schema']!='RBRIDGE_ORPHAN_ROOT_TTY_REVIEW_DATA_V1'
            or tty_review['status']!='ATTENDED_DATA_ONLY'
            or tty_review['review_packet_sha256']!=report_sha256(packet)
            or not _sha(tty_review['challenge_sha256'])
            or tty_review['local_tty_present'] is not True
            or tty_review['owner_authenticated'] is not False
            or tty_review['original_process_outcome']!='UNKNOWN'
            or tty_review['root_disposition_written'] is not False
            or any(tty_review[k] is not False for k in _ALLOWED_FLAGS)):
        _fail('ORPHAN_ROOT_DISPOSITION_TTY_UNQUALIFIED')
    if (type(kernel_census) is not dict or set(kernel_census)!=_SCAN_KEYS
            or kernel_census['schema']!='RBRIDGE_ORPHAN_KERNEL_CENSUS_V1'
            or kernel_census['status']!='NO_CURRENT_SYSTEMCTL_MATCH'
            or type(kernel_census['boot_id']) is not str
            or re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',kernel_census['boot_id']) is None
            or type(kernel_census['samples']) is not list
            or len(kernel_census['samples'])!=2
            or any(kernel_census[k] is not False for k in
                   ('may_resume_qualification','may_launch','may_change_production'))):
        _fail('ORPHAN_ROOT_DISPOSITION_CENSUS_UNQUALIFIED')
    for index,sample in enumerate(kernel_census['samples'],1):
        if (type(sample) is not dict or set(sample)!=_ITEM_KEYS
                or type(sample['sequence']) is not int or sample['sequence']!=index
                or type(sample['count']) is not int or not 1<=sample['count']<=131072
                or sample['live_systemctl']!=[]
                or sample['unclassified']!=[]):
            _fail('ORPHAN_ROOT_DISPOSITION_SAMPLE_UNQUALIFIED')
    return {
        'schema':'RBRIDGE_ORPHAN_PROTECTED_DISPOSITION_PREIMAGE_V1',
        'status':'INTENT_ONLY_UNRESOLVED_REVIEWED',
        'scope':'SERIALIZED_PREIMAGE_ONLY',
        'journal_name':_NAME,
        'intent_sha256':_INTENT,
        'observation_sha256':report_sha256(observation),
        'owner_claim_sha256':report_sha256(owner_claim),
        'tty_review_sha256':report_sha256(tty_review),
        'census_sha256':report_sha256(kernel_census),
        'boot_id':kernel_census['boot_id'],
        'historical_execution':'UNKNOWN',
        'historical_result':'UNKNOWN',
        'owner_authenticated':False,
        'root_provenance_verified':False,
        'journal_settled':False,
        'may_launch':False,
        'may_resume_qualification':False,
        'may_change_production':False}

def compare_disposition_preimage(observation,owner_claim,tty_review,kernel_census,provided):
    expected=disposition_preimage(observation,owner_claim,tty_review,kernel_census)
    if type(provided) is not dict or provided!=expected:
        _fail('ORPHAN_ROOT_DISPOSITION_PREIMAGE_CHANGED')
    return {'status':'DATA_MATCH_ONLY','sha256':report_sha256(expected),
            'root_provenance_verified':False,
            'may_launch':False,'may_resume_qualification':False,
            'may_change_production':False}
