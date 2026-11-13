import { describe, expect, it } from 'vitest';
import { selectBestEffortRenderFallbackPaths } from './best-effort-render-fallback';

const badPath = 'Lab/Bad sequence (seq_BADSEQ12).gb';
const goodPath = 'Lab/Good sequence (seq_GOODSEQ12).gb';
const input = {
  expectedSourceObjectIds: ['seq_BADSEQ12', 'seq_GOODSEQ12'],
  renderChecks: [
    {
      sourceObjectId: 'seq_BADSEQ12',
      passed: false,
      message: 'Product routing selected sequence, not text.',
    },
    { sourceObjectId: 'seq_GOODSEQ12', passed: true },
  ],
  blockingIssues: [
    {
      code: 'validation_failed' as const,
      blocking: true,
      sourceObjectId: 'seq_BADSEQ12',
      message: 'Product routing selected sequence, not text.',
    },
  ],
  sourceObjects: [
    { id: 'seq_BADSEQ12', sourcePath: badPath },
    { id: 'seq_GOODSEQ12', sourcePath: goodPath },
  ],
  sourceEntries: [
    { role: 'source-record' as const, sourceObjectId: 'seq_BADSEQ12', entryPath: badPath },
    { role: 'source-record' as const, sourceObjectId: 'seq_GOODSEQ12', entryPath: goodPath },
  ],
};

describe('best-effort render fallback', () => {
  it('selects only the exact verified entry whose product render failed', () => {
    expect(selectBestEffortRenderFallbackPaths(input)).toEqual([badPath]);
  });

  it('keeps global integrity and renderer availability failures blocking', () => {
    expect(
      selectBestEffortRenderFallbackPaths({
        ...input,
        blockingIssues: [
          ...input.blockingIssues,
          { code: 'hash_mismatch', blocking: true, message: 'Destination changed.' },
        ],
      })
    ).toEqual([]);
    expect(
      selectBestEffortRenderFallbackPaths({
        ...input,
        renderChecks: input.renderChecks.map((check) =>
          check.passed
            ? check
            : {
                ...check,
                message: 'Destination render validation failed closed: Renderer timed out.',
              }
        ),
      })
    ).toEqual([]);
  });

  it('rejects missing, duplicate, and previously downgraded render targets', () => {
    expect(
      selectBestEffortRenderFallbackPaths({
        ...input,
        renderChecks: input.renderChecks.slice(0, 1),
      })
    ).toEqual([]);
    expect(
      selectBestEffortRenderFallbackPaths({
        ...input,
        sourceEntries: [...input.sourceEntries, input.sourceEntries[0]],
      })
    ).toEqual([]);
    expect(
      selectBestEffortRenderFallbackPaths({
        ...input,
        alreadyFallbackEntryPaths: [badPath],
      })
    ).toEqual([]);
  });
});
