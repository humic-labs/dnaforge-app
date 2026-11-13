import { describe, expect, it, vi } from 'vitest';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
import {
  backgroundJobKind,
  installBackgroundJobTelemetry,
  type BackgroundJobTelemetryDeps,
} from './background-job-telemetry';

vi.mock('../services/managed-operations', () => ({
  managedOperations: { getSnapshot: () => ({ records: [] }), subscribe: () => () => undefined },
}));
vi.mock('./analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./analytics')>()),
  trackRendererEvent: vi.fn(),
}));

type Operation = ReturnType<BackgroundJobTelemetryDeps['operations']>[number];

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

function job(id: string, state: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id,
    kind: 'genome-indexing',
    state,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_090,
    settled_at: ['succeeded', 'failed', 'canceled', 'interrupted'].includes(state)
      ? 1_700_000_090
      : null,
    ...overrides,
  } as Operation;
}

function session(store: ReturnType<typeof memoryStore>, initial: Operation[]) {
  let operations = initial;
  let listener: () => void = () => undefined;
  const track = vi.fn();
  installBackgroundJobTelemetry({
    operations: () => operations,
    subscribe: (next) => {
      listener = next;
      return () => undefined;
    },
    track,
    store,
  });
  return {
    track,
    sent: () => track.mock.calls.map(([, properties]) => properties as Record<string, unknown>),
    update(next: Operation[]) {
      operations = next;
      listener();
    },
  };
}

describe('background job telemetry', () => {
  it('reports a job once when submitted and once when it finishes', () => {
    const store = memoryStore();
    const run = session(store, [job('op-1', 'queued')]);
    run.update([job('op-1', 'running')]);
    run.update([job('op-1', 'succeeded')]);
    run.update([job('op-1', 'succeeded')]);
    expect(run.track.mock.calls.every(([event]) => event === 'background_job_observed')).toBe(true);
    expect(run.sent()).toEqual([
      { feature_area: 'reliability', job_kind: 'genome_indexing', job_phase: 'submitted' },
      {
        feature_area: 'reliability',
        job_kind: 'genome_indexing',
        job_phase: 'completed',
        job_duration_ms: 90_000,
        recovered_at_launch: false,
      },
    ]);
    for (const properties of run.sent()) {
      expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
    }
  });

  it('reports a job that ended while the app was closed at the next launch', () => {
    const store = memoryStore();
    session(store, [job('op-2', 'running', { kind: 'alignment-coverage-preparation' })]);
    const relaunch = session(store, [
      job('op-2', 'interrupted', {
        kind: 'alignment-coverage-preparation',
        error: { code: 'SIDECAR_EXITED', message: 'worker exited reading /private/reads.bam' },
      }),
    ]);
    expect(relaunch.sent()).toEqual([
      {
        feature_area: 'reliability',
        job_kind: 'alignment_coverage_preparation',
        job_phase: 'interrupted',
        job_duration_ms: 90_000,
        error_class: 'sidecar_exited',
        recovered_at_launch: true,
      },
    ]);
    expect(JSON.stringify(relaunch.sent())).not.toMatch(/private|reads\.bam/);
  });

  it('ignores history it never saw running and names unknown kinds as other', () => {
    const store = memoryStore();
    const run = session(store, [job('old', 'succeeded'), job('older', 'failed')]);
    expect(run.track).not.toHaveBeenCalled();
    run.update([job('new', 'running', { kind: 'customer-pipeline-7' })]);
    expect(run.sent()).toEqual([
      { feature_area: 'reliability', job_kind: 'other', job_phase: 'submitted' },
    ]);
    expect(backgroundJobKind('Variant-Source-Preparation')).toBe('variant_source_preparation');
  });
});
