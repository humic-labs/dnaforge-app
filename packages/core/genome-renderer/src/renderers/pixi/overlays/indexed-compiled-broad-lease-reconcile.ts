export type CompiledBroadDemandLeaseReconcileView = {
  cameraEpoch: number;
  manifestFingerprint: string;
};

export type CompiledBroadDemandLeaseReconcileInspection<
  TLease extends CompiledBroadDemandLeaseReconcileView,
> =
  | {
      ok: false;
      reason:
        | 'compiled-broad-surface-live-demand-lease-required'
        | 'compiled-broad-surface-live-demand-lease-limit-exceeded'
        | 'compiled-broad-surface-duplicate-demand-lease'
        | 'compiled-broad-surface-demand-lease-stale-or-unknown'
        | 'compiled-broad-surface-demand-lease-owner-not-loaded';
    }
  | {
      ok: true;
      requestedLeaseIds: Set<string>;
      leases: TLease[];
    };

export function inspectCompiledBroadDemandLeaseReconcileRequest<
  TLease extends CompiledBroadDemandLeaseReconcileView,
>(input: {
  demandLeaseIds: readonly string[];
  currentCameraEpoch: number;
  leasesById: ReadonlyMap<string, TLease>;
  ownerFingerprints: ReadonlySet<string>;
}): CompiledBroadDemandLeaseReconcileInspection<TLease> {
  if (!Array.isArray(input.demandLeaseIds) || input.demandLeaseIds.length === 0) {
    return { ok: false, reason: 'compiled-broad-surface-live-demand-lease-required' };
  }
  if (input.demandLeaseIds.length > 16) {
    return { ok: false, reason: 'compiled-broad-surface-live-demand-lease-limit-exceeded' };
  }
  const requestedLeaseIds = new Set(input.demandLeaseIds);
  if (requestedLeaseIds.size !== input.demandLeaseIds.length) {
    return { ok: false, reason: 'compiled-broad-surface-duplicate-demand-lease' };
  }
  const leases: TLease[] = [];
  for (const leaseId of requestedLeaseIds) {
    const lease = input.leasesById.get(leaseId);
    if (!lease || lease.cameraEpoch !== input.currentCameraEpoch) {
      return { ok: false, reason: 'compiled-broad-surface-demand-lease-stale-or-unknown' };
    }
    leases.push(lease);
  }
  if (leases.some((lease) => !input.ownerFingerprints.has(lease.manifestFingerprint))) {
    return { ok: false, reason: 'compiled-broad-surface-demand-lease-owner-not-loaded' };
  }
  return { ok: true, requestedLeaseIds, leases };
}
