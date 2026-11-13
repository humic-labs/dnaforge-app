import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initPlatform, platform } from '../platform';
import { useDesignStore } from '../features/design/store';
import { useSequenceStore } from '../features/sequence/store';
import { useCanvasStore } from '../features/canvas';
import * as sequenceDocuments from '../features/sequence/sequence-document-repository';
import { usePageStore } from '../features/page/store';
import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import type { WorkspaceRendererMutationEvent } from '../shared/workspace-renderer-mutation';
import {
  prepareWorkspaceRendererMutation,
  abortWorkspaceRendererMutation,
  handleWorkspaceRendererMutationWithStores,
} from './workspace-renderer-mutation';
import {
  prepareWorkspaceSyncReplicaInRenderer,
  abortWorkspaceSyncReplicaInRenderer,
} from './workspace-sync-renderer-refresh';
import {
  beginWorkspaceEditorWrite,
  registerWorkspaceEditorBlocker,
} from './workspace-editor-mutation-state';

const ownerMocks = vi.hoisted(() => ({ runWorkspaceReconcileOperation: vi.fn() }));
vi.mock('./workspace-operations', () => ({
  runWorkspaceReconcileOperation: ownerMocks.runWorkspaceReconcileOperation,
}));

const PREPARING: Extract<WorkspaceRendererMutationEvent, { phase: 'preparing' }> = {
  deliveryId: 'replica-delivery',
  phase: 'preparing',
  workspaceRoot: '/managed/shared-root',
  source: { kind: 'cloud-sync', workspaceUuid: 'workspace-1', remoteVersionId: 'version-1' },
  affectedNotebookIds: ['note-1'],
  affectedDesignIds: [],
  affectedEntityIds: ['note-1', 'record-1'],
};
beforeAll(async () => {
  await initPlatform();
});
afterEach(() => {
  abortWorkspaceRendererMutation(PREPARING);
  abortWorkspaceSyncReplicaInRenderer({
    deliveryId: 'cloud-delivery',
    workspaceUuid: 'cloud-uuid',
  });
  usePageStore.setState({ dirtyIds: new Set() });
  useSequenceStore.getState().clearAll();
  useCanvasStore.setState({ panels: { main: { id: 'main', tabs: [], activeTabId: null } } });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
describe('shared workspace renderer mutation protection', () => {
  it('blocks editing an unresolved-owner notebook while its writes would be frozen', () => {
    const unregister = registerWorkspaceEditorBlocker(() => ({
      entityId: 'unresolved-page',
      state: 'clean',
    }));
    const editor = document.createElement('input');
    editor.dataset.pageId = 'unresolved-page';
    document.body.append(editor);
    prepareWorkspaceRendererMutation(PREPARING);
    const typing = new Event('beforeinput', { bubbles: true, cancelable: true });
    try {
      editor.dispatchEvent(typing);
      expect(typing.defaultPrevented).toBe(true);
    } finally {
      unregister();
    }
  });
  it('does not revive a sequence when its delayed read resolves after recovery release', async () => {
    const path = PREPARING.workspaceRoot + '/sequence.fasta';
    const ref = { kind: 'catalog-sequence', entityId: 'sequence-1' } as const;
    vi.spyOn(sequenceDocuments, 'resolveSequenceDocument').mockResolvedValue({
      ref,
      documentId: ref.entityId,
      sourcePath: path,
    });
    useCanvasStore.setState({ panels: { main: { id: 'main', tabs: [], activeTabId: null } } });
    useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: ref.entityId,
      label: 'Sequence',
      sequenceDocument: ref,
    });
    useSequenceStore.getState().setSequence(ref.entityId, {
      name: 'Original',
      sequence: 'ATGC',
      length: 4,
      circular: false,
      annotations: [],
    });
    const prepare = {
      ...PREPARING,
      affectedEntityIds: [...PREPARING.affectedEntityIds, ref.entityId],
    };
    await handleWorkspaceRendererMutationWithStores(prepare);
    const started = Promise.withResolvers<void>();
    const read = Promise.withResolvers<string>();
    vi.spyOn(platform().fs, 'readTextFile').mockImplementation(async () => {
      started.resolve();
      return read.promise;
    });
    const applying = handleWorkspaceRendererMutationWithStores({
      ...prepare,
      phase: 'applied',
      mutationToken: 'token',
      changedPaths: [path],
      deletedPaths: [],
      deletedEntityIds: [],
      deletedDesignIds: [],
    });
    const rejected = expect(applying).rejects.toThrow(/superseded/);
    await started.promise;
    await handleWorkspaceRendererMutationWithStores({
      ...prepare,
      phase: 'released',
      disposition: 'needs-recovery',
    });
    read.resolve('>Late result\nTTTT\n');
    await rejected;
    expect(useSequenceStore.getState().hasSequence(ref.entityId)).toBe(false);
    expect(useCanvasStore.getState().panels.main.tabs).toEqual([]);
  });
  it.each([false, true])(
    'does not publish a late design read after recovery release (new delivery: %s)',
    async (replace) => {
      const prepare = {
        ...PREPARING,
        affectedDesignIds: ['design-1'],
        affectedEntityIds: ['note-1', 'design-1'],
      };
      prepareWorkspaceRendererMutation(prepare);
      const readStarted = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<string>();
      vi.spyOn(platform().fs, 'readTextFile').mockImplementation(async () => {
        readStarted.resolve();
        return pending.promise;
      });
      const upsert = vi.spyOn(useDesignStore.getState(), 'upsertDesignFromArtifact');
      const evict = vi.spyOn(useDesignStore.getState(), 'deleteDesign');
      const applying = handleWorkspaceRendererMutationWithStores({
        ...prepare,
        phase: 'applied',
        mutationToken: 'token',
        changedPaths: [prepare.workspaceRoot + '/figure.wpdesign.json'],
        deletedPaths: [],
        deletedDesignIds: [],
        deletedEntityIds: [],
      });
      const rejected = expect(applying).rejects.toThrow(/superseded|cancelled/);
      await readStarted.promise;
      await handleWorkspaceRendererMutationWithStores({
        ...prepare,
        phase: 'released',
        disposition: 'needs-recovery',
      });
      const replacement = { ...prepare, deliveryId: 'new-delivery' };
      if (replace) prepareWorkspaceRendererMutation(replacement);
      const evictions = evict.mock.calls.length;
      pending.resolve(
        JSON.stringify({
          schema: 'waypoint.design.v1',
          kind: 'assembly-design',
          id: 'design-1',
          name: 'Old result',
          design: { id: 'design-1', name: 'Old result' },
        })
      );
      try {
        await rejected;
        expect(upsert).not.toHaveBeenCalled();
        expect(evict).toHaveBeenCalledTimes(evictions);
        if (replace)
          expect(() => beginWorkspaceEditorWrite({ entityId: 'note-1' })).toThrow(/project update/);
      } finally {
        abortWorkspaceRendererMutation(replacement);
      }
    }
  );
  it('checks registered form drafts and holds a write barrier through release', () => {
    const unregister = registerWorkspaceEditorBlocker(() => ({
      entityId: 'record-1',
      state: 'dirty',
    }));
    try {
      expect(() => prepareWorkspaceRendererMutation(PREPARING)).toThrow(/unsaved/);
    } finally {
      unregister();
      abortWorkspaceRendererMutation(PREPARING);
    }
    prepareWorkspaceRendererMutation(PREPARING);
    expect(() => beginWorkspaceEditorWrite({ entityId: 'note-1' })).toThrow(/project update/);
    abortWorkspaceRendererMutation(PREPARING);
    const finish = beginWorkspaceEditorWrite({ entityId: 'note-1' });
    finish();
  });
  it('does not let Undo and sync hold separate freezes for the same workspace root', () => {
    prepareWorkspaceRendererMutation(PREPARING);
    expect(() =>
      prepareWorkspaceSyncReplicaInRenderer({
        phase: 'preparing',
        deliveryId: 'cloud-delivery',
        workspaceUuid: 'cloud-uuid',
        workspaceRoot: PREPARING.workspaceRoot,
        remoteVersionId: 'remote-1',
        affectedNotebookIds: [],
        affectedDesignIds: [],
      })
    ).toThrow(/already/);
  });
  it('refuses dirty notebooks without leaving a generation or input freeze behind', () => {
    usePageStore.setState({ dirtyIds: new Set(['note-1']) });
    expect(() => prepareWorkspaceRendererMutation(PREPARING)).toThrow(/unsaved/);
    usePageStore.setState({ dirtyIds: new Set() });
    expect(() => prepareWorkspaceRendererMutation(PREPARING)).not.toThrow();
  });
  it('refreshes a clean cached sequence without any open view or package search', async () => {
    const documentId = 'closed-sequence';
    const sourcePath = `${PREPARING.workspaceRoot}/document.gb`;
    const before = {
      id: documentId,
      name: 'old name',
      sequence: 'ACGT',
      length: 4,
      annotations: [],
      circular: false,
      metadata: {},
    };
    useSequenceStore.getState().setSequence(documentId, before);
    useCanvasStore.setState({ panels: { main: { id: 'main', tabs: [], activeTabId: null } } });
    const read = vi
      .spyOn(platform().fs, 'readTextFile')
      .mockResolvedValue(
        serializeSequenceForInPlaceSave({ ...before, name: 'saved name' }, sourcePath)
      );
    const resolve = vi.spyOn(sequenceDocuments, 'resolveSequenceDocument');
    const event: typeof PREPARING = {
      ...PREPARING,
      affectedNotebookIds: [],
      affectedEntityIds: [documentId],
      source: { kind: 'document-command', actionId: 'action-a', documentId, sourcePath },
    };
    await handleWorkspaceRendererMutationWithStores(event);
    await handleWorkspaceRendererMutationWithStores({
      ...event,
      phase: 'applied',
      mutationToken: 'main-token',
      changedPaths: [sourcePath],
      deletedPaths: [],
      deletedEntityIds: [],
      deletedDesignIds: [],
    });
    expect(read).toHaveBeenCalledWith(sourcePath);
    expect(resolve).not.toHaveBeenCalled();
    expect(useSequenceStore.getState().getSequence(documentId)?.name).toBe('saved name');
    expect(useCanvasStore.getState().panels.main.tabs).toHaveLength(0);
  });

  it('refuses a dirty affected sequence after its last view closes', () => {
    const documentId = 'closed-sequence';
    const preparing = { ...PREPARING, affectedEntityIds: [documentId] };
    useCanvasStore.setState({ panels: { main: { id: 'main', tabs: [], activeTabId: null } } });
    useSequenceStore.getState().setSequence(documentId, {
      id: documentId,
      name: 'closed document',
      sequence: 'ACGT',
      length: 4,
      annotations: [],
      circular: false,
      metadata: {},
    });
    useSequenceStore.getState().dispatchEdit(documentId, { type: 'INSERT', text: 'A' });
    expect(() => prepareWorkspaceRendererMutation(preparing)).toThrow(/unsaved/);
    expect(useSequenceStore.getState().isDirty(documentId)).toBe(true);
    useSequenceStore.getState().discardEdits(documentId);
    expect(() => prepareWorkspaceRendererMutation(preparing)).not.toThrow();
  });
  it('blocks entity-scoped Registry and sequence surfaces even when IDs are not file paths', () => {
    const editor = document.createElement('input');
    editor.dataset.workspaceMutationEntityId = 'record-1';
    document.body.append(editor);
    prepareWorkspaceRendererMutation(PREPARING);
    const event = new Event('beforeinput', { bubbles: true, cancelable: true });
    editor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    abortWorkspaceRendererMutation(PREPARING);
    const after = new Event('beforeinput', { bubbles: true, cancelable: true });
    editor.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
  it('evicts clean stale notebooks on a recovery-required release, instead of resuming them', async () => {
    const evict = vi.spyOn(usePageStore.getState(), 'evictPages');
    prepareWorkspaceRendererMutation(PREPARING);
    await handleWorkspaceRendererMutationWithStores({
      phase: 'released',
      deliveryId: PREPARING.deliveryId,
      workspaceRoot: PREPARING.workspaceRoot,
      source: PREPARING.source,
      disposition: 'needs-recovery',
    });
    expect(evict).toHaveBeenCalledWith(['note-1']);
  });

  it('asks the owner for a strict, required rebuild under the delivery token and fails the apply when a required view does not reload', async () => {
    ownerMocks.runWorkspaceReconcileOperation.mockReset();
    const applied = {
      ...PREPARING,
      phase: 'applied' as const,
      mutationToken: 'main-capability-token',
      changedPaths: [],
      deletedPaths: [],
      deletedEntityIds: [],
      deletedDesignIds: [],
    };
    ownerMocks.runWorkspaceReconcileOperation.mockResolvedValueOnce({
      operationId: 'replica-refresh:replica-delivery',
      workspaceRoot: PREPARING.workspaceRoot,
      durable: {},
      display: { state: 'completed', participants: 1 },
    });
    await handleWorkspaceRendererMutationWithStores(PREPARING);
    await handleWorkspaceRendererMutationWithStores(applied);
    expect(ownerMocks.runWorkspaceReconcileOperation).toHaveBeenCalledOnce();
    const input = ownerMocks.runWorkspaceReconcileOperation.mock.calls[0][0];
    expect(input).toMatchObject({
      workspaceRoot: PREPARING.workspaceRoot,
      operationId: 'replica-refresh:replica-delivery',
      mutationToken: 'main-capability-token',
      strict: true,
      healManagedHead: false,
      displayDelivery: 'required',
      filesChanged: { notifyGitStatus: true },
    });
    expect(input.assertCurrent).toBeTypeOf('function');

    ownerMocks.runWorkspaceReconcileOperation.mockRejectedValueOnce(
      new Error('Required display delivery failed for /managed/shared-root: registry offline')
    );
    await handleWorkspaceRendererMutationWithStores(PREPARING);
    await expect(handleWorkspaceRendererMutationWithStores(applied)).rejects.toThrow(
      /Required display delivery failed/
    );
    const released = new Event('beforeinput', { bubbles: true, cancelable: true });
    document.dispatchEvent(released);
    expect(released.defaultPrevented).toBe(false);
  });
});
