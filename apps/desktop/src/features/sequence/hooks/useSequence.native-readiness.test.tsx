import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSequence } from './useSequence';
import { useSequenceStore } from '../store';
import {
  getNativeSequenceDocumentClient,
  installNativeSequenceDocumentClient,
  SequenceDocumentClientBridge,
} from '../sequence-document-client';
import { setSequenceClientPort } from '../sequence-client-port';
import { notifyWorkspaceReconciled } from '../../../services/workspace-reconciled-event';
import {
  NativeSequenceWorkingCopyOwner,
  type NativeSequenceRecord,
} from '../../../main/native-sequence-working-copy';

const native = vi.hoisted(() => ({
  available: vi.fn().mockResolvedValue(false),
  execute: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: {
      isSequenceDocumentAvailable: native.available,
      sequenceDocument: native.execute,
      subscribeSequenceDocuments: native.subscribe,
    },
  }),
}));
vi.mock('../../../hooks/useFileContent', () => ({
  useFileContent: () => ({
    sequence: null,
    acceptedRevision: null,
    loading: false,
    error: null,
    errorClass: null,
    reload: async () => {},
  }),
}));
vi.mock('../../canvas/public/store', () => ({
  useCanvasStore: (select: (state: { panels: Record<string, never> }) => unknown) =>
    select({ panels: {} }),
}));

let detach = () => {};
afterEach(() => {
  detach();
  useSequenceStore.getState().clearAll();
  vi.clearAllMocks();
  native.available.mockReset().mockResolvedValue(false);
  native.execute.mockReset();
  native.subscribe.mockReset().mockImplementation(() => () => {});
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

it.each([
  { label: 'existing sequence', bases: 'AAAACCCC', inFlight: false },
  { label: 'zero-base sequence', bases: '', inFlight: false },
  { label: 'reconciliation during an unavailable load', bases: 'AAAACCCC', inFlight: true },
])(
  'hydrates a cached promoted sequence after durable catalog reconciliation: $label',
  async ({ bases, inFlight }) => {
    const id = `quicklook-promoted-${bases.length}`;
    const sequence = {
      id,
      name: 'Quick Look',
      sequence: bases,
      length: bases.length,
      circular: false,
      annotations: [],
      metadata: {},
    };
    const records = new Map<string, NativeSequenceRecord>();
    const scope = {
      documentId: id,
      path: '/managed/pUC19/source.gb',
      workspaceRoot: '/managed',
      managed: true,
      readOnly: false,
      assertCurrent() {},
    };
    const owner = new NativeSequenceWorkingCopyOwner({
      resolve: async () => ({ ...scope, captureForSave: () => scope }),
      load: async () => ({ sequence, sha256: `sha256:${'0'.repeat(64)}` }),
      readSha256: async () => `sha256:${'0'.repeat(64)}`,
      save: async () => {
        throw new Error('Unexpected file Save');
      },
      loadRecord: async (documentId) => records.get(documentId),
      storeRecord: async (record) => {
        records.set(record.documentId, record);
      },
    });
    native.execute.mockImplementation((request) => owner.execute(request));
    native.subscribe.mockImplementation((listener) => owner.subscribe(listener));
    let release = () => {};
    if (inFlight)
      native.available.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(false);
          })
      );
    useSequenceStore.getState().setSequence(id, sequence);
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    detach = installNativeSequenceDocumentClient(useSequenceStore);
    const bridge = getNativeSequenceDocumentClient()!;
    if (inFlight) await vi.waitFor(() => expect(native.available).toHaveBeenCalledOnce());
    else await bridge.flush();
    const hook = renderHook(({ path }) => useSequence(path, id), {
      initialProps: { path: '/quick-look/pUC19/source.gb' },
    });
    try {
      expect(hook.result.current.data?.sequence).toBe(bases);
      expect(hook.result.current.editingPending).toBe(true);
      expect(native.execute).not.toHaveBeenCalled();
      if (!inFlight) {
        await act(async () => {
          notifyWorkspaceReconciled(scope.workspaceRoot);
          await bridge.flush();
        });
        expect(hook.result.current.editingPending).toBe(true);
        expect(native.execute).not.toHaveBeenCalled();
      }
      native.available.mockResolvedValue(true);
      hook.rerender({ path: scope.path });
      await act(async () => {
        notifyWorkspaceReconciled(scope.workspaceRoot);
        release();
        await bridge.flush();
      });
      expect(hook.result.current.editingPending).toBe(false);
      expect(native.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: id,
          operation: expect.objectContaining({ kind: 'inspect' }),
        })
      );
      expect(native.execute).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: id, operation: { kind: 'reload' } })
      );
      expect(() => bridge.assertInput(id)).not.toThrow();
      await act(async () => {
        useSequenceStore.getState().dispatchEdit(id, { type: 'INSERT', text: 'G' });
        await bridge.flush();
      });
      expect(hook.result.current.data?.sequence).toBe(`G${bases}`);
    } finally {
      release();
      hook.unmount();
      detach();
      detach = () => {};
      await owner.close();
    }
  }
);

it('does not reconnect a retired native client after a later reconciliation', async () => {
  const id = 'quicklook-retired-client';
  useSequenceStore.getState().setSequence(id, {
    id,
    name: 'Quick Look',
    sequence: 'AAAA',
    length: 4,
    circular: false,
    annotations: [],
    metadata: {},
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
  detach = installNativeSequenceDocumentClient(useSequenceStore);
  const bridge = getNativeSequenceDocumentClient()!;
  await bridge.flush();
  detach();
  detach = () => {};
  native.available.mockClear().mockResolvedValue(true);
  notifyWorkspaceReconciled('/managed');
  await bridge.flush();
  expect(native.available).not.toHaveBeenCalled();
  expect(native.execute).not.toHaveBeenCalled();
  expect(bridge.owns(id)).toBe(false);
  expect(getNativeSequenceDocumentClient()).toBeUndefined();
});

it('keeps cached sequence data visible while withholding editing until a native snapshot exists', async () => {
  const id = 'quicklook-cached-native-pending';
  const sequence = {
    id,
    name: 'Quick Look',
    sequence: 'AAAACCCC',
    length: 8,
    circular: false,
    annotations: [],
    metadata: {},
  };
  useSequenceStore.getState().setSequence(id, sequence);
  const bridge = new SequenceDocumentClientBridge(useSequenceStore);
  detach = setSequenceClientPort(bridge);
  bridge.refreshAvailableDocuments();
  await bridge.flush();
  expect(useSequenceStore.getState().isLoading(id)).toBe(false);
  expect(() => bridge.assertInput(id)).toThrow('SEQUENCE_DOCUMENT_NOT_READY');
  const hook = renderHook(() => useSequence('/quick-look/pUC19.gb', id));
  try {
    expect(hook.result.current.data?.sequence).toBe(sequence.sequence);
    expect(hook.result.current.isLoading).toBe(false);
    expect(hook.result.current.editingPending).toBe(true);
    expect(native.execute).not.toHaveBeenCalled();
  } finally {
    hook.unmount();
  }
});
