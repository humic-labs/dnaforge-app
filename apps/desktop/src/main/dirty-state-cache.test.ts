import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeDirtyDocument } from '../shared/native-document-drafts';
vi.mock('../shared/ipc-contract', () => ({ handleGroup: vi.fn(() => () => {}) }));
import {
  getDirtyState,
  readCurrentDirtyState,
  registerNativeDirtyStateProvider,
  setDirtyState,
} from './dirty-state-cache';

let dispose: (() => void) | undefined;
beforeEach(() => setDirtyState({ hasDirtyWork: false, details: '', dirtyItems: [] }));
afterEach(() => {
  dispose?.();
  dispose = undefined;
});
function draft(): NativeDirtyDocument {
  return {
    documentId: 'closed-file',
    target: { documentId: 'closed-file' },
    path: '/project/closed.txt',
    workspaceRoot: '/project',
    kind: 'text',
    dirty: true,
    saving: false,
    readOnly: false,
    recovery: false,
    inspectionRequired: false,
  };
}
describe('current native dirty-state projection', () => {
  it('flushes native clients and reads closed native drafts without renderer tabs', async () => {
    const calls: string[] = [];
    const provider = registerNativeDirtyStateProvider({
      subscribe: () => () => {},
      flush: async () => {
        calls.push('flush');
      },
      listDirty: async () => {
        calls.push('list');
        return [draft()];
      },
    });
    dispose = provider.dispose;
    expect(await readCurrentDirtyState()).toMatchObject({
      hasDirtyWork: true,
      details: '1 text file',
      dirtyFilePaths: ['/project/closed.txt'],
    });
    expect(calls).toEqual(['flush', 'list']);
  });
  it('invalidates from owner events without polling', async () => {
    let notify!: () => void;
    let documents: NativeDirtyDocument[] = [];
    const provider = registerNativeDirtyStateProvider({
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
      listDirty: async () => documents,
    });
    dispose = provider.dispose;
    await provider.refresh();
    expect(getDirtyState().hasDirtyWork).toBe(false);
    documents = [draft()];
    notify();
    await provider.refresh();
    expect(getDirtyState().details).toBe('1 text file');
  });
  it('keeps a failed client flush dirty even if the last native snapshot is clean', async () => {
    const provider = registerNativeDirtyStateProvider({
      subscribe: () => () => {},
      flush: async () => {
        throw new Error('Unacknowledged human input.');
      },
      listDirty: async () => [],
    });
    dispose = provider.dispose;
    expect(await readCurrentDirtyState()).toMatchObject({
      hasDirtyWork: true,
      details: 'open documents',
    });
    await provider.refresh();
    expect(getDirtyState().hasDirtyWork).toBe(true);
  });
  it('fails closed after an inventory read error and clears only after a fresh successful read', async () => {
    const listDirty = vi
      .fn<() => Promise<NativeDirtyDocument[]>>()
      .mockRejectedValueOnce(new Error('Profile unavailable.'))
      .mockResolvedValue([]);
    const provider = registerNativeDirtyStateProvider({ subscribe: () => () => {}, listDirty });
    dispose = provider.dispose;
    expect((await readCurrentDirtyState()).hasDirtyWork).toBe(true);
    expect((await readCurrentDirtyState()).hasDirtyWork).toBe(false);
  });
});
