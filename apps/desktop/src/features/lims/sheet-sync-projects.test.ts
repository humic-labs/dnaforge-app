import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { SheetSyncConnection } from './sheet-sync-connection';
import {
  getSheetSyncViews,
  refreshSheetSyncProject,
  retainSheetSyncProject,
} from './sheet-sync-projects';
const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  unwatch: vi.fn(),
  list: vi.fn(),
  pull: vi.fn(),
  authorization: vi.fn(),
  providerHandlers: new Set<() => void>(),
  handlers: new Set<(...args: unknown[]) => void>(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({
    googleSheets: {
      onChanged: (handler: () => void) => {
        mocks.providerHandlers.add(handler);
        return () => {
          mocks.providerHandlers.delete(handler);
        };
      },
    },
    fs: { exists: async () => true, watchFile: mocks.watch, unwatchFile: mocks.unwatch },
    on: (_event: string, handler: (...args: unknown[]) => void) => {
      mocks.handlers.add(handler);
      return () => {
        mocks.handlers.delete(handler);
      };
    },
  }),
}));
vi.mock('./sheet-sync-connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sheet-sync-connection')>()),
  listSheetSyncConnections: mocks.list,
}));
vi.mock('./sheet-sync-local-state', () => ({ localSheetSyncAuthorization: mocks.authorization }));
vi.mock('./sheet-sync-runtime', () => ({ pullExcelSheetConnection: mocks.pull }));
const connection: SheetSyncConnection = {
  schema: 'dnaforge.sheet-sync',
  schemaVersion: 1,
  id: 'd788e456-ebdf-4672-818c-d5e6a1ff99b4',
  importSetId: 'import-set',
  source: {
    path: '/master.xlsx',
    sheetName: 'Primers',
    keyColumn: 'ID',
    forcedKind: 'oligo',
    columnMappings: [],
  },
  destinationRelativePath: '',
  revision: `sha256:${'a'.repeat(64)}`,
  enabled: true,
  pending: null,
  finalization: null,
  checkpoints: [],
};
const summary = {
  created: 0,
  updated: 0,
  unchanged: 1,
  conflicts: [],
  localEdits: [],
  missingRows: [],
};
const release: Array<() => void> = [];
function retain() {
  const stop = retainSheetSyncProject('/project');
  release.push(stop);
  return stop;
}
function emit(path: string) {
  for (const handler of [...mocks.handlers]) handler(path);
}
function deferred() {
  let resolve: () => void = () => {
    throw new Error('Deferred executor did not run');
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: () => resolve() };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  mocks.providerHandlers.clear();
  mocks.watch.mockResolvedValue(undefined);
  mocks.unwatch.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([
    { kind: 'connection', stored: { connection, content: JSON.stringify(connection) } },
  ]);
  mocks.authorization.mockResolvedValue('authorized');
  mocks.pull.mockResolvedValue(summary);
});
afterEach(async () => {
  for (const stop of release.splice(0)) stop();
  await waitFor(() =>
    expect(getSheetSyncViews().filter((view) => view.workspaceRoot === '/project')).toHaveLength(0)
  );
  await Promise.resolve();
});
describe('workspace-lifetime spreadsheet watchers', () => {
  it('shares one native source watch across consumers and preserves unrelated event listeners', async () => {
    const foreign = vi.fn();
    mocks.handlers.add(foreign);
    const first = retain(),
      second = retain();
    await refreshSheetSyncProject('/project');
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(1));
    expect(mocks.watch.mock.calls.filter(([path]) => path === '/master.xlsx')).toHaveLength(1);
    emit('/project/.waypoint/sheet-sync');
    await refreshSheetSyncProject('/project');
    expect(mocks.pull).toHaveBeenCalledTimes(1);
    first();
    expect(mocks.unwatch).not.toHaveBeenCalledWith('/master.xlsx');
    emit('/master.xlsx');
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(2));
    second();
    await waitFor(() => expect(mocks.unwatch).toHaveBeenCalledWith('/master.xlsx'));
    expect(mocks.handlers.has(foreign)).toBe(true);
  });
  it('coalesces edits arriving during a pull without concurrent writers', async () => {
    const gate = deferred();
    let active = 0,
      peak = 0;
    mocks.pull.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (mocks.pull.mock.calls.length === 1) await gate.promise;
      active -= 1;
      return summary;
    });
    retain();
    await refreshSheetSyncProject('/project');
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(1));
    emit('/master.xlsx');
    emit('/master.xlsx');
    emit('/master.xlsx');
    gate.resolve();
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(getSheetSyncViews().some((view) => view.kind === 'ready')).toBe(true)
    );
    expect(peak).toBe(1);
  });
  it('does not watch or read an unapproved master and starts only after local authorization', async () => {
    mocks.authorization.mockResolvedValue('required');
    retain();
    await refreshSheetSyncProject('/project');
    expect(mocks.watch).not.toHaveBeenCalledWith('/master.xlsx');
    expect(mocks.pull).not.toHaveBeenCalled();
    expect(getSheetSyncViews().some((view) => view.kind === 'authorization-required')).toBe(true);
    mocks.authorization.mockResolvedValue('authorized');
    await refreshSheetSyncProject('/project');
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(1));
    expect(mocks.watch).toHaveBeenCalledWith('/master.xlsx');
  });
  it('waits for a stopped in-flight actor before reopening the same project', async () => {
    const gate = deferred();
    mocks.pull.mockImplementationOnce(async () => {
      await gate.promise;
      return summary;
    });
    const first = retain();
    await refreshSheetSyncProject('/project');
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(1));
    first();
    retain();
    await Promise.resolve();
    expect(mocks.watch.mock.calls.filter(([path]) => path === '/master.xlsx')).toHaveLength(1);
    gate.resolve();
    await refreshSheetSyncProject('/project');
    await waitFor(() => expect(mocks.pull).toHaveBeenCalledTimes(2));
    expect(mocks.watch.mock.calls.filter(([path]) => path === '/master.xlsx')).toHaveLength(2);
  });
  it('invalidates an earlier pull immediately while another source watch is still starting', async () => {
    const firstPull = deferred();
    const secondWatch = deferred();
    const second = {
      ...connection,
      id: '05a1d6e7-3d6a-4a59-81ec-8629f742a751',
      source: { ...connection.source, path: '/second.xlsx' },
    };
    mocks.list.mockResolvedValue(
      [connection, second].map((value) => ({
        kind: 'connection',
        stored: { connection: value, content: JSON.stringify(value) },
      }))
    );
    mocks.watch.mockImplementation(async (path: string) => {
      if (path === second.source.path) await secondWatch.promise;
    });
    let mutations = 0;
    let cancellation: unknown;
    let firstFinished = false;
    mocks.pull.mockImplementation(async ({ assertCurrent }: { assertCurrent: () => void }) => {
      await firstPull.promise;
      try {
        assertCurrent();
        mutations += 1;
      } catch (error) {
        cancellation = error;
      } finally {
        firstFinished = true;
      }
      return summary;
    });
    const stop = retain();
    try {
      await waitFor(() => expect(mocks.watch).toHaveBeenCalledWith(second.source.path));
      expect(mocks.pull).toHaveBeenCalledTimes(1);
      stop();
      firstPull.resolve();
      await waitFor(() => expect(firstFinished).toBe(true));
      expect(mutations).toBe(0);
      expect(cancellation).toBeInstanceOf(Error);
      expect(mocks.unwatch).not.toHaveBeenCalledWith(second.source.path);
    } finally {
      firstPull.resolve();
      secondWatch.resolve();
    }
    await waitFor(() => expect(mocks.unwatch).toHaveBeenCalledWith(second.source.path));
    expect(mocks.pull).toHaveBeenCalledTimes(1);
  });
});

describe('project-owned Google polling', () => {
  it('polls only the selected connection, invalidates old owner work on provider change and releases the timer', async () => {
    vi.useFakeTimers();
    const google: SheetSyncConnection = {
      ...connection,
      source: {
        provider: 'google-sheets',
        spreadsheetId: 'source-id',
        sheetId: 17,
        keyColumn: 'ID',
        forcedKind: 'oligo',
        columnMappings: [],
      },
    };
    mocks.list.mockResolvedValue([
      { kind: 'connection', stored: { connection: google, content: JSON.stringify(google) } },
    ]);
    const ownership: Array<() => void> = [];
    mocks.pull.mockImplementation(async ({ assertCurrent }: { assertCurrent: () => void }) => {
      ownership.push(assertCurrent);
      assertCurrent();
      return summary;
    });
    const stop = retain();
    try {
      await refreshSheetSyncProject('/project');
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.pull).toHaveBeenCalledTimes(1);
      expect(mocks.watch).not.toHaveBeenCalledWith(expect.stringContaining('docs.google.com'));
      await vi.advanceTimersByTimeAsync(60000);
      expect(mocks.pull).toHaveBeenCalledTimes(2);
      for (const changed of mocks.providerHandlers) changed();
      expect(() => ownership[0]()).toThrow('stopped');
      await refreshSheetSyncProject('/project');
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.pull).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(0);
      const count = mocks.pull.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120000);
      expect(mocks.pull).toHaveBeenCalledTimes(count);
      expect(mocks.providerHandlers.size).toBe(0);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
