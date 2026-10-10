"""Fail-closed common gate for one future P2A orphan qualification workflow.

No production issuer exists. This module deliberately cannot mint a Root
capability or except even the known orphan: doing so requires a separate live,
fresh, physically attested owner-signed Root issuer and same-process checks.
Both operative guards call this common gate when passed a candidate lease.
"""
from .models import InstallationError

class OrphanDualGuardLeaseError(InstallationError):pass

ORPHAN_NAME='helper-0b84e8af62a287a283eabcd4eef1cdb7'
ORPHAN_INTENT_SHA256='844d2d20e5f8c88257d3544158308637c524d55c78ffcaeee1b1b18c45e0a276'

def require_qualified_orphan_lease(candidate,*,guard,journal_name):
    """Always reject serialized, forged and premature capabilities.

    Future issuer integration must replace this with a protected, process-local,
    single-consumer grant while revalidating original journal and *both* guards.
    The present function never returns a permit, even for matching SHA data.
    """
    if guard not in ('MAINTENANCE_REGISTRY','HELPER_JOURNAL'):
        raise OrphanDualGuardLeaseError('ORPHAN_GUARD_SCOPE_INVALID')
    if journal_name!=ORPHAN_NAME:
        raise OrphanDualGuardLeaseError('ORPHAN_GUARD_TARGET_INVALID')
    if candidate is None:
        raise OrphanDualGuardLeaseError('ORPHAN_GUARD_LEASE_MISSING')
    # Source data, a constructed class instance, a callback, a typed token,
    # a cryptographic review comparison and a Root custody file are all
    # insufficient to grant operational authority without a live issuer.
    raise OrphanDualGuardLeaseError('ORPHAN_GUARD_ISSUER_NOT_IMPLEMENTED')
