import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abandonOpenTelemetryOperations,
  beginToolOperation,
  installTelemetryAbandonmentOnExit,
} from './analytics-operation';

const analyticsMocks = vi.hoisted(() => ({
  trackToolActionStarted: vi.fn(),
  trackToolActionCompleted: vi.fn(),
  trackToolOperationError: vi.fn(),
  trackRendererEvent: vi.fn<typeof import('./analytics').trackRendererEvent>(() => true),
  isAnalyticsIdentityIdentified: vi.fn(() => true),
  getMeaningfulActivityAuthority: vi.fn(() => ({
    actorKind: 'external' as const,
    executionMode: 'interactive' as const,
    impersonated: false,
  })),
  subscribeAnalyticsCaptureReady: vi.fn(() => () => {}),
}));

vi.mock('./analytics', () => analyticsMocks);

describe('beginToolOperation', () => {
  beforeEach(() => {
    abandonOpenTelemetryOperations();
    vi.clearAllMocks();
  });

  it('carries assembly planning context through the existing paired tool owner', () => {
    const context = {
      assemblyComputeStage: 'draft_primers',
      assemblyMaterialRoute: 'pcr',
      pcrTemplateCount: 2,
    } as const;
    const operation = beginToolOperation({
      toolId: 'assembly',
      surface: 'tab',
      action: 'computed',
      workflowMetadata: context,
    });
    operation.cancel();
    const receipts = analyticsMocks.trackRendererEvent.mock.calls.filter(
      ([event]) => event === 'workflow_action_observed'
    );
    expect(receipts).toHaveLength(2);
    const payloads = receipts.map(([, properties]) => {
      if (properties === undefined) throw new Error('Workflow receipt payload is missing');
      expect(properties).toMatchObject({
        workflow: 'assembly',
        assembly_compute_stage: 'draft_primers',
        assembly_material_route: 'pcr',
        pcr_template_count: 2,
      });
      return properties;
    });
    expect(payloads.map((properties) => properties.action_phase)).toEqual(['start', 'cancel']);
    expect(payloads[0].action_id).toBe(payloads[1].action_id);
  });

  it('pairs start and completion with one opaque operation ID and exact duration', () => {
    const operation = beginToolOperation(
      { toolId: 'assembly', surface: 'tab', action: 'computed' },
      { createId: () => '550e8400-e29b-41d4-a716-446655440001', now: () => 100 }
    );

    expect(analyticsMocks.trackToolActionStarted).toHaveBeenCalledWith(
      'assembly',
      'tab',
      'computed',
      '550e8400-e29b-41d4-a716-446655440001'
    );
    expect(operation.complete(275)).toBe(true);
    expect(operation.complete(400)).toBe(false);
    expect(operation.fail('compute', 450)).toBe(false);
    expect(analyticsMocks.trackToolActionCompleted).toHaveBeenCalledOnce();
    expect(analyticsMocks.trackToolActionCompleted).toHaveBeenCalledWith(
      'assembly',
      'tab',
      'computed',
      '550e8400-e29b-41d4-a716-446655440001',
      175
    );
  });

  it('consumes cancellation once with cancelled action and the attempted action', () => {
    const operation = beginToolOperation(
      { toolId: 'primer_design', surface: 'sidebar', action: 'searched' },
      { createId: () => '550e8400-e29b-41d4-a716-446655440002', now: () => 10 }
    );

    expect(operation.cancel(25)).toBe(true);
    expect(operation.cancel(30)).toBe(false);
    expect(analyticsMocks.trackToolOperationError).toHaveBeenCalledWith({
      toolId: 'primer_design',
      surface: 'sidebar',
      attemptedAction: 'searched',
      outcomeAction: 'cancelled',
      errorClass: 'cancelled',
      operationId: '550e8400-e29b-41d4-a716-446655440002',
      durationMs: 15,
    });
  });

  it('clamps the terminal duration to the governed integer boundary', () => {
    const operation = beginToolOperation(
      { toolId: 'assembly', surface: 'tab', action: 'exported' },
      { createId: () => '550e8400-e29b-41d4-a716-446655440003', now: () => 50 }
    );

    operation.fail('filesystem', 100_000_000);

    expect(analyticsMocks.trackToolOperationError).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 86_400_000, outcomeAction: 'failed' })
    );
  });

  it('distinguishes a completed empty-library search from a usable match', () => {
    const operation = beginToolOperation(
      { toolId: 'primers', surface: 'sidebar', action: 'searched' },
      { createId: () => '550e8400-e29b-41d4-a716-446655440004', now: () => 50 }
    );
    operation.complete(75, {
      status: 'no_match',
      resultCount: 0,
      usableResult: false,
      outcomeKind: 'library_empty',
    });
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith(
      'workflow_action_observed',
      expect.objectContaining({
        action_id: operation.operationId,
        action_phase: 'result',
        workflow_status: 'no_match',
        result_count: 0,
        usable_result: false,
        outcome_kind: 'library_empty',
      })
    );
    expect(operation.complete(100, { resultCount: 1, usableResult: true })).toBe(false);
  });
  it('preserves exact failed-stage metadata without permitting a second terminal', () => {
    const operation = beginToolOperation(
      { toolId: 'assembly', surface: 'tab', action: 'exported' },
      { createId: () => '550e8400-e29b-41d4-a716-446655440105', now: () => 50 }
    );
    expect(
      operation.fail('projection', 75, {
        artifactCorrelationId: '550e8400-e29b-41d4-a716-446655440106',
        outcomeKind: 'display_pending',
        valueDelivered: false,
      })
    ).toBe(true);
    expect(operation.complete(100)).toBe(false);
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith(
      'workflow_action_observed',
      expect.objectContaining({
        action_phase: 'error',
        artifact_correlation_id: '550e8400-e29b-41d4-a716-446655440106',
        outcome_kind: 'display_pending',
        value_delivered: false,
      })
    );
  });

  it('distinguishes declined replacement from a completed accepted package', () => {
    const operation = beginToolOperation(
      { toolId: 'assembly', surface: 'tab', action: 'exported' },
      { createId: () => '550e8400-e29b-41d4-a716-446655440107', now: () => 50 }
    );
    expect(
      operation.cancel(75, {
        outcomeKind: 'replacement_declined',
        valueDelivered: false,
        usableResult: false,
      })
    ).toBe(true);
    expect(operation.cancel(100)).toBe(false);
    expect(analyticsMocks.trackRendererEvent).toHaveBeenCalledWith(
      'workflow_action_observed',
      expect.objectContaining({
        action_phase: 'cancel',
        outcome_kind: 'replacement_declined',
        value_delivered: false,
        usable_result: false,
      })
    );
  });
});

describe('tool operation abandonment', () => {
  beforeEach(() => {
    abandonOpenTelemetryOperations();
    vi.clearAllMocks();
  });

  it('closes an unfinished tool action as abandoned when the window goes away', () => {
    const open = beginToolOperation({ toolId: 'assembly', surface: 'tab', action: 'computed' });
    const done = beginToolOperation({ toolId: 'primers', surface: 'sidebar', action: 'searched' });
    done.complete();
    const uninstall = installTelemetryAbandonmentOnExit(window);

    window.dispatchEvent(new Event('pagehide'));
    uninstall();

    expect(open.consumed).toBe(true);
    expect(analyticsMocks.trackToolOperationError).toHaveBeenCalledOnce();
    expect(analyticsMocks.trackToolOperationError).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'assembly', outcomeAction: 'cancelled' })
    );
    const abandoned = analyticsMocks.trackRendererEvent.mock.calls.filter(
      ([event, properties]) =>
        event === 'workflow_action_observed' && properties?.workflow_status === 'abandoned'
    );
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.[1]).toMatchObject({ workflow: 'assembly', action_phase: 'cancel' });
    window.dispatchEvent(new Event('pagehide'));
    expect(analyticsMocks.trackToolOperationError).toHaveBeenCalledOnce();
  });
});
