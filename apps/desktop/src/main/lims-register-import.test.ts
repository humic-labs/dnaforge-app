import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

vi.mock('electron', () => ({
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: vi.fn(), getVersion: vi.fn(() => '1.0.0') },
}));

vi.mock('../features/lims/operations', () => ({
  queryLimsEntities: vi.fn(async () => []),
  applyLimsImportBatch: vi.fn(),
}));

import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { createEmptyManagedWorkspace } from './workspace-git/import';
import { undoLimsImportBatchInDb } from './lims-import';
import { queryLimsEntitiesInDb } from './lims';
import { createLimsImportPlan } from '../features/lims/ingress';
import { queryLimsEntities } from '../features/lims/operations';
import {
  countSequenceRecords,
  registerImportedSequenceFile,
  registerImportedSequenceFromContent,
} from './lims-register-import';
import { readFileSync } from 'node:fs';
import { parseSequencePackageDocument, sequencePackageMetaPaths } from '../db/sequence-package';
import { hasWorkingChanges, readFileAtHead } from './workspace-git';

const SINGLE_FASTA = '>seq1 my plasmid\nACGTACGTACGTACGTACGTACGTACGTACGT\n';
const MULTI_FASTA =
  '>seq1 DNA gene\nACGTACGTACGTACGTACGT\n' +
  '>seq2 DNA gene\nTTTTGGGGCCCCAAAATTTT\n' +
  '>seq3 DNA gene\nGGGGCCCCAAAATTTTGGGG\n';
const DUPLICATE_MULTI_FASTA =
  '>first DNA construct\nACGTACGTACGTACGTACGT\n' + '>second DNA construct\nACGTACGTACGTACGTACGT\n';

function activeEntityRow(
  db: Database.Database,
  id: string
): { id: string; kind: string; tombstone: number; fields: string } | undefined {
  return db.prepare('SELECT id, kind, tombstone, fields FROM lims_entity WHERE id = ?').get(id) as
    | { id: string; kind: string; tombstone: number; fields: string }
    | undefined;
}

describe('registerImportedSequenceFile — COPY→REGISTER JOIN  Phase 0)', () => {
  let db: Database.Database;
  let tmp: string;
  let managedRoot: string;
  let targetRoot: string;
  let sourceDir: string;

  it('registers the original SnapGene bytes confirmed by native preview', async () => {
    const bytes = readFileSync(
      resolve(__dirname, '../../../..', 'test-fixtures/import-formats/pUC19.dna')
    );
    const sourcePath = join(sourceDir, 'real-pUC19.dna');
    writeFileSync(sourcePath, bytes);
    const expectedSourceSha256 = createHash('sha256').update(bytes).digest('hex');
    const result = await registerImportedSequenceFile(
      { sourcePath, targetRoot, expectedSourceSha256 },
      { db, managedRootDir: managedRoot }
    );
    expect(result.registered).toBe(true);
    expect(result.entityIds).toHaveLength(1);
    const owner = db.prepare('SELECT id FROM workspaces WHERE path = ?').get(targetRoot) as {
      id: number;
    };
    expect(
      db.prepare('SELECT workspace_id FROM lims_entity WHERE id = ?').get(result.entityIds[0])
    ).toEqual({ workspace_id: owner.id });
    expect(result.destPath).toMatch(/\.gb$/);
    expect(readFileSync(sourcePath)).toEqual(bytes);
  });

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    tmp = mkdtempSync(join(tmpdir(), 'wp-register-import-'));
    managedRoot = join(tmp, 'managed-workspaces');
    sourceDir = join(tmp, 'src');
    mkdirSync(sourceDir, { recursive: true });

    const ws = await createEmptyManagedWorkspace('Registry Target', {
      db,
      managedRootDir: managedRoot,
    });
    targetRoot = ws.repoPath;
    vi.mocked(queryLimsEntities).mockImplementation(async (input = {}) =>
      queryLimsEntitiesInDb(db, input)
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('countSequenceRecords counts FASTA and GenBank records', () => {
    expect(countSequenceRecords(SINGLE_FASTA)).toBe(1);
    expect(countSequenceRecords(MULTI_FASTA)).toBe(3);
    expect(countSequenceRecords('LOCUS a 10 bp\n//\nLOCUS b 10 bp\n//\n')).toBe(2);
    expect(countSequenceRecords('')).toBe(0);
  });

  it('copies the file into the managed root AND registers it, capturing the batch id', async () => {
    const source = join(sourceDir, 'plasmid.fasta');
    writeFileSync(source, SINGLE_FASTA);

    const result = await registerImportedSequenceFile(
      { sourcePath: source, targetRoot },
      { db, managedRootDir: managedRoot }
    );

    expect(result.destPath.startsWith(targetRoot)).toBe(true);
    expect(existsSync(result.destPath)).toBe(true);
    expect(existsSync(source)).toBe(true);

    expect(result.registered).toBe(true);
    expect(result.batchId).toBeTruthy();
    expect(result.entityIds).toHaveLength(1);

    const row = activeEntityRow(db, result.entityIds[0]);
    expect(row).toBeDefined();
    expect(row!.tombstone).toBe(0);
    expect(row!.kind).toBe('sequence');
    const fields = JSON.parse(row!.fields) as Record<string, unknown>;

    const seq = fields.sequence as { mode?: string; relPath?: string; fileContentHash?: string };
    expect(seq.mode).toBe('file');
    expect(seq.relPath).toBe(result.destPath);
    expect(seq.fileContentHash).toMatch(/^sha256:/);
    expect(fields._managedSequenceDocument).toMatchObject({
      kind: 'managed-sequence',
      packageId: result.entityIds[0],
    });

    const provenance = fields.sourceMetadata as {
      origin?: { type?: string; sourceName?: string };
    };
    expect(provenance.origin?.type).toBe('file_import');

    expect(provenance.origin?.sourceName).toBe('plasmid.gb');
  });

  it('accepts an unchanged BOM-prefixed file whose preview used browser text bytes', async () => {
    const source = join(sourceDir, 'bom-plasmid.fasta');
    writeFileSync(source, `\uFEFF${SINGLE_FASTA}`);
    const previewSha256 = createHash('sha256').update(SINGLE_FASTA).digest('hex');

    const result = await registerImportedSequenceFile(
      { sourcePath: source, targetRoot, expectedSourceSha256: previewSha256 },
      { db, managedRootDir: managedRoot }
    );

    expect(result.registered).toBe(true);
    const [registered] = queryLimsEntitiesInDb(db, { id: result.entityIds[0], limit: 1 });
    expect(registered.fields.sourceMetadata).toMatchObject({
      values: {
        sourceFileContentHash: `sha256:${createHash('sha256').update(readFileSync(source)).digest('hex')}`,
      },
    });
    expect(await hasWorkingChanges(targetRoot)).toBe(false);
  });

  it('preserves a pathless source identity through conversion so an exact re-preview skips', async () => {
    const sourceSha256 = createHash('sha256').update(SINGLE_FASTA).digest('hex');

    const result = await registerImportedSequenceFromContent(
      {
        content: SINGLE_FASTA,
        fileName: 'exact-reimport.fasta',
        targetRoot,
        expectedSourceSha256: sourceSha256,
      },
      { db, managedRootDir: managedRoot }
    );

    expect(result.registered).toBe(true);
    const [registered] = queryLimsEntitiesInDb(db, { id: result.entityIds[0], limit: 1 });
    expect(registered.fields.sequence).not.toMatchObject({
      fileContentHash: `sha256:${sourceSha256}`,
    });
    expect(registered.fields.sourceMetadata).toMatchObject({
      values: {
        sourceFileContentHash: `sha256:${sourceSha256}`,
        sourceRecordIndex: 0,
        sourceRecordCount: 1,
      },
    });
    const packageMetaPath = sequencePackageMetaPaths(dirname(result.destPath)).find((path) =>
      existsSync(path)
    );
    if (!packageMetaPath) throw new Error('Managed package metadata is missing.');
    const packageDocument = parseSequencePackageDocument(readFileSync(packageMetaPath, 'utf8'));
    expect(packageDocument.entity.fields.sourceMetadata).toMatchObject({
      values: {
        sourceFileContentHash: `sha256:${sourceSha256}`,
        sourceRecordIndex: 0,
        sourceRecordCount: 1,
      },
    });
    expect(await hasWorkingChanges(targetRoot)).toBe(false);
    const committedPackageDocument = parseSequencePackageDocument(
      (
        await readFileAtHead(
          targetRoot,
          relative(targetRoot, packageMetaPath).split('\\').join('/')
        )
      ).toString('utf8')
    );
    expect(committedPackageDocument.entity.fields.sourceMetadata).toEqual(
      packageDocument.entity.fields.sourceMetadata
    );

    const preview = await createLimsImportPlan({
      fileName: 'exact-reimport.fasta',
      text: SINGLE_FASTA,
      forcedKind: 'sequence',
    });

    expect(preview.records[0]).toMatchObject({
      accepted: false,
      action: 'skip',
      duplicateCandidates: [
        {
          entityId: result.entityIds[0],
          reason: expect.stringMatching(/original source-file record/i),
        },
      ],
    });
  });

  it('rolls package provenance back when its managed Git commit fails', async () => {
    const result = await registerImportedSequenceFromContent(
      {
        content: SINGLE_FASTA,
        fileName: 'provenance-commit-failure.fasta',
        targetRoot,
      },
      {
        db,
        managedRootDir: managedRoot,
        commitPathsIfDirty: vi
          .fn()
          .mockRejectedValue(new Error('forced provenance commit failure')),
      }
    );

    expect(result).toMatchObject({ committed: true, registered: false });
    expect(result.reason).toMatch(/forced provenance commit failure/i);
    const packageMetaPath = sequencePackageMetaPaths(dirname(result.destPath)).find((path) =>
      existsSync(path)
    );
    if (!packageMetaPath) throw new Error('Managed package metadata is missing.');
    const workingDocument = parseSequencePackageDocument(readFileSync(packageMetaPath, 'utf8'));
    expect(workingDocument.entity.fields.sourceMetadata).toBeUndefined();
    const headDocument = parseSequencePackageDocument(
      (
        await readFileAtHead(
          targetRoot,
          relative(targetRoot, packageMetaPath).split('\\').join('/')
        )
      ).toString('utf8')
    );
    expect(headDocument).toEqual(workingDocument);
    expect(await hasWorkingChanges(targetRoot)).toBe(false);
    expect(queryLimsEntitiesInDb(db, { limit: 100 })).toEqual([]);
  });

  it('a registered file → gone after undoLimsImportBatchInDb (reversible)', async () => {
    const source = join(sourceDir, 'reversible.fasta');
    writeFileSync(source, SINGLE_FASTA);

    const result = await registerImportedSequenceFile(
      { sourcePath: source, targetRoot },
      { db, managedRootDir: managedRoot }
    );
    expect(result.registered).toBe(true);

    expect(activeEntityRow(db, result.entityIds[0])!.tombstone).toBe(0);

    const undo = undoLimsImportBatchInDb(db, { batchId: result.batchId! });
    expect(undo.tombstonedEntities).toBe(1);

    expect(activeEntityRow(db, result.entityIds[0])!.tombstone).toBe(1);

    expect(existsSync(result.destPath)).toBe(true);
  });

  it('ZERO SILENT DATA LOSS: a multi-record file splits into packages and registers EVERY record', async () => {
    const source = join(sourceDir, 'multi.fasta');
    writeFileSync(source, MULTI_FASTA);

    const before = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };

    const result = await registerImportedSequenceFile(
      { sourcePath: source, targetRoot },
      { db, managedRootDir: managedRoot }
    );

    expect(existsSync(result.destPath)).toBe(true);
    expect(result.registered).toBe(true);
    expect(result.entityIds).toHaveLength(3);
    expect(result.packageProductPaths).toHaveLength(3);
    expect(result.packageProductPaths?.every((path) => existsSync(path))).toBe(true);

    expect(result.batchId).not.toBeNull();

    const sourceFileContentHash = `sha256:${createHash('sha256').update(MULTI_FASTA).digest('hex')}`;
    result.entityIds.forEach((entityId, sourceRecordIndex) => {
      const [entity] = queryLimsEntitiesInDb(db, { id: entityId, limit: 1 });
      expect(entity.fields.sourceMetadata).toMatchObject({
        values: {
          sourceFileContentHash,
          sourceRecordIndex,
          sourceRecordCount: 3,
        },
      });
    });

    const after = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };
    expect(after.n).toBe(before.n + 3);
  });

  it('splits and atomically registers every record in a real multi-record GenBank', async () => {
    const first = readFileSync(
      join(__dirname, '../../../../test-fixtures/sequences/circular/pUC19.gb'),
      'utf8'
    );
    const second = readFileSync(
      join(
        __dirname,
        '../../../../test-fixtures/sequences/linear/structure-mg1655-mioc-ape-label.gb'
      ),
      'utf8'
    );
    const source = join(sourceDir, 'multi.gb');
    writeFileSync(source, `${first.trimEnd()}\n${second}`);
    const before = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };

    const result = await registerImportedSequenceFile(
      { sourcePath: source, targetRoot },
      { db, managedRootDir: managedRoot }
    );

    expect(result.registered).toBe(true);
    expect(result.entityIds).toHaveLength(2);
    expect(result.batchId).not.toBeNull();
    const after = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };
    expect(after.n).toBe(before.n + 2);
    for (const entityId of result.entityIds) {
      const fields = JSON.parse(activeEntityRow(db, entityId)!.fields) as Record<string, unknown>;
      expect(fields._managedSequenceDocument).toMatchObject({
        kind: 'managed-sequence',
        packageId: entityId,
      });
    }
  });

  it('registers a multi-record package set atomically when a later record is a duplicate', async () => {
    const source = join(sourceDir, 'duplicate-records.fasta');
    writeFileSync(source, DUPLICATE_MULTI_FASTA);
    const before = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };

    const result = await registerImportedSequenceFile(
      { sourcePath: source, targetRoot },
      { db, managedRootDir: managedRoot }
    );

    const after = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };

    expect(existsSync(result.destPath)).toBe(true);
    expect(result.registered).toBe(false);
    expect(result.entityIds).toEqual([]);
    expect(result.reason).toMatch(/duplicate|import batch rejected/i);
    expect(after.n).toBe(before.n);
  });

  it('uses the package sequence kind and honors a provided batch id', async () => {
    const source = join(sourceDir, 'chr.fasta');
    writeFileSync(source, SINGLE_FASTA);

    const result = await registerImportedSequenceFile(
      { sourcePath: source, targetRoot, kind: 'sequence', batchId: 'fixed-batch-xyz' },
      { db, managedRootDir: managedRoot }
    );
    expect(result.registered).toBe(true);
    expect(result.batchId).toBe('fixed-batch-xyz');
    expect(activeEntityRow(db, result.entityIds[0])!.kind).toBe('sequence');
  });

  describe('registerImportedSequenceFromContent — CONTENT→WRITE→REGISTER (no source path)', () => {
    it('materializes the content into the managed root AND registers it file-backed', async () => {
      const result = await registerImportedSequenceFromContent(
        { content: SINGLE_FASTA, fileName: 'dropped-plasmid.fasta', targetRoot },
        { db, managedRootDir: managedRoot }
      );

      expect(result.destPath.startsWith(targetRoot)).toBe(true);
      expect(existsSync(result.destPath)).toBe(true);
      expect(result.destPath.endsWith('.gb')).toBe(true);
      const written = readFileSync(result.destPath, 'utf8');
      expect(written).toContain('LOCUS');

      const origin = written.slice(written.indexOf('ORIGIN') + 'ORIGIN'.length);
      const bases = origin.replace(/[^acgtnACGTN]/g, '').toUpperCase();
      expect(bases).toBe(SINGLE_FASTA.split('\n').slice(1).join('').toUpperCase());

      expect(result.registered).toBe(true);
      expect(result.batchId).toBeTruthy();
      expect(result.entityIds).toHaveLength(1);

      const row = activeEntityRow(db, result.entityIds[0]);
      expect(row!.kind).toBe('sequence');
      const fields = JSON.parse(row!.fields) as Record<string, unknown>;
      const seq = fields.sequence as { mode?: string; relPath?: string };
      expect(seq.mode).toBe('file');
      expect(seq.relPath).toBe(result.destPath);
    });

    it('ZERO SILENT DATA LOSS: multi-record content splits and registers EVERY record', async () => {
      const before = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };
      const result = await registerImportedSequenceFromContent(
        { content: MULTI_FASTA, fileName: 'multi.fasta', targetRoot },
        { db, managedRootDir: managedRoot }
      );

      expect(existsSync(result.destPath)).toBe(true);
      expect(result.registered).toBe(true);
      expect(result.entityIds).toHaveLength(3);
      expect(result.batchId).not.toBeNull();
      const after = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };
      expect(after.n).toBe(before.n + 3);
    });

    it('keeps an unpackageable file but does not create a bare Registry entity', async () => {
      const before = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };
      const result = await registerImportedSequenceFromContent(
        {
          content: 'This is not nucleotide sequence data.\n',
          fileName: 'not-a-sequence.fasta',
          targetRoot,
        },
        { db, managedRootDir: managedRoot }
      );

      expect(existsSync(result.destPath)).toBe(true);
      expect(result.registered).toBe(false);
      expect(result.entityIds).toEqual([]);
      expect(result.reason).toMatch(/no managed sequence package.*registry was not changed/is);
      const after = db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get() as { n: number };
      expect(after.n).toBe(before.n);
    });

    it('refuses an unknown (non-managed) workspace root before writing', async () => {
      const strayRoot = join(tmp, 'not-a-workspace');
      mkdirSync(strayRoot, { recursive: true });
      await expect(
        registerImportedSequenceFromContent(
          { content: SINGLE_FASTA, fileName: 'x.fasta', targetRoot: strayRoot },
          { db, managedRootDir: managedRoot }
        )
      ).rejects.toThrow(/unknown project root/i);
    });
  });
});
