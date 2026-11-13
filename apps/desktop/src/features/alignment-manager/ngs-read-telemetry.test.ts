import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationSnapshot } from '@waypoint/api-client';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import type { NgsReadEvidence } from './ngs-read-evidence';

const analytics = vi.hoisted(() => ({ trackRendererEvent: vi.fn() }));
vi.mock('../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/analytics')>()),
  ...analytics,
}));

import {
  mappedFractionBucket,
  readCountBucket,
  trackNgsReadAnalysisSettled,
  trackNgsReadAnalysisStarted,
  trackNgsReadAnalysisSubmitFailed,
} from './ngs-read-telemetry';

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

function operation(overrides: Partial<OperationSnapshot>): OperationSnapshot {
  return {
    id: 'op-1',
    state: 'succeeded',
    created_at: 1_700_000_000,
    settled_at: 1_700_000_042.5,
    updated_at: 1_700_000_042.5,
    ...overrides,
  } as OperationSnapshot;
}

const evidence = {
  totalReads: 2_400_000,
  mappedReads: 2_160_000,
  unmappedReads: 240_000,
  settings: { preset: 'map-ont' },
} as NgsReadEvidence;

function sent() {
  return analytics.trackRendererEvent.mock.calls.map(([event, properties]) => {
    expect(event).toBe('ngs_read_analysis_observed');
    expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
    return properties as Record<string, unknown>;
  });
}

describe('raw-read analysis telemetry', () => {
  beforeEach(() => analytics.trackRendererEvent.mockReset());

  it('buckets read counts and mapped fractions without exact values', () => {
    expect([0, 999, 1_000, 50_000, 999_999, 2_400_000, 40_000_000].map(readCountBucket)).toEqual([
      'lt_1k',
      'lt_1k',
      '1k_10k',
      '10k_100k',
      '100k_1m',
      '1m_10m',
      '10m_plus',
    ]);
    expect(mappedFractionBucket(2_160_000, 2_400_000)).toBe('80_95');
    expect(mappedFractionBucket(95, 100)).toBe('95_99');
    expect(mappedFractionBucket(99, 100)).toBe('99_plus');
    expect(mappedFractionBucket(1, 0)).toBe('unknown');
  });

  it('reports start, completion once per job, and every property survives the sanitizer', () => {
    const store = memoryStore();
    trackNgsReadAnalysisStarted('map-ont');
    trackNgsReadAnalysisSettled(operation({}), { evidence, candidateCount: 14 }, store);
    trackNgsReadAnalysisSettled(operation({}), { evidence, candidateCount: 14 }, store);
    expect(sent()).toEqual([
      { feature_area: 'scientific_workflow', analysis_phase: 'started', read_preset: 'map-ont' },
      {
        feature_area: 'scientific_workflow',
        analysis_phase: 'completed',
        read_preset: 'map-ont',
        read_count_bucket: '1m_10m',
        mapped_fraction_bucket: '80_95',
        candidate_count_bucket: '6_20',
        duration_ms: 42_500,
      },
    ]);
  });

  it('reports an import failure and a later successful import of the same job', () => {
    const store = memoryStore();
    trackNgsReadAnalysisSettled(operation({}), { error: new Error('reference closed') }, store);
    trackNgsReadAnalysisSettled(operation({}), { error: new Error('reference closed') }, store);
    trackNgsReadAnalysisSettled(operation({}), { evidence, candidateCount: 0 }, store);
    expect(
      sent().map(({ analysis_phase, failure_stage }) => [analysis_phase, failure_stage])
    ).toEqual([
      ['failed', 'import'],
      ['completed', undefined],
    ]);
  });

  it('reports job failures by error code, cancellations and submit failures', () => {
    const store = memoryStore();
    trackNgsReadAnalysisSettled(
      operation({
        id: 'op-failed',
        state: 'failed',
        error: { code: 'MINIMAP2-EXIT', message: 'minimap2 exited reading /private/reads.fq' },
      }),
      { error: new Error('Raw-read analysis failed.') },
      store
    );
    trackNgsReadAnalysisSettled(operation({ id: 'op-canceled', state: 'canceled' }), {}, store);
    trackNgsReadAnalysisSubmitFailed('sr', new TypeError('fetch failed'));
    const properties = sent();
    expect(properties).toEqual([
      expect.objectContaining({
        analysis_phase: 'failed',
        failure_stage: 'job',
        error_class: 'minimap2_exit',
      }),
      expect.objectContaining({ analysis_phase: 'canceled', duration_ms: 42_500 }),
      expect.objectContaining({
        analysis_phase: 'failed',
        failure_stage: 'submit',
        read_preset: 'sr',
        error_class: 'typeerror',
      }),
    ]);
    expect(JSON.stringify(properties)).not.toMatch(/private|reads\.fq/);
  });
});
