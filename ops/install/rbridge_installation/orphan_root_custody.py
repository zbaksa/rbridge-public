"""Complete bounded *data-only* custody of an unresolved Root helper INTENT.

A SHA-only Root disposition is insufficient to reconstruct the evidence later.
This module stores the canonical observation, unauthenticated owner claim,
TTY attendance data, two-snapshot kernel *summary*, and their validated
preimage alongside the existing non-authorizing record. The census summary
is NOT a retained per-process roster and cannot prove historical execution.

Pure construction/readback is fixture-testable; it is NOT a Root provenance
check, owner authentication, journal settlement or helper admission.
"""
import hashlib
import json
import re

from .models import InstallationError,encode_report,report_sha256
from .orphan_disposition_preimage import disposition_preimage,_NAME,_INTENT

class OrphanRootCustodyError(InstallationError):pass
def _fail(code):raise OrphanRootCustodyError(code)

MAX_CUSTODY_BYTES=16384
_RECORD_FIELDS={
    'schema','status','scope','journal_name','intent_sha256',
    'preimage_sha256','root_source_release','original_intent_identity',
    'historical_execution','historical_result','owner_authenticated',
    'journal_settled','may_settle','may_launch',
    'may_resume_qualification','may_change_production'}
_BUNDLE_FIELDS={
    'schema','scope','record','preimage','observation','owner_claim',
    'tty_review','kernel_census','historical_execution',
    'historical_result','owner_authenticated','may_settle',
    'may_launch','may_resume_qualification','may_change_production'}
_FALSE_FLAGS=('owner_authenticated','may_settle','may_launch',
              'may_resume_qualification','may_change_production')

def _record_matches_preimage(record,preimage):
    if (type(record) is not dict or set(record)!=_RECORD_FIELDS
            or record['schema']!='RBRIDGE_ROOT_ORPHAN_INTENT_EVIDENCE_V1'
            or record['status']!='ROOT_RECORD_ONLY_INTENT_UNRESOLVED'
            or record['scope']!='PROTECTED_APPEND_ONLY_DATA_NOT_AUTHORIZATION'
            or record['journal_name']!=_NAME or record['intent_sha256']!=_INTENT
            or record['preimage_sha256']!=report_sha256(preimage)
            or type(record['root_source_release']) is not str
            or re.fullmatch('toolkit-[0-9a-f]{40}',record['root_source_release']) is None
            or type(record['original_intent_identity']) is not list
            or len(record['original_intent_identity'])!=9
            or any(type(x) is not int or x<0 or x>9007199254740991
                   for x in record['original_intent_identity'])
            or record['historical_execution']!='UNKNOWN'
            or record['historical_result']!='UNKNOWN'
            or record['journal_settled'] is not False
            or any(record[k] is not False for k in _FALSE_FLAGS)):
        _fail('ORPHAN_CUSTODY_RECORD_UNQUALIFIED')

def build_root_custody_bundle(record,observation,owner_claim,tty_review,
                              kernel_census,preimage):
    """Return complete canonical evidence DATA; no authority is minted."""
    expected=disposition_preimage(
        observation,owner_claim,tty_review,kernel_census)
    if type(preimage) is not dict or preimage!=expected:
        _fail('ORPHAN_CUSTODY_PREIMAGE_CHANGED')
    _record_matches_preimage(record,expected)
    return {
        'schema':'RBRIDGE_ROOT_ORPHAN_CUSTODY_BUNDLE_V1',
        'scope':'RETAINED_SOURCE_DATA_NO_AUTHORITY',
        'record':record,
        'preimage':expected,
        'observation':observation,
        'owner_claim':owner_claim,
        'tty_review':tty_review,
        'kernel_census':kernel_census,
        'historical_execution':'UNKNOWN',
        'historical_result':'UNKNOWN',
        'owner_authenticated':False,
        'may_settle':False,
        'may_launch':False,
        'may_resume_qualification':False,
        'may_change_production':False}

def verify_root_custody_bytes(raw):
    """Independent strict canonical readback; proof of DATA only.

    The caller must independently qualify protected filesystem provenance,
    source release bytes, journal inode/contents and fresh Root process state.
    This does not check the human owner identity or permit qualification.
    """
    if type(raw) is not bytes or not 1<=len(raw)<=MAX_CUSTODY_BYTES:
        _fail('ORPHAN_CUSTODY_BYTE_LIMIT')
    def unique(pairs):
        out={}
        for k,v in pairs:
            if k in out:_fail('ORPHAN_CUSTODY_DUPLICATE_KEY')
            out[k]=v
        return out
    def bad_constant(_):
        _fail('ORPHAN_CUSTODY_JSON_INVALID')
    try:
        parsed=json.loads(raw.decode('utf-8'),object_pairs_hook=unique,
                          parse_constant=bad_constant)
    except (ValueError,TypeError,UnicodeError,RecursionError):
        _fail('ORPHAN_CUSTODY_JSON_INVALID')
    if (type(parsed) is not dict or set(parsed)!=_BUNDLE_FIELDS
            or parsed['schema']!='RBRIDGE_ROOT_ORPHAN_CUSTODY_BUNDLE_V1'
            or parsed['scope']!='RETAINED_SOURCE_DATA_NO_AUTHORITY'
            or parsed['historical_execution']!='UNKNOWN'
            or parsed['historical_result']!='UNKNOWN'
            or any(parsed[k] is not False for k in _FALSE_FLAGS)):
        _fail('ORPHAN_CUSTODY_ENVELOPE_UNQUALIFIED')
    expected=build_root_custody_bundle(
        parsed['record'],parsed['observation'],parsed['owner_claim'],
        parsed['tty_review'],parsed['kernel_census'],parsed['preimage'])
    if expected!=parsed or encode_report(expected)!=raw:
        _fail('ORPHAN_CUSTODY_BYTES_NOT_CANONICAL')
    return {'schema':'RBRIDGE_ORPHAN_ROOT_CUSTODY_READBACK_V1',
            'status':'RETAINED_DATA_VERIFIED_ONLY',
            'bundle_sha256':hashlib.sha256(raw).hexdigest(),
            'record_sha256':report_sha256(parsed['record']),
            'historical_execution':'UNKNOWN',
            'owner_authenticated':False,
            'may_settle':False,'may_launch':False,
            'may_resume_qualification':False,
            'may_change_production':False}
