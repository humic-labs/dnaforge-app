import { forwardRef, useImperativeHandle, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportDestinationPicker } from './ImportDestinationPicker';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';

const newFolderSpy = vi.fn();
const receivedInitialDirs: string[] = [];
const receivedSelectedDirs: string[] = [];

vi.mock('../../../components/WorkspaceFolderPicker', () => ({
  WorkspaceFolderPicker: forwardRef(function MockPicker(
    {
      onSelectFolder,
      initialDir,
      selectedDir,
    }: { onSelectFolder(path: string): void; initialDir: string; selectedDir: string },
    ref: React.Ref<{ newFolder(dir: string): void }>
  ) {
    receivedInitialDirs.push(initialDir);
    receivedSelectedDirs.push(selectedDir);
    useImperativeHandle(ref, () => ({ newFolder: newFolderSpy }));
    return (
      <button data-testid="wfp-stub" onClick={() => onSelectFolder('/ws/b')}>
        pick /ws/b
      </button>
    );
  }),
}));

const folder = (path: string, name: string, pinned = false): WorkspaceFolder => ({
  path,
  name,
  addedAt: 0,
  pinned,
});

describe('ImportDestinationPicker ', () => {
  beforeEach(() => {
    newFolderSpy.mockClear();
    receivedInitialDirs.length = 0;
    receivedSelectedDirs.length = 0;
  });

  it('the expand-to-reveal target stays LATCHED while the selection moves (right-click never re-expands)', () => {
    function Harness() {
      const [value, setValue] = useState<string | null>(null);
      return (
        <ImportDestinationPicker
          folders={[folder('/ws/a', 'Workspace A'), folder('/ws/b', 'Workspace B')]}
          value={value}
          onChange={setValue}
        />
      );
    }
    render(<Harness />);
    expect(receivedInitialDirs.at(-1)).toBe('');

    fireEvent.click(screen.getByTestId('wfp-stub'));
    expect(receivedSelectedDirs.at(-1)).toBe('/ws/b');
    expect(receivedInitialDirs.at(-1)).toBe('');
  });

  it('the New folder button creates a folder under the SELECTED folder', () => {
    render(
      <ImportDestinationPicker
        folders={[folder('/ws/a', 'Workspace A'), folder('/ws/b', 'Workspace B')]}
        value="/ws/a"
        onChange={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId('lims-import-destination-new-folder'));
    expect(newFolderSpy).toHaveBeenCalledWith('/ws/a');
  });

  it('with nothing selected, New folder does not guess a project from mount order', () => {
    render(
      <ImportDestinationPicker
        folders={[folder('/ws/a', 'Workspace A'), folder('/ws/b', 'Workspace B')]}
        value={null}
        onChange={vi.fn()}
      />
    );
    const button = screen.getByTestId('lims-import-destination-new-folder');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(newFolderSpy).not.toHaveBeenCalled();
  });

  it('with no open project, shows the "a new project will be created" note — no picker', () => {
    render(<ImportDestinationPicker folders={[]} value={null} onChange={vi.fn()} />);
    expect(screen.getByTestId('lims-import-destination')).toHaveTextContent(
      /new project will be created/i
    );
    expect(screen.queryByTestId('wfp-stub')).toBeNull();
  });

  it('pinned reference projects are excluded as write destinations', () => {
    render(
      <ImportDestinationPicker
        folders={[folder('/pin', 'Pinned', true)]}
        value={null}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('lims-import-destination')).toHaveTextContent(
      /new project will be created/i
    );
  });

  it('as a full step, shows the folder tree AND the chosen destination name', () => {
    render(
      <ImportDestinationPicker
        folders={[folder('/ws/a', 'Workspace A'), folder('/ws/b', 'Workspace B')]}
        value="/ws/a"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('wfp-stub')).toBeInTheDocument();
    expect(screen.getByTestId('lims-import-destination-current')).toHaveTextContent('Workspace A');
  });

  it('when nothing is chosen yet (value null) with ≥1 workspace, prompts to choose (tree shown)', () => {
    render(
      <ImportDestinationPicker
        folders={[folder('/ws/a', 'Workspace A'), folder('/ws/b', 'Workspace B')]}
        value={null}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('lims-import-destination-unset')).toHaveTextContent(
      /choose a folder/i
    );
    expect(screen.getByTestId('wfp-stub')).toBeInTheDocument();
  });

  it('selecting a folder in the picker calls onChange with its path', () => {
    const onChange = vi.fn();
    render(
      <ImportDestinationPicker
        folders={[folder('/ws/a', 'Workspace A'), folder('/ws/b', 'Workspace B')]}
        value={null}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByTestId('wfp-stub'));
    expect(onChange).toHaveBeenCalledWith('/ws/b');
  });
});
