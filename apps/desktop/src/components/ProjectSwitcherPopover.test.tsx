/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const libraryMocks = vi.hoisted(() => ({
  listWorkspaceLibrary: vi.fn(),
  restoreWorkspace: vi.fn(),
  restoreFromTrash: vi.fn(),

  trashDaysRemaining: vi.fn((trashedAt: number | null) => (trashedAt == null ? Infinity : 7)),
}));

vi.mock('../features/workspace-loader/workspace-library', () => ({
  listWorkspaceLibrary: libraryMocks.listWorkspaceLibrary,
  restoreWorkspace: libraryMocks.restoreWorkspace,
  restoreFromTrash: libraryMocks.restoreFromTrash,
  trashDaysRemaining: libraryMocks.trashDaysRemaining,
  normalizeWorkspaceTimestamp: (value: number | null | undefined) => value ?? null,
}));

import { ProjectSwitcherPopover } from './ProjectSwitcherPopover';
import * as platformModule from '../platform';
import { browserMockBridge } from '../platform/browser-mock';
import { useCanvasStore } from '../features/canvas/store';
import { useWorkspaceFileRelocatedRetarget } from '../features/workspace/useWorkspaceFileRelocatedRetarget';

function RecoveryScene() {
  useWorkspaceFileRelocatedRetarget();
  return (
    <ProjectSwitcherPopover
      x={0}
      y={0}
      openRepoPaths={[]}
      onClose={vi.fn()}
      onOpenProject={vi.fn()}
      onImportProject={vi.fn()}
    />
  );
}

describe('ProjectSwitcherPopover', () => {
  it.each(['relinked', 'rejected'] as const)(
    'retargets retained tabs only after a verified folder recovery: %s',
    async (status) => {
      useCanvasStore.getState().reset();
      useCanvasStore
        .getState()
        .openTab('main', { type: 'text', entityId: '/missing/notes.txt', label: 'notes.txt' });
      const bridge = browserMockBridge;
      const spy = vi.spyOn(platformModule, 'platform').mockReturnValue({
        ...bridge,
        dialog: { ...bridge.dialog, open: vi.fn().mockResolvedValue('/moved') },
        workspace: {
          ...bridge.workspace,
          relinkRoot: vi
            .fn()
            .mockResolvedValue(
              status === 'relinked'
                ? { status, workspaceId: 1, repoPath: '/moved' }
                : { status, reason: 'identity-mismatch' }
            ),
        },
      });
      libraryMocks.listWorkspaceLibrary.mockResolvedValue({
        active: [
          {
            repoUuid: 'missing',
            name: 'Missing project',
            repoPath: '/missing',
            originPath: null,
            lastOpenedAt: 1,
            archivedAt: null,
            trashedAt: null,
            rootState: 'missing',
          },
        ],
        archived: [],
        trashed: [],
      });
      try {
        render(<RecoveryScene />);
        fireEvent.click(await screen.findByRole('button', { name: 'Locate folder' }));
        if (status === 'relinked') {
          await waitFor(() =>
            expect(useCanvasStore.getState().panels.main.tabs[0].entityId).toBe('/moved/notes.txt')
          );
        } else {
          await screen.findByRole('alert');
          expect(useCanvasStore.getState().panels.main.tabs[0].entityId).toBe('/missing/notes.txt');
        }
      } finally {
        spy.mockRestore();
        useCanvasStore.getState().reset();
      }
    }
  );

  beforeEach(() => {
    vi.clearAllMocks();
    libraryMocks.listWorkspaceLibrary.mockResolvedValue({
      active: [
        {
          repoUuid: 'uuid-a',
          name: 'Project A',
          repoPath: '/managed/a/repo',
          originPath: '/Users/me/a',
          lastOpenedAt: Date.now(),
          archivedAt: null,
          trashedAt: null,
        },
        {
          repoUuid: 'uuid-b',
          name: 'Project B',
          repoPath: '/managed/b/repo',
          originPath: '/Users/me/b',
          lastOpenedAt: Date.now() - 60_000,
          archivedAt: null,
          trashedAt: null,
        },
      ],
      archived: [
        {
          repoUuid: 'uuid-c',
          name: 'Archived Project',
          repoPath: '/managed/c/repo',
          originPath: '/Users/me/c',
          lastOpenedAt: Date.now() - 120_000,
          archivedAt: Date.now(),
          trashedAt: null,
        },
      ],
      trashed: [],
    });

    libraryMocks.restoreWorkspace.mockResolvedValue(1);
    libraryMocks.restoreFromTrash.mockResolvedValue(1);
  });

  it('lists every current project, marks open ones, and shows all three sections ', async () => {
    const onOpenProject = vi.fn();
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={['/managed/a/repo']}
        onClose={vi.fn()}
        onOpenProject={onOpenProject}
        onImportProject={vi.fn()}
      />
    );

    const current = await screen.findByTestId('project-switcher-current');
    expect(within(current).getByTestId('project-switcher-row-uuid-a')).toHaveTextContent('Open');
    expect(within(current).getByTestId('project-switcher-row-uuid-b')).not.toHaveTextContent(
      'Open'
    );
    expect(screen.getByText('Current (2)')).toBeInTheDocument();
    expect(screen.getByText('Archived (1)')).toBeInTheDocument();
    expect(screen.getByText('Trash (0)')).toBeInTheDocument();
    expect(screen.getByText('Trash is empty')).toBeInTheDocument();
    const newProject = screen.getByTestId('project-switcher-new-project');
    const importProject = screen.getByTestId('project-switcher-import');
    expect(newProject.parentElement).toBe(importProject.parentElement);
    fireEvent.click(await screen.findByTestId('project-switcher-row-uuid-b'));

    expect(onOpenProject).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUuid: 'uuid-b',
        repoPath: '/managed/b/repo',
        name: 'Project B',
      })
    );
  });

  it('creates a named empty project without importing a folder ', async () => {
    const onCreateProject = vi.fn().mockResolvedValue(true);
    const onImportProject = vi.fn();
    const onClose = vi.fn();
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={[]}
        onClose={onClose}
        onOpenProject={vi.fn()}
        onImportProject={onImportProject}
        onCreateProject={onCreateProject}
      />
    );

    fireEvent.click(screen.getByTestId('project-switcher-new-project'));
    const create = screen.getByTestId('project-switcher-new-project-create');
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText('New project name'), {
      target: { value: '  Plasmid screen  ' },
    });
    fireEvent.click(create);

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onCreateProject).toHaveBeenCalledExactlyOnceWith('Plasmid screen');
    expect(onImportProject).not.toHaveBeenCalled();
  });

  it('keeps the popover open when project creation fails', async () => {
    const onCreateProject = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={[]}
        onClose={onClose}
        onOpenProject={vi.fn()}
        onImportProject={vi.fn()}
        onCreateProject={onCreateProject}
      />
    );

    fireEvent.click(screen.getByTestId('project-switcher-new-project'));
    fireEvent.change(screen.getByLabelText('New project name'), { target: { value: 'X' } });
    fireEvent.submit(screen.getByLabelText('New project name'));

    await waitFor(() => expect(onCreateProject).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByTestId('project-switcher-new-project-create')).toHaveTextContent('Create')
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows origin basenames instead of raw Windows paths in project rows', async () => {
    libraryMocks.listWorkspaceLibrary.mockResolvedValue({
      active: [
        {
          repoUuid: 'uuid-win',
          name: 'Windows Onboarding',
          repoPath: 'C:\\Users\\user\\AppData\\Roaming\\DNAForge\\managed\\abc\\repo',
          originPath: 'C:\\Users\\user\\Documents\\Onboarding Beta',
          lastOpenedAt: Date.now(),
          archivedAt: null,
          trashedAt: null,
        },
      ],
      archived: [],
      trashed: [],
    });

    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={[]}
        onClose={vi.fn()}
        onOpenProject={vi.fn()}
        onImportProject={vi.fn()}
      />
    );

    const row = await screen.findByTestId('project-switcher-row-uuid-win');
    expect(row).toHaveTextContent('Onboarding Beta');
    expect(row).not.toHaveTextContent('C:\\Users\\');
  });

  it('shows the archived picker expanded by default (no collapse to discover)', async () => {
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={['/managed/a/repo']}
        onClose={vi.fn()}
        onOpenProject={vi.fn()}
        onImportProject={vi.fn()}
      />
    );

    const archived = await screen.findByTestId('project-switcher-archived');
    expect(within(archived).getByText('Archived Project')).toBeInTheDocument();
    expect(screen.queryByTestId('project-switcher-toggle-archived')).toBeNull();

    expect(screen.getByTestId('project-switcher-restore-uuid-c')).toBeInTheDocument();
  });

  it('restores an archived project before opening it (row click)', async () => {
    const onOpenProject = vi.fn();
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={['/managed/a/repo']}
        onClose={vi.fn()}
        onOpenProject={onOpenProject}
        onImportProject={vi.fn()}
      />
    );

    const archived = await screen.findByTestId('project-switcher-archived');
    fireEvent.click(within(archived).getByText('Archived Project'));

    await waitFor(() => expect(libraryMocks.restoreWorkspace).toHaveBeenCalledWith('uuid-c'));
    expect(onOpenProject).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUuid: 'uuid-c',
        repoPath: '/managed/c/repo',
        name: 'Archived Project',
      })
    );
  });

  it('restores in place via the visible Restore button without opening', async () => {
    const onOpenProject = vi.fn();
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={['/managed/a/repo']}
        onClose={vi.fn()}
        onOpenProject={onOpenProject}
        onImportProject={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByTestId('project-switcher-restore-uuid-c'));

    await waitFor(() => expect(libraryMocks.restoreWorkspace).toHaveBeenCalledWith('uuid-c'));

    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it('does not open when restore reports 0 rows changed (record missing)', async () => {
    libraryMocks.restoreWorkspace.mockResolvedValueOnce(0);
    const onOpenProject = vi.fn();
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={['/managed/a/repo']}
        onClose={vi.fn()}
        onOpenProject={onOpenProject}
        onImportProject={vi.fn()}
      />
    );

    const archived = await screen.findByTestId('project-switcher-archived');
    fireEvent.click(within(archived).getByText('Archived Project'));

    await waitFor(() => expect(libraryMocks.restoreWorkspace).toHaveBeenCalledWith('uuid-c'));
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it('routes import through the parent project importer', async () => {
    const onImportProject = vi.fn();
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={[]}
        onClose={vi.fn()}
        onOpenProject={vi.fn()}
        onImportProject={onImportProject}
      />
    );

    fireEvent.click(await screen.findByTestId('project-switcher-import'));
    expect(onImportProject).toHaveBeenCalledTimes(1);
  });

  it('shows the deletion check date without promising deletion of protected projects', async () => {
    libraryMocks.listWorkspaceLibrary.mockResolvedValue({
      active: [],
      archived: [],
      trashed: [
        {
          repoUuid: 'uuid-t',
          name: 'Trashed Project',
          repoPath: '/managed/t/repo',
          originPath: '/Users/me/t',
          lastOpenedAt: Date.now() - 300_000,
          archivedAt: null,
          trashedAt: Date.now(),
        },
      ],
    });
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={[]}
        onClose={vi.fn()}
        onOpenProject={vi.fn()}
        onImportProject={vi.fn()}
      />
    );

    const trash = await screen.findByTestId('project-switcher-trashed');
    expect(within(trash).getByText('Trashed Project')).toBeInTheDocument();

    expect(within(trash).getByText(/deletion check in 7 days/i)).toBeInTheDocument();
    expect(
      within(trash).getByText(/original project.*retained records or history.*kept/i)
    ).toBeInTheDocument();

    expect(screen.getByTestId('project-switcher-restore-uuid-t')).toBeInTheDocument();
    expect(screen.getByTestId('project-switcher-purge-uuid-t')).toBeInTheDocument();
  });

  it('restores a trashed project from the visible Restore button and opens it', async () => {
    const onOpenProject = vi.fn();
    libraryMocks.listWorkspaceLibrary.mockResolvedValue({
      active: [],
      archived: [],
      trashed: [
        {
          repoUuid: 'uuid-t',
          name: 'Trashed Project',
          repoPath: '/managed/t/repo',
          originPath: '/Users/me/t',
          lastOpenedAt: Date.now() - 300_000,
          archivedAt: null,
          trashedAt: Date.now(),
        },
      ],
    });
    render(
      <ProjectSwitcherPopover
        x={10}
        y={20}
        openRepoPaths={[]}
        onClose={vi.fn()}
        onOpenProject={onOpenProject}
        onImportProject={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByTestId('project-switcher-restore-uuid-t'));

    await waitFor(() => expect(libraryMocks.restoreFromTrash).toHaveBeenCalledWith('uuid-t'));

    expect(onOpenProject).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUuid: 'uuid-t',
        repoPath: '/managed/t/repo',
        name: 'Trashed Project',
      })
    );
  });
});

describe('project list recovery (F22)', () => {
  const props = {
    x: 10,
    y: 20,
    openRepoPaths: [],
    onClose: vi.fn(),
    onOpenProject: vi.fn(),
    onImportProject: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('does not claim empty after a failed first read and retries in place', async () => {
    libraryMocks.listWorkspaceLibrary
      .mockRejectedValueOnce(new Error('controlled failure'))
      .mockResolvedValueOnce({ active: [], archived: [], trashed: [] });
    render(<ProjectSwitcherPopover {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your projects');
    expect(screen.queryByText('No current projects')).not.toBeInTheDocument();
    expect(screen.queryByText('Trash is empty')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry projects' }));
    expect(await screen.findByText('No current projects')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(libraryMocks.listWorkspaceLibrary).toHaveBeenCalledTimes(2);
  });
  it('retains the last confirmed rows and the create draft when a refresh fails', async () => {
    libraryMocks.listWorkspaceLibrary
      .mockResolvedValueOnce({
        active: [
          {
            repoUuid: 'fixture',
            name: 'Controlled project',
            repoPath: '/fixture',
            originPath: null,
            lastOpenedAt: 1,
            archivedAt: null,
            trashedAt: null,
          },
        ],
        archived: [],
        trashed: [],
      })
      .mockRejectedValueOnce(new Error('controlled refresh failure'));
    render(<ProjectSwitcherPopover {...props} onCreateProject={vi.fn()} />);
    await screen.findByText('Controlled project');
    fireEvent.click(screen.getByTestId('project-switcher-new-project'));
    fireEvent.change(screen.getByLabelText('New project name'), {
      target: { value: 'Unsent fixture' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Showing the last loaded projects');
    expect(screen.getByText('Controlled project')).toBeInTheDocument();
    expect(screen.getByLabelText('New project name')).toHaveValue('Unsent fixture');
    expect(screen.queryByText('No current projects')).not.toBeInTheDocument();
  });
});

describe('project list permission and readiness distinctions', () => {
  it('shows a bounded permission refusal without claiming an empty library', async () => {
    libraryMocks.listWorkspaceLibrary.mockRejectedValueOnce(
      Object.assign(new Error('private detail'), { code: 'EACCES' })
    );
    render(
      <ProjectSwitcherPopover
        x={0}
        y={0}
        openRepoPaths={[]}
        onClose={vi.fn()}
        onOpenProject={vi.fn()}
        onImportProject={vi.fn()}
      />
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Project access was refused');
    expect(screen.queryByText('No current projects')).not.toBeInTheDocument();
    expect(screen.queryByText('private detail')).not.toBeInTheDocument();
  });
});

describe('missing project roots', () => {
  it('retains missing projects, disables opening them, and offers Locate only with retained identity', async () => {
    libraryMocks.listWorkspaceLibrary.mockResolvedValueOnce({
      active: [
        {
          repoUuid: 'missing',
          name: 'Missing project',
          repoPath: '/missing',
          originPath: null,
          lastOpenedAt: 1,
          archivedAt: null,
          trashedAt: null,
          rootState: 'missing',
        },
        {
          repoUuid: null,
          name: 'Unidentified project',
          repoPath: '/unidentified',
          originPath: null,
          lastOpenedAt: 1,
          archivedAt: null,
          trashedAt: null,
          rootState: 'missing',
        },
      ],
      archived: [],
      trashed: [],
    });
    render(
      <ProjectSwitcherPopover
        x={0}
        y={0}
        openRepoPaths={[]}
        onClose={vi.fn()}
        onOpenProject={vi.fn()}
        onImportProject={vi.fn()}
      />
    );
    expect(await screen.findByTestId('project-switcher-row-missing')).toBeDisabled();
    expect(screen.getByTestId('project-switcher-row-/unidentified')).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Locate folder' })).toHaveLength(1);
    expect(
      screen.getByText('Missing folder — no retained identity to verify a replacement')
    ).toBeVisible();
  });
});
