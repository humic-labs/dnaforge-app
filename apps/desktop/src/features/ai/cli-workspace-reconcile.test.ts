import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadDir, mockStat, mockRevealPath, mockOpenDocument } = vi.hoisted(() => ({
  mockReadDir: vi.fn(),
  mockStat: vi.fn(),
  mockRevealPath: vi.fn(),
  mockOpenDocument: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: vi.fn(() => ({
    fs: {
      readDir: mockReadDir,
      stat: mockStat,
    },
  })),
}));

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: vi.fn(() => ({
      revealPath: mockRevealPath,
    })),
  },
}));

vi.mock('../document-opening/open-document', () => ({ openDocument: mockOpenDocument }));

import {
  diffWorkspaceSnapshots,
  reconcileCliWorkspaceChanges,
  scanWorkspaceFiles,
  selectRepresentativeCliOutput,
  type WorkspaceFileSnapshot,
} from './cli-workspace-reconcile';

type DirEntry = { name: string; isDirectory: boolean; isFile: boolean };
type StatEntry = { size: number; mtime: number; isFile: boolean; isDirectory: boolean };

function file(name: string): DirEntry {
  return { name, isDirectory: false, isFile: true };
}

function dir(name: string): DirEntry {
  return { name, isDirectory: true, isFile: false };
}

function snapshot(rootPath: string, records: Array<{ path: string; size: number; mtime: number }>) {
  return {
    rootPath,
    files: new Map(records.map((record) => [record.path, record])),
    truncated: false,
    errors: [],
  } satisfies WorkspaceFileSnapshot;
}

function mockVirtualWorkspace({
  dirs,
  stats,
}: {
  dirs: Record<string, DirEntry[]>;
  stats: Record<string, StatEntry>;
}) {
  mockReadDir.mockImplementation(async (path: string) => dirs[path] ?? []);
  mockStat.mockImplementation(async (path: string) => {
    const stat = stats[path];
    if (!stat) throw new Error(`ENOENT: ${path}`);
    return stat;
  });
}

describe('CLI workspace reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenDocument.mockResolvedValue({ status: 'presented', tabId: 'tab-output' });
  });

  it('scans bounded workspace files while skipping dependency and hidden folders', async () => {
    mockVirtualWorkspace({
      dirs: {
        '/workspace': [dir('outputs'), dir('node_modules'), dir('.git'), file('input.fa')],
        '/workspace/outputs': [file('summary.md')],
        '/workspace/node_modules': [file('ignored.js')],
        '/workspace/.git': [file('config')],
      },
      stats: {
        '/workspace/input.fa': { size: 12, mtime: 1, isFile: true, isDirectory: false },
        '/workspace/outputs/summary.md': { size: 34, mtime: 2, isFile: true, isDirectory: false },
      },
    });

    const result = await scanWorkspaceFiles('/workspace');

    expect([...result.files.keys()]).toEqual([
      '/workspace/input.fa',
      '/workspace/outputs/summary.md',
    ]);
    expect(mockReadDir).not.toHaveBeenCalledWith('/workspace/node_modules');
    expect(mockReadDir).not.toHaveBeenCalledWith('/workspace/.git');
  });

  it('diffs snapshots and chooses the most useful created output', () => {
    const before = snapshot('/workspace', [
      { path: '/workspace/src/script.py', size: 100, mtime: 1 },
      { path: '/workspace/old.txt', size: 20, mtime: 1 },
    ]);
    const after = snapshot('/workspace', [
      { path: '/workspace/src/script.py', size: 101, mtime: 2 },
      { path: '/workspace/outputs/final_report.md', size: 200, mtime: 3 },
      { path: '/workspace/outputs/run.lock', size: 1, mtime: 3 },
    ]);

    const changes = diffWorkspaceSnapshots(before, after);

    expect(changes.created.map((record) => record.path)).toEqual([
      '/workspace/outputs/final_report.md',
      '/workspace/outputs/run.lock',
    ]);
    expect(changes.modified.map((record) => record.path)).toEqual(['/workspace/src/script.py']);
    expect(changes.deleted.map((record) => record.path)).toEqual(['/workspace/old.txt']);
    expect(selectRepresentativeCliOutput(changes)).toBe('/workspace/outputs/final_report.md');
  });

  it('refreshes and reveals representative output without opening a tab by default', async () => {
    mockVirtualWorkspace({
      dirs: {
        '/workspace': [dir('outputs'), file('input.fa')],
        '/workspace/outputs': [file('analysis_report.md')],
      },
      stats: {
        '/workspace/input.fa': { size: 12, mtime: 1, isFile: true, isDirectory: false },
        '/workspace/outputs/analysis_report.md': {
          size: 512,
          mtime: 10,
          isFile: true,
          isDirectory: false,
        },
      },
    });
    const before = snapshot('/workspace', [{ path: '/workspace/input.fa', size: 12, mtime: 1 }]);
    const events: CustomEvent[] = [];
    const onChanged = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener('waypoint:workspace-files-changed', onChanged);

    const result = await reconcileCliWorkspaceChanges({
      workspaceRoot: '/workspace',
      before,
    });

    window.removeEventListener('waypoint:workspace-files-changed', onChanged);
    expect(result.representativePath).toBe('/workspace/outputs/analysis_report.md');
    expect(result.openedPath).toBeNull();
    expect(mockRevealPath).toHaveBeenCalledWith('/workspace/outputs/analysis_report.md');
    expect(mockOpenDocument).not.toHaveBeenCalled();
    expect(events.at(-1)?.detail).toEqual({
      workspaceRoot: '/workspace',
      path: '/workspace/outputs/analysis_report.md',
    });
  });

  it('opens a representative text output when explicitly requested', async () => {
    mockVirtualWorkspace({
      dirs: {
        '/workspace': [dir('outputs'), file('input.fa')],
        '/workspace/outputs': [file('analysis_report.md')],
      },
      stats: {
        '/workspace/input.fa': { size: 12, mtime: 1, isFile: true, isDirectory: false },
        '/workspace/outputs/analysis_report.md': {
          size: 512,
          mtime: 10,
          isFile: true,
          isDirectory: false,
        },
      },
    });
    const before = snapshot('/workspace', [{ path: '/workspace/input.fa', size: 12, mtime: 1 }]);

    const result = await reconcileCliWorkspaceChanges({
      workspaceRoot: '/workspace',
      before,
      openRepresentativeOutput: true,
    });

    expect(result.representativePath).toBe('/workspace/outputs/analysis_report.md');
    expect(result.openedPath).toBe('/workspace/outputs/analysis_report.md');
    expect(mockOpenDocument).toHaveBeenCalledWith({
      target: { kind: 'file', path: '/workspace/outputs/analysis_report.md', tabType: 'text' },
      label: 'analysis_report.md',
      placement: { kind: 'focused' },
    });
  });

  it('opens a representative HTML report output when explicitly requested  — html still surfaces)', async () => {
    mockVirtualWorkspace({
      dirs: {
        '/workspace': [dir('outputs'), file('input.fa')],
        '/workspace/outputs': [file('analysis_report.html')],
      },
      stats: {
        '/workspace/input.fa': { size: 12, mtime: 1, isFile: true, isDirectory: false },
        '/workspace/outputs/analysis_report.html': {
          size: 2048,
          mtime: 10,
          isFile: true,
          isDirectory: false,
        },
      },
    });
    const before = snapshot('/workspace', [{ path: '/workspace/input.fa', size: 12, mtime: 1 }]);

    const result = await reconcileCliWorkspaceChanges({
      workspaceRoot: '/workspace',
      before,
      openRepresentativeOutput: true,
    });

    expect(result.representativePath).toBe('/workspace/outputs/analysis_report.html');
    expect(result.openedPath).toBe('/workspace/outputs/analysis_report.html');
    expect(mockRevealPath).toHaveBeenCalledWith('/workspace/outputs/analysis_report.html');
    expect(mockOpenDocument).toHaveBeenCalledWith({
      target: { kind: 'file', path: '/workspace/outputs/analysis_report.html', tabType: 'html' },
      label: 'analysis_report.html',
      placement: { kind: 'focused' },
    });
  });

  it('does NOT auto-open a non-report .html outside an output dir (gated like text, not unconditional)', async () => {
    mockVirtualWorkspace({
      dirs: {
        '/workspace': [dir('notes'), file('input.fa')],
        '/workspace/notes': [file('page.html')],
      },
      stats: {
        '/workspace/input.fa': { size: 12, mtime: 1, isFile: true, isDirectory: false },
        '/workspace/notes/page.html': { size: 2048, mtime: 10, isFile: true, isDirectory: false },
      },
    });
    const before = snapshot('/workspace', [{ path: '/workspace/input.fa', size: 12, mtime: 1 }]);

    const result = await reconcileCliWorkspaceChanges({
      workspaceRoot: '/workspace',
      before,
    });

    expect(result.openedPath).toBeNull();
    expect(mockOpenDocument).not.toHaveBeenCalled();
  });

  it('routes representative biology outputs through the sequence opener', async () => {
    mockVirtualWorkspace({
      dirs: {
        '/workspace': [dir('outputs')],
        '/workspace/outputs': [file('edited_construct.gb')],
      },
      stats: {
        '/workspace/outputs/edited_construct.gb': {
          size: 1024,
          mtime: 10,
          isFile: true,
          isDirectory: false,
        },
      },
    });

    await reconcileCliWorkspaceChanges({
      workspaceRoot: '/workspace',
      before: snapshot('/workspace', []),
      openRepresentativeOutput: true,
    });

    expect(mockOpenDocument).toHaveBeenCalledWith({
      target: { kind: 'file', path: '/workspace/outputs/edited_construct.gb', tabType: 'sequence' },
      label: 'edited_construct.gb',
      placement: { kind: 'focused' },
    });
    expect(mockOpenDocument).toHaveBeenCalledTimes(1);
  });
});
