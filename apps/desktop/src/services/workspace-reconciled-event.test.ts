import { describe, expect, it } from 'vitest';

import {
  notifyWorkspaceReconciled,
  WORKSPACE_RECONCILED_EVENT,
  type WorkspaceReconciledEventDetail,
} from './workspace-reconciled-event';

describe('notifyWorkspaceReconciled', () => {
  it('announces the rebuilt root synchronously and collects no promises', () => {
    const received: WorkspaceReconciledEventDetail[] = [];
    const listener = (event: Event): void => {
      received.push((event as CustomEvent<WorkspaceReconciledEventDetail>).detail);
    };
    window.addEventListener(WORKSPACE_RECONCILED_EVENT, listener);
    try {
      notifyWorkspaceReconciled('/managed/workspace-a');
      expect(received).toEqual([{ path: null, workspaceRoot: '/managed/workspace-a' }]);
      expect(Object.keys(received[0])).toEqual(['path', 'workspaceRoot']);
    } finally {
      window.removeEventListener(WORKSPACE_RECONCILED_EVENT, listener);
    }
  });
});
