"""Pure, non-authorizing review packet for an unresolved helper INTENT.

No Root filesystem access, no journal repair, and no owner authentication.
A claim or packet is DATA ONLY, never a release/settlement capability.
"""
import re
from .models import InstallationError,report_sha256
from .orphan_intent_review import READONLY_ARGV_SHA,READONLY_EXE_SHA

class OrphanReviewPacketError(InstallationError):pass
def _fail(reason):raise OrphanReviewPacketError(reason)

_OBS={'schema','status','scope','name','intent_sha256','boot_relation',
      'executable_sha256','argv_sha256','historical_execution',
      'historical_operation_result','original_process_identity','missing',
      'may_settle','may_launch','may_resume_qualification','may_change_production'}
_CLAIM={'schema','scope','decision','journal_name','intent_sha256',
        'observation_sha256','owner_claim','issue_number','challenge',
        'acknowledgement'}
_FLAGS=('may_settle','may_launch','may_resume_qualification','may_change_production')
_ACK='HISTORICAL_EXECUTION_UNKNOWN_NO_RETRY_AUTHORIZATION'
_DECISION='ACKNOWLEDGED_UNKNOWN_WITHOUT_ADMISSION'

def _hash(value):return type(value) is str and re.fullmatch('[0-9a-f]{64}',value) is not None

def build_orphan_review_packet(observation,claim):
    """Pure comparison of claimed values; cannot authenticate the claimant."""
    if (type(observation) is not dict or set(observation)!=_OBS
            or observation['schema']!='RBRIDGE_ORPHAN_READONLY_INTENT_OBSERVATION_V1'
            or observation['status']!='INTENT_ONLY_UNRESOLVED'
            or observation['scope'] not in ('FIXTURE_DATA_ONLY','ROOT_READONLY_DATA_OBSERVATION_ONLY')
            or type(observation['name']) is not str
            or not re.fullmatch('helper-[0-9a-f]{32}',observation['name'])
            or not _hash(observation['intent_sha256'])
            or observation['boot_relation']!='CURRENT'
            or observation['executable_sha256']!=READONLY_EXE_SHA
            or observation['argv_sha256']!=READONLY_ARGV_SHA
            or observation['historical_execution']!='UNKNOWN'
            or observation['historical_operation_result']!='UNKNOWN'
            or observation['original_process_identity']!='UNAVAILABLE'
            or observation['missing']!=['running.json','settled.json']
            or any(observation[k] is not False for k in _FLAGS)):
        _fail('ORPHAN_PACKET_OBSERVATION_INVALID')
    if (type(claim) is not dict or set(claim)!=_CLAIM
            or claim['schema']!='RBRIDGE_ORPHAN_REVIEW_OWNER_CLAIM_V1'
            or claim['scope']!='UNAUTHENTICATED_CLAIM_ONLY'
            or claim['decision']!=_DECISION
            or claim['journal_name']!=observation['name']
            or claim['intent_sha256']!=observation['intent_sha256']
            or claim['observation_sha256']!=report_sha256(observation)
            or type(claim['owner_claim']) is not str
            or re.fullmatch('[A-Za-z0-9-]{1,39}',claim['owner_claim']) is None
            or type(claim['issue_number']) is not int
            or not 1<=claim['issue_number']<=2147483647
            or not _hash(claim['challenge']) or claim['challenge']=='0'*64
            or claim['acknowledgement']!=_ACK):
        _fail('ORPHAN_PACKET_CLAIM_INVALID')
    return {
        'schema':'RBRIDGE_ORPHAN_REVIEW_PACKET_V1',
        'status':'UNVERIFIED_OWNER_CLAIM_UNRESOLVED',
        'scope':'PURE_SERIALIZED_DATA_ONLY',
        'journal_name':observation['name'],
        'intent_sha256':observation['intent_sha256'],
        'observation_sha256':report_sha256(observation),
        'claim_sha256':report_sha256(claim),
        'historical_execution':'UNKNOWN',
        'historical_operation_result':'UNKNOWN',
        'owner_authenticated':False,
        'journal_settled':False,
        'may_launch':False,
        'may_resume_qualification':False,
        'may_change_production':False,
    }

def compare_orphan_review_packet(observation,claim,packet):
    """Pure byte-equivalent comparison never confers authority."""
    expected=build_orphan_review_packet(observation,claim)
    if type(packet) is not dict or packet!=expected:
        _fail('ORPHAN_PACKET_CHANGED')
    return {'status':'DATA_MATCH_ONLY','packet_sha256':report_sha256(expected),
            'authenticated':False,'may_launch':False,
            'may_resume_qualification':False,'may_change_production':False}
