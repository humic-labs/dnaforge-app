import type Database from 'better-sqlite3';
import { createTestDb } from '../../main/__tests__/test-db';
import { ensureSchema } from '../../main/schema';
import { mutateLegacyNotebookPageInDb } from '../../main/notebook-projection-authority';
import { ensureWorkspaceOwnerInDb } from '../../main/catalog-projection-commands';
import { notebookProjectionFingerprint } from '../../shared/notebook-projection';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const repairMock = vi.fn();
const selectMock = vi.fn();
const legacyMutationMock = vi.fn();
let nativeDb: Database.Database;
const writeArtifactMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);

vi.mock('./entity-ref/repair-page-references', () => ({
  repairPageReferences: (...args: unknown[]) => repairMock(...args),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      select: selectMock,
      execute: vi.fn(),
      mutateLegacyNotebookPage: (...args: unknown[]) => legacyMutationMock(...args),
      replaceNotebookProjection: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

vi.mock('../../db/workspace-artifacts', () => ({
  writeNotebookArtifactSnapshot: (...args: unknown[]) => writeArtifactMock(...args),
  trashNotebookArtifactForPage: vi.fn(async () => undefined),
  resolveNotebookArtifactWorkspaceOwner: vi.fn(async () => ({
    status: 'bound',
    workspaceRoot: '/managed/bbbb-owns-the-notebook/repo',
  })),
}));

const WS_A = '/managed/aaaa-first-but-wrong/repo';
const WS_B = '/managed/bbbb-owns-the-notebook/repo';

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      folders: [{ path: '/pinned/test-fixtures', pinned: true }, { path: WS_A }, { path: WS_B }],
      selectedPath: null,
    }),
  },
}));

vi.mock('../workspace-loader/resolve-import-root', () => ({
  resolveActiveImportRoot: () => WS_A,
}));

vi.mock('../../db/workspace-catalog', () => ({
  resolveWorkspaceId: async () => 1,
  getCurrentCatalogFileForEntity: async () => null,
  resolveWorkspaceScope: async (root: string) =>
    root === WS_A ? 'aaaa' : root === WS_B ? 'bbbb' : null,
}));

const LEGACY_DOC = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'mention', attrs: { entityType: 'sequence', entityId: 'a.gb', label: 'A' } },
      ],
    },
  ],
};

const repairedDocument = (occurrenceId?: string) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'mention',
          attrs: {
            entityType: 'sequence',
            entityId: 'ent-1',
            label: 'A',
            path: 'a/a.gb',
            objectUuid: 'uuid-1',
            contentHash: null,
            ...(occurrenceId ? { occurrenceId } : {}),
          },
        },
      ],
    },
  ],
});

const REPAIRED_DOC = repairedDocument();
const STORED_REPAIRED_DOC = repairedDocument('legacy-4a3beb335fd49edb');

function pageRow(id: string, content: unknown) {
  const row = {
    id,
    title: 'Cloning log',
    content: JSON.stringify(content),
    date: null,
    created_at: 1,
    updated_at: 2,
  };
  nativeDb
    .prepare(
      'INSERT OR REPLACE INTO pages(id,title,content,date,created_at,updated_at) VALUES(@id,@title,@content,@date,@created_at,@updated_at)'
    )
    .run(row);
  return row;
}

async function freshStore() {
  vi.resetModules();
  const mod = await import('./store');
  return mod.usePageStore;
}

beforeEach(() => {
  repairMock.mockReset();
  selectMock.mockReset();
  nativeDb = createTestDb();
  ensureSchema(nativeDb, ':memory:');
  for (const [root, scope] of [
    [WS_A, 'aaaa'],
    [WS_B, 'bbbb'],
  ]) {
    const id = ensureWorkspaceOwnerInDb(nativeDb, root);
    nativeDb.prepare('UPDATE workspaces SET repo_uuid=? WHERE id=?').run(scope, id);
  }
  legacyMutationMock.mockReset();
  legacyMutationMock.mockImplementation(async (input) =>
    mutateLegacyNotebookPageInDb(nativeDb, input)
  );
  writeArtifactMock.mockReset();
  writeArtifactMock.mockResolvedValue(null);
});

afterEach(() => nativeDb.close());

describe('page store — legacy reference repair reachability', () => {
  it('🟥 repairs a page that was PRELOADED into the cache by initialize()', async () => {
    selectMock.mockResolvedValue([pageRow('bbbb::nb-1', LEGACY_DOC)]);
    repairMock.mockResolvedValue({
      content: REPAIRED_DOC,
      repaired: 1,
      skipped: [],
      changed: true,
    });

    const store = await freshStore();
    await store.getState().initialize();

    expect(store.getState().pages['bbbb::nb-1']).toBeTruthy();

    const page = await store.getState().fetchPage('bbbb::nb-1');

    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(page?.content).toEqual(STORED_REPAIRED_DOC);
    expect(store.getState().pages['bbbb::nb-1'].content).toEqual(STORED_REPAIRED_DOC);
  });

  it('runs at most once per page per session', async () => {
    selectMock.mockResolvedValue([pageRow('bbbb::nb-1', LEGACY_DOC)]);
    repairMock.mockResolvedValue({
      content: REPAIRED_DOC,
      repaired: 1,
      skipped: [],
      changed: true,
    });

    const store = await freshStore();
    await store.getState().initialize();

    await store.getState().fetchPage('bbbb::nb-1');
    await store.getState().fetchPage('bbbb::nb-1');
    await store.getState().fetchPage('bbbb::nb-1');

    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(legacyMutationMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        (
          nativeDb.prepare('SELECT content FROM pages WHERE id=?').get('bbbb::nb-1') as {
            content: string;
          }
        ).content
      )
    ).toEqual(STORED_REPAIRED_DOC);
    expect(store.getState().dirtyIds.has('bbbb::nb-1')).toBe(false);
  });

  it.each([true, false])(
    'retries an unacknowledged repair (first write committed: %s)',
    async (committed) => {
      selectMock.mockResolvedValue([pageRow('bbbb::nb-1', LEGACY_DOC)]);
      repairMock.mockResolvedValue({
        content: REPAIRED_DOC,
        repaired: 1,
        skipped: [],
        changed: true,
      });
      legacyMutationMock.mockImplementationOnce(async (input) => {
        if (committed) mutateLegacyNotebookPageInDb(nativeDb, input);
        return null;
      });
      const store = await freshStore();
      await store.getState().initialize();
      await store.getState().fetchPage('bbbb::nb-1');
      expect(store.getState().dirtyIds.has('bbbb::nb-1')).toBe(true);
      await store.getState().fetchPage('bbbb::nb-1');
      await store.getState().fetchPage('bbbb::nb-1');
      expect(repairMock).toHaveBeenCalledTimes(2);
      expect(legacyMutationMock).toHaveBeenCalledTimes(2);
      expect(store.getState().dirtyIds.has('bbbb::nb-1')).toBe(false);
      expect(
        JSON.parse(
          (
            nativeDb.prepare('SELECT content FROM pages WHERE id=?').get('bbbb::nb-1') as {
              content: string;
            }
          ).content
        )
      ).toEqual(STORED_REPAIRED_DOC);
    }
  );

  it('waits for the repaired authority revision and returns its exact fingerprint', async () => {
    selectMock.mockResolvedValue([pageRow('bbbb::nb-1', LEGACY_DOC)]);
    repairMock.mockResolvedValue({
      content: REPAIRED_DOC,
      repaired: 1,
      skipped: [],
      changed: true,
    });
    let releaseCommit: (() => void) | undefined;
    legacyMutationMock.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          releaseCommit = () => resolve(mutateLegacyNotebookPageInDb(nativeDb, input));
        })
    );

    const store = await freshStore();
    await store.getState().initialize();
    let settled = false;
    const repair = store
      .getState()
      .ensureReferencesRepaired('bbbb::nb-1')
      .then((fingerprint) => {
        settled = true;
        return fingerprint;
      });

    await vi.waitFor(() => expect(legacyMutationMock).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    releaseCommit?.();
    const committed = nativeDb
      .prepare('SELECT title,content FROM pages WHERE id=?')
      .get('bbbb::nb-1') as { title: string; content: string };
    await expect(repair).resolves.toBe(
      notebookProjectionFingerprint(committed.title, committed.content)
    );
  });

  it('leaves the page untouched when nothing was repaired', async () => {
    selectMock.mockResolvedValue([pageRow('bbbb::nb-1', LEGACY_DOC)]);
    repairMock.mockResolvedValue({
      content: LEGACY_DOC,
      repaired: 0,
      skipped: [],
      changed: false,
    });

    const store = await freshStore();
    await store.getState().initialize();
    const page = await store.getState().fetchPage('bbbb::nb-1');

    expect(page?.content).toEqual(LEGACY_DOC);
  });

  it('🟥 passes the OWNING workspace root, not the first non-pinned one', async () => {
    selectMock.mockResolvedValue([pageRow('bbbb::nb-1', LEGACY_DOC)]);
    repairMock.mockResolvedValue({
      content: LEGACY_DOC,
      repaired: 0,
      skipped: [],
      changed: false,
    });

    const store = await freshStore();
    await store.getState().initialize();
    await store.getState().fetchPage('bbbb::nb-1');

    expect(repairMock).toHaveBeenCalledWith(LEGACY_DOC, WS_B);
    expect(repairMock, 'must never be handed the non-owning workspace').not.toHaveBeenCalledWith(
      LEGACY_DOC,
      WS_A
    );
  });

  it('also repairs on the DB-read path (page not preloaded)', async () => {
    selectMock.mockResolvedValueOnce([]).mockResolvedValueOnce([pageRow('bbbb::nb-2', LEGACY_DOC)]);
    repairMock.mockResolvedValue({
      content: REPAIRED_DOC,
      repaired: 1,
      skipped: [],
      changed: true,
    });

    const store = await freshStore();
    await store.getState().initialize();
    const page = await store.getState().fetchPage('bbbb::nb-2');

    expect(repairMock).toHaveBeenCalledTimes(1);
    expect(page?.content).toEqual(repairedDocument('legacy-2652f7da9e6cf482'));
  });
});
