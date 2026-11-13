// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { SHARE_SNAPSHOT_PUBLIC_WARNING, formatShareSnapshotSuccess } from './share-snapshot';

describe('share-snapshot copy', () => {
  it('includes the public-link warning and version when present', () => {
    expect(
      formatShareSnapshotSuccess({
        versionNumber: 4,
        url: 'https://dnaforge.com/d/abc#token=t',
      })
    ).toContain('v4');
    expect(
      formatShareSnapshotSuccess({
        versionNumber: 4,
        url: 'https://dnaforge.com/d/abc#token=t',
      })
    ).toContain(SHARE_SNAPSHOT_PUBLIC_WARNING);
  });
});
