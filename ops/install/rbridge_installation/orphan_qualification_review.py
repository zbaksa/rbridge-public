"""Stage2E data-only comparison of a retained Stage2D custody bundle.

The input is self-consistent canonical DATA, not Root provenance, authenticated
owner consent, an admission capability or permission to repeat qualification.
The source-release equality comparison is explicitly UNTRUSTED data matching:
it cannot attest which protected executable ran on a real host.
A successful comparison ALWAYS returns BLOCKED.
"""
import json
import re

from .models import InstallationError,report_sha256
from .orphan_root_custody import verify_root_custody_bytes

class OrphanCustodyAdmissionError(InstallationError):pass
def _fail(reason):raise OrphanCustodyAdmissionError(reason)

_JOURNAL='helper-0b84e8af62a287a283eabcd4eef1cdb7'
_INTENT='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'
_REQUEST_KEYS={'schema','scope','action','journal_name','intent_sha256',
               'custody_bundle_sha256','root_source_sha',
               'proposed_driver_sha256','nonce','service_actions',
               'production_switch_authorized'}

def _sha(value,length=64):
    return (type(value) is str and
            re.fullmatch('[0-9a-f]{'+str(length)+'}',value) is not None)

def review_custody_qualification_request(custody_bytes,request):
    """Verify all retained hashes, but grant zero helper or production rights."""
    verified=verify_root_custody_bytes(custody_bytes)
    bundle=json.loads(custody_bytes)
    record=bundle['record']
    if (verified['status']!='RETAINED_DATA_VERIFIED_ONLY'
            or record['journal_name']!=_JOURNAL
            or record['intent_sha256']!=_INTENT
            or record['historical_result']!='UNKNOWN'
            or record['owner_authenticated'] is not False
            or record['journal_settled'] is not False):
        _fail('ORPHAN_CUSTODY_ADMISSION_BUNDLE_UNQUALIFIED')
    if (type(request) is not dict or set(request)!=_REQUEST_KEYS
            or request['schema']!='RBRIDGE_ORPHAN_CUSTODY_QUALIFICATION_REQUEST_V2'
            or request['scope']!='UNAUTHENTICATED_REQUEST_DATA_ONLY'
            or request['action']!='PREPARE_SINGLE_P2A_ROOT_QUALIFICATION'
            or request['journal_name']!=_JOURNAL
            or request['intent_sha256']!=_INTENT
            or request['custody_bundle_sha256']!=verified['bundle_sha256']
            or not _sha(request['root_source_sha'],40)
            or record['root_source_release']!='toolkit-'+request['root_source_sha']
            or not _sha(request['proposed_driver_sha256'])
            or not _sha(request['nonce'],32)
            or request['nonce']=='0'*32
            or type(request['service_actions']) is not list
            or request['service_actions']!=[]
            or request['production_switch_authorized'] is not False):
        _fail('ORPHAN_CUSTODY_ADMISSION_REQUEST_UNQUALIFIED')
    return {
        'schema':'RBRIDGE_ORPHAN_CUSTODY_QUALIFICATION_COMPARISON_V2',
        'status':'ADMISSION_BLOCKED_PENDING_LIVE_ROOT_ORIGIN',
        'scope':'PURE_RETAINED_DATA_COMPARISON_ONLY',
        'custody_bundle_sha256':verified['bundle_sha256'],
        'record_sha256':verified['record_sha256'],
        'request_sha256':report_sha256(request),
        'source_release_binding':'UNVERIFIED_DATA_MATCH_ONLY',
        'source_provenance_verified':False,
        'requirements_missing':[
            'VERIFIED_PUBLISHED_ROOT_SOURCE_AND_PROTECTED_EVIDENCE',
            'INDEPENDENT_AUTHENTICATED_OWNER_RECEIPT',
            'FRESH_SAME_PROCESS_COMPLETE_KERNEL_PROOF',
            'PROCESS_LOCAL_SINGLE_WORKFLOW_CAPABILITY',
            'PINNED_ROOT_QUALIFICATION_DRIVER_AND_GUARD_INTEGRATION'],
        'historical_execution':'UNKNOWN',
        'owner_authenticated':False,
        'may_settle':False,
        'may_launch':False,
        'may_resume_qualification':False,
        'may_change_production':False}

def compare_custody_qualification_request(custody_bytes,request,comparison):
    expected=review_custody_qualification_request(custody_bytes,request)
    if type(comparison) is not dict or comparison!=expected:
        _fail('ORPHAN_CUSTODY_ADMISSION_COMPARISON_CHANGED')
    return {'status':'DATA_MATCH_BLOCKED',
            'comparison_sha256':report_sha256(expected),
            'source_provenance_verified':False,
            'owner_authenticated':False,
            'may_launch':False,
            'may_resume_qualification':False,
            'may_change_production':False}
