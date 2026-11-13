// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { withoutSessionReadinessDemotion } from './genome-session-readiness';
import type { GenomeSessionShell } from './indexed-genome';

const generation = (inventory: string) =>
  ({ inventoryFingerprint: inventory }) as GenomeSessionShell['assemblyAssetGeneration'];

function shell(overrides: Partial<GenomeSessionShell>): GenomeSessionShell {
  return {
    sessionId: 'session-1',
    assemblyAssetGeneration: generation('gen-a'),
    assemblyAnnotationProductsReadiness: 'ready',
    assemblySearchReadiness: 'pending',
    ...overrides,
  } as GenomeSessionShell;
}

describe('withoutSessionReadinessDemotion', () => {
  it('keeps admitted search when an older pending copy of the same session arrives', () => {
    const admitted = shell({
      assemblySearchReadiness: 'ready',
      assemblyAnnotationFeatureCount: 12,
    });
    const stale = shell({ assemblySearchReadiness: 'pending' });
    const merged = withoutSessionReadinessDemotion(admitted, stale);
    expect(merged.assemblySearchReadiness).toBe('ready');
    expect(merged.assemblyAnnotationFeatureCount).toBe(12);
  });

  it('keeps admitted annotation products the same way', () => {
    const merged = withoutSessionReadinessDemotion(
      shell({ assemblyAnnotationProductsReadiness: 'ready' }),
      shell({ assemblyAnnotationProductsReadiness: 'pending' })
    );
    expect(merged.assemblyAnnotationProductsReadiness).toBe('ready');
  });

  it('accepts pending for a different session or a different generation', () => {
    const admitted = shell({ assemblySearchReadiness: 'ready' });
    expect(
      withoutSessionReadinessDemotion(admitted, shell({ sessionId: 'session-2' }))
        .assemblySearchReadiness
    ).toBe('pending');
    expect(
      withoutSessionReadinessDemotion(
        admitted,
        shell({ assemblyAssetGeneration: generation('gen-b') })
      ).assemblySearchReadiness
    ).toBe('pending');
  });

  it('lets other readiness values and promotions through unchanged', () => {
    expect(
      withoutSessionReadinessDemotion(
        shell({ assemblySearchReadiness: 'ready' }),
        shell({ assemblySearchReadiness: 'not-applicable' })
      ).assemblySearchReadiness
    ).toBe('not-applicable');
    expect(
      withoutSessionReadinessDemotion(
        shell({ assemblySearchReadiness: 'pending' }),
        shell({ assemblySearchReadiness: 'ready' })
      ).assemblySearchReadiness
    ).toBe('ready');
    expect(withoutSessionReadinessDemotion(null, shell({})).assemblySearchReadiness).toBe(
      'pending'
    );
  });
});
