"""Source-data review of a proposed one-time P2A qualification retry.

A previously stored orphan disposition is NOT an admission capability.
This module never exempts helper_journal or maintenance_registry checks.
"""
import re
from .models import InstallationError,report_sha256

class OrphanAdmissionDataError(InstallationError):pass
def _fail(reason):raise OrphanAdmissionDataError(reason)

_JOURNAL='helper-0b84e8af62a287a283eabcd4eef1cdb7'
_INTENT='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'
_ROOT_SOURCE='2de2e17cf0cec83940ddfb04ee20e29f3c26262a'
_RECORD_KEYS={'schema','status','scope','journal_name','intent_sha256',
    'preimage_sha256','root_source_release','original_intent_identity',
    'historical_execution','historical_result','owner_authenticated',
    'journal_settled','may_settle','may_launch','may_resume_qualification',
    'may_change_production'}
_REQUEST_KEYS={'schema','scope','action','journal_name','intent_sha256',
    'disposition_sha256','root_source_sha','proposed_driver_sha256',
    'nonce','service_actions','production_switch_authorized'}

def _digest(value,length=64):
    return (type(value) is str
            and re.fullmatch('[0-9a-f]{'+str(length)+'}',value) is not None)

def review_orphan_qualification_request(record,request):
    """Return a BLOCKED data comparison. Never create Root admission."""
    if (type(record) is not dict or set(record)!=_RECORD_KEYS
            or record['schema']!='RBRIDGE_ROOT_ORPHAN_INTENT_EVIDENCE_V1'
            or record['status']!='ROOT_RECORD_ONLY_INTENT_UNRESOLVED'
            or record['scope']!='PROTECTED_APPEND_ONLY_DATA_NOT_AUTHORIZATION'
            or record['journal_name']!=_JOURNAL
            or record['intent_sha256']!=_INTENT
            or not _digest(record['preimage_sha256'])
            or record['root_source_release']!='toolkit-'+_ROOT_SOURCE
            or type(record['original_intent_identity']) is not list
            or len(record['original_intent_identity'])!=9
            or any(type(x) is not int for x in record['original_intent_identity'])
            or record['historical_execution']!='UNKNOWN'
            or record['historical_result']!='UNKNOWN'
            or any(record[k] is not False for k in (
                'owner_authenticated','journal_settled','may_settle',
                'may_launch','may_resume_qualification','may_change_production'))):
        _fail('ORPHAN_ADMISSION_RECORD_UNQUALIFIED')
    if (type(request) is not dict or set(request)!=_REQUEST_KEYS
            or request['schema']!='RBRIDGE_ORPHAN_QUALIFICATION_REVIEW_REQUEST_V1'
            or request['scope']!='UNAUTHENTICATED_REQUEST_DATA_ONLY'
            or request['action']!='PREPARE_SINGLE_P2A_ROOT_QUALIFICATION'
            or request['journal_name']!=_JOURNAL
            or request['intent_sha256']!=_INTENT
            or request['disposition_sha256']!=report_sha256(record)
            or request['root_source_sha']!=_ROOT_SOURCE
            or not _digest(request['proposed_driver_sha256'])
            or not _digest(request['nonce'],32) or request['nonce']=='0'*32
            or request['service_actions']!=[]
            or request['production_switch_authorized'] is not False):
        _fail('ORPHAN_ADMISSION_REQUEST_UNQUALIFIED')
    return {
        'schema':'RBRIDGE_ORPHAN_QUALIFICATION_REQUEST_COMPARISON_V1',
        'status':'ADMISSION_BLOCKED_PENDING_LIVE_ROOT_ORIGIN',
        'scope':'PURE_DATA_COMPARISON_ONLY',
        'disposition_sha256':report_sha256(record),
        'request_sha256':report_sha256(request),
        'requirements_missing':[
            'AUTHENTICATED_OWNER_FOREGROUND_ROOT_RECEIPT',
            'FRESH_COMPLETE_KERNEL_PROOF',
            'SINGLE_PROCESS_NON_SERIALIZABLE_ADMISSION_ORIGIN',
            'ROOT_PROTECTED_QUALIFICATION_BINDING'],
        'original_process_result':'UNKNOWN',
        'may_settle':False,
        'may_launch':False,
        'may_resume_qualification':False,
        'may_change_production':False}

def compare_orphan_qualification_request(record,request,comparison):
    expected=review_orphan_qualification_request(record,request)
    if type(comparison) is not dict or comparison!=expected:
        _fail('ORPHAN_ADMISSION_COMPARISON_CHANGED')
    return {'status':'DATA_MATCH_BLOCKED',
            'comparison_sha256':report_sha256(expected),
            'may_launch':False,'may_resume_qualification':False,
            'may_change_production':False}
