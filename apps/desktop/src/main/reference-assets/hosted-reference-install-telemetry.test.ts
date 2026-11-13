import { describe, expect, it } from 'vitest';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import { beginHostedReferenceInstallObservation } from './hosted-reference-install-telemetry';

describe('hosted reference install telemetry', () => {
  it('joins each phase to the original native operation and settles it once', () => {
    const observations: Array<Record<string, unknown>> = [];
    let now = 1_000;
    const handle = beginHostedReferenceInstallObservation(
      (observation) => observations.push(observation),
      () => now
    );
    now = 2_000;
    handle.annotationReady();
    handle.annotationReady();
    now = 3_000;
    handle.ready();
    handle.failed('building-search', true);
    handle.annotationReady();

    expect(observations.map(({ install_phase }) => install_phase)).toEqual([
      'started',
      'annotation_ready',
      'ready',
    ]);
    const operationId = observations[0]?.operation_id;
    expect(operationId).toEqual(expect.stringMatching(/^[a-f0-9-]{36}$/));
    expect(observations.map(({ operation_id }) => operation_id)).toEqual(
      Array(3).fill(operationId)
    );
    expect(observations.map(({ origin_started_at_ms }) => origin_started_at_ms)).toEqual([
      1_000, 1_000, 1_000,
    ]);
    expect(observations.map(({ occurred_at_ms }) => occurred_at_ms)).toEqual([1_000, 2_000, 3_000]);
  });

  it('maps preparation phases to a closed stage and reports update and fallback', () => {
    const observations: unknown[] = [];
    let now = 1_000;
    const handle = beginHostedReferenceInstallObservation(
      (observation) => observations.push(observation),
      () => now
    );
    handle.previousVersion(true);
    handle.progress('prepared-bundle-fallback');
    handle.progress('indexing-reference');
    now = 4_500;
    handle.failed('indexing-reference', true);

    expect(observations).toEqual([
      {
        feature_area: 'scientific_workflow',
        operation_id: expect.any(String),
        occurred_at_ms: 1_000,
        origin_started_at_ms: 1_000,
        install_phase: 'started',
      },
      {
        feature_area: 'scientific_workflow',
        operation_id: expect.any(String),
        occurred_at_ms: 4_500,
        origin_started_at_ms: 1_000,
        install_phase: 'failed',
        install_stage: 'indexing_reference',
        annotations_ready: true,
        duration_ms: 3_500,
        used_bundle_fallback: true,
        is_update: true,
      },
    ]);
  });

  it('reports unknown phases as other', () => {
    const observations: Array<Record<string, unknown>> = [];
    const handle = beginHostedReferenceInstallObservation((observation) =>
      observations.push(observation)
    );
    handle.failed('/Users/someone/genome.fa', false);
    expect(observations[1]?.install_stage).toBe('other');
  });

  it('never lets the observer interrupt an install', () => {
    const handle = beginHostedReferenceInstallObservation(() => {
      throw new Error('observer failure');
    });
    expect(() => handle.ready()).not.toThrow();
  });

  it('preserves opaque correlation and clocks through the allowlist without a catalog build', () => {
    const observations: Array<Record<string, unknown>> = [];
    const handle = beginHostedReferenceInstallObservation((observation) =>
      observations.push(observation)
    );
    handle.previousVersion(false);
    handle.ready();
    const sanitized = sanitizeClosedBetaProperties(observations[1]);
    expect(sanitized).toMatchObject({
      install_phase: 'ready',
      is_update: false,
      used_bundle_fallback: false,
      operation_id: observations[0]?.operation_id,
      occurred_at_ms: expect.any(Number),
      origin_started_at_ms: observations[0]?.origin_started_at_ms,
    });
    expect(sanitized).not.toHaveProperty('genome_build');
  });
});
