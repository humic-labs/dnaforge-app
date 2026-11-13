import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { staleAlignmentSession } from './alignment';

describe('alignment reference fixture integrity', () => {
  it('keeps current evidence bound to the exact reference file bytes', () => {
    const scenario = staleAlignmentSession({ isStale: false });
    const alignment = scenario.alignment!;
    const content = scenario.files![alignment.sourcePath];
    const checksum = `sha256:${createHash('sha256').update(content).digest('hex')}`;

    expect(alignment.isStale).toBe(false);
    expect(alignment.staleSessionIds).toEqual([]);
    expect(alignment.storedChecksum).toBe(checksum);
  });

  it('retains mismatched historical evidence for the stale scenario', () => {
    const scenario = staleAlignmentSession();
    const alignment = scenario.alignment!;
    const content = scenario.files![alignment.sourcePath];
    const checksum = `sha256:${createHash('sha256').update(content).digest('hex')}`;

    expect(alignment.isStale).toBe(true);
    expect(alignment.staleSessionIds).toEqual(['alignment-stale-session']);
    expect(alignment.storedChecksum).not.toBe(checksum);
  });
});
