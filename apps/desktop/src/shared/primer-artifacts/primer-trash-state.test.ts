import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLimsTestBridge } from '../../main/__tests__/lims-bridge-for-db';
import { setCatalogFileStateInDb } from '../../main/catalog-projection-commands';
import { createPrimerTrashReader } from './primer-trash-state';
import type { PrimerRecoveryDependencies } from './primer-recovery-port';
import type { SqliteIpcValue } from '../sqlite-ipc';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '1.0.0'), exit: vi.fn() },
}));

const unused = async (): Promise<never> => {
  throw new Error('The Trash reader must only read catalog state.');
};
const entityId = '00000000-0000-4000-9000-000000000001';
let fixture: ReturnType<typeof createLimsTestBridge>;
let root: string;
let path: string;
let clock: number;

beforeEach(() => {
  fixture = createLimsTestBridge({ withOriginalProject: false });
  root = mkdtempSync(join(tmpdir(), 'primer-trash-state-'));
  path = join(root, 'primers', 'Trashed.primer.json');
  clock = 1_800_000_000_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  fixture.db
    .prepare('INSERT INTO workspaces (id,name,path,repo_uuid,created_at) VALUES (?,?,?,?,?)')
    .run(4, 'My Project', root, '00000000-0000-4000-8000-000000000004', 1);
  fixture.db
    .prepare(
      'INSERT INTO catalog_entities (id,type,name,locator,storage_type,workspace_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(entityId, 'primer', 'Trashed', `primer:${entityId}`, 'file', 4, 1, 1);
  fixture.db
    .prepare(
      'INSERT INTO catalog_entity_files (id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run('primer-file', entityId, 4, path, 'primer-artifact', 'current', 1, 1);
});

afterEach(() => {
  vi.useRealTimers();
  fixture.db.close();
  rmSync(root, { recursive: true, force: true });
});

function markMissing(reason: string) {
  vi.setSystemTime((clock += 1_000));
  setCatalogFileStateInDb(fixture.db, path, 'missing', reason);
}

function trashReader() {
  const dependencies: PrimerRecoveryDependencies = {
    io: () => ({
      db: {
        select: async <T>(sql: string, params: SqliteIpcValue[] = []): Promise<T> =>
          fixture.db.prepare(sql).all(...params) as T,
      },
      workspace: { getOriginalDefaultProject: unused },
      fs: {
        exists: async () => false,
        readTextFile: unused,
        validateWorkspacePath: unused,
        writeWorkspaceTextFileAtomic: unused,
      },
    }),
    setSetting: unused,
    withRendererWorkspaceMutation: unused,
    getLimsRegistryPreview: unused,
    buildFileDnaSequenceRef: unused,
    generateCatalogNumber: unused,
    findTrashedPrimerDocument: unused,
    readPrimerRegistryRelationships: unused,
  };
  return createPrimerTrashReader(dependencies);
}

it.each([
  ['Git discovery reports the trashed file missing afterwards', ['moved-to-trash', 'git-indexer']],
  [
    'Git discovery reported the file missing before Trash recorded it',
    ['git-indexer', 'moved-to-trash'],
  ],
])('keeps the Trash reason when %s', async (_case, reasons) => {
  for (const reason of reasons) markMissing(reason);
  expect(
    fixture.db
      .prepare(
        "SELECT COUNT(*) AS count FROM catalog_entity_events WHERE event_type='file_missing'"
      )
      .get()
  ).toEqual({ count: 2 });
  await expect(trashReader().findTrashedPrimerDocument(entityId, path)).resolves.toMatchObject({
    path,
    workspace_id: 4,
    status: 'missing',
    file_kind: 'primer-artifact',
  });
});

it('does not treat a permanent delete after Trash as a Trash entry', async () => {
  markMissing('moved-to-trash');
  markMissing('deleted');
  markMissing('git-indexer');
  await expect(trashReader().findTrashedPrimerDocument(entityId, path)).resolves.toBeNull();
});

it('does not explain a later disappearance with an earlier Trash action', async () => {
  markMissing('moved-to-trash');
  vi.setSystemTime((clock += 1_000));
  fixture.db
    .prepare("UPDATE catalog_entity_files SET status='current',missing_since=NULL WHERE path=?")
    .run(path);
  markMissing('git-indexer');
  await expect(trashReader().findTrashedPrimerDocument(entityId, path)).resolves.toBeNull();
});
