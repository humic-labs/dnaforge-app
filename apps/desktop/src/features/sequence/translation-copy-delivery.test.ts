import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import * as correlation from '../../lib/telemetry-correlation';
import { abandonOpenWorkflowActions } from '../../lib/workflow-telemetry';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../../shared/analytics-registry.generated';
import { isQualifyingMeaningfulActivity } from '../../shared/meaningful-activity.generated';
import { translationCopyLengthBucket } from '../../shared/translation-copy-telemetry';
import {
  createTranslationCopyDelivery,
  TRANSLATION_COPY_OBSERVED,
} from './translation-copy-delivery';

const capture = vi.hoisted(() => ({ generation: 0 }));
vi.mock('../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/analytics')>()),
  getAnalyticsCaptureGeneration: () => capture.generation,
}));
const APP = '550e8400-e29b-41d4-a716-446655440001';
const A = '550e8400-e29b-41d4-a716-446655440002';
const B = '550e8400-e29b-41d4-a716-446655440003';
const metadata = {
  strand: 'forward',
  frame: 1,
  codeCategory: 'standard',
  lengthBucket: '2_5',
} as const;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function observation() {
  let id = 10;
  const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
  const storePending = vi.fn(async () => undefined);
  const deliver = createTranslationCopyDelivery({
    track,
    storePending,
    createId: () => `550e8400-e29b-41d4-a716-${String(++id).padStart(12, '0')}`,
    now: () => Date.now(),
    isIdentified: () => false,
    activityAuthority: () => ({
      actorKind: 'external',
      executionMode: 'interactive',
      impersonated: false,
    }),
  });
  return {
    track,
    deliver,
    storePending,
    properties: () => track.mock.calls.map(([, properties]) => properties),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  capture.generation = 0;
  sessionStorage.clear();
  sessionStorage.setItem('dnaforge_telemetry_app_session_id', APP);
  sessionStorage.setItem('dnaforge_telemetry_episode_correlation_id', A);
  correlation.__resetTelemetryCorrelationForTests();
});
afterEach(() => {
  abandonOpenWorkflowActions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('translation copy physical settlement', () => {
  it('invokes the physical callback synchronously, then joins one actual fulfillment without scientific data', async () => {
    const o = observation();
    const pending = deferred();
    const write = vi.fn(() => pending.promise);
    const done = o.deliver({ ...metadata, write });
    expect(write).toHaveBeenCalledTimes(1);
    expect(o.track).toHaveBeenCalledTimes(1);
    vi.setSystemTime(1250);
    pending.resolve();
    await expect(done).resolves.toBeUndefined();
    const [start, end] = o.properties();
    expect(start).toMatchObject({
      action_phase: 'start',
      translation_copy_result: 'pending',
      occurred_at_ms: 1000,
    });
    expect(end).toMatchObject({
      action_phase: 'result',
      action_id: start.action_id,
      app_session_id: APP,
      episode_correlation_id: A,
      occurred_at_ms: 1250,
      duration_ms: 250,
      translation_copy_result: 'delivered',
      workflow: 'content',
      workflow_action: 'copy',
    });
    expect(end.effect_id).not.toBe(start.action_id);
    expect(o.track.mock.calls.map(([event]) => event)).toEqual([
      TRANSLATION_COPY_OBSERVED,
      TRANSLATION_COPY_OBSERVED,
    ]);
    expect(abandonOpenWorkflowActions()).toBe(0);
    expect(o.storePending).not.toHaveBeenCalled();
    expect(
      isQualifyingMeaningfulActivity({
        workflow: 'content',
        action: 'copy',
        status: 'success',
        success: true,
        valueDelivered: true,
        usableResult: true,
      })
    ).toBe(false);
  });

  it.each([
    new DOMException('private path and protein', 'NotAllowedError'),
    new Error('private text'),
    undefined,
  ])('retains the original rejection value and gives retry a new action ID', async (error) => {
    const o = observation();
    const write = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    await expect(o.deliver({ ...metadata, write })).rejects.toBe(error);
    await expect(o.deliver({ ...metadata, write })).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
    const [start, fail, retry, success] = o.properties();
    expect(fail).toMatchObject({
      action_id: start.action_id,
      action_phase: 'error',
      translation_copy_result: error instanceof DOMException ? 'not_allowed' : 'write_failed',
    });
    expect(retry.action_id).not.toBe(start.action_id);
    expect(success).toMatchObject({
      action_id: retry.action_id,
      translation_copy_result: 'delivered',
    });
    expect(JSON.stringify(o.properties())).not.toContain('private');
    expect(o.storePending).not.toHaveBeenCalled();
  });

  it('preserves a synchronous hostile rejection and still consumes its bounded failure', async () => {
    const error = new Error();
    Object.defineProperty(error, 'name', {
      get() {
        throw new Error('hostile');
      },
    });
    const o = observation();
    const write = vi.fn(() => {
      throw error;
    });
    await expect(o.deliver({ ...metadata, write })).rejects.toBe(error);
    expect(write).toHaveBeenCalledTimes(1);
    expect(o.properties()[1]).toMatchObject({ translation_copy_result: 'write_failed' });
    expect(abandonOpenWorkflowActions()).toBe(0);
  });

  it.each(['refused_start', 'throwing_start', 'throwing_terminal', 'throwing_setup'] as const)(
    'isolates %s from physical fulfillment',
    async (mode) => {
      const o = observation();
      if (mode === 'refused_start') o.track.mockReturnValueOnce(false);
      if (mode === 'throwing_start')
        o.track.mockImplementationOnce(() => {
          throw new Error('telemetry');
        });
      if (mode === 'throwing_terminal')
        o.track.mockReturnValueOnce(true).mockImplementationOnce(() => {
          throw new Error('telemetry');
        });
      if (mode === 'throwing_setup')
        vi.spyOn(correlation, 'getTelemetryCorrelationContext').mockImplementationOnce(() => {
          throw new Error('context');
        });
      const write = vi.fn(async () => undefined);
      await expect(o.deliver({ ...metadata, write })).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledTimes(1);
      expect(o.track).toHaveBeenCalledTimes(
        mode === 'throwing_setup' ? 0 : mode === 'throwing_terminal' ? 2 : 1
      );
      expect(abandonOpenWorkflowActions()).toBe(0);
      expect(o.storePending).not.toHaveBeenCalled();
    }
  );

  it('keeps the physical error when terminal telemetry also throws', async () => {
    const o = observation();
    o.track.mockReturnValueOnce(true).mockImplementationOnce(() => {
      throw new Error('telemetry');
    });
    const error = new Error('physical');
    await expect(o.deliver({ ...metadata, write: () => Promise.reject(error) })).rejects.toBe(
      error
    );
    expect(abandonOpenWorkflowActions()).toBe(0);
  });

  it.each(['generation', 'episode', 'episode_round_trip', 'session', 'throwing_context'] as const)(
    'consumes without egress or revival after %s changes',
    async (mode) => {
      const o = observation();
      const pending = deferred();
      const done = o.deliver({ ...metadata, write: () => pending.promise });
      if (mode === 'generation') capture.generation += 2;
      if (mode === 'episode' || mode === 'episode_round_trip')
        correlation.setEpisodeCorrelationId(B);
      if (mode === 'episode_round_trip') correlation.setEpisodeCorrelationId(A);
      if (mode === 'session') {
        sessionStorage.setItem('dnaforge_telemetry_app_session_id', B);
        correlation.__resetTelemetryCorrelationForTests();
      }
      if (mode === 'throwing_context')
        vi.spyOn(correlation, 'getTelemetryCorrelationContext').mockImplementationOnce(() => {
          throw new Error('context');
        });
      pending.resolve();
      await expect(done).resolves.toBeUndefined();
      expect(o.track).toHaveBeenCalledTimes(1);
      correlation.setEpisodeCorrelationId(A);
      expect(abandonOpenWorkflowActions()).toBe(0);
      expect(o.track).toHaveBeenCalledTimes(1);
      expect(o.storePending).not.toHaveBeenCalled();
    }
  );

  it('keeps same-value episode setters idempotent during a pending write', async () => {
    const o = observation();
    const pending = deferred();
    const done = o.deliver({ ...metadata, write: () => pending.promise });
    const revision = correlation.getTelemetryCorrelationRevision();
    correlation.setEpisodeCorrelationId(A.toUpperCase());
    expect(correlation.getTelemetryCorrelationRevision()).toBe(revision);
    pending.resolve();
    await done;
    expect(o.properties()[1]).toMatchObject({ translation_copy_result: 'delivered' });
  });

  it('reports page exit as interrupted observation while allowing the physical write to finish', async () => {
    const o = observation();
    const pending = deferred();
    const done = o.deliver({ ...metadata, write: () => pending.promise });
    expect(abandonOpenWorkflowActions()).toBe(1);
    expect(o.properties()[1]).toMatchObject({
      action_phase: 'cancel',
      translation_copy_result: 'observation_interrupted',
    });
    pending.resolve();
    await expect(done).resolves.toBeUndefined();
    expect(o.track).toHaveBeenCalledTimes(2);
    expect(o.storePending).not.toHaveBeenCalled();
  });

  it('keeps opaque joins and closed metadata through both production sanitizer layers', async () => {
    const o = observation();
    await o.deliver({ ...metadata, write: async () => undefined });
    for (const properties of o.properties()) {
      expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
      const safe = sanitizeSdkEvent(
        {
          event: TRANSLATION_COPY_OBSERVED,
          properties: sanitizeClosedBetaProperties({
            ...properties,
            translation: 'private',
            length: 37,
            error_message: 'private',
            write: () => undefined,
          }),
        },
        'desktop',
        'unknown',
        CLOSED_BETA_EVENT_PROPERTIES,
        undefined,
        CLOSED_BETA_EVENT_VERSIONS
      );
      expect(safe?.properties).toMatchObject(properties);
      expect(safe?.properties).toHaveProperty('event_version', 1);
      for (const key of ['translation', 'length', 'error_message', 'write'])
        expect(safe?.properties).not.toHaveProperty(key);
    }
    expect(
      sanitizeClosedBetaProperties({
        translation_copy_code: 'private-code',
        translation_copy_frame: '37',
        translation_copy_strand: 'private',
        translation_copy_result: 'private',
        translation_copy_length_bucket: '37',
      })
    ).toEqual({});
  });

  it.each([
    [0, '0'],
    [1, '1'],
    [2, '2_5'],
    [5, '2_5'],
    [6, '6_20'],
    [20, '6_20'],
    [21, '21_100'],
    [100, '21_100'],
    [101, '100_plus'],
    [-1, 'unknown'],
    [1.5, 'unknown'],
    [NaN, 'unknown'],
  ] as const)('buckets internal output length %s as %s', (count, bucket) =>
    expect(translationCopyLengthBucket(count)).toBe(bucket)
  );
});
