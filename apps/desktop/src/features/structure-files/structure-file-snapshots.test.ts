// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import {
  acquireStructureFileSnapshotLease,
  clearStructureFileSnapshotsForTests,
  getStructureFileSnapshot,
  getStructureFileSnapshotCacheDiagnostics,
  registerStructureFileSnapshot,
  registerStructureFileSnapshotForLease,
} from './structure-file-snapshots';

function snapshot(index: number, data: string) {
  return {
    structureViewId: `view-${index}`,
    revisionId: `revision-${index}`,
    filePath: `/lab/structure-${index}.cif`,
    coordinateDigestSha256: `${index}`.padStart(64, '0'),
    parser: 'mmcif' as const,
    encoding: 'text' as const,
    data,
  };
}

describe('structure coordinate snapshot ownership', () => {
  beforeEach(() => clearStructureFileSnapshotsForTests());

  it('bounds inactive coordinate bodies instead of retaining every opened structure forever', () => {
    const eightMiB = 'x'.repeat(8 * 1024 * 1024);
    for (let index = 0; index < 40; index += 1) {
      registerStructureFileSnapshot(snapshot(index, eightMiB));
    }

    expect(getStructureFileSnapshot('view-0')).toBeUndefined();
    expect(getStructureFileSnapshot('view-39')).toBeDefined();
  });

  it('retains shared coordinates until the final mounted-view lease releases', () => {
    const releaseFirst = acquireStructureFileSnapshotLease('view-1');
    const releaseSecond = acquireStructureFileSnapshotLease('view-1');
    registerStructureFileSnapshot(snapshot(1, 'ATOM 1'));

    releaseFirst.release();
    expect(getStructureFileSnapshot('view-1')).toBeDefined();
    expect(getStructureFileSnapshotCacheDiagnostics()).toEqual({
      viewIds: ['view-1'],
      leasedViewIds: ['view-1'],
      inactiveBytes: 0,
      registrationSequence: 1,
    });
    releaseSecond.release();
    expect(getStructureFileSnapshot('view-1')).toBeUndefined();
    expect(getStructureFileSnapshotCacheDiagnostics()).toEqual({
      viewIds: [],
      leasedViewIds: [],
      inactiveBytes: 0,
      registrationSequence: 1,
    });
  });

  it('refuses a late registration after the requesting view lease released', () => {
    const lease = acquireStructureFileSnapshotLease('view-1');
    lease.release();

    const registered = registerStructureFileSnapshotForLease(snapshot(1, 'ATOM 1'), lease);

    expect(registered).toBe(false);
    expect(getStructureFileSnapshotCacheDiagnostics()).toEqual({
      viewIds: [],
      leasedViewIds: [],
      inactiveBytes: 0,
      registrationSequence: 0,
    });
  });

  it('increments the registration sequence even when the same view id is replaced', () => {
    registerStructureFileSnapshot(snapshot(1, 'ATOM 1'));
    registerStructureFileSnapshot(snapshot(1, 'ATOM 2'));

    expect(getStructureFileSnapshotCacheDiagnostics().registrationSequence).toBe(2);
  });
});
