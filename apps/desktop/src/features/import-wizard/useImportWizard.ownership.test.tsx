import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportExecResult } from './execute-import-outcome';
import type { ImportFlowDeps } from './run-import-flow';

const mocks = vi.hoisted(() => ({
  folders: [{ path: '/projects/yeast' }, { path: '/projects/control' }],
  openDialog: vi.fn(),
  runImportFlow: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    on: () => () => undefined,
    dialog: { open: mocks.openDialog },
    workspace: {},
    lims: { countEntitiesByKind: vi.fn(async () => ({})) },
  }),
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: { folders: typeof mocks.folders; selectedPath: null }) => unknown) =>
      selector({ folders: mocks.folders, selectedPath: null }),
    { getState: () => ({ folders: mocks.folders, selectedPath: null }) }
  ),
}));
vi.mock('./run-import-flow', () => ({ runImportFlow: mocks.runImportFlow }));
vi.mock('../../utils/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/environment')>()),
  isBrowserOnly: () => false,
}));
vi.mock('../canvas/public', () => ({
  useCanvasStore: { getState: () => ({ openChatTab: vi.fn() }) },
}));
vi.mock('../../lib/open-external-preview', () => ({ openExternalFiles: vi.fn() }));

import { useImportWizard } from './useImportWizard';

async function completeImport(result: ImportExecResult): Promise<Record<string, unknown>[]> {
  mocks.runImportFlow.mockImplementation(async (_paths: string[], deps: ImportFlowDeps) => {
    deps.onComplete?.(result);
    return result;
  });
  const details: Record<string, unknown>[] = [];
  const listener = (event: Event): void => {
    details.push((event as CustomEvent<Record<string, unknown>>).detail);
  };
  window.addEventListener('waypoint:workspace-files-changed', listener);
  try {
    const hook = renderHook(() => useImportWizard());
    await act(() =>
      hook.result.current.openEntityImport({
        entityType: 'dna-sequences',
        destination: { kind: 'choose' },
      })
    );
    hook.unmount();
    return details;
  } finally {
    window.removeEventListener('waypoint:workspace-files-changed', listener);
  }
}

describe('native import completion workspace ownership', () => {
  beforeEach(() => {
    mocks.openDialog.mockReset();
    mocks.openDialog.mockResolvedValue(['/originals/accepted.dnas']);
    mocks.runImportFlow.mockReset();
  });

  it('reconstructs the owning project after a valid import into its nested folder', async () => {
    const destPath = '/projects/yeast/import-target/accepted';
    const details = await completeImport({
      imported: 1,
      skipped: 1,
      failed: 0,
      errors: [],
      workspaceRoot: '/projects/yeast',
      touchedRoots: ['/projects/yeast/import-target'],
      written: [{ sourcePath: '/originals/accepted.dnas', destPath }],
    });
    expect(details).toEqual([
      {
        workspaceRoot: '/projects/yeast',
        workspaceRoots: ['/projects/yeast'],
        createdNewWorkspace: false,
        createdWorkspaceName: null,
        revealPaths: [destPath],
      },
    ]);
  });

  it('deduplicates folders within one owner while retaining a different project', async () => {
    const destPath = '/projects/yeast/Experiments/2026/accepted';
    const details = await completeImport({
      imported: 3,
      skipped: 0,
      failed: 0,
      errors: [],
      workspaceRoot: '/projects/yeast/Experiments/2026',
      touchedRoots: [
        '/projects/yeast/Experiments/2026',
        '/projects/yeast/Other',
        '/projects/control/Nested',
      ],
      written: [
        { sourcePath: '/originals/accepted.dnas', destPath },
        { sourcePath: '/originals/second.dnas', destPath: '/projects/yeast/Other/second' },
        { sourcePath: '/originals/control.dnas', destPath: '/projects/control/Nested/control' },
      ],
    });
    expect(details).toHaveLength(1);
    expect(details[0].workspaceRoot).toBe('/projects/yeast');
    expect(details[0].workspaceRoots).toEqual(['/projects/yeast', '/projects/control']);
    expect(details[0].revealPaths).toEqual([
      destPath,
      '/projects/yeast/Other/second',
      '/projects/control/Nested/control',
    ]);
    expect(details.every((detail) => detail.createdNewWorkspace === false)).toBe(true);
  });

  it('retains explicit new-project mounting before that root is in the mounted store', async () => {
    const details = await completeImport({
      imported: 1,
      skipped: 0,
      failed: 0,
      errors: [],
      workspaceRoot: '/projects/yeast/new-project',
      touchedRoots: ['/projects/yeast/new-project'],
      createdNewWorkspace: true,
      createdWorkspaceName: 'New project',
      written: [
        {
          sourcePath: '/originals/accepted.dnas',
          destPath: '/projects/yeast/new-project/accepted',
        },
      ],
    });
    expect(details[0]).toMatchObject({
      workspaceRoot: '/projects/yeast/new-project',
      workspaceRoots: ['/projects/yeast/new-project'],
      createdNewWorkspace: true,
      createdWorkspaceName: 'New project',
      revealPaths: ['/projects/yeast/new-project/accepted'],
    });
  });
});
