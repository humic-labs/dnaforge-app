export interface StructureFileSnapshot {
  structureViewId: string;
  revisionId: string;
  filePath: string;
  coordinateDigestSha256: string;
  parser: 'pdb' | 'mmcif';
  encoding: 'text' | 'binary';
  data: string | Uint8Array;
}

interface SnapshotCacheEntry {
  snapshot: StructureFileSnapshot;
  estimatedBytes: number;
  lastAccess: number;
}

export interface StructureFileSnapshotLease {
  readonly structureViewId: string;
  isActive(): boolean;
  release(): void;
}

const MAX_INACTIVE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const snapshotsByViewId = new Map<string, SnapshotCacheEntry>();
const leaseCountsByViewId = new Map<string, number>();
let inactiveSnapshotBytes = 0;
let accessSequence = 0;
let registrationSequence = 0;
let registrationPauseForTests: Promise<void> | null = null;
let resumeRegistrationForTests: (() => void) | null = null;

function estimateSnapshotBytes(snapshot: StructureFileSnapshot): number {
  return typeof snapshot.data === 'string' ? snapshot.data.length : snapshot.data.byteLength;
}

function isLeased(structureViewId: string): boolean {
  return (leaseCountsByViewId.get(structureViewId) ?? 0) > 0;
}

function deleteSnapshot(structureViewId: string): void {
  const entry = snapshotsByViewId.get(structureViewId);
  if (!entry) return;
  if (!isLeased(structureViewId)) inactiveSnapshotBytes -= entry.estimatedBytes;
  snapshotsByViewId.delete(structureViewId);
}

function pruneInactiveSnapshots(): void {
  if (inactiveSnapshotBytes <= MAX_INACTIVE_SNAPSHOT_BYTES) return;
  const candidates = [...snapshotsByViewId.entries()]
    .filter(([viewId]) => !isLeased(viewId))
    .sort(([, left], [, right]) => left.lastAccess - right.lastAccess);
  for (const [viewId] of candidates) {
    deleteSnapshot(viewId);
    if (inactiveSnapshotBytes <= MAX_INACTIVE_SNAPSHOT_BYTES) break;
  }
}

export function registerStructureFileSnapshot(snapshot: StructureFileSnapshot): void {
  deleteSnapshot(snapshot.structureViewId);
  registrationSequence += 1;
  const entry: SnapshotCacheEntry = {
    snapshot,
    estimatedBytes: estimateSnapshotBytes(snapshot),
    lastAccess: ++accessSequence,
  };
  snapshotsByViewId.set(snapshot.structureViewId, entry);
  if (!isLeased(snapshot.structureViewId)) inactiveSnapshotBytes += entry.estimatedBytes;
  pruneInactiveSnapshots();
}

export function getStructureFileSnapshot(
  structureViewId: string
): StructureFileSnapshot | undefined {
  const entry = snapshotsByViewId.get(structureViewId);
  if (!entry) return undefined;
  entry.lastAccess = ++accessSequence;
  return entry.snapshot;
}

export function acquireStructureFileSnapshotLease(
  structureViewId: string
): StructureFileSnapshotLease {
  const previousCount = leaseCountsByViewId.get(structureViewId) ?? 0;
  leaseCountsByViewId.set(structureViewId, previousCount + 1);
  if (previousCount === 0) {
    const entry = snapshotsByViewId.get(structureViewId);
    if (entry) inactiveSnapshotBytes -= entry.estimatedBytes;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const currentCount = leaseCountsByViewId.get(structureViewId) ?? 0;
    if (currentCount <= 1) {
      snapshotsByViewId.delete(structureViewId);
      leaseCountsByViewId.delete(structureViewId);
      pruneInactiveSnapshots();
      return;
    }
    leaseCountsByViewId.set(structureViewId, currentCount - 1);
  };

  return {
    structureViewId,
    isActive: () => !released,
    release,
  };
}

export function registerStructureFileSnapshotForLease(
  snapshot: StructureFileSnapshot,
  lease: StructureFileSnapshotLease
): boolean {
  if (lease.structureViewId !== snapshot.structureViewId || !lease.isActive()) return false;
  registerStructureFileSnapshot(snapshot);
  return true;
}

export function clearStructureFileSnapshotsForTests(): void {
  snapshotsByViewId.clear();
  leaseCountsByViewId.clear();
  inactiveSnapshotBytes = 0;
  accessSequence = 0;
  registrationSequence = 0;
  setStructureFileSnapshotRegistrationPausedForTests(false);
}

export function setStructureFileSnapshotRegistrationPausedForTests(paused: boolean): void {
  if (paused) {
    if (registrationPauseForTests) return;
    registrationPauseForTests = new Promise<void>((resolve) => {
      resumeRegistrationForTests = resolve;
    });
    return;
  }
  resumeRegistrationForTests?.();
  resumeRegistrationForTests = null;
  registrationPauseForTests = null;
}

export async function waitForStructureFileSnapshotRegistrationForTests(): Promise<void> {
  await registrationPauseForTests;
}

export function getStructureFileSnapshotCacheDiagnostics(): {
  viewIds: string[];
  leasedViewIds: string[];
  inactiveBytes: number;
  registrationSequence: number;
} {
  return {
    viewIds: [...snapshotsByViewId.keys()].sort(),
    leasedViewIds: [...leaseCountsByViewId.entries()]
      .filter(([, count]) => count > 0)
      .map(([viewId]) => viewId)
      .sort(),
    inactiveBytes: inactiveSnapshotBytes,
    registrationSequence,
  };
}
