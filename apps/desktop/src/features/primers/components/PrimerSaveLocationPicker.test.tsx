import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PrimerSaveLocationPicker } from './PrimerSaveLocationPicker';

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
  roots: [{ path: '/w/proj', name: 'proj' }],
  initialDir: '/w/proj/sequences',
  selectedDir: '/w/proj/sequences',
  onSelectFolder: vi.fn(),
};

describe('PrimerSaveLocationPicker (inline tree / compact-field hybrid)', () => {
  beforeEach(() => {
    fsMock.readDir.mockReset();
    fsMock.readDir.mockImplementation(async () => []);
  });

  it('defaults to the original inline tree beneath a slash-separated path field', () => {
    render(<PrimerSaveLocationPicker {...base} />);

    const trigger = screen.getByTestId('primer-save-location-trigger');
    expect(trigger).toHaveTextContent('proj / sequences');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('primer-save-location-menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('primer-save-location-picker')).toBeInTheDocument();
    expect(screen.getByTestId('primer-save-location-expanded')).toBeInTheDocument();
  });

  it('collapses to the compact selected-folder field and expands inline again', () => {
    render(<PrimerSaveLocationPicker {...base} />);

    const trigger = screen.getByTestId('primer-save-location-trigger');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('proj / sequences');
    expect(screen.queryByTestId('primer-save-location-picker')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('primer-save-location-picker')).toBeInTheDocument();
  });

  it('selects and expands a subfolder while leaving the inline picker open', async () => {
    const onSelectFolder = vi.fn();
    fsMock.readDir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/w/proj') {
        return [
          { name: 'sequences', isDirectory: true },
          { name: 'oligos', isDirectory: true },
        ];
      }
      if (dirPath === '/w/proj/oligos') return [{ name: 'nested', isDirectory: true }];
      return [];
    });
    render(<PrimerSaveLocationPicker {...base} onSelectFolder={onSelectFolder} />);

    const oligos = await waitFor(() => {
      const row = document.querySelector('[data-entry-path="/w/proj/oligos"]');
      expect(row).not.toBeNull();
      return row as HTMLElement;
    });
    fireEvent.click(oligos);

    expect(onSelectFolder).toHaveBeenCalledWith('/w/proj/oligos');
    await waitFor(() => expect(screen.getByText('nested')).toBeInTheDocument());
    expect(screen.getByTestId('primer-save-location-trigger')).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByTestId('primer-save-location-picker')).toBeInTheDocument();
  });

  it('auto-expands and highlights the folder supplied by the creation entry point', async () => {
    fsMock.readDir.mockImplementation(async (dirPath: string) =>
      dirPath === '/w/proj' ? [{ name: 'sequences', isDirectory: true }] : []
    );
    render(<PrimerSaveLocationPicker {...base} />);

    const selected = await waitFor(() => {
      const row = document.querySelector('[data-entry-path="/w/proj/sequences"]');
      expect(row).not.toBeNull();
      return row as HTMLElement;
    });
    expect(selected.className).toContain('text-accent');
  });
});
