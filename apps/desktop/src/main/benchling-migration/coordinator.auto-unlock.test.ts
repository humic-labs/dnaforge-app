import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

const { executeLocalBundleMigration, unlockMigrationWorkspace } = vi.hoisted(() => ({
  executeLocalBundleMigration: vi.fn(),
  unlockMigrationWorkspace: vi.fn(),
}));

vi.mock('./local-bundle-executor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./local-bundle-executor')>()),
  executeLocalBundleMigration,
}));

vi.mock('./staging-workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./staging-workspace')>()),
  unlockMigrationWorkspace,
}));

import type { MigrationRun, MigrationScope } from '../../shared/benchling-migration';
import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { LocalBenchlingMigrationCoordinator } from './coordinator';
import { advanceMigrationRun } from './state-machine';
import { createMigrationStagingWorkspace } from './staging-workspace';
import { migrationDatabasePath, MigrationStore } from './store';

describe('a local bundle import unlocks itself when it passes', () => {
  let root: string;
  let globalDb: ReturnType<typeof createTestDb>;
  const openedStores: MigrationStore[] = [];
  const databases: ReturnType<typeof createTestDb>[] = [];
  const stores = new Map<string, MigrationStore>();

  const LOCAL_SCOPE: MigrationScope = {
    version: 1,
    kind: 'file',
    acquisition: 'local_bundle',
    source: {
      id: 'etr_AUTOUNLOCK',
      url: 'https://benchling.com/example/etr_AUTOUNLOCK',
      objectType: 'notebook_entry',
    },
  };

  function openStore(workspacePath: string): MigrationStore {
    const existing = stores.get(workspacePath);
    if (existing) return existing;
    const db = createTestDb();
    databases.push(db);
    const store = new MigrationStore(db);
    stores.set(workspacePath, store);
    openedStores.push(store);
    return store;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'coordinator-auto-unlock-'));
    globalDb = createTestDb();
    ensureSchema(globalDb, ':memory:');
    executeLocalBundleMigration.mockReset();
    unlockMigrationWorkspace.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    stores.clear();
    openedStores.length = 0;
    globalDb.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function coordinator() {
    return new LocalBenchlingMigrationCoordinator({
      globalDb,
      managedRootDir: root,
      openStore,
      discardWorkspace: async () => undefined,
      renderValidator: async () => [],
      now: () => '2026-08-14T18:00:00.000Z',
    });
  }

  async function createRun(): Promise<MigrationRun> {
    const run = await createMigrationStagingWorkspace({
      scope: LOCAL_SCOPE,
      displayName: 'Auto unlock fixture',
      deps: {
        managedRootDir: root,
        globalDb,
        createWorkspaceId: () => 'auto-unlock-run',
        openStore,
        now: () => '2026-08-14T18:00:00.000Z',
      },
    });
    mkdirSync(join(run.workspacePath, '.dnaforge', 'migration'), { recursive: true });
    writeFileSync(migrationDatabasePath(run.workspacePath), 'test store marker');
    let advanced = run;
    const store = openStore(run.workspacePath);
    while (advanced.state !== 'parsing') {
      advanced = advanceMigrationRun(advanced, '2026-08-14T18:00:00.000Z');
      store.saveRun(advanced);
    }
    return advanced;
  }

  async function settle(): Promise<void> {
    await vi.waitFor(() => expect(executeLocalBundleMigration).toHaveBeenCalled());
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  function finished(run: MigrationRun, passed: boolean, state: MigrationRun['state']) {
    return { run: { ...run, state }, report: { passed } };
  }

  it('unlocks a validated import without waiting to be asked', async () => {
    const run = await createRun();
    executeLocalBundleMigration.mockResolvedValue(finished(run, true, 'ready_to_unlock'));

    await coordinator().start(run.id);
    await settle();

    expect(unlockMigrationWorkspace).toHaveBeenCalledTimes(1);
    expect(unlockMigrationWorkspace.mock.calls[0]?.[0]).toMatchObject({
      workspacePath: run.workspacePath,
    });
  });

  it.each([false, true])(
    'resumes native ZIP finalization after restart (fails: %s)',
    async (fails) => {
      const run = await createRun();
      let ready = run;
      while (ready.state !== 'ready_to_unlock')
        ready = advanceMigrationRun(ready, '2026-08-14T18:00:00.000Z');
      ready = {
        ...ready,
        workspaceOrigin: { kind: 'migration_created' },
        externalZipEntries: [],
        externalZipSource: {
          schema: 'dnaforge.benchling.external-zip-source.v1',
          sourceId: 'source',
          originalPath: join(root, 'export.zip'),
          displayName: 'export.zip',
          zipSha256: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 1,
          selectedAt: ready.createdAt,
        },
      };
      const recoveredDb = createTestDb();
      databases.push(recoveredDb);
      const store = new MigrationStore(recoveredDb);
      store.saveRun(ready);
      stores.set(run.workspacePath, store);
      executeLocalBundleMigration.mockResolvedValue({ run: ready, report: { passed: true } });
      unlockMigrationWorkspace.mockImplementation(async () => {
        if (fails) throw new Error('finalization failed');
        store.saveRun(advanceMigrationRun(ready, '2026-08-14T18:00:00.000Z'));
      });
      const subject = coordinator();
      await Promise.all([subject.getActiveRun(), subject.getActiveRun()]);
      await vi.waitFor(() => expect(store.getRun()?.state).toBe(fails ? 'failed' : 'unlocked'));
      expect(executeLocalBundleMigration).toHaveBeenCalledTimes(1);
      expect(unlockMigrationWorkspace).toHaveBeenCalledTimes(1);
      if (fails) expect(store.getRun()?.lastError?.code).toBe('internal_invariant');
    }
  );

  it('joins a renderer unlock to the automatic unlock already in progress', async () => {
    const run = await createRun();
    let readyRun = run;
    let resolveUnlock!: () => void;
    const unlockPending = new Promise<void>((resolve) => {
      resolveUnlock = resolve;
    });

    executeLocalBundleMigration.mockImplementation(async () => {
      const store = openStore(run.workspacePath);
      while (readyRun.state !== 'ready_to_unlock') {
        readyRun = advanceMigrationRun(readyRun, '2026-08-14T18:00:00.000Z');
        store.saveRun(readyRun);
      }
      return { run: readyRun, report: { passed: true } };
    });
    unlockMigrationWorkspace.mockImplementation(() => unlockPending);

    const subject = coordinator();
    const automaticUnlock = subject.start(run.id);
    await vi.waitFor(() => expect(unlockMigrationWorkspace).toHaveBeenCalledTimes(1));

    const rendererUnlock = subject.unlock(run.id);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(subject.discard(run.id)).rejects.toThrow(
      'Cancel the active migration before discarding it.'
    );

    const unlocked = advanceMigrationRun(readyRun, '2026-08-14T18:00:00.000Z');
    openStore(run.workspacePath).saveRun(unlocked);
    resolveUnlock();

    await expect(Promise.all([automaticUnlock, rendererUnlock])).resolves.toEqual([
      expect.objectContaining({ state: 'unlocked' }),
      expect.objectContaining({ state: 'unlocked' }),
    ]);
    expect(unlockMigrationWorkspace).toHaveBeenCalledTimes(1);
  });

  it('releases a failed unlock reservation so the user can retry', async () => {
    const run = await createRun();
    const store = openStore(run.workspacePath);
    let readyRun = run;
    while (readyRun.state !== 'ready_to_unlock') {
      readyRun = advanceMigrationRun(readyRun, '2026-08-14T18:00:00.000Z');
      store.saveRun(readyRun);
    }

    unlockMigrationWorkspace.mockRejectedValueOnce(new Error('transient finalization failure'));
    const subject = coordinator();

    await expect(subject.unlock(run.id)).rejects.toThrow('transient finalization failure');

    unlockMigrationWorkspace.mockImplementationOnce(async () => {
      store.saveRun(advanceMigrationRun(readyRun, '2026-08-14T18:00:00.000Z'));
    });
    await expect(subject.unlock(run.id)).resolves.toMatchObject({ state: 'unlocked' });
    expect(unlockMigrationWorkspace).toHaveBeenCalledTimes(2);
  });

  it('leaves a failed import locked, so a broken import never joins the library', async () => {
    const run = await createRun();
    executeLocalBundleMigration.mockResolvedValue(finished(run, false, 'ready_to_unlock'));

    await coordinator().start(run.id);
    await settle();

    expect(unlockMigrationWorkspace).not.toHaveBeenCalled();
  });

  it('does not unlock a run that never reached validation', async () => {
    const run = await createRun();
    executeLocalBundleMigration.mockResolvedValue(finished(run, true, 'action_required'));

    await coordinator().start(run.id);
    await settle();

    expect(unlockMigrationWorkspace).not.toHaveBeenCalled();
  });
});
