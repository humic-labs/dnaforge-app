import { describe, it, expect } from 'vitest';
import { resolveActiveImportRoot } from './resolve-import-root';
import type { WorkspaceFolder } from '../../stores/workspaceStore';

function folder(path: string, extra: Partial<WorkspaceFolder> = {}): WorkspaceFolder {
  return { path, name: path.split('/').pop() ?? path, addedAt: 0, ...extra };
}

describe('resolveActiveImportRoot ', () => {
  it('returns null when there are no importable (non-pinned) roots', () => {
    expect(resolveActiveImportRoot({ folders: [] })).toBeNull();
    expect(resolveActiveImportRoot({ folders: [folder('/pinned', { pinned: true })] })).toBeNull();
  });

  it('uses the sole open root when there is exactly one', () => {
    expect(resolveActiveImportRoot({ folders: [folder('/a')] })).toBe('/a');
  });

  it('prefers the root containing the selected path over everything else', () => {
    const folders = [folder('/a'), folder('/b')];
    expect(
      resolveActiveImportRoot({
        folders,
        selectedPath: '/b/sub/file.gb',
        workspacePath: '/a',
      })
    ).toBe('/b');
  });

  it('prefers the deepest matching root when roots are nested', () => {
    const outer = folder('/a');
    const inner = folder('/a/inner');
    expect(
      resolveActiveImportRoot({ folders: [outer, inner], selectedPath: '/a/inner/x.gb' })
    ).toBe('/a/inner');
    expect(
      resolveActiveImportRoot({ folders: [inner, outer], selectedPath: '/a/inner/x.gb' })
    ).toBe('/a/inner');
  });

  it('refuses duplicate normalized roots for selection, focus, and legacy fallback', () => {
    const duplicates = [folder('/a/inner'), folder('/a/inner/')];
    const reversed = [...duplicates].reverse();

    for (const folders of [duplicates, reversed]) {
      expect(resolveActiveImportRoot({ folders, selectedPath: '/a/inner/x.gb' })).toBeNull();
      expect(resolveActiveImportRoot({ folders, focusedRootPath: '/a/inner' })).toBeNull();
      expect(resolveActiveImportRoot({ folders, workspacePath: '/a/inner' })).toBeNull();
    }
  });

  it('does not fall through from an ambiguous higher-priority signal', () => {
    const duplicateSelection = [folder('/a/inner'), folder('/a/inner/'), folder('/b')];
    const duplicateFocus = [folder('/a'), folder('/b'), folder('/b/')];

    for (const folders of [duplicateSelection, [...duplicateSelection].reverse()]) {
      expect(
        resolveActiveImportRoot({
          folders,
          selectedPath: '/a/inner/x.gb',
          focusedRootPath: '/b',
          workspacePath: '/b',
        })
      ).toBeNull();
    }
    for (const folders of [duplicateFocus, [...duplicateFocus].reverse()]) {
      expect(
        resolveActiveImportRoot({
          folders,
          focusedRootPath: '/b',
          workspacePath: '/a',
        })
      ).toBeNull();
    }
  });

  it('falls back to the focused project root when selection does not resolve', () => {
    const folders = [folder('/a'), folder('/b')];
    expect(resolveActiveImportRoot({ folders, focusedRootPath: '/b' })).toBe('/b');
  });

  it('uses the legacy workspacePath only as a last-resort tiebreak', () => {
    const folders = [folder('/a'), folder('/b')];
    expect(resolveActiveImportRoot({ folders, workspacePath: '/b' })).toBe('/b');
  });

  it('returns null when multiple roots and no active signal (ambiguous → caller prompts)', () => {
    const folders = [folder('/a'), folder('/b')];
    expect(resolveActiveImportRoot({ folders })).toBeNull();
    expect(resolveActiveImportRoot({ folders, workspacePath: '/nope' })).toBeNull();
  });

  it('never targets a pinned dev-fixture root', () => {
    const folders = [folder('/pinned', { pinned: true }), folder('/real')];
    expect(resolveActiveImportRoot({ folders, selectedPath: '/pinned/x.gb' })).toBe('/real');
  });
});
