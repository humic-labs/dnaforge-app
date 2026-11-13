/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitMocks = vi.hoisted(() => ({
  gitWorkspaceLog: vi.fn(),
}));

vi.mock('../features/workspace/git', () => ({
  gitWorkspaceLog: gitMocks.gitWorkspaceLog,
}));

import { ProjectHome } from './ProjectHome';

const project = {
  entry: null,
  repoPath: '/managed/a/repo',
  name: 'Project A',
  lastOpenedAt: Date.now(),
  originPath: '/Users/me/a',
};

describe('ProjectHome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMocks.gitWorkspaceLog.mockResolvedValue([
      {
        hash: 'abc123456789',
        message: 'Initial import',
        date: '2026-06-20T10:00:00Z',
        relativeDate: '2 days ago',
      },
    ]);
  });

  it('renders project metadata and repo-wide history', async () => {
    render(
      <ProjectHome
        project={project}
        onClose={vi.fn()}
        onArchiveProject={vi.fn()}
        onOpenRegistry={vi.fn()}
        onOpenSwitcher={vi.fn()}
        onRevealProject={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Project A' })).toBeInTheDocument();
    expect(screen.getByText('Imported from a')).toBeInTheDocument();
    expect(screen.getByText('Managed project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share snapshot' })).toBeInTheDocument();
    expect(screen.getAllByText('a').length).toBeGreaterThan(0);
    expect(screen.queryByText('/Users/me/a')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Initial import')).toBeInTheDocument());
    expect(gitMocks.gitWorkspaceLog).toHaveBeenCalledWith('/managed/a/repo', 50);
  });

  it('does not render raw Windows paths for managed project metadata', async () => {
    render(
      <ProjectHome
        project={{
          ...project,
          repoPath: 'C:\\Users\\user\\AppData\\Roaming\\DNAForge\\managed\\abc\\repo',
          originPath: 'C:\\Users\\user\\Documents\\Onboarding Beta',
        }}
        onClose={vi.fn()}
        onArchiveProject={vi.fn()}
        onOpenRegistry={vi.fn()}
        onOpenSwitcher={vi.fn()}
        onRevealProject={vi.fn()}
      />
    );

    expect(screen.getByText('Imported from Onboarding Beta')).toBeInTheDocument();
    expect(screen.getByText('Onboarding Beta')).toBeInTheDocument();
    expect(screen.queryByText(/C:\\Users\\/)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(gitMocks.gitWorkspaceLog).toHaveBeenCalledWith(
        'C:\\Users\\user\\AppData\\Roaming\\DNAForge\\managed\\abc\\repo',
        50
      )
    );
  });

  it('routes primary project actions to App-owned handlers', async () => {
    const onClose = vi.fn();
    const onArchiveProject = vi.fn();
    const onOpenRegistry = vi.fn();
    const onOpenSwitcher = vi.fn();
    const onRevealProject = vi.fn();

    render(
      <ProjectHome
        project={project}
        onClose={onClose}
        onArchiveProject={onArchiveProject}
        onOpenRegistry={onOpenRegistry}
        onOpenSwitcher={onOpenSwitcher}
        onRevealProject={onRevealProject}
      />
    );

    fireEvent.click(screen.getByTestId('project-home-switch'));
    fireEvent.click(screen.getByTestId('project-home-archive'));
    fireEvent.click(screen.getByTestId('project-home-open-registry'));
    fireEvent.click(screen.getByTestId('project-home-reveal'));
    fireEvent.click(screen.getByTestId('project-home-close'));

    expect(onOpenSwitcher).toHaveBeenCalledTimes(1);
    expect(onArchiveProject).toHaveBeenCalledWith('/managed/a/repo');
    expect(onOpenRegistry).toHaveBeenCalledTimes(1);
    expect(onRevealProject).toHaveBeenCalledWith('/managed/a/repo');
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(gitMocks.gitWorkspaceLog).toHaveBeenCalledWith('/managed/a/repo', 50)
    );
  });
});
