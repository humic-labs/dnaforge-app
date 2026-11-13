// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeClosedBetaProperties, hasPropertySanitizer } from '../shared/analytics-allowlist';
import { CLOSED_BETA_EVENT_PROPERTIES } from '../shared/analytics-registry.generated';
const { track } = vi.hoisted(() => ({
  track: vi.fn((_event: string, _properties: Record<string, unknown>) => true),
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
import { beginHistoryObservation, createHistoryCorrelationId } from './chat-history-telemetry';
const pane = '33760000-0000-4000-8000-000000000001';
const parent = '33760000-0000-4000-8000-000000000002';
describe('history observation contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    track.mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());
  it('settles store and pane once under one independently random operation', () => {
    const product = vi.spyOn(crypto, 'randomUUID');
    const operation = beginHistoryObservation('delete', 'history_surface', pane, parent);
    operation.store({
      result: 'delete_returned',
      authority: 'sqlite_return',
      replacement: 'read_failed_placeholder',
      availability: 'placeholder',
    });
    operation.store({ result: 'row_updated' });
    operation.pane({
      result: 'placeholder_presented',
      authority: 'pane_commit',
      paneRole: 'current_pane',
      presentedGenerationId: pane,
    });
    operation.pane({ result: 'pane_presented' });
    expect(product).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledTimes(3);
    const events = track.mock.calls;
    expect(new Set(events.map(([, value]) => value.operation_id)).size).toBe(1);
    expect(operation.id).not.toBe(pane);
    expect(operation.id).not.toBe(parent);
    expect(events.map(([, value]) => value.history_stage)).toEqual(['operation', 'store', 'pane']);
    expect(events[2]![1]).toMatchObject({
      history_availability: 'placeholder',
      history_replacement: 'read_failed_placeholder',
      history_shadow_cleanup: 'NOT_ATTESTED',
    });
    for (const [, properties] of events) {
      expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
      expect(
        Object.keys(properties).every((key) =>
          (CLOSED_BETA_EVENT_PROPERTIES.chat_history_observed as readonly string[]).includes(key)
        )
      ).toBe(true);
    }
  });
  it('has a sanitizer for every declared field and drops sentinels and invented authority', () => {
    for (const key of CLOSED_BETA_EVENT_PROPERTIES.chat_history_observed)
      expect(hasPropertySanitizer(key)).toBe(true);
    const sentinel = 'PRIVATE-H1-query-title-/workspace/conversation-id';
    const safe = sanitizeClosedBetaProperties({
      query: sentinel,
      title: sentinel,
      conversation_id: sentinel,
      workspace_path: sentinel,
      error: sentinel,
      history_result: sentinel,
      history_authority: 'secure_erasure',
      history_pane_generation_id: sentinel,
      history_shadow_cleanup: 'VERIFIED',
    });
    expect(safe).toEqual({});
    expect(JSON.stringify(safe)).not.toContain(sentinel);
  });
  it('drops arbitrary IDs but retains approved random correlation', () => {
    const observed = beginHistoryObservation(
      'resume',
      'history_surface',
      '/private/pane',
      'conversation-stable-id'
    );
    expect(observed.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]?.[1]).not.toHaveProperty('history_pane_generation_id');
    expect(createHistoryCorrelationId()).not.toBe(createHistoryCorrelationId());
  });
  it('cannot throw when random generation fails', () => {
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => {
      throw new Error('private randomness refusal');
    });
    const observed = beginHistoryObservation('list', 'store');
    expect(observed.id).toBeNull();
    expect(() => {
      observed.store({ phase: 'error', result: 'read_rejected' });
      observed.pane({ phase: 'cancelled', result: 'surface_closed' });
    }).not.toThrow();
    expect(track).not.toHaveBeenCalled();
  });
  it.each(['refused', 'throws'] as const)(
    'does not retry or throw when the optional sink %s',
    (mode) => {
      if (mode === 'refused') track.mockReturnValue(false);
      else
        track.mockImplementation(() => {
          throw new Error('private sink refusal');
        });
      expect(() => {
        const operation = beginHistoryObservation('rename', 'store');
        operation.store({ phase: 'error', result: 'native_write_rejected' });
        operation.store({ result: 'row_updated' });
      }).not.toThrow();
      expect(track).toHaveBeenCalledTimes(2);
    }
  );
  it('does not attach an operation begun without consent to later opt-in', () => {
    original.ready = false;
    const operation = beginHistoryObservation('delete', 'history_surface');
    original.ready = true;
    operation.store({ result: 'delete_returned', authority: 'sqlite_return' });
    operation.pane({ result: 'pane_presented' });
    expect(track).not.toHaveBeenCalled();
  });
  it.each(['account', 'session', 'episode'] as const)(
    'does not rebind a late history result after original %s changes',
    (field) => {
      const operation = beginHistoryObservation('delete', 'history_surface');
      original[field] = 'private-replacement';
      operation.store({ result: 'delete_returned', authority: 'sqlite_return' });
      operation.pane({ result: 'placeholder_presented' });
      expect(track).toHaveBeenCalledOnce();
      expect(JSON.stringify(track.mock.calls)).not.toContain('private-account-a');
    }
  );
});
