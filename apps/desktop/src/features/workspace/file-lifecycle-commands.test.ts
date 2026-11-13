import { withUserMessage } from '@waypoint/user-messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfirmDialogStore } from '../../components/confirm-dialog-store';
import { FileLifecycleError, listFileTrash, mutateFileLifecycle } from './file-lifecycle-commands';
import { workspaceFilesOutputSchema } from '../ai/public/tools/workspace-files';
import { assertMcpOutput } from '../../test-utils/mcp-output-test-helper';

const native = vi.hoisted(() => ({ fileTrash: vi.fn(), clean: vi.fn(), lease: vi.fn() }));
vi.mock('../../platform', () => ({ platform: () => ({ shell: { fileTrash: native.fileTrash } }) }));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: (root: string, run: (token: string) => Promise<unknown>) => {
    native.lease(root);
    return run('current-native-lease');
  },
}));
vi.mock('../../services/workspace-operations', () => ({
  reconcileWorkspaceAfterFilesChanged: vi.fn(),
}));
vi.mock('../../db/workspace-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/workspace-catalog')>();
  return {
    ...actual,
    markCatalogPathMissing: vi.fn(),
    getCatalogEntityForFilePath: async () => null,
  };
});
vi.mock('./workspace-document-guards', () => ({ assertWorkspaceDocumentsClean: native.clean }));

const id = '11111111-1111-4111-8111-111111111111';
const entry = {
  id,
  originalPath: 'notes.csv',
  type: 'file',
  size: 10,
  trashedAt: '2026-10-30T20:00:00.000Z',
  revision: 'exact-current-entry',
  deletionStarted: false,
};
const purge = {
  kind: 'purge' as const,
  workspaceRoot: '/workspace',
  entryId: id,
  expectedRevision: entry.revision,
};
beforeEach(() => {
  useConfirmDialogStore.getState().resolveCurrent(false);
  native.lease.mockReset();
  native.clean.mockReset().mockResolvedValue(undefined);
  native.fileTrash
    .mockReset()
    .mockImplementation(async (request) =>
      request.kind === 'list'
        ? { kind: 'list', entries: [entry], errors: [], nextOffset: null }
        : { kind: request.kind, entryId: id, changed: true, warnings: [] }
    );
});

describe('shared human and agent file lifecycle owner', () => {
  it('describes the native recoverable entries in the agent output contract', async () => {
    const result = await listFileTrash('/workspace');
    assertMcpOutput(workspaceFilesOutputSchema, { ok: true, ...result });
    expect(result.entries).toEqual([entry]);
  });

  it('binds permanent deletion to the exact displayed entry and performs no write after denial', async () => {
    const pending = mutateFileLifecycle(purge);
    await vi.waitFor(() => expect(useConfirmDialogStore.getState().request).not.toBeNull());
    expect(useConfirmDialogStore.getState().request).toMatchObject({
      safeDefault: true,
      confirmLabel: 'Delete permanently',
    });
    expect(useConfirmDialogStore.getState().request!.message).toContain('notes.csv');
    useConfirmDialogStore.getState().resolveCurrent(false);
    expect(await pending).toBeNull();
    expect(native.fileTrash).toHaveBeenCalledTimes(1);
    expect(native.lease).not.toHaveBeenCalled();
  });

  it('passes only the confirmed identity and revision to the native owner under its current lease', async () => {
    const pending = mutateFileLifecycle(purge);
    await vi.waitFor(() => expect(useConfirmDialogStore.getState().request).not.toBeNull());
    useConfirmDialogStore.getState().resolveCurrent(true);
    const result = await pending;
    expect(result).toMatchObject({ kind: 'purge', changed: true, entryId: id });
    assertMcpOutput(workspaceFilesOutputSchema, { ok: true, ...result });
    expect(native.fileTrash).toHaveBeenLastCalledWith({
      ...purge,
      mutationToken: 'current-native-lease',
    });
  });

  it('cancels an outstanding confirmation when the operation stops', async () => {
    const controller = new AbortController();
    const pending = mutateFileLifecycle(purge, controller.signal);
    await vi.waitFor(() => expect(useConfirmDialogStore.getState().request).not.toBeNull());
    controller.abort();
    expect(await pending).toBeNull();
    expect(useConfirmDialogStore.getState().request).toBeNull();
    expect(native.fileTrash).toHaveBeenCalledTimes(1);
    expect(native.lease).not.toHaveBeenCalled();
  });

  it('refuses a dirty draft before making any native file mutation', async () => {
    native.clean.mockRejectedValue(
      withUserMessage(
        new Error('Save or discard the affected document draft first.'),
        'validation.compatible.35'
      )
    );
    const error = await mutateFileLifecycle({
      kind: 'trash',
      workspaceRoot: '/workspace',
      path: '/workspace/notes.csv',
      expectedRevision: 'source-revision',
    }).catch((error) => error);
    expect(error).toBeInstanceOf(FileLifecycleError);
    expect(error.receipt).toMatchObject({ code: 'DIRTY_FILE_DRAFT', stateChanged: false });
    expect(native.fileTrash).not.toHaveBeenCalled();
  });
});
