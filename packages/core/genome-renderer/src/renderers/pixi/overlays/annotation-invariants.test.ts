import { beforeEach, describe, expect, it } from 'vitest';

import {
  checkTranscriptBlockCountCoherence,
  runAnnotationInvariantGuard,
  type AnnotationInvariantContext,
} from './annotation-invariants';

function makeContext(
  overrides: Partial<AnnotationInvariantContext> = {}
): AnnotationInvariantContext {
  return {
    visibleFeatureCount: 0,
    blockCount: 0,
    renderMode: 'retained',
    transcriptKey: 'test-key',
    sourceWindowStartBp: 0,
    sourceWindowEndBp: 5_000_000,
    viewStartBp: 1_000_000,
    viewEndBp: 2_000_000,
    transcriptSamples: [],
    ...overrides,
  };
}

describe('TRANSCRIPT_BLOCK_COUNT_COHERENCE', () => {
  describe('RED proofs (must fire)', () => {
    it('fires when visibleFeatureCount > 0 and blockCount === 0 in retained mode', () => {
      const context = makeContext({
        visibleFeatureCount: 42,
        blockCount: 0,
        renderMode: 'retained',
      });
      const result = checkTranscriptBlockCountCoherence(context);
      expect(result, 'invariant should have fired but returned null').not.toBeNull();
      expect(result?.invariantId).toBe('TRANSCRIPT_BLOCK_COUNT_COHERENCE');
      expect(result?.message).toMatch(/42 transcript/);
      expect(result?.message).toMatch(/built 0 GPU blocks/);
    });

    it('fires even when the visible count is small (single missing transcript counts)', () => {
      const context = makeContext({
        visibleFeatureCount: 1,
        blockCount: 0,
        renderMode: 'retained',
      });
      const result = checkTranscriptBlockCountCoherence(context);
      expect(result).not.toBeNull();
      expect(result?.invariantId).toBe('TRANSCRIPT_BLOCK_COUNT_COHERENCE');
    });

    it('captures the diagnostic context exactly as supplied', () => {
      const sample = {
        id: 12345,
        type: 'mRNA',
        displayName: 'DLG2-201',
        start: 83_400_000,
        end: 85_600_000,
        exonCount: 0,
        cdsCount: 0,
        laneResolved: true,
      };
      const context = makeContext({
        visibleFeatureCount: 12,
        blockCount: 0,
        transcriptSamples: [sample],
        viewStartBp: 84_400_000,
        viewEndBp: 84_600_000,
      });
      const result = checkTranscriptBlockCountCoherence(context);
      expect(result).not.toBeNull();
      expect(result?.context.transcriptSamples[0]).toEqual(sample);
      expect(result?.context.viewStartBp).toBe(84_400_000);
      expect(result?.context.viewEndBp).toBe(84_600_000);
    });
  });

  describe('GREEN proofs (must NOT fire)', () => {
    it('stays silent when blocks were built for every visible transcript', () => {
      const context = makeContext({
        visibleFeatureCount: 42,
        blockCount: 1092,
        renderMode: 'retained',
      });
      expect(checkTranscriptBlockCountCoherence(context)).toBeNull();
    });

    it('stays silent when blockCount > visibleFeatureCount (legitimate — each transcript expands into multiple blocks)', () => {
      const context = makeContext({
        visibleFeatureCount: 12,
        blockCount: 313,
        renderMode: 'retained',
      });
      expect(checkTranscriptBlockCountCoherence(context)).toBeNull();
    });

    it('stays silent when blockCount < visibleFeatureCount but > 0 (partial render is not the bug class this catches)', () => {
      const context = makeContext({
        visibleFeatureCount: 42,
        blockCount: 1,
        renderMode: 'retained',
      });
      expect(checkTranscriptBlockCountCoherence(context)).toBeNull();
    });

    it('stays silent when visibleFeatureCount === 0 (no transcripts means no blocks expected)', () => {
      const context = makeContext({
        visibleFeatureCount: 0,
        blockCount: 0,
        renderMode: 'retained',
      });
      expect(checkTranscriptBlockCountCoherence(context)).toBeNull();
    });

    it('stays silent when renderMode !== retained (other paths have their own paths to drawn pixels)', () => {
      const context = makeContext({
        visibleFeatureCount: 42,
        blockCount: 0,
        renderMode: 'rebuild',
      });
      expect(checkTranscriptBlockCountCoherence(context)).toBeNull();
    });

    it('stays silent in cache-hit mode (retained mesh from prior frame is presumed valid)', () => {
      const context = makeContext({
        visibleFeatureCount: 42,
        blockCount: 0,
        renderMode: 'cache-hit',
      });
      expect(checkTranscriptBlockCountCoherence(context)).toBeNull();
    });

    it('stays silent in none mode (no render happened)', () => {
      const context = makeContext({
        visibleFeatureCount: 42,
        blockCount: 0,
        renderMode: 'none',
      });
      expect(checkTranscriptBlockCountCoherence(context)).toBeNull();
    });
  });
});

describe('runAnnotationInvariantGuard (with diagnostics enabled via VITEST env)', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined') {
      (
        window as unknown as { __annotationInvariantViolations?: unknown }
      ).__annotationInvariantViolations = [];
    }
  });

  it('returns the violation record and writes to the window sink when invariant fires', () => {
    const context = makeContext({
      visibleFeatureCount: 99,
      blockCount: 0,
      renderMode: 'retained',
    });
    const record = runAnnotationInvariantGuard(context);
    expect(record).not.toBeNull();
    expect(record?.invariantId).toBe('TRANSCRIPT_BLOCK_COUNT_COHERENCE');
    if (typeof window !== 'undefined') {
      const sink = (
        window as unknown as {
          __annotationInvariantViolations?: Array<{ invariantId: string }>;
        }
      ).__annotationInvariantViolations;
      expect(sink?.length).toBe(1);
      expect(sink?.[0].invariantId).toBe('TRANSCRIPT_BLOCK_COUNT_COHERENCE');
    }
  });

  it('returns null and does not write to the sink when state is healthy', () => {
    const context = makeContext({
      visibleFeatureCount: 99,
      blockCount: 1000,
      renderMode: 'retained',
    });
    const record = runAnnotationInvariantGuard(context);
    expect(record).toBeNull();
    if (typeof window !== 'undefined') {
      const sink = (
        window as unknown as {
          __annotationInvariantViolations?: Array<unknown>;
        }
      ).__annotationInvariantViolations;
      expect(sink?.length ?? 0).toBe(0);
    }
  });

  it('window sink caps at 20 entries (does not grow unboundedly)', () => {
    if (typeof window === 'undefined') return;
    const context = makeContext({
      visibleFeatureCount: 1,
      blockCount: 0,
      renderMode: 'retained',
    });
    for (let i = 0; i < 30; i++) {
      runAnnotationInvariantGuard(context);
    }
    const sink = (
      window as unknown as {
        __annotationInvariantViolations?: Array<unknown>;
      }
    ).__annotationInvariantViolations;
    expect(sink?.length).toBeLessThanOrEqual(20);
  });
});
