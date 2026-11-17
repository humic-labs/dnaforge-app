import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb } from './__tests__/test-db';
import { seedOriginalProjectFixture } from './__tests__/original-project-fixture';
import { ensureSchema } from './schema';
import { TrackViewLibrary } from './track-view-library';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { reconstructFileBackedRegistryEntity } from './file-backed-registry-mutation';
import { settleEntityProjectionSourceInMain } from './entity-projection-receipts';
import { trackViewFixture } from '../shared/track-view-fixture';
import { parseTrackViewDocument, type SavedTrackView } from '../shared/track-view';
import { trackViewProjectionFields } from '../shared/track-view-projection';

let fixture: ReturnType<typeof createFileTestDb>;
let root: string;
let originalProject: ReturnType<typeof seedOriginalProjectFixture>;
let library: TrackViewLibrary;

beforeEach(async () => {
  fixture = createFileTestDb('unbound-track-view-registry');
  ensureSchema(fixture.db, fixture.dbPath);
  originalProject = seedOriginalProjectFixture(fixture.db);
  root = await mkdtemp(join(tmpdir(), 'fixture-unbound-track-library-'));
  library = new TrackViewLibrary(root);
});

afterEach(async () => {
  fixture.cleanup();
  await rm(root, { recursive: true, force: true });
});

function projectCatalog(saved: SavedTrackView) {
  const document = saved.document;
  const fields = trackViewProjectionFields(document);
  registerCatalogEntityInDb(fixture.db, {
    id: document.id,
    type: 'track-view',
    name: document.name,
    locator: `entity://track-view/${document.id}`,
    storageType: 'file',
    workspaceRoot: saved.workspaceRoot ?? null,
    metadata: {
      schema: document.schema,
      referenceId: document.reference.assemblyId,
      referenceName: document.reference.name,
      trackCount: fields.trackCount,
      fingerprint: fields.artifactFingerprint,
    },
  });
  bindCatalogEntityFileInDb(fixture.db, {
    entityId: document.id,
    path: saved.path,
    fileKind: 'dnaforge-track-view',
    workspaceRoot: saved.workspaceRoot ?? null,
    status: 'current',
  });
}

async function createSavedView() {
  const saved = await library.save({
    document: parseTrackViewDocument(
      JSON.stringify({ ...trackViewFixture(), name: 'Yeast detail draft' })
    ),
    expectedRevision: null,
  });
  expect(saved.workspaceRoot).toBeUndefined();
  projectCatalog(saved);
  const entity = await reconstructFileBackedRegistryEntity(
    fixture.db,
    {
      action: 'register',
      input: {
        id: saved.document.id,
        kind: 'track-view',
        name: saved.document.name,
        fields: trackViewProjectionFields(saved.document),
        registrationStatus: 'registered',
        domainStatus: null,
        workspaceId: saved.workspaceRoot ? originalProject.workspaceId : null,
        actor: 'track-view-file',
      },
    },
    (work) => work()
  );
  expect(entity).toMatchObject({
    name: 'Yeast detail draft',
    workspaceId: originalProject.workspaceId,
  });
  return saved;
}

describe('library Track view file and Registry ownership', () => {
  it('renames the Registry projection without moving the unbound file or its original project owner', async () => {
    const previous = await createSavedView();
    const renamed = await library.save({
      document: { ...previous.document, name: 'Yeast detail' },
      expectedRevision: previous.revision,
    });
    projectCatalog(renamed);
    expect(renamed.path).toBe(previous.path);
    expect(parseTrackViewDocument(await readFile(renamed.path, 'utf8')).name).toBe('Yeast detail');
    expect(
      fixture.db
        .prepare('SELECT name,workspace_id FROM catalog_entities WHERE id=?')
        .get(renamed.document.id)
    ).toEqual({ name: 'Yeast detail', workspace_id: null });
    expect(
      fixture.db
        .prepare(
          "SELECT workspace_id FROM catalog_entity_files WHERE entity_id=? AND status='current'"
        )
        .get(renamed.document.id)
    ).toEqual({ workspace_id: null });
    await expect(
      reconstructFileBackedRegistryEntity(
        fixture.db,
        {
          action: 'update',
          input: {
            id: renamed.document.id,
            name: renamed.document.name,
            fields: trackViewProjectionFields(renamed.document),
            replaceFields: true,
            registrationStatus: 'registered',
            domainStatus: null,
            workspaceId: renamed.workspaceRoot ? originalProject.workspaceId : null,
            actor: 'track-view-file',
          },
        },
        (work) => work()
      )
    ).resolves.toMatchObject({
      id: previous.document.id,
      name: 'Yeast detail',
      workspaceId: originalProject.workspaceId,
    });
  });

  it('settles the real native equality receipt for an unbound library file with its assigned Registry project', async () => {
    const saved = await createSavedView();
    await expect(
      settleEntityProjectionSourceInMain(fixture.db, {
        key: {
          adapterKind: 'track-view',
          entityId: saved.document.id,
          workspaceKey: 'unbound',
          relativePath: saved.path,
          projectionVersion: 1,
        },
        fingerprint: trackViewProjectionFields(saved.document).artifactFingerprint,
      })
    ).resolves.toBeUndefined();
  });
});

describe('library Track view Registry project retention', () => {
  it('keeps the first assigned Registry project after the default project changes', async () => {
    const saved = await createSavedView();
    const otherRoot = join(root, 'different-default');
    await (await import('node:fs/promises')).mkdir(otherRoot);
    fixture.db
      .prepare(
        'INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(?,?,?,?,?,?)'
      )
      .run(900_000_001, 'Different default', otherRoot, 'different-default', 'writable', 2);
    fixture.db
      .prepare('INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)')
      .run('default_workspace_path', otherRoot, Date.now());
    const renamed = await library.save({
      document: { ...saved.document, name: 'Retained owner' },
      expectedRevision: saved.revision,
    });
    projectCatalog(renamed);
    await expect(
      reconstructFileBackedRegistryEntity(
        fixture.db,
        {
          action: 'update',
          input: {
            id: renamed.document.id,
            name: renamed.document.name,
            fields: trackViewProjectionFields(renamed.document),
            replaceFields: true,
            workspaceId: null,
            actor: 'track-view-file',
          },
        },
        (work) => work()
      )
    ).resolves.toMatchObject({
      name: 'Retained owner',
      workspaceId: originalProject.workspaceId,
    });
    expect(
      fixture.db
        .prepare('SELECT workspace_id FROM catalog_entities WHERE id=?')
        .get(renamed.document.id)
    ).toEqual({ workspace_id: null });
    expect(
      fixture.db.prepare('SELECT value FROM settings WHERE key=?').get('default_workspace_path')
    ).toEqual({ value: otherRoot });
  });

  it('refuses an explicit different Registry project while preserving the native file binding', async () => {
    const saved = await createSavedView();
    await expect(
      reconstructFileBackedRegistryEntity(
        fixture.db,
        {
          action: 'update',
          input: {
            id: saved.document.id,
            name: saved.document.name,
            fields: trackViewProjectionFields(saved.document),
            replaceFields: true,
            workspaceId: 900_000_001,
            actor: 'track-view-file',
          },
        },
        (work) => work()
      )
    ).rejects.toThrow(/owning project|canonical file projection/);
    expect(
      fixture.db.prepare('SELECT workspace_id FROM lims_entity WHERE id=?').get(saved.document.id)
    ).toEqual({ workspace_id: originalProject.workspaceId });
    expect(
      fixture.db
        .prepare(
          "SELECT workspace_id,path FROM catalog_entity_files WHERE entity_id=? AND status='current'"
        )
        .get(saved.document.id)
    ).toEqual({ workspace_id: null, path: saved.path });
  });
});
