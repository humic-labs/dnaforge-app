import { beforeEach, expect, it, vi } from 'vitest';
const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ trackRendererEvent: capture }));
import { observeModelPreference } from './preference-telemetry';

beforeEach(() => capture.mockClear());

it('joins preference write stages without including the provider or model alias', () => {
  const route = { kind: 'provider', provider: 'openai', model: 'PRIVATE_ROUTER_ALIAS' } as const;
  const operationId = crypto.randomUUID();
  observeModelPreference(route, 'persist', 'started', 'none', operationId, 'custom');
  observeModelPreference(route, 'persist', 'failed', 'persist-failed', operationId, 'custom');
  expect(capture).toHaveBeenCalledTimes(2);
  expect(capture.mock.calls[1][1]).toMatchObject({
    operation_id: operationId,
    preference_stage: 'persist',
    preference_outcome: 'failed',
    preference_route_kind: 'provider',
    preference_model_source: 'custom',
    preference_failure_code: 'persist-failed',
  });
  expect(JSON.stringify(capture.mock.calls)).not.toContain('PRIVATE_ROUTER_ALIAS');
  expect(JSON.stringify(capture.mock.calls)).not.toContain('openai');
});

it('uses the approved extension category for team routes', () => {
  observeModelPreference({ kind: 'team', id: 'PRIVATE_TEAM' }, 'restore', 'succeeded');
  expect(capture.mock.calls[0][1].preference_route_kind).toBe('extension');
  expect(JSON.stringify(capture.mock.calls)).not.toContain('PRIVATE_TEAM');
});
