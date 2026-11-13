/** @vitest-environment jsdom */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { managedSequenceEditAccess } from '../lims/public/registry-record-edit-access';
import { RegistryInlineFieldEditor } from '../lims/public/components/registry/RegistryInlineFieldEditor';
import type { ProjectEditFolder } from './project-edit-folders';
import { useProjectEditFolders } from './use-project-edit-folders';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('./project-edit-folders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./project-edit-folders')>()),
  listProjectEditFolders: mocks.list,
}));

const packageRoot = '/projects/sequences/pDEMO421';
const activeProject: ProjectEditFolder = {
  path: '/projects/sequences',
  name: 'My sequences',
  lifecycle: 'active',
};

describe('Registry project access while durable availability is being read', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    useWorkspaceStore.setState({
      folders: [{ path: activeProject.path, name: 'Old sidebar entry', addedAt: 1, pinned: false }],
      fileTreeRefreshToken: 0,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not offer editing from stale sidebar access while a reference project is loading', async () => {
    let complete!: (folders: ProjectEditFolder[]) => void;
    mocks.list.mockImplementation(
      () =>
        new Promise<ProjectEditFolder[]>((resolve) => {
          complete = resolve;
        })
    );
    const view = renderHook(() => useProjectEditFolders());
    expect(managedSequenceEditAccess(packageRoot, view.result.current)).toMatchObject({
      canEdit: false,
      reason: 'checking',
      message: expect.stringContaining('Checking project access'),
    });
    await act(async () =>
      complete([{ ...activeProject, name: 'Reference sequences', pinned: true }])
    );
    await waitFor(() =>
      expect(managedSequenceEditAccess(packageRoot, view.result.current)).toMatchObject({
        canEdit: false,
        reason: 'reference',
      })
    );
  });

  it('does not offer editing from an unverified sidebar entry when durable availability fails to load', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.list.mockRejectedValue(new Error('Project records could not be loaded'));
    const view = renderHook(() => useProjectEditFolders());
    await waitFor(() => expect(log).toHaveBeenCalled());
    expect(managedSequenceEditAccess(packageRoot, view.result.current).canEdit).toBe(false);
  });

  it('does not keep offering edits from an old active record after a refresh fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.list.mockResolvedValue([activeProject]);
    const view = renderHook(() => useProjectEditFolders());
    await waitFor(() => expect(view.result.current).toContainEqual(activeProject));
    expect(managedSequenceEditAccess(packageRoot, view.result.current).canEdit).toBe(true);
    mocks.list.mockRejectedValue(new Error('Project records could not be refreshed'));
    act(() => useWorkspaceStore.getState().bumpFileTreeRefresh());
    await waitFor(() => expect(log).toHaveBeenCalled());
    expect(managedSequenceEditAccess(packageRoot, view.result.current).canEdit).toBe(false);
  });

  it('keeps a durable active project editable without a sidebar root', async () => {
    useWorkspaceStore.setState({ folders: [] });
    mocks.list.mockResolvedValue([activeProject]);
    const view = renderHook(() => useProjectEditFolders());
    await waitFor(() =>
      expect(managedSequenceEditAccess(packageRoot, view.result.current)).toEqual({
        canEdit: true,
        workspaceRoot: activeProject.path,
      })
    );
  });

  it('keeps Registry controls unavailable until access is checked and retains a draft across a failed refresh', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const save = vi.fn().mockResolvedValue(undefined);
    let complete!: (folders: ProjectEditFolder[]) => void;
    mocks.list.mockImplementation(
      () =>
        new Promise<ProjectEditFolder[]>((resolve) => {
          complete = resolve;
        })
    );
    function Description() {
      const access = managedSequenceEditAccess(packageRoot, useProjectEditFolders());
      return (
        <>
          {!access.canEdit ? <p role="status">{access.message}</p> : null}
          <RegistryInlineFieldEditor
            field={{ key: 'description', label: 'Description', type: 'long_text' }}
            value={undefined}
            onCommit={access.canEdit ? save : undefined}
          />
        </>
      );
    }
    render(<Description />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking project access');
    expect(screen.queryByRole('button', { name: 'Edit Description' })).not.toBeInTheDocument();
    await act(async () => complete([activeProject]));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Description' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Keep this attempted edit' },
    });
    mocks.list.mockRejectedValue(new Error('Project availability refresh failed'));
    act(() => useWorkspaceStore.getState().bumpFileTreeRefresh());
    expect(await screen.findByRole('alert')).toHaveTextContent('has not been saved');
    expect(log).toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
    expect(screen.getByText('Keep this attempted edit')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry Description' })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    mocks.list.mockResolvedValue([activeProject]);
    act(() => useWorkspaceStore.getState().bumpFileTreeRefresh());
    const retry = screen.getByRole('button', { name: 'Retry Description' });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() => expect(save).toHaveBeenCalledWith('Keep this attempted edit'));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
