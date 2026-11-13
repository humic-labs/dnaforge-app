import { beforeEach, describe, expect, it, vi } from 'vitest';
const common = vi.hoisted(() => ({
  capture: vi.fn(),
  ready: vi.fn(),
  account: vi.fn(),
  episode: '10000000-0000-4000-8000-000000000001',
}));
vi.mock('./analytics', () => ({
  trackRendererEvent: common.capture,
  isAnalyticsCaptureReady: common.ready,
  getAnalyticsIdentifiedAccountId: common.account,
}));
vi.mock('./telemetry-correlation', () => ({
  getTelemetryCorrelationContext: () => ({
    appSessionId: '10000000-0000-4000-8000-000000000002',
    episodeCorrelationId: common.episode,
  }),
}));
import { beginSkillObservation } from './skill-operation-telemetry';
beforeEach(() => {
  vi.clearAllMocks();
  common.episode = '10000000-0000-4000-8000-000000000001';
  common.ready.mockReturnValue(true);
  common.account.mockReturnValue('private-account-a');
  common.capture.mockImplementation(() => undefined);
});
describe('Skills renderer observation non-interference', () => {
  it('settles once, keeps one separate readback, and never exports the private account', () => {
    const o = beginSkillObservation('install', {
      host: 'all',
      scope: 'workspace',
      source: 'catalog',
    });
    o.settle('owner_return', 'accepted');
    o.settle('owner_return', 'failed');
    o.readback('inventory_unavailable');
    o.readback('inventory_matched');
    expect(common.capture.mock.calls.map(([, p]) => [p.skills_stage, p.skills_result])).toEqual([
      ['intent', 'requested'],
      ['owner_return', 'accepted'],
      ['readback', 'inventory_unavailable'],
    ]);
    expect(new Set(common.capture.mock.calls.map(([, p]) => p.operation_id)).size).toBe(1);
    expect(JSON.stringify(common.capture.mock.calls)).not.toContain('private-account-a');
  });
  it('keeps consent-off intent and later identity transitions out of capture', () => {
    common.ready.mockReturnValue(false);
    const off = beginSkillObservation('save');
    common.ready.mockReturnValue(true);
    off.settle('owner_return', 'accepted');
    expect(common.capture).not.toHaveBeenCalled();
    const original = beginSkillObservation('save');
    common.account.mockReturnValue('private-account-b');
    original.settle('owner_return', 'accepted');
    original.readback('inventory_returned');
    expect(common.capture).toHaveBeenCalledOnce();
  });
  it('contains optional publisher failures through intent, settle and readback', () => {
    common.capture.mockImplementation(() => {
      throw new Error('synthetic SDK unavailable');
    });
    expect(() => {
      const o = beginSkillObservation('import');
      o.settle('owner_return', 'accepted');
      o.readback('inventory_returned');
    }).not.toThrow();
  });
  it('does not rebind an asynchronous outcome to a later common telemetry episode for the same account', () => {
    const original = beginSkillObservation('install');
    common.ready.mockReturnValue(false);
    common.episode = '20000000-0000-4000-8000-000000000001';
    common.ready.mockReturnValue(true);
    original.settle('owner_return', 'accepted');
    original.readback('inventory_returned');
    expect(common.capture).toHaveBeenCalledOnce();
    expect(common.capture.mock.calls[0]![1].skills_stage).toBe('intent');
  });
});
