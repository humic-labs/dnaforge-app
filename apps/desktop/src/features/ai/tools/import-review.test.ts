import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  call: vi.fn(),
  folders: [{ name: 'Admitted', path: '/ws/admitted', addedAt: 0 }],
}));
vi.mock('../../../platform', () => ({ platform: () => ({ importReview: { call: native.call } }) }));
vi.mock('../../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ folders: native.folders }) },
}));
import { createImportReviewTool, importReviewSchema } from './import-review';
import { executeImportReviewAgent } from '../../../shared/import-review-agent';
const execute = (input: unknown) =>
  executeImportReviewAgent(
    importReviewSchema.parse(input),
    { projects: () => native.folders, call: native.call }
  );

beforeEach(() => {
  native.call.mockReset();
  native.folders = [{ name: 'Admitted', path: '/ws/admitted', addedAt: 0 }];
});

describe('import_review adapter', () => {
  it('maps a current exact project and bounded source decision into the native owner', async () => {
    native.call.mockResolvedValue({
      id: 'retained',
      revision: 'current',
      workspaceRoot: '/ws/admitted',
    });
    expect(
      await execute({
        project: 'Admitted',
        operation: {
          kind: 'prepare',
          destination: '.',
          source: { fileName: 'rows.csv', text: 'Name\nRecord', forcedKind: 'custom_material' },
        },
      })
    ).toMatchObject({ id: 'retained' });
    expect(native.call).toHaveBeenCalledWith({
      kind: 'prepare',
      workspaceRoot: '/ws/admitted',
      destinationDir: '/ws/admitted',
      source: { fileName: 'rows.csv', text: 'Name\nRecord', forcedKind: 'custom_material' },
    });
  });
  it('refuses a path outside the admitted roots and traversal before native work', async () => {
    await expect(
      execute({
        project: 'Admitted',
        operation: {
          kind: 'prepare',
          destination: '../other',
          source: { fileName: 'rows.csv', text: 'Name\nRecord' },
        },
      })
    ).rejects.toThrow('IMPORT_DESTINATION_INVALID');
    await expect(
      execute({
        project: 'Admitted',
        operation: {
          kind: 'prepare',
          source: { fileName: 'rows.csv', sourcePath: '/private/ungranted.csv' },
        },
      })
    ).rejects.toThrow('IMPORT_SOURCE_UNAVAILABLE');
    expect(native.call).not.toHaveBeenCalled();
  });
  it('does not mutate another project review or retain a closed root grant', async () => {
    native.call.mockResolvedValue({ id: 'other', revision: 'current', workspaceRoot: '/ws/other' });
    await expect(
      execute({
        project: 'Admitted',
        operation: {
          kind: 'execute',
          id: 'other',
          expectedRevision: 'current',
          command: { kind: 'cancel' },
        },
      })
    ).rejects.toThrow('IMPORT_REVIEW_PROJECT_MISMATCH');
    expect(native.call).toHaveBeenCalledTimes(1);
    native.folders = [];
    await expect(
      execute({
          project: 'Admitted',
          operation: { kind: 'prepare', source: { fileName: 'rows.csv', text: 'Name\nRecord' } },
      })
    ).rejects.toThrow('IMPORT_PROJECT_UNAVAILABLE');
  });
  it('cannot use human renderer authority as an agent transport fallback', async () => {
    expect(await createImportReviewTool(native.folders).execute!(
      importReviewSchema.parse({ project: 'Admitted', operation: { kind: 'prepare', source: { fileName: 'rows.csv', text: 'Name\nRecord' } } }),
      { toolCallId: 'native-route-required', messages: [] }
    )).toMatchObject({ ok: false, code: 'IMPORT_REVIEW_NATIVE_ROUTE_REQUIRED', stateChanged: false });
    expect(native.call).not.toHaveBeenCalled();
  });
});
