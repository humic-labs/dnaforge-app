import { userMessage } from '@waypoint/user-messages';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceSyncReplicaAppliedEvent,
  WorkspaceSyncReplicaPreparingEvent,
} from '../shared/workspace-sync-ipc';
import { usePageStore } from '../features/page/store';
import { useSequenceStore } from '../features/sequence/store';
import { useDesignStore } from '../features/design/store';
import { useToastStore } from '../stores/toast-store';
import type { SequenceDesign } from '../features/design/types';
import {
  hasPendingDesignArtifactMirror,
  startDesignArtifactMirroring,
  stopDesignArtifactMirroring,
} from '../features/design/design-artifact-mirror';
import { setMockFileContent } from '../test/platform-mocks';
import { initPlatform } from '../platform';
import {
  abortWorkspaceSyncReplicaInRenderer,
  handleWorkspaceSyncReplicaLifecycleWithStores,
  prepareWorkspaceSyncReplicaInRenderer,
  refreshWorkspaceSyncReplicaInRenderer,
} from './workspace-sync-renderer-refresh';

const EVENT: WorkspaceSyncReplicaAppliedEvent = {
  deliveryId: 'delivery-a',
  phase: 'applied',
  mutationToken: 'mutation-token-a',
  workspaceUuid: 'workspace-a',
  workspaceRoot: '/managed/workspace-a',
  remoteVersionId: 'version-b',
  changedPaths: ['/managed/workspace-a/changed.gb'],
  deletedPaths: ['/managed/workspace-a/deleted.gb'],
  affectedNotebookIds: ['notebook-updated', 'notebook-deleted'],
  affectedDesignIds: [],
  deletedDesignIds: [],
};

const PREPARING: WorkspaceSyncReplicaPreparingEvent = {
  deliveryId: 'delivery-a',
  phase: 'preparing',
  workspaceUuid: 'workspace-a',
  workspaceRoot: '/managed/workspace-a',
  remoteVersionId: 'version-b',
  affectedNotebookIds: ['notebook-updated', 'notebook-deleted'],
  affectedDesignIds: [],
};

beforeAll(async () => {
  await initPlatform();
});

afterEach(() => {
  abortWorkspaceSyncReplicaInRenderer(PREPARING);
  stopDesignArtifactMirroring();
  usePageStore.setState({ dirtyIds: new Set() });
  useSequenceStore.setState({ dirtyPaths: {} });
  useDesignStore.setState({ designs: {}, activeDesignId: null });
  useToastStore.getState().clearToasts();
});

function design(id: string, name: string): SequenceDesign {
  return {
    id,
    name,
    regions: [],
    spacers: [],
    topology: 'circular',
    assemblyMethod: 'gibson',
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    status: 'draft',
    validationErrors: [],
    version: 1,
    createdAt: new Date('2026-08-25T00:00:00.000Z'),
    updatedAt: new Date('2026-08-25T00:00:00.000Z'),
  } as unknown as SequenceDesign;
}

describe('refreshWorkspaceSyncReplicaInRenderer', () => {
  it('reloads current notebooks, closes deleted notebook/file tabs, and then reconciles the workspace', async () => {
    const reloadPages = vi.fn(async () => ({ missingIds: ['notebook-deleted'] }));
    const reloadSequence = vi.fn(async () => undefined);
    const clearSequence = vi.fn();
    const closeTab = vi.fn();
    const reconcileWorkspace = vi.fn();

    await refreshWorkspaceSyncReplicaInRenderer(EVENT, {
      reloadPages,
      sequenceDocumentIdForPath: (path) =>
        path.endsWith('changed.gb')
          ? 'fixture:sequence:changed'
          : path.endsWith('deleted.gb')
            ? 'fixture:sequence:deleted'
            : null,
      isSequenceLoaded: (documentId) => documentId === 'fixture:sequence:changed',
      reloadSequence,
      clearSequence,
      getPanels: () => [
        {
          id: 'main',
          tabs: [
            { id: 'updated-page-tab', entityId: 'notebook-updated' },
            { id: 'deleted-page-tab', entityId: 'notebook-deleted' },
            { id: 'deleted-file-tab', entityId: 'fixture:sequence:deleted' },
            { id: 'survivor-tab', entityId: 'fixture:sequence:changed' },
          ],
        },
      ],
      closeTab,
      reconcileWorkspace: async (workspaceRoot, mutationToken) =>
        reconcileWorkspace(workspaceRoot, mutationToken),
    });

    expect(reloadPages).toHaveBeenCalledWith(['notebook-updated', 'notebook-deleted']);
    expect(reloadSequence).toHaveBeenCalledWith(
      'fixture:sequence:changed',
      '/managed/workspace-a/changed.gb'
    );
    expect(clearSequence).toHaveBeenCalledWith('fixture:sequence:deleted');
    expect(closeTab.mock.calls).toEqual([
      ['main', 'deleted-page-tab'],
      ['main', 'deleted-file-tab'],
    ]);
    expect(reconcileWorkspace).toHaveBeenCalledWith('/managed/workspace-a', 'mutation-token-a');
    expect(reconcileWorkspace.mock.invocationCallOrder[0]).toBeGreaterThan(
      reloadPages.mock.invocationCallOrder.at(-1) ?? 0
    );
  });

  it('does not treat a notebook query failure as a confirmed deletion', async () => {
    const closeTab = vi.fn();
    const reconcileWorkspace = vi.fn();
    await expect(
      refreshWorkspaceSyncReplicaInRenderer(EVENT, {
        reloadPages: async () => {
          throw new Error('database unavailable');
        },
        sequenceDocumentIdForPath: () => null,
        isSequenceLoaded: () => false,
        reloadSequence: async () => undefined,
        clearSequence: vi.fn(),
        getPanels: () => [{ id: 'main', tabs: [{ id: 'page-tab', entityId: 'notebook-updated' }] }],
        closeTab,
        reconcileWorkspace: async (root) => reconcileWorkspace(root),
      })
    ).rejects.toThrow('database unavailable');
    expect(closeTab).not.toHaveBeenCalled();
    expect(reconcileWorkspace).not.toHaveBeenCalled();
  });

  it('hydrates changed designs, removes deleted designs, and does not schedule an echo mirror', async () => {
    const changedPath = '/managed/workspace-a/updated.wpdesign.json';
    useDesignStore.setState({
      designs: {
        'design-updated': design('design-updated', 'Old local'),
        'design-deleted': design('design-deleted', 'Delete me'),
      },
      activeDesignId: 'design-updated',
    });
    startDesignArtifactMirroring();
    setMockFileContent(
      changedPath,
      JSON.stringify({
        schema: 'waypoint.design.v1',
        kind: 'assembly-design',
        id: 'design-updated',
        name: 'Remote',
        design: design('design-updated', 'Remote'),
      })
    );
    const preparing = {
      ...PREPARING,
      affectedNotebookIds: [],
      affectedDesignIds: ['design-updated', 'design-deleted'],
    };
    const applied = {
      ...EVENT,
      changedPaths: [changedPath],
      deletedPaths: ['/managed/workspace-a/deleted.wpdesign.json'],
      affectedNotebookIds: [],
      affectedDesignIds: ['design-updated', 'design-deleted'],
      deletedDesignIds: ['design-deleted'],
    };

    prepareWorkspaceSyncReplicaInRenderer(preparing);
    await handleWorkspaceSyncReplicaLifecycleWithStores(applied);

    expect(useDesignStore.getState().designs['design-updated']?.name).toBe('Remote');
    expect(useDesignStore.getState().designs['design-deleted']).toBeUndefined();
    expect(hasPendingDesignArtifactMirror(['design-updated'])).toBe(false);
  });

  it('releases an aborted replica barrier and reschedules the unchanged local design', async () => {
    useDesignStore.setState({
      designs: { 'design-local': design('design-local', 'Local') },
      activeDesignId: 'design-local',
    });
    startDesignArtifactMirroring();
    const preparing = {
      ...PREPARING,
      affectedNotebookIds: [],
      affectedDesignIds: ['design-local'],
    };

    prepareWorkspaceSyncReplicaInRenderer(preparing);
    await handleWorkspaceSyncReplicaLifecycleWithStores({
      deliveryId: preparing.deliveryId,
      phase: 'aborted',
      workspaceUuid: preparing.workspaceUuid,
      workspaceRoot: preparing.workspaceRoot,
      remoteVersionId: preparing.remoteVersionId,
    });

    expect(hasPendingDesignArtifactMirror(['design-local'])).toBe(true);
  });

  it.each(['empty', 'legacy-scoped'] as const)(
    'refreshes a valid %s design without keeping stale local content',
    async (variant) => {
      const id = 'design-restored';
      const path = '/managed/workspace-a/restored.wpdesign.json';
      useDesignStore.setState({ designs: { [id]: design(id, 'Stale') }, activeDesignId: id });
      startDesignArtifactMirroring();
      setMockFileContent(
        path,
        JSON.stringify({
          schema: 'waypoint.design.v1',
          kind: 'assembly-design',
          id: variant === 'legacy-scoped' ? `old-scope::${id}` : id,
          design: variant === 'empty' ? null : design(`old-scope::${id}`, 'Restored'),
        })
      );
      const preparing = { ...PREPARING, affectedNotebookIds: [], affectedDesignIds: [id] };
      prepareWorkspaceSyncReplicaInRenderer(preparing);
      await handleWorkspaceSyncReplicaLifecycleWithStores({
        ...EVENT,
        affectedNotebookIds: [],
        affectedDesignIds: [id],
        changedPaths: [path],
        deletedPaths: [],
        deletedDesignIds: [],
      });
      if (variant === 'empty') expect(useDesignStore.getState().designs[id]).toBeUndefined();
      else expect(useDesignStore.getState().designs[id]).toMatchObject({ id, name: 'Restored' });
      expect(useDesignStore.getState().designs[`old-scope::${id}`]).toBeUndefined();
      expect(hasPendingDesignArtifactMirror([id])).toBe(false);
    }
  );

  it('shows a durable warning after applying a replica with inert legacy LIMS files', async () => {
    const preparing = {
      ...PREPARING,
      affectedNotebookIds: [],
      affectedDesignIds: [],
    };
    prepareWorkspaceSyncReplicaInRenderer(preparing);

    await handleWorkspaceSyncReplicaLifecycleWithStores({
      ...EVENT,
      changedPaths: [],
      deletedPaths: [],
      affectedNotebookIds: [],
      affectedDesignIds: [],
      deletedDesignIds: [],
      warnings: [userMessage('sync.legacyDataKept')],
    });

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message: userMessage('sync.legacyDataKept'),
        type: 'warning',
        duration: 0,
      }),
    ]);
  });

  it('freezes input before acknowledging preparation and releases only on abort', () => {
    const pageRoot = document.createElement('div');
    pageRoot.dataset.pageId = 'notebook-updated';
    const focused = document.createElement('input');
    pageRoot.append(focused);
    document.body.append(pageRoot);
    focused.focus();
    expect(document.activeElement).toBe(focused);

    prepareWorkspaceSyncReplicaInRenderer(PREPARING);
    expect(document.activeElement).not.toBe(focused);
    const blocked = new Event('beforeinput', { bubbles: true, cancelable: true });
    focused.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    abortWorkspaceSyncReplicaInRenderer(PREPARING);
    const released = new Event('beforeinput', { bubbles: true, cancelable: true });
    focused.dispatchEvent(released);
    expect(released.defaultPrevented).toBe(false);
    pageRoot.remove();
  });

  it('releases the input freeze when an applied lifecycle refresh fails', async () => {
    prepareWorkspaceSyncReplicaInRenderer(PREPARING);
    usePageStore.setState({ dirtyIds: new Set(['notebook-updated']) });

    await expect(handleWorkspaceSyncReplicaLifecycleWithStores(EVENT)).rejects.toThrow(
      'unsaved renderer state'
    );

    const released = new Event('beforeinput', { bubbles: true, cancelable: true });
    document.dispatchEvent(released);
    expect(released.defaultPrevented).toBe(false);
  });

  it('does not blur or block a dirty notebook from another workspace', () => {
    const otherPage = document.createElement('div');
    otherPage.dataset.pageId = 'notebook-other-workspace';
    const input = document.createElement('input');
    otherPage.append(input);
    document.body.append(otherPage);
    input.focus();
    usePageStore.setState({ dirtyIds: new Set(['notebook-other-workspace']) });

    expect(() => prepareWorkspaceSyncReplicaInRenderer(PREPARING)).not.toThrow();
    expect(document.activeElement).toBe(input);
    const usable = new Event('beforeinput', { bubbles: true, cancelable: true });
    input.dispatchEvent(usable);
    expect(usable.defaultPrevented).toBe(false);

    otherPage.remove();
  });

  it('blocks pointer-driven formatting inside an affected notebook', () => {
    const pageRoot = document.createElement('div');
    pageRoot.dataset.pageId = 'notebook-updated';
    const formattingButton = document.createElement('button');
    pageRoot.append(formattingButton);
    document.body.append(pageRoot);

    prepareWorkspaceSyncReplicaInRenderer(PREPARING);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    formattingButton.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    pageRoot.remove();
  });

  it('rejects preparation when an editor is already dirty and leaves input usable', () => {
    usePageStore.setState({ dirtyIds: new Set(['notebook-updated']) });
    expect(() => prepareWorkspaceSyncReplicaInRenderer(PREPARING)).toThrow('unsaved changes');
    const input = new Event('beforeinput', { bubbles: true, cancelable: true });
    document.dispatchEvent(input);
    expect(input.defaultPrevented).toBe(false);
  });

  it('rejects preparation while an affected design mirror is still pending', () => {
    startDesignArtifactMirroring();
    useDesignStore.setState({
      designs: { 'design-updated': design('design-updated', 'Local pending') },
      activeDesignId: 'design-updated',
    });

    expect(() =>
      prepareWorkspaceSyncReplicaInRenderer({
        ...PREPARING,
        affectedNotebookIds: [],
        affectedDesignIds: ['design-updated'],
      })
    ).toThrow('unsaved changes');
  });
});
