import { beforeEach, describe, expect, it, vi } from 'vitest';
const common = vi.hoisted(() => ({ capture: vi.fn(), enqueue: vi.fn(), fromReceipt: vi.fn() }));
vi.mock('../analytics', () => ({
  captureOptionalTelemetryOrigin: common.capture,
  enqueueOptionalAnalyticsEvent: common.enqueue,
  enqueueOptionalAnalyticsEventFromReceipt: common.fromReceipt,
}));
import {
  captureSkillObservation,
  publishCommittedSkillObservation,
  reportSkillOwnerReturn,
  skillRequestObservationContext,
} from './skill-observation';
import {
  decodeSkillObservation,
  prepareSkillObservation,
  type CommittedSkillObservation,
  type SkillMutationObservationContext,
} from './skill-observation-contract';
const origin = {
  consentScope: '10000000-0000-4000-8000-000000000001',
  contextId: '10000000-0000-4000-8000-000000000002',
  processId: '10000000-0000-4000-8000-000000000003',
  classification: 'synthetic' as const,
};
const context: SkillMutationObservationContext = {
  operationId: '20000000-0000-4000-8000-000000000001',
  eventId: '20000000-0000-4000-8000-000000000002',
  returnEventId: '20000000-0000-4000-8000-000000000003',
  origin,
};
const facts = {
  action: 'save' as const,
  atMs: 50,
  binding: { kind: 'skill' as const, id: 'private-native-id', updatedAt: 50 },
  host: 'all' as const,
  scope: 'workspace' as const,
  source: 'local' as const,
  installed: 'installed' as const,
  storedEnablement: 'disabled' as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  common.capture.mockReturnValue(origin);
  common.enqueue.mockReturnValue(true);
  common.fromReceipt.mockReturnValue(true);
});

describe('Skills existing common-publisher adapter', () => {
  it('creates three independent observation UUIDs without using native identifiers', () => {
    const observed = captureSkillObservation()!;
    expect(observed.origin).toBe(origin);
    expect(new Set([observed.operationId, observed.eventId, observed.returnEventId]).size).toBe(3);
    for (const id of [observed.operationId, observed.eventId, observed.returnEventId])
      expect(id).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(common.capture).toHaveBeenCalledOnce();
  });
  it('keeps returned acceptance and committed receipt as separate events under the captured original origin', () => {
    reportSkillOwnerReturn(context, 'save', 'accepted', {
      host: 'all',
      scope: 'workspace',
      source: 'local',
    });
    expect(common.enqueue).toHaveBeenCalledWith(
      origin,
      expect.objectContaining({
        eventId: context.returnEventId,
        referenceId: context.operationId,
        referenceKind: 'skill_operation',
        properties: expect.objectContaining({
          skills_stage: 'owner_return',
          skills_result: 'accepted',
          skills_installed: 'not_attested',
        }),
      })
    );
    const receipt = prepareSkillObservation(context, facts)!;
    common.fromReceipt.mockImplementation((read) => {
      expect(read()).toEqual({
        origin,
        event: expect.objectContaining({
          eventId: context.eventId,
          createdAtMs: 50,
          properties: receipt.properties,
        }),
      });
      return true;
    });
    expect(publishCommittedSkillObservation(() => receipt)).toBe(true);
    expect(common.capture).not.toHaveBeenCalled();
    expect(JSON.stringify(common.enqueue.mock.calls)).not.toContain('private-native-id');
  });
  it('rereads the domain owner for every fromReceipt check and does not cache a committed DTO', () => {
    let current: CommittedSkillObservation | null = prepareSkillObservation(context, facts);
    const read = vi.fn(() => current);
    common.fromReceipt.mockImplementation((readCommitted) => {
      expect(readCommitted()).not.toBeNull();
      current = null;
      expect(readCommitted()).toBeNull();
      return false;
    });
    expect(publishCommittedSkillObservation(read)).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('contains unavailable origin and common-publisher exceptions', () => {
    common.capture.mockReturnValue(null);
    expect(captureSkillObservation()).toBeNull();
    common.capture.mockImplementation(() => {
      throw new Error('synthetic capture failure');
    });
    expect(captureSkillObservation()).toBeNull();
    common.enqueue.mockImplementation(() => {
      throw new Error('synthetic enqueue failure');
    });
    expect(() => reportSkillOwnerReturn(context, 'save', 'failed')).not.toThrow();
    common.fromReceipt.mockImplementation(() => {
      throw new Error('synthetic publisher failure');
    });
    expect(publishCommittedSkillObservation(() => prepareSkillObservation(context, facts))).toBe(
      false
    );
  });
  it('rejects hostile persisted optional metadata and keeps private target bindings outside properties', () => {
    const receipt = prepareSkillObservation(context, facts)!;
    expect(receipt.binding.id).toBe('private-native-id');
    expect(JSON.stringify(receipt.properties)).not.toContain('private-native-id');
    expect(
      decodeSkillObservation({
        ...receipt,
        properties: { ...receipt.properties, instructions: 'SECRET' },
      })
    ).toBeNull();
    expect(
      decodeSkillObservation({
        ...receipt,
        properties: { ...receipt.properties, skills_task_reuse: 'useful' },
      })
    ).toBeNull();
    expect(
      decodeSkillObservation({
        ...receipt,
        properties: { ...receipt.properties, skills_host: '/private/config' },
      })
    ).toBeNull();
    expect(
      prepareSkillObservation(
        { ...context, origin: { ...origin, processId: 'not-an-origin' } },
        facts
      )
    ).toBeNull();
    expect(prepareSkillObservation(context, { ...facts, atMs: NaN })).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(
      prepareSkillObservation({ ...context, origin: { ...origin, ...circular } }, facts)
    ).not.toBeNull();
  });
  it('extracts only closed request host/scope/source without coercing a path or throwing getter', () => {
    expect(
      skillRequestObservationContext(
        {
          provider: 'dynamic-private-provider',
          scope: '/private/work',
          workspacePath: '/private/work',
        },
        'managed'
      )
    ).toEqual({ host: 'unknown', scope: 'current_context', source: 'managed' });
    expect(
      skillRequestObservationContext(
        {
          get provider() {
            throw new Error('private');
          },
        },
        'catalog'
      )
    ).toEqual({ source: 'catalog' });
  });
});
