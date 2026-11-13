/** @vitest-environment node */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrimerLegacyProjectionInput } from '../shared/primer-projection-ipc';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
}));

import { createTestDb } from './__tests__/test-db';
import { createLimsBridgeForDb } from './__tests__/lims-bridge-for-db';
import { ensureSchema } from './schema';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { bindCatalogEntityFileInDb } from './catalog-file-binding';
import { ensureWorkspaceOwnerInDb, setCatalogFileStateInDb } from './catalog-projection-commands';
import { replacePrimerLegacyProjectionInDb } from './primer-projection';
import {
  buildPrimerArtifact,
  primerLegacyProjectionFromArtifact,
  serializePrimerArtifact,
  type PrimerArtifactV1,
} from '../features/primers/public/primer-artifact';
import { primerFromProjectionRow } from '../shared/primer-artifacts/primer-repository';
import type { DbPrimerRow } from '../shared/primer-artifacts/types';

describe('canonical primer native projection authority', () => {
  let db: Database.Database;
  let root: string;
  let path: string;
  let artifact: PrimerArtifactV1;
  let projection: PrimerLegacyProjectionInput;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'dnaforge-primer-authority-'));
    path = join(root, 'Canonical.primer.json');
    db = createTestDb();
    ensureSchema(db, ':memory:');
    const workspaceId = ensureWorkspaceOwnerInDb(db, root);
    artifact = await buildPrimerArtifact({
      id: 'canonical-primer',
      catalogNumber: 'P901',
      name: 'Canonical',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot: root,
      artifactPath: path,
    });
    const content = serializePrimerArtifact(artifact);
    writeFileSync(path, content);
    registerCatalogEntityInDb(db, {
      id: artifact.id,
      type: 'primer',
      name: artifact.name,
      locator: `waypoint://primer/${artifact.id}`,
      storageType: 'file',
      workspaceRoot: root,
      metadata: { artifactRevision: artifact.artifactRevision },
    });
    bindCatalogEntityFileInDb(db, {
      entityId: artifact.id,
      path,
      fileKind: 'primer-artifact',
      workspaceRoot: root,
      contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    });
    projection = primerLegacyProjectionFromArtifact(artifact, workspaceId, []);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('publishes only the shared projection derived from the real canonical artifact', () => {
    replacePrimerLegacyProjectionInDb(db, projection);
    expect(db.prepare('SELECT id,name,sequence FROM primers').all()).toEqual([
      { id: artifact.id, name: artifact.name, sequence: artifact.sequence.bases },
    ]);
    const before = db.prepare('SELECT * FROM primers').all();
    expect(() => replacePrimerLegacyProjectionInDb(db, { ...projection, name: 'Bypass' })).toThrow(
      /authoritative artifact/
    );
    expect(db.prepare('SELECT * FROM primers').all()).toEqual(before);
    expect(readFileSync(path, 'utf8')).toBe(serializePrimerArtifact(artifact));
  });

  it('refuses changed file bytes or a claimed artifact with no native binding before creating a projection', () => {
    writeFileSync(path, serializePrimerArtifact({ ...artifact, name: 'Changed externally' }));
    expect(() => replacePrimerLegacyProjectionInDb(db, projection)).toThrow(
      /changed before projection/
    );
    expect(() => replacePrimerLegacyProjectionInDb(db, { ...projection, id: 'phantom' })).toThrow(
      /no native artifact binding/
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM primers').get()).toEqual({ count: 0 });
  });

  it('refuses an existing canonical identity whose caller removes its authority marker and native binding', () => {
    replacePrimerLegacyProjectionInDb(db, projection);
    db.prepare('DELETE FROM catalog_entity_files WHERE entity_id=?').run(artifact.id);
    expect(() =>
      replacePrimerLegacyProjectionInDb(db, { ...projection, originDetails: {}, name: 'Bypass' })
    ).toThrow(/no native artifact binding/);
    expect(db.prepare('SELECT name FROM primers WHERE id=?').get(artifact.id)).toEqual({
      name: artifact.name,
    });
  });

  it('refuses a forged binding set that the artifact does not contain', () => {
    expect(() =>
      replacePrimerLegacyProjectionInDb(db, {
        ...projection,
        bindings: [
          {
            id: 'forged',
            sequenceId: 9876,
            bindingStart: 1,
            bindingEnd: 20,
            strand: 1,
            source: 'manual',
          },
        ],
      })
    ).toThrow(/authoritative artifact/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM primers').get()).toEqual({ count: 0 });
  });

  it('retires compatibility rows only after real file removal, checked binding retirement and Registry archive', async () => {
    const lims = createLimsBridgeForDb(db);
    await lims.registerEntity({
      id: artifact.id,
      kind: 'oligo',
      name: artifact.name,
      fields: {
        sequence: {
          mode: 'inline',
          bases: artifact.sequence.bases,
          length: artifact.sequence.bases.length,
          topology: 'linear',
        },
      },
      workspaceId: projection.workspaceId,
      actor: 'test',
    });
    replacePrimerLegacyProjectionInDb(db, projection);
    const retirement = {
      ...projection,
      retireArtifact: {
        artifactPath: artifact.file.workspaceRelativePath,
        expectedArtifactRevision: artifact.artifactRevision,
      },
    };
    expect(() => replacePrimerLegacyProjectionInDb(db, retirement)).toThrow(/checked file removal/);
    unlinkSync(path);
    setCatalogFileStateInDb(db, path, 'historical', 'primer-deleted');
    expect(() => replacePrimerLegacyProjectionInDb(db, retirement)).toThrow(/archived Registry/);
    await lims.archiveEntity({ id: artifact.id, actor: 'test' });
    replacePrimerLegacyProjectionInDb(db, retirement);
    expect(db.prepare('SELECT COUNT(*) AS count FROM primers').get()).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT status FROM catalog_entity_files WHERE entity_id=?').get(artifact.id)
    ).toEqual({ status: 'historical' });
  });

  it('retires a trashed primer from its stored library row and recorded revision', async () => {
    const lims = createLimsBridgeForDb(db);
    await lims.registerEntity({
      id: artifact.id,
      kind: 'oligo',
      name: artifact.name,
      fields: {
        sequence: {
          mode: 'inline',
          bases: artifact.sequence.bases,
          length: artifact.sequence.bases.length,
          topology: 'linear',
        },
      },
      workspaceId: projection.workspaceId,
      actor: 'test',
    });
    replacePrimerLegacyProjectionInDb(db, projection);
    unlinkSync(path);
    setCatalogFileStateInDb(db, path, 'missing', 'moved-to-trash');
    setCatalogFileStateInDb(db, path, 'missing', 'git-indexer');
    await lims.archiveEntity({ id: artifact.id, actor: 'test' });
    const primer = primerFromProjectionRow(
      db.prepare('SELECT * FROM primers WHERE id=?').get(artifact.id) as DbPrimerRow
    );
    const { metadata } = db
      .prepare('SELECT metadata FROM catalog_entities WHERE id=?')
      .get(artifact.id) as { metadata: string };
    replacePrimerLegacyProjectionInDb(db, {
      ...primer,
      originDetails: primer.originDetails ?? {},
      bindings: [],
      retireArtifact: {
        artifactPath: String(primer.originDetails?.artifactPath),
        expectedArtifactRevision: Number(JSON.parse(metadata).artifactRevision),
      },
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM primers').get()).toEqual({ count: 0 });
  });
});
