import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileContextMenu } from './FileContextMenu';
import { useWorkspaceStore } from '../stores/workspaceStore';

beforeEach(() => {
  useWorkspaceStore.getState().clearWorkspace();
  useWorkspaceStore.setState({
    folders: ['/lab/project', '/lab/project-other'].map((path) => ({
      path,
      name: path,
      addedAt: 1,
    })),
    expandedPaths: new Set(['/lab/project', '/lab/project-other']),
    selectedPath: '/lab/project/alpha/notes.txt',
  });
});
afterEach(cleanup);

it.each([
  [true, '/lab/project', 'Collapse Other Projects'],
  [false, '/lab/project/alpha', 'Collapse Other Folders'],
] as const)('collapses other branches from the %s root menu', (isRootFolder, path, label) => {
  const onClose = vi.fn();
  const before = useWorkspaceStore.getState();
  render(
    <FileContextMenu
      position={{ x: 0, y: 0 }}
      displayName="Selected branch"
      isDirectory
      isRootFolder={isRootFolder}
      onCopyPath={vi.fn()}
      onRevealInFinder={vi.fn()}
      onClose={onClose}
      onCollapseOthers={() => useWorkspaceStore.getState().collapseOtherBranches(path)}
    />
  );
  fireEvent.click(screen.getByRole('menuitem', { name: label, exact: true }));
  const after = useWorkspaceStore.getState();
  expect([...after.expandedPaths]).toEqual(['/lab/project']);
  expect(after.selectedPath).toBe(before.selectedPath);
  expect(after.folders).toBe(before.folders);
  expect(after.collapseOthersRequest?.path).toBe(path);
  expect(onClose).toHaveBeenCalledOnce();
  const request = after.collapseOthersRequest;
  after.expandPath('/lab/project-other');
  after.collapseOtherBranches(path);
  expect(useWorkspaceStore.getState().expandedPaths.has('/lab/project-other')).toBe(false);
  expect(useWorkspaceStore.getState().collapseOthersRequest).not.toBe(request);
});

it('does not offer collapse actions for files', () => {
  render(
    <FileContextMenu
      position={{ x: 0, y: 0 }}
      displayName="notes.txt"
      isDirectory={false}
      isRootFolder={false}
      onCopyPath={vi.fn()}
      onRevealInFinder={vi.fn()}
      onClose={vi.fn()}
      onCollapseOthers={vi.fn()}
    />
  );
  expect(screen.queryByRole('menuitem', { name: /Collapse Other/ })).toBeNull();
});

it('preserves the containing Windows project and refuses an unrelated target', () => {
  useWorkspaceStore.setState({
    folders: ['C:\\Lab\\Project', 'C:\\Lab\\Project-other'].map((path) => ({
      path,
      name: path,
      addedAt: 1,
    })),
    expandedPaths: new Set(['C:\\Lab\\Project', 'C:\\Lab\\Project-other']),
  });
  const before = useWorkspaceStore.getState();
  before.collapseOtherBranches('C:\\Elsewhere');
  expect(useWorkspaceStore.getState()).toBe(before);
  before.collapseOtherBranches('c:/lab/project/alpha');
  expect([...useWorkspaceStore.getState().expandedPaths]).toEqual(['C:\\Lab\\Project']);
});
