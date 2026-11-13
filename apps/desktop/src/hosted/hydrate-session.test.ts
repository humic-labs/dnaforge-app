// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { hostedSnapshotFileMatchesHint } from './snapshot-file-match';

describe('hostedSnapshotFileMatchesHint', () => {
  const file = { path: 'sequences/annotated-hosted-journey.gbk' };

  it('matches relative path, filename, and label stem', () => {
    expect(hostedSnapshotFileMatchesHint(file, 'sequences/annotated-hosted-journey.gbk')).toBe(
      true
    );
    expect(hostedSnapshotFileMatchesHint(file, 'annotated-hosted-journey.gbk')).toBe(true);
    expect(hostedSnapshotFileMatchesHint(file, 'annotated-hosted-journey')).toBe(true);
  });

  it('rejects a different file', () => {
    expect(hostedSnapshotFileMatchesHint(file, 'untouched-control.gbk')).toBe(false);
    expect(hostedSnapshotFileMatchesHint(file, undefined)).toBe(false);
  });
});
