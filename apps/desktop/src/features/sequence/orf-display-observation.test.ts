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
import { createOrfDisplayObserver, ORF_DISPLAY_OBSERVED } from './orf-display-observation';

const capture = vi.hoisted(() => ({ generation: 0 }));
vi.mock('../../lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/analytics')>()),
  getAnalyticsCaptureGeneration: () => capture.generation,
}));
const APP = '550e8400-e29b-41d4-a716-446655440001';
const A = '550e8400-e29b-41d4-a716-446655440002';
const B = '550e8400-e29b-41d4-a716-446655440003';

function observation(count = 1) {
  let id = 10;
  const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
  const storePending = vi.fn(async () => undefined);
  const dependencies = {
    track,
    storePending,
    createId: () => `550e8400-e29b-41d4-a716-${String(++id).padStart(12, '0')}`,
    now: () => Date.now(),
    isIdentified: () => true,
  };
  const observeDisplay = createOrfDisplayObserver(dependencies);
  const observe = createOrfDetectionObserver({ ...dependencies, observeDisplay });
  const detector = observe({ source: 'worker', sequenceLength: 1001 });
  if (!detector) throw new Error('Expected a detector observation');
  return {
    track,
    storePending,
    detector,
    ready: () => detector.detected(count) || undefined,
    properties: () =>
      track.mock.calls
        .filter(([event]) => event === ORF_DISPLAY_OBSERVED)
        .map(([, properties]) => properties),
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

describe('ORF display observation', () => {
  it.each(['sequence_canvas', 'sequence_tracks', 'plasmid_map'] as const)(
    'joins the first qualified %s frame to its accepted detector result',
    (surface) => {
      const o = observation();
      expect(o.properties()).toEqual([]);
      const presentation = o.ready();
      expect(presentation).toBeDefined();
      expect(o.track.mock.calls.map(([event]) => event)).toEqual([
        ORF_DETECTION_OBSERVED,
        ORF_DETECTION_OBSERVED,
        ORF_DISPLAY_OBSERVED,
      ]);
      expect(o.properties()).toHaveLength(1);
      vi.setSystemTime(1400);
      presentation?.presented({ kind: 'orf_drawn', surface });
      presentation?.presented({ kind: 'orf_drawn', surface });
      presentation?.retire('retry');
      const [start, end] = o.properties();
      expect(end).toMatchObject({
        action_id: start.action_id,
        parent_action_id: o.track.mock.calls[0][1].action_id,
        action_phase: 'result',
        workflow_action: 'view',
        workflow_status: 'viewed',
        orf_display_result: 'drawn',
        orf_display_surface: surface,
        orf_display_source: 'worker',
        orf_display_result_count_bucket: '1',
        duration_ms: 400,
        app_session_id: APP,
        episode_correlation_id: A,
      });
      expect(o.properties()).toHaveLength(2);
      expect(o.storePending).not.toHaveBeenCalled();
      expect(abandonOpenWorkflowActions()).toBe(0);
    }
  );

  it('keeps a valid empty model separate from a drawn nonempty model', () => {
    const o = observation(0);
    o.ready()?.presented({ kind: 'empty_model', surface: 'sequence_canvas' });
    expect(o.properties()[1]).toMatchObject({
      orf_display_result: 'empty',
      orf_display_result_count_bucket: '0',
      workflow_status: 'no_match',
    });
    expect(o.storePending).not.toHaveBeenCalled();
  });

  it.each(['refused_start', 'refused_result', 'changed_result_authority'] as const)(
    'admits no display after %s',
    (mode) => {
      const o = observation();
      if (mode === 'refused_result') o.track.mockReturnValueOnce(false);
      if (mode === 'changed_result_authority')
        o.track.mockImplementationOnce(() => {
          correlation.setEpisodeCorrelationId(B);
          return true;
        });
      if (mode === 'refused_start') o.track.mockReturnValueOnce(true).mockReturnValueOnce(false);
      const presentation = o.ready();
      if (mode === 'refused_start') expect(presentation).toBeUndefined();
      else expect(o.properties()).toHaveLength(0);
      expect(abandonOpenWorkflowActions()).toBe(0);
    }
  );

  it.each(['superseded', 'retry', 'view_hidden', 'detector_cancelled', 'unmounted'] as const)(
    'retires %s without accepting a late frame',
    (reason) => {
      const o = observation();
      const presentation = o.ready();
      presentation?.retire(reason);
      presentation?.presented({ kind: 'orf_drawn', surface: 'plasmid_map' });
      expect(o.properties()).toHaveLength(2);
      expect(o.properties()[1]).toMatchObject({
        action_phase: 'cancel',
        orf_display_result: reason,
        success: false,
      });
    }
  );

  it.each(['consent', 'episode_round_trip', 'session', 'reset'] as const)(
    'fences a pending display across %s',
    (change) => {
      const o = observation();
      const presentation = o.ready();
      if (change === 'consent') capture.generation += 2;
      if (change === 'episode_round_trip') {
        correlation.setEpisodeCorrelationId(B);
        correlation.setEpisodeCorrelationId(A);
      }
      if (change === 'session') sessionStorage.setItem('dnaforge_telemetry_app_session_id', B);
      if (change === 'session' || change === 'reset')
        correlation.__resetTelemetryCorrelationForTests();
      presentation?.presented({ kind: 'orf_drawn', surface: 'sequence_canvas' });
      expect(o.properties()).toHaveLength(1);
      expect(abandonOpenWorkflowActions()).toBe(0);
    }
  );

  it('uses the existing page-exit owner to consume pending display', () => {
    const o = observation();
    const presentation = o.ready();
    expect(abandonOpenWorkflowActions()).toBe(1);
    presentation?.presented({ kind: 'orf_drawn', surface: 'sequence_canvas' });
    expect(o.properties()[1]).toMatchObject({
      action_phase: 'cancel',
      orf_display_result: 'observation_interrupted',
    });
    expect(o.properties()).toHaveLength(2);
  });

  it('keeps only approved joins and finite display fields through both production sanitizers', () => {
    const o = observation(27);
    o.ready()?.presented({ kind: 'orf_drawn', surface: 'plasmid_map' });
    for (const properties of o.properties()) {
      const safe = sanitizeSdkEvent(
        {
          event: ORF_DISPLAY_OBSERVED,
          properties: sanitizeClosedBetaProperties({
            ...properties,
            sequence: 'PRIVATE_ORF_DISPLAY_SEQUENCE',
            filename: 'PRIVATE_ORF_DISPLAY_FILE',
            result_count: 27,
            error_message: 'PRIVATE_ORF_DISPLAY_ERROR',
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
      for (const key of [
        'sequence',
        'filename',
        'result_count',
        'error_message',
        'value_delivered',
        'usable_result',
      ])
        expect(safe?.properties).not.toHaveProperty(key);
      expect(JSON.stringify(safe)).not.toContain('PRIVATE_ORF_DISPLAY');
    }
  });
});
