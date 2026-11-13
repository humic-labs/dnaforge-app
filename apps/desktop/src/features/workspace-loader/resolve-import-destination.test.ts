import { describe, it, expect } from 'vitest';
import { resolveImportDestination } from './resolve-import-destination';
import type { WorkspaceFolder } from '../../stores/workspaceStore';

function folder(path: string, extra: Partial<WorkspaceFolder> = {}): WorkspaceFolder {
  return { path, name: path.split('/').pop() ?? path, addedAt: 0, ...extra };
}

describe('resolveImportDestination ', () => {
  it('preselects a NEW workspace for a folder drop when no workspace is open', () => {
    const r = resolveImportDestination({ folders: [], dropKind: 'folder' });
    expect(r.preselected).toEqual({ kind: 'new-workspace' });
    expect(r.requiresExplicitChoice).toBe(false);
    expect(r.reason).toBe('preselect-new-workspace');
  });

  it('a pinned-only workspace list counts as "no workspace open"', () => {
    const r = resolveImportDestination({
      folders: [folder('/pinned', { pinned: true })],
      dropKind: 'folder',
    });
    expect(r.preselected).toEqual({ kind: 'new-workspace' });
    expect(r.requiresExplicitChoice).toBe(false);
  });

  it('FORCES an explicit choice for a single-file drop with no workspace (no silent one-file workspace)', () => {
    const r = resolveImportDestination({ folders: [], dropKind: 'file' });
    expect(r.requiresExplicitChoice).toBe(true);
    expect(r.reason).toBe('require-choice-file');
  });

  it('preselects the sole open workspace root for any drop', () => {
    const r = resolveImportDestination({ folders: [folder('/a')], dropKind: 'files' });
    expect(r.preselected).toEqual({ kind: 'existing-root', rootPath: '/a' });
    expect(r.requiresExplicitChoice).toBe(false);
    expect(r.reason).toBe('preselect-existing');
  });

  it('preselects the root that contains the currently-selected path', () => {
    const r = resolveImportDestination({
      folders: [folder('/a'), folder('/b')],
      selectedPath: '/b/sub/x.gb',
      dropKind: 'file',
    });
    expect(r.preselected).toEqual({ kind: 'existing-root', rootPath: '/b' });
    expect(r.requiresExplicitChoice).toBe(false);
  });

  it('FORCES an explicit pick when multiple roots are open with no active signal', () => {
    const r = resolveImportDestination({
      folders: [folder('/a'), folder('/b')],
      dropKind: 'folder',
    });
    expect(r.requiresExplicitChoice).toBe(true);
    expect(r.reason).toBe('require-choice-ambiguous');
  });
});
