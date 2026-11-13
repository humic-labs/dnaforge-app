import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';

const state = vi.hoisted(() => ({
  bytes: new Uint8Array([1, 1, 1]),
  head: 'first-head',
  index: vi.fn(),
  read: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    workspace: { indexManagedCatalogHead: state.index },
    fs: {
      exists: async () => false,
      readFileBounded: state.read,
    },
  }),
}));
vi.mock('../../services/read-accepted-scientific-file', () => ({
  readAcceptedScientificFile: async () => null,
}));

import {
  electronWorkspaceSessionController,
  openElectronWorkspaceSessionFile,
} from './electron-session';

const originalFolders = useWorkspaceStore.getState().folders;

beforeEach(() => {
  state.bytes = new Uint8Array([1, 1, 1]);
  state.head = 'first-head';
  state.index.mockReset().mockImplementation(async () => ({
    headCommit: state.head,
    files: [
      {
        relPath: 'sequence.gb',
        oid: createHash('sha1')
          .update(`blob ${state.bytes.byteLength}\0`)
          .update(state.bytes)
          .digest('hex'),
        sizeBytes: state.bytes.byteLength,
        modifiedAt: 1,
      },
    ],
  }));
  state.read.mockReset().mockImplementation(async (_path: string, maxBytes: number) => {
    if (state.bytes.byteLength > maxBytes) throw new Error('File exceeds the bounded read.');
    return state.bytes.slice();
  });
  useWorkspaceStore.setState({
    folders: [{ path: '/workspace', name: 'Project', addedAt: 1 }],
  });
});

afterEach(() => {
  useWorkspaceStore.setState({ folders: originalFolders });
});

it('opens a closed sequence after its native save advances the project HEAD', async () => {
  await electronWorkspaceSessionController.initialize('/workspace');
  state.bytes = new Uint8Array([2, 2, 2, 2]);
  state.head = 'native-save-head';

  await expect(openElectronWorkspaceSessionFile('/workspace/sequence.gb')).resolves.toBe(
    'sequence.gb'
  );
  const opened = electronWorkspaceSessionController.getState().openFiles[0];
  expect(opened.bytes).toEqual(state.bytes);
  expect(opened.file.sizeBytes).toBe(4);
  expect(state.read).toHaveBeenCalledWith('/workspace/sequence.gb', 4);
});

it('refreshes an externally committed existing file before verifying its bytes', async () => {
  await electronWorkspaceSessionController.initialize('/workspace');
  const prior = electronWorkspaceSessionController.getState().snapshot?.revisionId;
  state.bytes = new TextEncoder().encode('ACGTAATT');
  state.head = 'externally-committed-head';
  expect(await openElectronWorkspaceSessionFile('/workspace/sequence.gb')).toBe('sequence.gb');
  const current = electronWorkspaceSessionController.getState();
  expect(current.snapshot?.revisionId).not.toBe(prior);
  expect(current.openFiles[0].bytes).toEqual(state.bytes);
  expect(state.read).toHaveBeenLastCalledWith('/workspace/sequence.gb', state.bytes.byteLength);
});
