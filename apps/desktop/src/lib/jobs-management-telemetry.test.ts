// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const { track } = vi.hoisted(() => ({
  track: vi.fn((_name: string, _properties?: Record<string, unknown>) => true),
}));
const original = vi.hoisted(() => ({
  ready: true,
  account: 'private-account-a',
  session: '10000000-0000-4000-8000-000000000001',
  episode: '10000000-0000-4000-8000-000000000002',
}));
vi.mock('./telemetry-correlation', () => ({
  getTelemetryCorrelationContext: () => ({
    appSessionId: original.session,
    episodeCorrelationId: original.episode,
  }),
}));
beforeEach(() => {
  original.ready = true;
  original.account = 'private-account-a';
  original.session = '10000000-0000-4000-8000-000000000001';
  original.episode = '10000000-0000-4000-8000-000000000002';
});
vi.mock('./analytics', () => ({
  trackRendererEvent: track,
  isAnalyticsCaptureReady: () => original.ready,
  getAnalyticsIdentifiedAccountId: () => original.account,
}));
import { beginJobManagement, jobManagementContext } from './jobs-management-telemetry';
import { CLOSED_BETA_EVENT_PROPERTIES } from '../shared/analytics-registry.generated';
import { hasPropertySanitizer, sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
const events = () => track.mock.calls.map(([, properties]) => properties!);
describe('closed Jobs management producer', () => {
  beforeEach(() => {
    track.mockReset().mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());
  it('keeps management acceptance, confirmation and later terminal observation distinct and once-only', () => {
    const productId = vi.spyOn(crypto, 'randomUUID');
    const observed = beginJobManagement('stop', {
      owner: 'managed-operation',
      freshness: 'current',
      mode: 'managed',
      state: 'running',
      availability: 'none',
      observedAtMs: 100,
    });
    observed.confirm(true);
    observed.confirm(false);
    observed.settle({ phase: 'accepted', result: 'stop_accepted', authority: 'owner_ack' });
    expect(events().some((row) => row.jobs_result === 'terminal_cancelled')).toBe(false);
    observed.settle({ phase: 'refused', result: 'stop_unavailable' });
    observed.record({
      phase: 'observed',
      result: 'terminal_cancelled',
      authority: 'owner_record',
      state: 'cancelled',
      observedAtMs: 200,
    });
    observed.record({ phase: 'observed', result: 'terminal_succeeded' });
    expect(productId).not.toHaveBeenCalled();
    expect(events()).toHaveLength(4);
    expect(new Set(events().map((row) => row.operation_id)).size).toBe(1);
    expect(events().map((row) => row.jobs_stage)).toEqual([
      'intent',
      'confirmation',
      'request',
      'record',
    ]);
    expect(events().at(-1)).toMatchObject({
      jobs_result: 'terminal_cancelled',
      jobs_execution_state: 'cancelled',
      jobs_authority: 'owner_record',
      jobs_context_basis: 'record_observation',
      jobs_operation_relation: 'action_only_native_not_exported',
      jobs_observed_at_ms: 200,
    });
    for (const properties of events())
      expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
  });
  it('accepts only closed context fields and never copies native/scientific identity or payload', () => {
    const sentinel = 'PRIVATE-job-path-title-id-actor-provider-result';
    const job = {
      id: sentinel,
      owner: { kind: 'hosted-compute', nativeId: sentinel },
      observation: { freshness: 'stale', observedAtMs: 123 },
      executionContext: { mode: 'connected', ownerInstanceId: sentinel },
      result: { availability: 'available', reason: sentinel },
      state: 'succeeded',
      title: sentinel,
      target: sentinel,
      targetIdentity: sentinel,
      inputRevision: sentinel,
      error: sentinel,
    };
    beginJobManagement('import', jobManagementContext(job)).settle({
      phase: 'refused',
      result: 'import_not_applied',
      authority: 'adapter_return',
    });
    expect(JSON.stringify(track.mock.calls)).not.toContain(sentinel);
    expect(events()[0]).toMatchObject({
      jobs_owner: 'hosted-compute',
      jobs_freshness: 'stale',
      jobs_origin: 'live',
    });
    for (const key of CLOSED_BETA_EVENT_PROPERTIES.job_management_observed)
      expect(hasPropertySanitizer(key)).toBe(true);
    expect(
      sanitizeClosedBetaProperties({
        native_id: sentinel,
        job_id: sentinel,
        provider_id: sentinel,
        result_payload: sentinel,
        error: sentinel,
        jobs_owner: sentinel,
        jobs_result: sentinel,
        jobs_operation_relation: sentinel,
      })
    ).toEqual({});
  });
  it('keeps recorded history separate from a new live run and rejects invalid clocks', () => {
    beginJobManagement('record_completed', { mode: 'recorded', observedAtMs: Number.NaN }).settle({
      phase: 'result',
      result: 'recorded_history_added',
      authority: 'owner_ack',
    });
    expect(events()[1]).toMatchObject({
      jobs_origin: 'recorded',
      jobs_execution_mode: 'recorded',
      jobs_observation_clock: 'unknown',
    });
    expect(events()[1]).not.toHaveProperty('jobs_observed_at_ms');
    expect(track.mock.calls.every(([name]) => name === 'job_management_observed')).toBe(true);
  });
  it('does not recycle the initial owner clock or availability for nonattested retirement', () => {
    const observed = beginJobManagement('stop', {
      owner: 'managed-operation',
      freshness: 'current',
      mode: 'managed',
      state: 'running',
      availability: 'available',
      observedAtMs: 100,
    });
    observed.record({
      phase: 'cancelled',
      result: 'surface_closed',
      freshness: 'superseded',
      authority: 'not_attested',
    });
    expect(events()[1]).toMatchObject({
      jobs_context_basis: 'intent_and_outcome',
      jobs_observation_clock: 'unknown',
      jobs_freshness: 'superseded',
      jobs_result_availability: 'unknown',
      jobs_execution_state: 'unknown',
    });
    expect(events()[1]).not.toHaveProperty('jobs_observed_at_ms');
  });
  it('contains optional entropy failure without using a native/product ID fallback', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('PRIVATE-entropy');
    });
    const observed = beginJobManagement('release');
    expect(observed.id).toBeNull();
    expect(() => {
      observed.confirm(false);
      observed.settle({ phase: 'cancelled', result: 'confirmation_cancelled' });
    }).not.toThrow();
    expect(track).not.toHaveBeenCalled();
  });
  it.each(['consent_or_schema_refused', 'capture_throws'] as const)(
    'does not throw or retry when %s',
    (mode) => {
      if (mode === 'capture_throws')
        track.mockImplementation(() => {
          throw new Error('PRIVATE-sink');
        });
      else track.mockReturnValue(false);
      expect(() => {
        const observed = beginJobManagement('open');
        observed.settle({ phase: 'refused', result: 'open_unavailable' });
        observed.settle({ phase: 'result', result: 'open_presented' });
      }).not.toThrow();
      expect(track).toHaveBeenCalledTimes(2);
    }
  );
  it('does not attach a management request begun without consent to later opt-in', () => {
    original.ready = false;
    const operation = beginJobManagement('stop');
    original.ready = true;
    operation.confirm(true);
    operation.settle({ phase: 'accepted', result: 'stop_accepted', authority: 'owner_ack' });
    operation.record({
      phase: 'observed',
      result: 'terminal_cancelled',
      authority: 'owner_record',
    });
    expect(track).not.toHaveBeenCalled();
  });
  it.each(['account', 'session', 'episode'] as const)(
    'does not rebind late management results after original %s changes',
    (field) => {
      const operation = beginJobManagement('stop');
      original[field] = 'private-replacement';
      operation.confirm(true);
      operation.settle({ phase: 'accepted', result: 'stop_accepted', authority: 'owner_ack' });
      operation.record({
        phase: 'observed',
        result: 'terminal_cancelled',
        authority: 'owner_record',
      });
      expect(track).toHaveBeenCalledOnce();
      expect(JSON.stringify(track.mock.calls)).not.toContain('private-account-a');
    }
  );
});
