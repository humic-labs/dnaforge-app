import { describe, expect, it, vi } from 'vitest';
import { beginWorkflowAction, observeWorkflowAction } from './workflow-telemetry';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
import { CLOSED_BETA_EVENT_PROPERTIES } from '../shared/analytics-registry.generated';

const input = {
  workflow: 'registry',
  action: 'create',
  workflowOrigin: 'projection',
  initiator: 'system',
} as const;

describe('workflow loop telemetry', () => {
  it('bounds a 1000-operation projection burst across fresh action IDs and both phases', () => {
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const dependencies = { track, now: () => 100_000, isIdentified: () => true };
    for (let tick = 0; tick < 1000; tick += 1) {
      beginWorkflowAction(input, dependencies).complete({ status: 'created', affectedCount: 1 });
    }
    const observed = track.mock.calls.filter(([event]) => event === 'workflow_action_observed');
    expect(observed).toHaveLength(60);
    expect(observed.length).toBeLessThan(100);
    expect(track.mock.calls.filter(([event]) => event === 'loop_suppressed')).toHaveLength(1);
    expect(track.mock.calls.some(([event]) => event === 'meaningful_activity_completed')).toBe(
      false
    );
  });

  it('uses a rolling minute across a clock-minute boundary and permits later observations', () => {
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    let now = 119_999;
    const dependencies = { track, now: () => now };
    for (let tick = 0; tick < 60; tick += 1) observeWorkflowAction(input, dependencies);
    now = 120_000;
    expect(observeWorkflowAction(input, dependencies)).toBe(false);
    expect(track.mock.calls.filter(([event]) => event === 'workflow_action_observed')).toHaveLength(
      60
    );
    now = 179_999;
    expect(observeWorkflowAction(input, dependencies)).toBe(true);
  });

  it('retains a real error after its start was suppressed and keeps unrelated workflows visible', () => {
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    const dependencies = { track, now: () => 100_000 };
    for (let tick = 0; tick < 60; tick += 1) observeWorkflowAction(input, dependencies);
    const failed = beginWorkflowAction(input, dependencies);
    expect(failed.startAccepted).toBe(false);
    expect(failed.fail('io_error')).toBe(true);
    expect(track).toHaveBeenCalledWith(
      'workflow_action_observed',
      expect.objectContaining({ action_phase: 'error', success: false, error_class: 'io_error' })
    );
    expect(observeWorkflowAction({ workflow: 'annotation', action: 'create' }, dependencies)).toBe(
      true
    );
  });

  it('retains only closed workflow context in the suppression diagnostic', () => {
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    for (let tick = 0; tick < 100; tick += 1)
      observeWorkflowAction(input, { track, now: () => 100_000 });
    const summary = track.mock.calls.find(([event]) => event === 'loop_suppressed');
    expect(summary).toBeDefined();
    const properties = summary![1];
    expect(properties).toMatchObject({
      workflow: 'registry',
      workflow_action: 'create',
      workflow_origin: 'projection',
    });
    expect(properties).not.toHaveProperty('action_id');
    expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
    expect(CLOSED_BETA_EVENT_PROPERTIES.loop_suppressed).toEqual(
      expect.arrayContaining(['workflow', 'workflow_action', 'workflow_origin'])
    );
  });

  it('bounds identical failed observations separately and retains their failure class', () => {
    const track = vi.fn((_event: string, _properties: Record<string, unknown>) => true);
    for (let tick = 0; tick < 1000; tick += 1)
      observeWorkflowAction(
        { ...input, success: false, errorClass: 'io_error' },
        { track, now: () => 100_000 }
      );
    expect(track.mock.calls.filter(([event]) => event === 'workflow_action_observed')).toHaveLength(
      60
    );
    expect(track).toHaveBeenCalledWith(
      'loop_suppressed',
      expect.objectContaining({
        success: false,
        workflow_status: 'failed',
        error_class: 'io_error',
      })
    );
    expect(
      observeWorkflowAction(
        { ...input, success: false, errorClass: 'permission_denied' },
        { track, now: () => 100_000 }
      )
    ).toBe(true);
  });
});
