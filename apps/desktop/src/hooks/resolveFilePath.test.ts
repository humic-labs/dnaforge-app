import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveFilePath,
  resolveFilePathWithFallback,
  resolveFilePathWithPersistedWorkspace,
} from './resolveFilePath';
import { useWorkspaceStore } from '../stores/workspaceStore';

describe('resolveFilePath', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ folders: [], activeWorkspaceFile: null });
  });

  it('passes absolute paths through unchanged', () => {
    expect(resolveFilePath('/Users/me/data/seq.gb')).toBe('/Users/me/data/seq.gb');
  });

  it('passes Windows absolute paths through unchanged', () => {
    expect(resolveFilePath('C:\\Users\\user\\seq.gb')).toBe('C:\\Users\\user\\seq.gb');
  });

  it('resolves relative path against single workspace folder', () => {
    useWorkspaceStore.setState({
      folders: [{ path: '/Users/me/project', name: 'project', addedAt: 0 }],
    });
    expect(resolveFilePath('data/plasmid-variants/seq.gb')).toBe(
      '/Users/me/project/data/plasmid-variants/seq.gb'
    );
  });

  it('resolves relative path with folder-name prefix in multi-root', () => {
    useWorkspaceStore.setState({
      folders: [
        { path: '/Users/me/lab-data', name: 'Lab Data', addedAt: 0 },
        { path: '/Users/me/references', name: 'References', addedAt: 1 },
      ],
    });
    expect(resolveFilePath('Lab Data/seqs/plasmid.gb')).toBe('/Users/me/lab-data/seqs/plasmid.gb');
  });

  it('throws on relative path with no project folders and no active file', () => {
    useWorkspaceStore.setState({ folders: [], activeWorkspaceFile: null });
    expect(() => resolveFilePath('data/seq.gb')).toThrow(/project/i);
  });

  it('resolves relative path using activeWorkspaceFile when folders empty', () => {
    useWorkspaceStore.setState({
      folders: [],
      activeWorkspaceFile: '/Users/me/project/my.waypoint-workspace',
    });
    expect(resolveFilePath('data/seq.gb')).toBe('/Users/me/project/data/seq.gb');
  });
});

describe('resolveFilePathWithFallback', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      folders: [
        { path: '/Users/test/replasmidgenotyping', name: 'replasmidgenotyping', addedAt: 0 },
        { path: '/Users/test/Dev Assets', name: 'Dev Assets', addedAt: 0 },
      ],
    });
  });

  it('passes absolute paths through unchanged', () => {
    expect(resolveFilePathWithFallback('/absolute/path/file.gb')).toBe('/absolute/path/file.gb');
  });

  it('resolves folder-prefixed path directly', () => {
    expect(resolveFilePathWithFallback('Dev Assets/data/file.gb')).toBe(
      '/Users/test/Dev Assets/data/file.gb'
    );
  });

  it('falls back to folder-prefix search when path lacks prefix', () => {
    const result = resolveFilePathWithFallback('data/file.gb');
    expect(result).toBe('/Users/test/replasmidgenotyping/data/file.gb');
  });

  it('returns original path if all fallbacks fail', () => {
    useWorkspaceStore.setState({ folders: [], activeWorkspaceFile: null });
    const result = resolveFilePathWithFallback('nonexistent/path/file.gb');
    expect(result).toBe('nonexistent/path/file.gb');
  });

  it('handles single-folder workspace without fallback needed', () => {
    useWorkspaceStore.setState({
      folders: [{ path: '/Users/test/workspace', name: 'workspace', addedAt: 0 }],
    });
    expect(resolveFilePathWithFallback('plasmids/pUC19.gb')).toBe(
      '/Users/test/workspace/plasmids/pUC19.gb'
    );
  });
});

describe('resolveFilePathWithPersistedWorkspace', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ folders: [], activeWorkspaceFile: null });
  });

  it('resolves a relative cold-start tab against the SQLite workspace root', () => {
    expect(
      resolveFilePathWithPersistedWorkspace(
        'tables/quoted-notes.csv',
        '/Users/test/current-workspace'
      )
    ).toBe('/Users/test/current-workspace/tables/quoted-notes.csv');
  });

  it('keeps the mounted workspace store authoritative once it is available', () => {
    useWorkspaceStore.setState({
      folders: [{ path: '/Users/test/mounted', name: 'mounted', addedAt: 0 }],
    });

    expect(
      resolveFilePathWithPersistedWorkspace('tables/quoted-notes.csv', '/Users/test/stale')
    ).toBe('/Users/test/mounted/tables/quoted-notes.csv');
  });

  it('leaves an unresolved relative path unchanged when no workspace authority exists', () => {
    expect(resolveFilePathWithPersistedWorkspace('quoted-notes.csv', null)).toBe(
      'quoted-notes.csv'
    );
  });

  it('passes an absolute cold-start path inside the persisted workspace through unchanged', () => {
    expect(
      resolveFilePathWithPersistedWorkspace(
        '/Users/test/current-workspace/structures/1FS0.pdb',
        '/Users/test/current-workspace'
      )
    ).toBe('/Users/test/current-workspace/structures/1FS0.pdb');
  });

  it('passes an absolute cold-start path outside the persisted workspace through unchanged', () => {
    expect(
      resolveFilePathWithPersistedWorkspace(
        '/tmp/elsewhere/1FS0.pdb',
        '/Users/test/current-workspace'
      )
    ).toBe('/tmp/elsewhere/1FS0.pdb');
  });

  it('passes a Windows absolute cold-start path through unchanged', () => {
    expect(
      resolveFilePathWithPersistedWorkspace('C:\\workspace\\structures\\1FS0.pdb', 'C:\\workspace')
    ).toBe('C:\\workspace\\structures\\1FS0.pdb');
  });
});
