import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  AssemblySaveLocationPicker,
  type AssemblySaveLocationPickerHandle,
} from './AssemblySaveLocationPicker';

const fsMock = vi.hoisted(() => ({
  readDir: vi.fn(async () => []),
  exists: vi.fn(async () => false),
  mkdir: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
}));
vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: fsMock,
    shell: { revealItemInDir: vi.fn(async () => {}) },
  }),
}));
vi.mock('../../../db/workspace-catalog', () => ({
  registerWorkspaceFile: vi.fn(async () => {}),
}));

const base = {
  roots: [{ path: '/w/project', name: 'Project' }],
  initialDir: '/w/project/assemblies',
  selectedDir: '/w/project/assemblies',
  onSelectFolder: vi.fn(),
};

describe('AssemblySaveLocationPicker', () => {
  beforeEach(() => fsMock.readDir.mockReset().mockResolvedValue([]));

  it('shows destination folders without files at any expanded depth', async () => {
    fsMock.readDir.mockImplementation(async (path: string) => {
      if (path === '/w/project')
        return [
          { name: 'assemblies', isDirectory: true },
          { name: 'notes.md', isDirectory: false },
        ];
      if (path === '/w/project/assemblies')
        return [
          { name: 'accepted', isDirectory: true },
          { name: 'draft.wpdesign.json', isDirectory: false },
        ];
      return [];
    });
    const onSelectFolder = vi.fn();
    render(<AssemblySaveLocationPicker {...base} onSelectFolder={onSelectFolder} />);
    const destination = await screen.findByText('accepted');
    expect(screen.queryByText('notes')).toBeNull();
    expect(screen.queryByText('draft')).toBeNull();
    expect(document.querySelector('[data-entry-path="/w/project/notes.md"]')).toBeNull();
    expect(
      document.querySelector('[data-entry-path="/w/project/assemblies/draft.wpdesign.json"]')
    ).toBeNull();
    fireEvent.click(destination);
    expect(onSelectFolder).toHaveBeenCalledWith('/w/project/assemblies/accepted');
  });

  it('is the shared DNAForge workspace-folder picker with assembly-owned test ids', () => {
    render(<AssemblySaveLocationPicker {...base} />);

    expect(screen.getByTestId('assembly-save-location-picker')).toBeInTheDocument();
    expect(screen.getByTestId('assembly-picker-folder-/w/project')).toBeInTheDocument();
    expect(screen.queryByTestId('assembly-picker-confirm')).toBeNull();
    expect(screen.queryByTestId('assembly-save-location-new-folder')).toBeNull();
  });

  it('reports the folder selected through the shared tree', () => {
    const onSelectFolder = vi.fn();
    render(<AssemblySaveLocationPicker {...base} onSelectFolder={onSelectFolder} />);

    fireEvent.click(screen.getByTestId('assembly-picker-folder-/w/project'));

    expect(onSelectFolder).toHaveBeenCalledWith('/w/project');
  });

  it('hosts start the shared inline editor through the forwarded newFolder handle', async () => {
    const pickerRef = createRef<AssemblySaveLocationPickerHandle>();
    render(
      <AssemblySaveLocationPicker
        ref={pickerRef}
        {...base}
        initialDir="/w/project"
        selectedDir="/w/project"
      />
    );

    pickerRef.current?.newFolder('/w/project');

    const input = (await screen.findByDisplayValue('New Folder')) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
  });
});
