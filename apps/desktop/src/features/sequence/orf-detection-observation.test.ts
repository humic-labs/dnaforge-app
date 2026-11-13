import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import * as correlation from '../../lib/telemetry-correlation';
import { abandonOpenWorkflowActions } from '../../lib/workflow-telemetry';
import { sanitizeClosedBetaProperties } from '../../shared/analytics-allowlist';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../../shared/analytics-registry.generated';
import { createOrfDetectionObserver, ORF_DETECTION_OBSERVED } from './orf-detection-observation';

const capture = vi.hoisted(() => ({ generation: 0 }));
vi.mock('../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/analytics')>()),
  getAnalyticsCaptureGeneration: () => capture.generation,
}));

const APP = '550e8400-e29b-41d4-a716-446655440001';
const A = '550e8400-e29b-41d4-a716-446655440002';
const B = '550e8400-e29b-41d4-a716-446655440003';
const INPUT = { source: 'worker', sequenceLength: 1001 } as const;

function observation() {
  let id = 10;
  const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
  const storePending = vi.fn(async () => undefined);
  const observe = createOrfDetectionObserver({
    track,
    storePending,
    createId: () => `550e8400-e29b-41d4-a716-${String(++id).padStart(12, '0')}`,
    now: () => Date.now(),
    isIdentified: () => true,
    activityAuthority: () => ({
      actorKind: 'external',
      executionMode: 'interactive',
      impersonated: false,
    }),
  });
  const start = (input: Parameters<typeof observe>[0] = INPUT) => {
    const current = observe(input);
    if (!current) throw new Error('Expected an observation');
    return current;
  };
  return {
    track,
    storePending,
    start,
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

describe('ORF detection observation', () => {
  it('joins one accepted computation and one result without admitting display or meaningful activity', () => {
    const o = observation();
    const current = o.start();
    vi.setSystemTime(1250);
    current.detected(27);
    current.detected(0);
    current.failed('worker_error');
    current.retire('retry');
    const [start, end] = o.properties();
    expect(o.track).toHaveBeenCalledTimes(2);
    expect(o.track.mock.calls.map(([event]) => event)).toEqual([
      ORF_DETECTION_OBSERVED,
      ORF_DETECTION_OBSERVED,
    ]);
    expect(start).toMatchObject({
      action_phase: 'start',
      orf_detection_result: 'pending',
      orf_detection_source: 'worker',
      orf_detection_sequence_length_bucket: '100_plus',
      orf_detection_result_count_bucket: 'unknown',
      occurred_at_ms: 1000,
    });
    expect(end).toMatchObject({
      action_phase: 'result',
      workflow: 'content',
      workflow_action: 'compute',
      workflow_status: 'ready',
      success: true,
      action_id: start.action_id,
      app_session_id: APP,
      episode_correlation_id: A,
      occurred_at_ms: 1250,
      duration_ms: 250,
      orf_detection_result: 'results',
      orf_detection_result_count_bucket: '21_100',
    });
    expect(end.effect_id).not.toBe(start.action_id);
    expect(abandonOpenWorkflowActions()).toBe(0);
    expect(o.storePending).not.toHaveBeenCalled();
    for (const key of ['value_delivered', 'usable_result', 'result_count', 'sequenceLength'])
      expect(end).not.toHaveProperty(key);
  });

  it('keeps cached zero distinct from pending and gives a genuine retry a new action', () => {
    const o = observation();
    o.start({ ...INPUT, source: 'cache' }).detected(0);
    o.start({ ...INPUT, source: 'fallback' }).detected(1);
    const [first, empty, retry, ready] = o.properties();
    expect(empty).toMatchObject({
      orf_detection_source: 'cache',
      orf_detection_result: 'empty',
      orf_detection_result_count_bucket: '0',
      workflow_status: 'no_match',
      success: true,
    });
    expect(retry.action_id).not.toBe(first.action_id);
    expect(ready).toMatchObject({
      orf_detection_source: 'fallback',
      orf_detection_result: 'results',
    });
    expect(o.storePending).not.toHaveBeenCalled();
  });

  it.each(['detector_error', 'worker_error'] as const)(
    'records finite failure %s once',
    (reason) => {
      const o = observation();
      const current = o.start();
      current.failed(reason);
      current.detected(1);
      expect(o.properties()).toHaveLength(2);
      expect(o.properties()[1]).toMatchObject({
        action_phase: 'error',
        orf_detection_result: reason,
        success: false,
      });
    }
  );

  it.each(['superseded', 'retry', 'view_hidden', 'detector_cancelled', 'unmounted'] as const)(
    'consumes retirement %s before any late result',
    (reason) => {
      const o = observation();
      const current = o.start();
      current.retire(reason);
      current.detected(1);
      current.retire(reason);
      expect(o.properties()).toHaveLength(2);
      expect(o.properties()[1]).toMatchObject({
        action_phase: 'cancel',
        orf_detection_result: reason,
        success: false,
      });
    }
  );

  it.each([-1, 1.5, NaN, Infinity])('fails closed on invalid internal result count %s', (count) => {
    const o = observation();
    o.start().detected(count);
    expect(o.properties()[1]).toMatchObject({
      action_phase: 'error',
      orf_detection_result: 'invalid_result',
      orf_detection_result_count_bucket: 'unknown',
      success: false,
    });
  });

  it.each(['refused_start', 'throwing_start', 'throwing_terminal'] as const)(
    'consumes %s without reconstructing an accepted start',
    (mode) => {
      const o = observation();
      if (mode === 'refused_start') o.track.mockReturnValueOnce(false);
      if (mode === 'throwing_start')
        o.track.mockImplementationOnce(() => {
          throw new Error('controlled tracker failure');
        });
      if (mode === 'throwing_terminal')
        o.track.mockReturnValueOnce(true).mockImplementationOnce(() => {
          throw new Error('controlled tracker failure');
        });
      const current = o.start();
      expect(() => current.detected(1)).not.toThrow();
      current.detected(1);
      current.retire('retry');
      expect(o.track).toHaveBeenCalledTimes(mode === 'throwing_terminal' ? 2 : 1);
      expect(abandonOpenWorkflowActions()).toBe(0);
      expect(o.storePending).not.toHaveBeenCalled();
    }
  );

  it.each(['consent', 'episode', 'episode_round_trip', 'session', 'reset'] as const)(
    'retires old egress across %s and never transfers it to the new context',
    (change) => {
      const o = observation();
      const current = o.start();
      if (change === 'consent') capture.generation += 2;
      if (change === 'episode') correlation.setEpisodeCorrelationId(B);
      if (change === 'episode_round_trip') {
        correlation.setEpisodeCorrelationId(B);
        correlation.setEpisodeCorrelationId(A);
      }
      if (change === 'session') {
        sessionStorage.setItem('dnaforge_telemetry_app_session_id', B);
        correlation.__resetTelemetryCorrelationForTests();
      }
      if (change === 'reset') correlation.__resetTelemetryCorrelationForTests();
      current.detected(1);
      current.retire('unmounted');
      expect(o.track).toHaveBeenCalledTimes(1);
      expect(abandonOpenWorkflowActions()).toBe(0);
      expect(o.storePending).not.toHaveBeenCalled();
    }
  );

  it('does not retire an idempotent same-episode setter', () => {
    const o = observation();
    const current = o.start();
    correlation.setEpisodeCorrelationId(A);
    current.detected(1);
    expect(o.track).toHaveBeenCalledTimes(2);
  });

  it('lets the existing page-exit owner consume a pending computation without a display start', () => {
    const o = observation();
    const current = o.start();
    expect(abandonOpenWorkflowActions()).toBe(1);
    current.detected(1);
    expect(o.properties()).toHaveLength(2);
    expect(o.properties()[1]).toMatchObject({
      action_phase: 'cancel',
      orf_detection_result: 'observation_interrupted',
    });
  });

  it('projects only closed buckets and joins through both production sanitizers', () => {
    const o = observation();
    const privateInput = {
      ...INPUT,
      sequence: 'PRIVATE_ORF_SEQUENCE_SENTINEL',
      geneticCodeKey: 'PRIVATE_ORF_CODE_SENTINEL',
      filename: 'PRIVATE_ORF_FILENAME_SENTINEL',
    };
    o.start(privateInput).detected(27);
    expect(JSON.stringify(o.properties())).not.toContain('PRIVATE_ORF');
    for (const properties of o.properties()) {
      const safe = sanitizeSdkEvent(
        {
          event: ORF_DETECTION_OBSERVED,
          properties: sanitizeClosedBetaProperties({
            ...properties,
            sequence: privateInput.sequence,
            geneticCodeKey: privateInput.geneticCodeKey,
            filename: privateInput.filename,
            result_count: 27,
            error_message: 'PRIVATE_ORF_ERROR_SENTINEL',
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
      for (const key of ['sequence', 'geneticCodeKey', 'filename', 'result_count', 'error_message'])
        expect(safe?.properties).not.toHaveProperty(key);
    }
    expect(
      sanitizeClosedBetaProperties({
        orf_detection_source: 'PRIVATE_ORF_SOURCE_SENTINEL',
        orf_detection_result: 'PRIVATE_ORF_RESULT_SENTINEL',
        orf_detection_sequence_length_bucket: '1001',
        orf_detection_result_count_bucket: 27,
      })
    ).toEqual({});
  });
});
