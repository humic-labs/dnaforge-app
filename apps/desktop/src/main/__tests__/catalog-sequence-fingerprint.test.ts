import { promises as fs } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeSequenceFingerprint } from '@waypoint/sequence-utils/sequence-fingerprint';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { FASTA_KIND_DECLARATION_EVENT } from '../../shared/fasta-kind';
import { refreshCatalogFileFingerprintsInDb } from '../catalog-projection-commands';
import {
  catalogWorkspaceFileAdmissionWitnessInDb,
  registerWorkspaceFileInDb,
  resolveWorkspaceFileSequenceFingerprintInDb,
} from '../catalog-entity-registration';
import {
  bindCatalogEntityFileInDb,
  resolveBindingSequenceFingerprint,
} from '../catalog-file-binding';

const NOW = 1_700_000_000_000;
const FIRST = 'ATGACCATGATTACGGATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTG';
const EDITED = 'ATGACCATGATTACGGATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTA';

describe('catalog sequence fingerprints (real SQLite)', () => {
  let root: string;
  let db: Database.Database;
  let path: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fixture-catalog-'));
    path = join(root, 'clone.fasta');
    db = createTestDb();
    db.pragma('foreign_keys = ON');
    ensureSchema(db, ':memory:');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at) VALUES (1, 'W', ?, ${NOW})`
    ).run(root);
    db.prepare(
      `INSERT INTO catalog_entities (id, type, name, locator, storage_type, status, workspace_id, created_at, updated_at)
       VALUES ('e1', 'sequence', 'clone', ?, 'file', 'active', 1, ${NOW}, ${NOW})`
    ).run(`file://${path}`);
  });
  afterEach(async () => {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function bind(contentHash: string) {
    const input = { entityId: 'e1', path, fileKind: 'fasta', workspaceRoot: root, contentHash };
    return bindCatalogEntityFileInDb(
      db,
      input,
      undefined,
      undefined,
      await resolveBindingSequenceFingerprint(db, input)
    );
  }

  const fingerprintOf = (residues: string) =>
    computeSequenceFingerprint({ kind: 'dna', topology: 'linear', residues });

  it('stores the fingerprint and finds the file by it', async () => {
    await writeFile(path, `>clone\n${FIRST}\n`);

    const row = await bind('git:1');

    expect(row.sequence_fingerprint).toBe(await fingerprintOf(FIRST));
    expect(
      db
        .prepare('SELECT path FROM catalog_entity_files WHERE sequence_fingerprint = ?')
        .all(await fingerprintOf(FIRST))
    ).toEqual([{ path }]);
  });

  it('reuses the stored fingerprint while the content hash is unchanged', async () => {
    await writeFile(path, `>clone\n${FIRST}\n`);
    await bind('git:1');
    await fs.rm(path);

    expect((await bind('git:1')).sequence_fingerprint).toBe(await fingerprintOf(FIRST));
  });

  it('recomputes when the content hash changes', async () => {
    await writeFile(path, `>clone\n${FIRST}\n`);
    await bind('git:1');
    await writeFile(path, `>clone\n${EDITED}\n`);

    expect((await bind('git:2')).sequence_fingerprint).toBe(await fingerprintOf(EDITED));
  });

  it('derives registration fingerprints through the native owner without declaring FASTA kind', async () => {
    await writeFile(path, `>clone\n${FIRST}\n`);
    const input = {
      path,
      fileKind: 'fasta',
      entityType: 'sequence' as const,
      workspaceRoot: root,
      contentHash: 'git:1',
    };
    const witness = catalogWorkspaceFileAdmissionWitnessInDb(db, input);
    const fingerprint = await resolveWorkspaceFileSequenceFingerprintInDb(db, input);
    const entity = registerWorkspaceFileInDb(db, input, fingerprint, witness);
    expect(
      db
        .prepare('SELECT sequence_fingerprint FROM catalog_entity_files WHERE entity_id=?')
        .get(entity.id)
    ).toEqual({ sequence_fingerprint: await fingerprintOf(FIRST) });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM catalog_entity_events WHERE event_type=?')
        .get(FASTA_KIND_DECLARATION_EVENT)
    ).toEqual({ count: 0 });
  });

  it('rejects changed registration authority after the fingerprint read', async () => {
    await writeFile(path, `>clone\n${FIRST}\n`);
    const input = {
      path,
      fileKind: 'fasta',
      entityType: 'sequence' as const,
      workspaceRoot: root,
      contentHash: 'git:1',
    };
    const witness = catalogWorkspaceFileAdmissionWitnessInDb(db, input);
    const fingerprint = await resolveWorkspaceFileSequenceFingerprintInDb(db, input);
    db.prepare("UPDATE catalog_entities SET name='changed' WHERE id='e1'").run();
    expect(() => registerWorkspaceFileInDb(db, input, fingerprint, witness)).toThrow(
      'registration authority changed while waiting'
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entity_files').get()).toEqual({
      count: 0,
    });
  });

  it('keeps the existing FASTA binding kind during generic fingerprint discovery', async () => {
    await writeFile(path, `>clone\n${FIRST}\n`);
    await bind('git:1');
    const input = {
      path,
      fileKind: 'genbank',
      entityType: 'protein' as const,
      workspaceRoot: root,
      contentHash: 'git:1',
    };
    const witness = catalogWorkspaceFileAdmissionWitnessInDb(db, input);
    const fingerprint = await resolveWorkspaceFileSequenceFingerprintInDb(db, input);
    const entity = registerWorkspaceFileInDb(db, input, fingerprint, witness);
    expect(entity.type).toBe('sequence');
    expect(
      db
        .prepare(
          'SELECT file_kind,sequence_fingerprint FROM catalog_entity_files WHERE entity_id=?'
        )
        .get(entity.id)
    ).toEqual({ file_kind: 'fasta', sequence_fingerprint: await fingerprintOf(FIRST) });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM catalog_entity_events WHERE event_type=?')
        .get(FASTA_KIND_DECLARATION_EVENT)
    ).toEqual({ count: 0 });
  });

  it('preserves matching refresh fingerprints and clears them before changed-source recomputation', async () => {
    await writeFile(path, `>clone\n${FIRST}\n`);
    const binding = await bind('git:1');
    refreshCatalogFileFingerprintsInDb(db, [{ ...binding, workspace_id: 1 }]);
    expect(
      db.prepare('SELECT sequence_fingerprint FROM catalog_entity_files WHERE id=?').get(binding.id)
    ).toEqual({ sequence_fingerprint: await fingerprintOf(FIRST) });
    await writeFile(path, `>clone\n${EDITED}\n`);
    refreshCatalogFileFingerprintsInDb(db, [
      { ...binding, workspace_id: 1, content_hash: 'git:2' },
    ]);
    expect(
      db
        .prepare('SELECT content_hash,sequence_fingerprint FROM catalog_entity_files WHERE id=?')
        .get(binding.id)
    ).toEqual({ content_hash: 'git:2', sequence_fingerprint: null });
    expect((await bind('git:2')).sequence_fingerprint).toBe(await fingerprintOf(EDITED));
  });
});
