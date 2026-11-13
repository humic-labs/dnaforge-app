// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { trackTileErrorRetryable } from './track-tile-retryability';

describe('track tile retryability', () => {
  it('uses the source typed retryability when present', () => {
    expect(
      trackTileErrorRetryable(Object.assign(new Error('UCSC unavailable'), { retryable: true }))
    ).toBe(true);
    expect(
      trackTileErrorRetryable(Object.assign(new Error('No such track'), { retryable: false }))
    ).toBe(false);
  });

  it('retries upstream failures and stops on an immutable source failure', () => {
    expect(trackTileErrorRetryable(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(trackTileErrorRetryable(new Error('The remote source could not be reached'))).toBe(true);
    expect(trackTileErrorRetryable(new Error('The remote genomic source validator changed'))).toBe(
      false
    );
    expect(trackTileErrorRetryable(new Error('upstream-truncated:10000/10000'))).toBe(false);
  });

  it('stops reconnecting when a saved local source is missing or needs a new file selection', () => {
    for (const message of [
      "Error invoking remote method 'dialog:authorizeLocalIndexedTrack': Error: ENOENT: no such file or directory, realpath '/removed-worktree/signal.bw'",
      'The selected indexed genomic source is not a regular file.',
      'This local indexed track is outside every active project.',
      'Select this local indexed track through the DNAForge file picker first.',
    ]) {
      expect(trackTileErrorRetryable(new Error(message))).toBe(false);
    }
  });
});
