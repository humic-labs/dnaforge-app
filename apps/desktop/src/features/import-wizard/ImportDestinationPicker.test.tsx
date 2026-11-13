import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ImportDestinationPicker } from './ImportDestinationPicker';
import type { ImportDestination } from '../workspace-loader/resolve-import-destination';

function roots() {
  return [
    { path: '/ws/ecoli', name: 'E. coli work' },
    { path: '/ws/yeast', name: 'Yeast project' },
  ];
}

describe('ImportDestinationPicker  D4)', () => {
  it('does not present Registry as a storage destination', () => {
    render(
      <ImportDestinationPicker
        roots={roots()}
        selected={{ kind: 'existing-root', rootPath: '/ws/ecoli' }}
        onSelect={vi.fn()}
      />
    );
    expect(screen.queryByRole('treeitem', { name: /register as entities/i })).toBeNull();
  });

  it('lists New workspace + every open workspace root', () => {
    render(
      <ImportDestinationPicker
        roots={roots()}
        selected={{ kind: 'existing-root', rootPath: '/ws/ecoli' }}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('dest-new-workspace')).toBeTruthy();
    expect(screen.getByText('E. coli work')).toBeTruthy();
    expect(screen.getByText('Yeast project')).toBeTruthy();
  });

  it('marks the currently-selected root aria-selected', () => {
    render(
      <ImportDestinationPicker
        roots={roots()}
        selected={{ kind: 'existing-root', rootPath: '/ws/yeast' }}
        onSelect={vi.fn()}
      />
    );
    const yeast = screen.getByText('Yeast project').closest('[role="treeitem"]')!;
    expect(yeast.getAttribute('aria-selected')).toBe('true');
    const ecoli = screen.getByText('E. coli work').closest('[role="treeitem"]')!;
    expect(ecoli.getAttribute('aria-selected')).toBe('false');
  });

  it('selecting a workspace calls onSelect with that existing-root', () => {
    const onSelect = vi.fn();
    render(
      <ImportDestinationPicker
        roots={roots()}
        selected={{ kind: 'new-workspace' }}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByText('Yeast project'));
    expect(onSelect).toHaveBeenCalledWith<[ImportDestination]>({
      kind: 'existing-root',
      rootPath: '/ws/yeast',
    });
  });

  it('selecting New workspace calls onSelect with new-workspace', () => {
    const onSelect = vi.fn();
    render(
      <ImportDestinationPicker
        roots={roots()}
        selected={{ kind: 'existing-root', rootPath: '/ws/ecoli' }}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByTestId('dest-new-workspace'));
    expect(onSelect).toHaveBeenCalledWith<[ImportDestination]>({ kind: 'new-workspace' });
  });

  it('marks New workspace selected when that is the destination', () => {
    render(
      <ImportDestinationPicker
        roots={roots()}
        selected={{ kind: 'new-workspace' }}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByTestId('dest-new-workspace').getAttribute('aria-selected')).toBe('true');
  });

  it('still shows New workspace when no workspaces are open', () => {
    render(
      <ImportDestinationPicker roots={[]} selected={{ kind: 'new-workspace' }} onSelect={vi.fn()} />
    );
    expect(screen.getByTestId('dest-new-workspace')).toBeTruthy();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(1);
  });

  it('can hide the registry route for an editable workspace import', () => {
    render(
      <ImportDestinationPicker
        roots={roots()}
        selected={{ kind: 'new-workspace' }}
        onSelect={vi.fn()}
        showRegistry={false}
      />
    );

    expect(screen.getByTestId('dest-new-workspace')).toBeTruthy();
    expect(screen.queryByTestId('dest-registry')).toBeNull();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(3);
  });

  it('expands a workspace to its subfolders and lets you select one (D4 subfolder targeting)', async () => {
    const onSelect = vi.fn();
    const listSubfolders = vi.fn(async (path: string) =>
      path === '/ws/ecoli' ? [{ path: '/ws/ecoli/plasmids', name: 'plasmids' }] : []
    );
    render(
      <ImportDestinationPicker
        roots={roots()}
        selected={{ kind: 'existing-root', rootPath: '/ws/ecoli' }}
        onSelect={onSelect}
        listSubfolders={listSubfolders}
      />
    );
    expect(screen.queryByText('plasmids')).toBeNull();
    fireEvent.click(screen.getByTestId('dest-expand-E. coli work'));
    const sub = await screen.findByText('plasmids');
    expect(listSubfolders).toHaveBeenCalledWith('/ws/ecoli');
    fireEvent.click(sub);
    expect(onSelect).toHaveBeenCalledWith({
      kind: 'existing-root',
      rootPath: '/ws/ecoli/plasmids',
    });
  });

  it('shows no expander when listSubfolders is not provided (root-level only)', () => {
    render(
      <ImportDestinationPicker
        roots={roots()}
        selected={{ kind: 'existing-root', rootPath: '/ws/ecoli' }}
        onSelect={vi.fn()}
      />
    );
    expect(screen.queryByTestId('dest-expand-E. coli work')).toBeNull();
  });
});
