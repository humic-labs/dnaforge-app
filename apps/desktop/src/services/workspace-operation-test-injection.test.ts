// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';
import {
  armWorkspaceOperationFailure,
  disarmWorkspaceOperationFailure,
  throwInjectedWorkspaceOperationFailure,
  workspaceOperationFailureState,
} from './workspace-operation-test-injection';

describe('workspace operation failure injection', () => {
  afterEach(() => disarmWorkspaceOperationFailure());

  it('refuses to arm a second failure while one is still pending, and re-arms once it fired', () => {
    armWorkspaceOperationFailure({ stage: 'display' });
    expect(() => armWorkspaceOperationFailure({ stage: 'display' })).toThrow(/already armed/);
    expect(() => throwInjectedWorkspaceOperationFailure('display', '/ws/a')).toThrow();
    expect(() => armWorkspaceOperationFailure({ stage: 'reconstruction' })).not.toThrow();
    disarmWorkspaceOperationFailure();
    expect(workspaceOperationFailureState()).toBeNull();
  });

  it('fires exactly once, only for the armed stage and root, tolerating trailing separators', () => {
    armWorkspaceOperationFailure({ stage: 'reconstruction', workspaceRoot: '/ws/a/' });
    expect(() => throwInjectedWorkspaceOperationFailure('display', '/ws/a')).not.toThrow();
    expect(() => throwInjectedWorkspaceOperationFailure('reconstruction', '/ws/b')).not.toThrow();
    expect(workspaceOperationFailureState()).toEqual({
      stage: 'reconstruction',
      workspaceRoot: '/ws/a',
      pending: true,
      hits: 0,
    });
    expect(() => throwInjectedWorkspaceOperationFailure('reconstruction', '/ws/a')).toThrow(
      'Injected workspace reconstruction failure'
    );
    expect(() => throwInjectedWorkspaceOperationFailure('reconstruction', '/ws/a')).not.toThrow();
    expect(workspaceOperationFailureState()).toMatchObject({ pending: false, hits: 1 });
  });

  it('is inert when nothing is armed', () => {
    expect(workspaceOperationFailureState()).toBeNull();
    expect(() => throwInjectedWorkspaceOperationFailure('display', '/ws/a')).not.toThrow();
  });
});
