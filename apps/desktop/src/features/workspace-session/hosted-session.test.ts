import type { WorkspaceSessionFile } from '@waypoint/domain-services';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { hostedWorkspaceRoot } from '../../hosted/paths';
import { SOFT_WARN_BYTES } from '../../shared/oversized-guard';
import { useWorkspaceStore } from '../../stores/workspaceStore';

const state = vi.hoisted(() => ({
  files: new Map<string, WorkspaceSessionFile[]>(),
  load: vi.fn(),
  read: vi.fn(),
}));

vi.mock('../../hosted/controller', async () => {
  const { WorkspaceSessionController } = await import('@waypoint/domain-services');
  const controller = new WorkspaceSessionController({
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
        watch: false,
        history: true,
        restore: true,
      },
    },
    listWorkspaces: async () => ({
      workspaces: [...state.files.keys()].map((workspaceId) => ({
        workspaceId,
        displayName: 'Project',
        latestRevisionId: 'accepted',
        latestRevisionNumber: 1,
      })),
    }),
    loadWorkspace: state.load,
    readFile: state.read,
    createWorkspace: async () => {
      throw new Error('Unexpected project creation');
    },
    commit: async () => {
      throw new Error('Unexpected project write');
    },
  });
  return {
    hostedWorkspaceSessionController: controller,
    initializeHostedWorkspaceSession: (id?: string | null) => controller.initialize(id),
  };
});

import {
  electronWorkspaceSessionController as controller,
  openElectronWorkspaceSessionFile,
  refreshElectronWorkspaceSessionForPath,
} from './hosted-session';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const originalFolders = useWorkspaceStore.getState().folders;

function file(path: string, sizeBytes = 3): WorkspaceSessionFile {
  return {
    path,
    sizeBytes,
    resourceId: path,
    contentRevision: 'accepted',
    contentSha256: null,
    contentType: 'application/octet-stream',
  };
}

beforeEach(async () => {
  controller.reset();
  state.files.clear();
  state.files.set(FIRST, [file('sequence.gb')]);
  state.files.set(SECOND, [file('second.gb')]);
  state.load.mockReset().mockImplementation(async ({ workspaceId }) => ({
    workspaceId,
    revisionId: 'accepted',
    revisionNumber: 1,
    files: [...(state.files.get(workspaceId) ?? [])],
  }));
  state.read.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  useWorkspaceStore.setState({
    folders: [FIRST, SECOND].map((id) => ({
      path: hostedWorkspaceRoot(id),
      name: 'Project',
      addedAt: 1,
    })),
  });
  await controller.initialize(FIRST);
  state.load.mockClear();
});

afterEach(() => {
  controller.reset();
  useWorkspaceStore.setState({ folders: originalFolders });
});

it('opens accepted browser bytes without refreshing a known file', async () => {
  await expect(
    openElectronWorkspaceSessionFile(`${hostedWorkspaceRoot(FIRST)}/sequence.gb`)
  ).resolves.toBe('sequence.gb');
  expect(state.load).not.toHaveBeenCalled();
  expect(controller.getState().openFiles[0].bytes).toEqual(new Uint8Array([1, 2, 3]));
});

it('refreshes the browser snapshot when a newly published file is missing', async () => {
  state.files.get(FIRST)!.push(file('new.gb'));
  await expect(
    openElectronWorkspaceSessionFile(`${hostedWorkspaceRoot(FIRST)}/new.gb`)
  ).resolves.toBe('new.gb');
  expect(state.load).toHaveBeenCalledTimes(1);
  expect(controller.getState().activeFilePath).toBe('new.gb');
});

it('selects the target project before reading its file', async () => {
  await expect(
    openElectronWorkspaceSessionFile(`${hostedWorkspaceRoot(SECOND)}/second.gb`)
  ).resolves.toBe('second.gb');
  expect(controller.getState().activeWorkspaceId).toBe(SECOND);
  expect(state.read.mock.calls[0][0].snapshot.workspaceId).toBe(SECOND);
});

it('leaves oversized browser files to the existing large-file path', async () => {
  state.files.get(FIRST)!.push(file('large.gb', SOFT_WARN_BYTES));
  await expect(
    openElectronWorkspaceSessionFile(`${hostedWorkspaceRoot(FIRST)}/large.gb`)
  ).resolves.toBeNull();
  expect(state.read).not.toHaveBeenCalled();
  expect(controller.getState().openFiles).toEqual([]);
});

it('refreshes only changes belonging to the active project', async () => {
  await refreshElectronWorkspaceSessionForPath(`${hostedWorkspaceRoot(SECOND)}/second.gb`, null);
  expect(state.load).not.toHaveBeenCalled();
  await refreshElectronWorkspaceSessionForPath(`${hostedWorkspaceRoot(FIRST)}/sequence.gb`, null);
  expect(state.load).toHaveBeenCalledTimes(1);
});
