import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';
const state = vi.hoisted(() => ({
  bytes: new Uint8Array([1, 1, 1]),
  indexed: new Uint8Array([1, 1, 1]),
  index: vi.fn(),
  read: vi.fn(),
  proof: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    workspace: { indexManagedCatalogHead: state.index },
    fs: { exists: async () => false, readFileBounded: state.read },
  }),
}));
vi.mock('../../services/read-accepted-scientific-file', () => ({
  readAcceptedScientificFile: async () => null,
}));
vi.mock('../../services/acknowledged-sequence-read', () => ({
  canReadAcknowledgedSequence: state.proof,
}));
import {
  closeElectronWorkspaceSessionFile,
  electronWorkspaceSessionController as controller,
  openElectronWorkspaceSessionFile,
} from './electron-session';
const previous = useWorkspaceStore.getState();
beforeEach(async () => {
  vi.clearAllMocks();
  state.bytes = new Uint8Array([1, 1, 1]);
  state.indexed = state.bytes;
  state.index.mockImplementation(async () => ({
    headCommit: 'old-head',
    files: [
      {
        relPath: 'sequence.gb',
        oid: createHash('sha1')
          .update(`blob ${state.indexed.length}\0`)
          .update(state.indexed)
          .digest('hex'),
        sizeBytes: state.indexed.length,
        modifiedAt: 1,
      },
    ],
  }));
  state.read.mockImplementation(async (_path: string, maxBytes: number) => {
    if (state.bytes.length > maxBytes) throw new Error('File exceeds the bounded read.');
    return state.bytes.slice();
  });
  state.proof.mockResolvedValue(false);
  useWorkspaceStore.setState({
    folders: [{ path: '/workspace', name: 'Project', addedAt: 1, mountRequest: 1 }],
    selectedPath: '/workspace/sequence.gb',
  });
  await controller.initialize('/workspace');
  state.index.mockClear();
});
afterEach(() => {
  useWorkspaceStore.setState({ folders: previous.folders, selectedPath: previous.selectedPath });
});
it('lets only an exact pending acknowledgement use the existing presenter without claiming that old Git HEAD accepted its bytes', async () => {
  state.bytes = new Uint8Array([2, 2, 2, 2]);
  state.proof.mockResolvedValue(true);
  await expect(openElectronWorkspaceSessionFile('/workspace/sequence.gb')).resolves.toBeNull();
  expect(state.proof).toHaveBeenCalledExactlyOnceWith('/workspace/sequence.gb');
  expect(state.read).not.toHaveBeenCalled();
  expect(state.index).not.toHaveBeenCalled();
  expect(controller.getState().openFiles).toHaveLength(0);
});
it('retains current Git snapshot and bounded-byte verification when the acknowledgement proof refuses', async () => {
  state.bytes = new Uint8Array([2, 2, 2, 2]);
  await expect(openElectronWorkspaceSessionFile('/workspace/sequence.gb')).rejects.toThrow(
    'bounded read'
  );
  expect(state.index).toHaveBeenCalled();
  expect(state.read).toHaveBeenCalledWith('/workspace/sequence.gb', 3);
  expect(controller.getState().openFiles).toHaveLength(0);
});
it('refuses a newer mount that supersedes a deferred acknowledged read proof', async () => {
  let release!: (value: boolean) => void;
  state.proof.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      })
  );
  const pending = openElectronWorkspaceSessionFile('/workspace/sequence.gb');
  const rejected = expect(pending).rejects.toThrow('project changed');
  await vi.waitFor(() => expect(state.proof).toHaveBeenCalledOnce());
  useWorkspaceStore.setState({
    folders: [{ path: '/workspace', name: 'Newer project', addedAt: 2, mountRequest: 2 }],
  });
  release(true);
  await rejected;
  expect(state.read).not.toHaveBeenCalled();
  expect(controller.getState().openFiles).toHaveLength(0);
});

it.each([true, false])(
  'verifies overlapping file opens against their owning mounted projects (first file matches Git: %s)',
  async (matchesGit) => {
    useWorkspaceStore.setState({
      folders: [
        { path: '/workspace', name: 'First', addedAt: 1, mountRequest: 1 },
        { path: '/other', name: 'Second', addedAt: 2, mountRequest: 2 },
      ],
    });
    await controller.initialize('/workspace');

    let release!: (acknowledged: boolean) => void;
    state.proof.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    const first = openElectronWorkspaceSessionFile('/workspace/sequence.gb');
    await vi.waitFor(() => expect(state.proof).toHaveBeenCalledWith('/workspace/sequence.gb'));
    await expect(openElectronWorkspaceSessionFile('/other/sequence.gb')).resolves.toBe(
      'sequence.gb'
    );
    if (!matchesGit) state.bytes = new Uint8Array([9, 9, 9]);
    release(false);
    if (matchesGit) await expect(first).resolves.toBeNull();
    else
      await expect(first).rejects.toThrow(
        'Local file changed before it could be opened: sequence.gb.'
      );

    expect(state.read).toHaveBeenCalledWith('/workspace/sequence.gb', 3);
    expect(state.read).toHaveBeenCalledWith('/other/sequence.gb', 3);
    expect(controller.getState().activeWorkspaceId).toBe('/other');
    closeElectronWorkspaceSessionFile('sequence.gb', '/workspace/sequence.gb');
    expect(controller.getState().openFiles).toHaveLength(1);
    closeElectronWorkspaceSessionFile('sequence.gb', '/other/sequence.gb');
    expect(controller.getState().openFiles).toHaveLength(0);
  }
);
