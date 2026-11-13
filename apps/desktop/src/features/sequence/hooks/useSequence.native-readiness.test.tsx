import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSequence } from './useSequence';
import { useSequenceStore } from '../store';
import { SequenceDocumentClientBridge } from '../sequence-document-client';
import { setSequenceClientPort } from '../sequence-client-port';

const native = vi.hoisted(() => ({
  available: vi.fn().mockResolvedValue(false),
  execute: vi.fn(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: { isSequenceDocumentAvailable: native.available, sequenceDocument: native.execute },
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
