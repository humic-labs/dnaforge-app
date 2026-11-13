import { describe, it, expect } from 'vitest';
import {
  runCatches,
  runCatchesAsync,
  assertMutantKilled,
  assertCorrectImplPasses,
} from './mutation-harness';

describe('engine/testing/mutation-harness — honesty', () => {
  it('runCatches: true when the block throws, false when it does not', () => {
    expect(
      runCatches(() => {
        throw new Error('boom');
      })
    ).toBe(true);
    expect(runCatches(() => {})).toBe(false);
  });

  it('runCatchesAsync: true when the block rejects, false when it resolves', async () => {
    expect(await runCatchesAsync(async () => Promise.reject(new Error('x')))).toBe(true);
    expect(await runCatchesAsync(async () => {})).toBe(false);
  });

  it('assertMutantKilled PASSES for a throwing block (mutant killed)', () => {
    assertMutantKilled('killed', () => {
      throw new Error('mutant detected');
    });
  });

  it('assertMutantKilled THROWS for a non-throwing block (mutant SURVIVED)', () => {
    expect(() => assertMutantKilled('survivor', () => {})).toThrow();
  });

  it('assertCorrectImplPasses PASSES for a non-throwing block', () => {
    assertCorrectImplPasses('ok', () => {});
  });

  it('assertCorrectImplPasses THROWS when the correct-impl block throws', () => {
    expect(() =>
      assertCorrectImplPasses('broken', () => {
        throw new Error('should not happen');
      })
    ).toThrow();
  });
});
