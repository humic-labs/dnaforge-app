export const COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1 =
  'compiled-broad-surface-demand-lease.v1' as const;

export function compiledBroadDemandLeaseId(input: {
  cameraEpoch: number;
  manifestFingerprint: string;
  isoformMode: string;
  laneLimit: number | null;
}): string {
  return `${COMPILED_BROAD_SURFACE_DEMAND_LEASE_V1}:${input.cameraEpoch}:${input.manifestFingerprint}:${input.isoformMode}:${input.laneLimit}`;
}

export function compiledBroadSurfaceAdmissionLeaseFailure(input: {
  demandLeaseId: string | undefined;
  cameraEpoch: number;
  manifestFingerprint: string;
  cellId: string;
  lease:
    | {
        cameraEpoch: number;
        manifestFingerprint: string;
        allowedCellIds: ReadonlySet<string>;
      }
    | undefined;
}): string | null {
  if (!input.demandLeaseId) return 'compiled-broad-surface-demand-lease-required';
  if (!input.lease || input.lease.cameraEpoch !== input.cameraEpoch) {
    return 'compiled-broad-surface-demand-lease-stale-or-unknown';
  }
  if (input.lease.manifestFingerprint !== input.manifestFingerprint) {
    return 'compiled-broad-surface-demand-lease-manifest-mismatch';
  }
  if (!input.lease.allowedCellIds.has(input.cellId)) {
    return 'compiled-broad-surface-cell-outside-demand-lease';
  }
  return null;
}
