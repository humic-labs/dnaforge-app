import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProteinSaveLocationPicker } from './ProteinSaveLocationPicker';

vi.mock('../../../platform', () => ({
  platform: () => ({ fs: { readDir: vi.fn(async () => []) } }),
}));

const base = {
  roots: [{ path: '/w/proj', name: 'proj' }],
  initialDir: '/w/proj/proteins',
  selectedDir: '/w/proj/proteins',
  onSelectFolder: vi.fn(),
};

describe('ProteinSaveLocationPicker (reuses the workspace file tree)', () => {
  it('renders each mounted workspace as a selectable root', () => {
    render(<ProteinSaveLocationPicker {...base} />);
    expect(screen.getByTestId('protein-save-location-picker')).toBeInTheDocument();
    expect(screen.getByTestId('protein-picker-folder-/w/proj')).toBeInTheDocument();
  });

  it('calls onSelectFolder when a folder is clicked', () => {
    const onSelectFolder = vi.fn();
    render(<ProteinSaveLocationPicker {...base} onSelectFolder={onSelectFolder} />);
    fireEvent.click(screen.getByTestId('protein-picker-folder-/w/proj'));
    expect(onSelectFolder).toHaveBeenCalledWith('/w/proj');
  });

  it('highlights the selected folder', () => {
    render(<ProteinSaveLocationPicker {...base} selectedDir="/w/proj" />);
    expect(screen.getByTestId('protein-picker-folder-/w/proj').className).toContain('text-accent');
  });
});
