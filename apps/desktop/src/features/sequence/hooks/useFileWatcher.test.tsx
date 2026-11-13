import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import {
  WorkspaceSessionController,
  type WorkspaceSessionAdapter,
  type WorkspaceSessionSnapshot,
} from '@waypoint/domain-services';
import { useSequenceStore } from '../store';
import { useFileWatcher } from './useFileWatcher';
import { emitHostedFileChanged } from '../../../hosted/events';
import { hostedDocumentIdentity } from '../../../hosted/document-identity';

const { readTextFile, hostedState } = vi.hoisted(() => ({
  readTextFile: vi.fn(),
  hostedState: {
    value: null as unknown as Record<string, unknown>,
    controller: null as WorkspaceSessionController | null,
  },
}));

vi.mock('../../../platform', async () => {
  const { subscribeHostedFileChanged } = await import('../../../hosted/events');
  return {
    platform: () => ({
      fs: {
        readTextFile,
        readFile: vi.fn(),
        watchFile: vi.fn(async () => {}),
        unwatchFile: vi.fn(async () => {}),
      },
      on: (event: string, listener: (...args: unknown[]) => void) =>
        event === 'file-changed' ? subscribeHostedFileChanged(listener) : () => {},
    }),
  };
});
vi.mock('../../../db/workspace-catalog', () => ({ findWorkspaceRootForPath: () => '/managed' }));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: [] }) },
}));
vi.mock('../../../hosted/controller', () => ({
  hostedWorkspaceSessionController: {
    getState: () => hostedState.controller?.getState() ?? hostedState.value,
    subscribe: (listener: () => void) => hostedState.controller?.subscribe(listener) ?? (() => {}),
  },
}));

const documentId = 'sequence-document-async-reload';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const filePath = `/hosted/${workspaceId}/sequences/construct.gb`;
const original: AnnotatedSequence = {
  id: documentId,
  name: 'construct',
  sequence: 'ACGTACGT',
  length: 8,
  annotations: [],
  circular: false,
};
const genbank = 'LOCUS       construct 8 bp DNA linear\nORIGIN\n        1 ttttacgt\n//\n';

function mount() {
  const onReload = vi.fn();
  const hook = renderHook(() =>
    useFileWatcher({
      filePath,
      documentId,
      isDirty: useSequenceStore((state) => state.dirtyPaths[documentId] === true),
      onReload,
    })
  );
  return { ...hook, onReload };
}
function deferredRead() {
  let resolve!: (value: string) => void;
  readTextFile.mockImplementation(
    () =>
      new Promise<string>((accept) => {
        resolve = accept;
      })
  );
  return { resolve: (value = genbank) => resolve(value) };
}
function type(text: string) {
  useSequenceStore.getState().dispatchEdit(documentId, { type: 'INSERT', text });
}

beforeEach(() => {
  delete document.documentElement.dataset.dnaforgeRuntime;
  readTextFile.mockReset();
  hostedState.controller = null;
  useSequenceStore.getState().clearAll();
  useSequenceStore.getState().setSequence(documentId, original);
  hostedState.value = {
    principal: { id: 'actor-a' },
    activeWorkspaceId: workspaceId,
    workspaces: [{ workspaceId, clientWorkspaceId: 'client-workspace' }],
    snapshot: {
      workspaceId,
      revisionId: 'accepted-one',
      revisionNumber: 1,
      files: [
        {
          path: 'sequences/construct.gb',
          resourceId: 'file-id',
          contentRevision: 'sha256:old',
          contentSha256: 'old',
          sizeBytes: 8,
          contentType: 'application/genbank',
        },
      ],
    },
  };
});

describe('sequence watcher asynchronous reload ownership', () => {
  it('keeps concurrent clean reloads clean rather than inventing unsaved edits', async () => {
    const reads: Array<(content: string) => void> = [];
    readTextFile.mockImplementation(() => new Promise<string>((resolve) => reads.push(resolve)));
    const hook = mount();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.result.current.reloadFromDisk();
      second = hook.result.current.reloadFromDisk();
    });
    await waitFor(() => expect(readTextFile).toHaveBeenCalledTimes(2));
    await act(async () => {
      reads[1]!(genbank);
      await second;
    });
    await act(async () => {
      reads[0]!(genbank);
      await first;
    });
    expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('ttttacgt');
    expect(useSequenceStore.getState().dirtyPaths[documentId]).not.toBe(true);
    expect(hook.result.current.showExternalChangeToast).toBe(false);
    expect(hook.onReload).toHaveBeenCalledOnce();
  });

  it('reloads accepted restored bytes through the real controller, cache and parser', async () => {
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
    const relativePath = 'sequences/construct.gb';
    const bytesFor = (length: number) =>
      new TextEncoder().encode(
        `LOCUS       construct ${length} bp DNA linear\nORIGIN\n        1 ${'a'.repeat(length)}\n//\n`
      );
    const file = {
      path: relativePath,
      resourceId: 'file-id',
      contentRevision: 'sha256:saved-125',
      contentSha256: 'saved-125',
      sizeBytes: bytesFor(125).byteLength,
      contentType: 'application/genbank',
    };
    const saved: WorkspaceSessionSnapshot = {
      workspaceId,
      revisionId: 'accepted-two',
      revisionNumber: 2,
      files: [file],
    };
    const restored: WorkspaceSessionSnapshot = {
      ...saved,
      revisionId: 'accepted-three',
      revisionNumber: 3,
      files: [
        {
          ...file,
          contentRevision: 'sha256:restored-120',
          contentSha256: 'restored-120',
          sizeBytes: bytesFor(120).byteLength,
        },
      ],
    };
    let releaseReadBack!: () => void;
    const readBackPending = new Promise<void>((resolve) => {
      releaseReadBack = resolve;
    });
    let restoringReads = 0;
    const adapter: WorkspaceSessionAdapter = {
      descriptor: {
        kind: 'hosted-browser',
        authority: 'dnaforge-manifest-revisions',
        identityFidelity: 'stable-resource-id',
        capabilities: {
          createWorkspace: true,
          multiFile: true,
          write: true,
          rename: true,
          move: true,
          delete: true,
          watch: true,
          history: true,
          restore: true,
        },
      },
      listWorkspaces: async () => ({
        principal: { id: 'actor-a', label: 'Scientist' },
        workspaces: [
          {
            workspaceId,
            clientWorkspaceId: 'client-workspace',
            displayName: 'Restore fixture',
            latestRevisionId: saved.revisionId,
            latestRevisionNumber: 2,
          },
        ],
      }),
      createWorkspace: vi.fn(),
      loadWorkspace: async () => saved,
      readFile: async ({ snapshot }) => {
        if (snapshot.revisionId !== 'accepted-three') return bytesFor(125);
        restoringReads += 1;
        if (restoringReads === 1) await readBackPending;
        return bytesFor(120);
      },
      commit: vi.fn(),
      listHistory: async () => [
        {
          revisionId: 'accepted-one',
          revisionNumber: 1,
          createdAt: '2026-10-05T00:00:00Z',
          fileCount: 1,
          sizeBytes: bytesFor(120).byteLength,
        },
      ],
      restoreRevision: async () => restored,
    };
    const controller = new WorkspaceSessionController(adapter);
    hostedState.controller = controller;
    await controller.initialize(workspaceId);
    await controller.openFile(relativePath);
    await controller.loadHistory();
    useSequenceStore.getState().setSequence(documentId, {
      ...original,
      sequence: 'a'.repeat(125),
      length: 125,
    });
    readTextFile.mockImplementation(async () =>
      new TextDecoder().decode((await controller.openFile(relativePath)).bytes)
    );
    const subscriptions = vi.spyOn(controller, 'subscribe');
    const hook = mount();
    await waitFor(() => expect(subscriptions).toHaveBeenCalledOnce());
    let restoring!: ReturnType<typeof controller.restoreRevision>;
    act(() => {
      restoring = controller.restoreRevision('accepted-one');
    });
    await waitFor(() => expect(hook.onReload).toHaveBeenCalledOnce());
    const firstReload = useSequenceStore.getState().sequences[documentId];
    await act(async () => {
      releaseReadBack();
      await restoring;
      emitHostedFileChanged(filePath);
    });

    expect(firstReload?.length).toBe(120);
    expect(firstReload?.sequence).toBe('a'.repeat(120));
    await waitFor(() =>
      expect(useSequenceStore.getState().sequences[documentId]?.length).toBe(120)
    );
    expect(useSequenceStore.getState().savedSequences[documentId]?.length).toBe(120);
    expect(useSequenceStore.getState().dirtyPaths[documentId]).not.toBe(true);
    expect(hook.result.current.showExternalChangeToast).toBe(false);
    expect(controller.getState().snapshot?.revisionId).toBe('accepted-three');
    expect(hostedDocumentIdentity(filePath)).toMatchObject({
      revisionId: 'accepted-three',
      contentSha256: 'restored-120',
      resourceId: 'file-id',
    });
  });

  it('loads a still-clean document from the actual GenBank parser and publishes one reload', async () => {
    readTextFile.mockResolvedValue(genbank);
    const hook = mount();
    await act(async () => {
      await hook.result.current.reloadFromDisk();
    });
    expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('ttttacgt');
    expect(useSequenceStore.getState().dirtyPaths[documentId]).not.toBe(true);
    expect(hook.onReload).toHaveBeenCalledOnce();
  });

  it.each(['typing', 'annotation'] as const)(
    'preserves %s begun while an external read is in flight',
    async (edit) => {
      const pending = deferredRead();
      const hook = mount();
      let reading!: Promise<void>;
      act(() => {
        reading = hook.result.current.reloadFromDisk();
      });
      await waitFor(() => expect(readTextFile).toHaveBeenCalledOnce());
      act(() => {
        if (edit === 'typing') type('GG');
        else
          useSequenceStore.getState().addAnnotation(documentId, {
            name: 'my new feature',
            type: 'misc_feature',
            start: 1,
            end: 4,
            direction: 1,
          });
      });
      const before = useSequenceStore.getState().captureForSave(documentId);
      await act(async () => {
        pending.resolve();
        await reading;
      });
      expect(useSequenceStore.getState().captureForSave(documentId)).toEqual(before);
      expect(useSequenceStore.getState().dirtyPaths[documentId]).toBe(true);
      expect(hook.result.current.showExternalChangeToast).toBe(true);
      expect(hook.onReload).not.toHaveBeenCalled();
    }
  );

  it('allows an explicit reviewed discard of an unchanged dirty draft', async () => {
    act(() => type('GG'));
    readTextFile.mockResolvedValue(genbank);
    const hook = mount();
    await act(async () => {
      hook.result.current.acceptExternalChange();
    });
    await waitFor(() => expect(hook.onReload).toHaveBeenCalledOnce());
    expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('ttttacgt');
    expect(useSequenceStore.getState().dirtyPaths[documentId]).not.toBe(true);
  });

  it('asks again if the user edits after agreeing to discard the preceding draft', async () => {
    act(() => type('GG'));
    const pending = deferredRead();
    const hook = mount();
    act(() => {
      hook.result.current.acceptExternalChange();
    });
    await waitFor(() => expect(readTextFile).toHaveBeenCalledOnce());
    act(() => type('AA'));
    const before = useSequenceStore.getState().captureForSave(documentId);
    await act(async () => {
      pending.resolve();
    });
    expect(useSequenceStore.getState().captureForSave(documentId)).toEqual(before);
    expect(hook.result.current.showExternalChangeToast).toBe(true);
    expect(hook.onReload).not.toHaveBeenCalled();
  });

  it('does not roll a newer clean document back when an earlier read finishes late', async () => {
    const pending = deferredRead();
    const hook = mount();
    let reading!: Promise<void>;
    act(() => {
      reading = hook.result.current.reloadFromDisk();
    });
    await waitFor(() => expect(readTextFile).toHaveBeenCalledOnce());
    act(() =>
      useSequenceStore.getState().setSequence(documentId, { ...original, sequence: 'CCCCACGT' })
    );
    await act(async () => {
      pending.resolve();
      await reading;
    });
    expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('CCCCACGT');
    expect(hook.onReload).not.toHaveBeenCalled();
  });

  it.each(['account', 'workspace', 'local revision', 'content'] as const)(
    'discards a stale hosted read after its %s identity changes',
    async (change) => {
      document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
      expect(hostedDocumentIdentity(filePath)).not.toBeNull();
      const pending = deferredRead();
      const hook = mount();
      let reading!: Promise<void>;
      act(() => {
        reading = hook.result.current.reloadFromDisk();
      });
      await waitFor(() => expect(readTextFile).toHaveBeenCalledOnce());
      const snapshot = hostedState.value.snapshot as {
        localRevisionId?: string;
        files: { contentSha256: string }[];
      };
      if (change === 'account') hostedState.value.principal = { id: 'actor-b' };
      else if (change === 'workspace') hostedState.value.activeWorkspaceId = 'another-workspace';
      else if (change === 'local revision') snapshot.localRevisionId = 'new-local-operation';
      else snapshot.files[0]!.contentSha256 = 'new-content';
      await act(async () => {
        pending.resolve();
        await reading;
      });
      expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('ACGTACGT');
      expect(hook.onReload).not.toHaveBeenCalled();
    }
  );

  it('does not publish a read owned by an unmounted tab', async () => {
    const pending = deferredRead();
    const hook = mount();
    let reading!: Promise<void>;
    act(() => {
      reading = hook.result.current.reloadFromDisk();
    });
    await waitFor(() => expect(readTextFile).toHaveBeenCalledOnce());
    hook.unmount();
    await act(async () => {
      pending.resolve();
      await reading;
    });
    expect(useSequenceStore.getState().sequences[documentId]?.sequence).toBe('ACGTACGT');
    expect(hook.onReload).not.toHaveBeenCalled();
  });
});
