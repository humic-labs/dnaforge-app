// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  WorkspaceSessionController,
  type WorkspaceSessionAdapter,
} from '@waypoint/domain-services';
import {
  persistHostedWorkspaceSelection,
  withHostedWorkspaceSelection,
  type WorkspaceSelectionStorage,
} from './workspace-selection';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
function adapter(accountId = 'account-one'): WorkspaceSessionAdapter {
  return {
    descriptor: {
      kind: 'hosted-browser',
      authority: 'dnaforge-manifest-revisions',
      identityFidelity: 'stable-resource-id',
      capabilities: {
        createWorkspace: false,
        multiFile: true,
        write: false,
        rename: false,
        move: false,
        delete: false,
        watch: false,
        history: false,
        restore: false,
      },
    },
    listWorkspaces: async () => ({
      principal: { id: accountId, label: accountId },
      workspaces: [FIRST, SECOND].map((workspaceId) => ({
        workspaceId,
        displayName: workspaceId,
        latestRevisionId: null,
        latestRevisionNumber: 0,
      })),
    }),
    loadWorkspace: async ({ workspaceId }) => ({
      workspaceId,
      revisionId: null,
      revisionNumber: 0,
      files: [],
    }),
    createWorkspace: async () => {
      throw new Error('Unexpected fixture creation');
    },
    readFile: async () => {
      throw new Error('Unexpected fixture read');
    },
    commit: async () => {
      throw new Error('Unexpected fixture commit');
    },
  };
}
function storage(): WorkspaceSelectionStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('hosted selected-project persistence', () => {
  it('resumes the selected project through the real shared owner after reload', async () => {
    const saved = storage();
    const first = new WorkspaceSessionController(
      withHostedWorkspaceSelection(adapter(), () => saved)
    );
    const detach = persistHostedWorkspaceSelection(first, () => saved);
    await first.initialize();
    await first.selectWorkspace(SECOND);
    detach();
    const reloaded = new WorkspaceSessionController(
      withHostedWorkspaceSelection(adapter(), () => saved)
    );
    await reloaded.initialize();
    expect(reloaded.getState().activeWorkspaceId).toBe(SECOND);
  });

  it('keeps account preferences separate even when both accounts can access the same projects', async () => {
    const saved = storage();
    const first = new WorkspaceSessionController(
      withHostedWorkspaceSelection(adapter(), () => saved)
    );
    const detach = persistHostedWorkspaceSelection(first, () => saved);
    await first.initialize();
    await first.selectWorkspace(SECOND);
    detach();
    const other = new WorkspaceSessionController(
      withHostedWorkspaceSelection(adapter('account-two'), () => saved)
    );
    await other.initialize();
    expect(other.getState().activeWorkspaceId).toBe(FIRST);
  });

  it('retains explicit project selection ahead of a remembered project', async () => {
    const saved = storage();
    const first = new WorkspaceSessionController(
      withHostedWorkspaceSelection(adapter(), () => saved)
    );
    const detach = persistHostedWorkspaceSelection(first, () => saved);
    await first.initialize();
    await first.selectWorkspace(SECOND);
    detach();
    const reloaded = new WorkspaceSessionController(
      withHostedWorkspaceSelection(adapter(), () => saved)
    );
    await reloaded.initialize(FIRST);
    expect(reloaded.getState().activeWorkspaceId).toBe(FIRST);
  });

  it('allows normal selection when preference storage is unavailable', async () => {
    const inaccessible = () => {
      throw new Error('Storage is disabled');
    };
    const first = new WorkspaceSessionController(
      withHostedWorkspaceSelection(adapter(), inaccessible)
    );
    const detach = persistHostedWorkspaceSelection(first, inaccessible);
    await first.initialize();
    await first.selectWorkspace(SECOND);
    expect(first.getState().activeWorkspaceId).toBe(SECOND);
    detach();
  });
});
