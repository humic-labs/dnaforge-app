// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    principal: { id: 'actor-a' },
    activeWorkspaceId: '11111111-1111-4111-8111-111111111111',
    snapshot: {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      revisionId: null,
      revisionNumber: 0,
      files: [],
    },
  },
  files: [] as File[],
  begin: vi.fn(),
  end: vi.fn(),
  write: vi.fn(),
  nativeOpen: vi.fn(),
  stage: vi.fn(),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    dialog: { open: mocks.nativeOpen },
    fs: {
      beginWorkspaceMutation: mocks.begin,
      endWorkspaceMutation: mocks.end,
      writeWorkspaceBinaryFileAtomic: mocks.write,
    },
  }),
}));
vi.mock('../../../hosted/controller', () => ({
  hostedWorkspaceSessionController: { getState: () => mocks.state },
  initializeHostedWorkspaceSession: vi.fn(),
}));
vi.mock('../../../hosted/open-file-dialog', () => ({
  openHostedFileDialog: async (_options: unknown, importer: (files: File[]) => Promise<unknown>) =>
    importer(mocks.files),
}));
vi.mock('./stage-alignment-query', () => ({ stageAlignmentQueryPaths: mocks.stage }));
import '../../../hosted/import-files';
import { selectAlignmentQueryFiles } from './select-alignment-query-files';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const referencePath = `/hosted/${workspaceId}/sequences/reference/reference.gb`;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.state.principal = { id: 'actor-a' };
  mocks.state.activeWorkspaceId = workspaceId;
  mocks.state.snapshot = { workspaceId, revisionId: null, revisionNumber: 0, files: [] };
  mocks.files = [new File(['>query\nACGT\n'], 'query.fasta')];
  mocks.begin.mockResolvedValue('mutation-a');
  mocks.end.mockResolvedValue(undefined);
  mocks.write.mockResolvedValue(undefined);
  mocks.stage.mockImplementation(async (_reference: string, paths: string[]) => paths);
});

describe('alignment picker account and project scope', () => {
  it.each(['account', 'project'])(
    'rejects a %s switch while acquiring the mutation lease before importing bytes',
    async (change) => {
      let admit!: (token: string) => void;
      mocks.begin.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            admit = resolve;
          })
      );
      const selected = selectAlignmentQueryFiles(referencePath, {}).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      await vi.waitFor(() => expect(mocks.begin).toHaveBeenCalledOnce());
      if (change === 'account') mocks.state.principal = { id: 'actor-b' };
      else {
        mocks.state.activeWorkspaceId = '22222222-2222-4222-8222-222222222222';
        mocks.state.snapshot.workspaceId = mocks.state.activeWorkspaceId;
      }
      admit('mutation-a');
      expect(await selected).toMatchObject({
        error: expect.objectContaining({
          message: expect.stringMatching(/account or project changed|changed while importing/),
        }),
      });
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.stage).not.toHaveBeenCalled();
      expect(mocks.end).toHaveBeenCalledWith('mutation-a');
    }
  );

  it('rejects a project switch while reading selected bytes without any filesystem write', async () => {
    let finishRead!: (bytes: ArrayBuffer) => void;
    const read = vi.spyOn(mocks.files[0], 'arrayBuffer').mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finishRead = resolve;
        })
    );
    const selected = selectAlignmentQueryFiles(referencePath, {}).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    mocks.state.activeWorkspaceId = '22222222-2222-4222-8222-222222222222';
    mocks.state.snapshot.workspaceId = mocks.state.activeWorkspaceId;
    finishRead(new TextEncoder().encode('>query\nACGT\n').buffer);
    expect(await selected).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringMatching(/account or project changed|changed while importing/),
      }),
    });
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });

  it('imports and attaches the selected query under the same captured workspace lease', async () => {
    await selectAlignmentQueryFiles(referencePath, {});
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: `/hosted/${workspaceId}`,
        path: `/hosted/${workspaceId}/files/query.fasta`,
        mutationToken: 'mutation-a',
      })
    );
    expect(mocks.stage).toHaveBeenCalledWith(referencePath, [
      `/hosted/${workspaceId}/files/query.fasta`,
    ]);
    expect(mocks.end).toHaveBeenCalledWith('mutation-a');
  });

  it('delegates native references to the native dialog', async () => {
    mocks.nativeOpen.mockResolvedValue(['/native/query.fasta']);
    await expect(selectAlignmentQueryFiles('/native/reference.gb', {})).resolves.toEqual([
      '/native/query.fasta',
    ]);
    expect(mocks.nativeOpen).toHaveBeenCalledWith({});
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});
