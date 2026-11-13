import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { createFileTestDb } from './test-db';
import { ensureSchema } from '../schema';
import { ensureWorkspaceOwnerInDb } from '../catalog-projection-commands';
import { registerWorkspaceFileInDb } from '../catalog-entity-registration';
import { createEntityReferenceInDb } from '../entity-reference-commands';
import { prepareEntityReferenceRow } from '../../shared/entity-reference-ipc';
import {
  classifyFastaInMain,
  getFastaKindAuthorityInMain,
  getFastaKindReadAuthorityInDb,
} from '../fasta-kind-authority';
import { ensureSequenceIndexInDb } from '../sequence-index-command';
import { saveSequenceDocumentWithLineage } from '../sequence-document-save';
import { FASTA_KIND_DECLARATION_EVENT } from '../../shared/fasta-kind';

let fixture: ReturnType<typeof createFileTestDb>;
let db: Database.Database;
let root: string;
function source(name: string) {
  const path = join(root, name);
  writeFileSync(path, '>source\nACGT\n');
  const entity = registerWorkspaceFileInDb(db, {
    path,
    workspaceRoot: root,
    fileKind: 'fasta',
    entityType: 'sequence',
  });
  return { path, entity };
}
function reference(entityId: string, locator = `entity://sequence/${entityId}`) {
  return prepareEntityReferenceRow({
    entityType: 'sequence_region',
    displayLabel: 'Source bases 1–4',
    locator,
    deepLinkParams: { start: 1, end: 4 },
    data: null,
    source: 'user',
    workspaceScope: null,
    workspaceRootPath: root,
  });
}
function saveInput(entityId: string, path: string) {
  const sequence: AnnotatedSequence = {
    id: entityId,
    name: 'source',
    sequence: 'AACGT',
    length: 5,
    circular: false,
    annotations: [],
  };
  return {
    documentId: entityId,
    sourcePath: path,
    capture: {
      sequence,
      draftBaseline: { sequence: 'ACGT', length: 4, circular: false },
      draftSequence: 'AACGT',
      insertedRanges: [{ start: 0, end: 1 }],
      deletedRanges: [],
      substitutedRanges: [],
      draftLineageId: 'native-fasta-draft',
    },
  };
}
function historyCount() {
  return db
    .prepare('SELECT COUNT(*) AS count FROM catalog_entity_events WHERE event_type=?')
    .get(FASTA_KIND_DECLARATION_EVENT) as { count: number };
}

beforeEach(() => {
  fixture = createFileTestDb('fasta-authoring');
  db = fixture.db;
  ensureSchema(db, fixture.dbPath);
  root = join(fixture.tmpDir, 'workspace');
  mkdirSync(root);
  ensureWorkspaceOwnerInDb(db, root);
});
afterEach(() => fixture.cleanup());

describe('native FASTA scientific authoring admission', () => {
  it.each(['Legacy.faa', 'Legacy.fa'])(
    'refuses canonical and historical scientific reference authoring for undeclared %s',
    (name) => {
      const current = source(name);
      const bytes = readFileSync(current.path);
      expect(() => createEntityReferenceInDb(db, reference(current.entity.id))).toThrow(
        'FASTA_KIND_CLASSIFICATION_REQUIRED'
      );
      expect(() =>
        createEntityReferenceInDb(db, reference(current.entity.id, `git://HEAD/${name}`))
      ).toThrow('FASTA_KIND_CLASSIFICATION_REQUIRED');
      expect(db.prepare('SELECT * FROM entity_references').all()).toEqual([]);
      expect(readFileSync(current.path)).toEqual(bytes);
      expect(historyCount().count).toBe(0);
    }
  );

  it('repairs a source-equal legacy nucleotide index without upgrading its scientific authority', () => {
    const current = source('Legacy.fa');
    const input = {
      documentId: current.entity.id,
      filePath: current.path,
      workspaceRoot: root,
    };
    const index = ensureSequenceIndexInDb(db, input);
    expect(ensureSequenceIndexInDb(db, input)).toBe(index);
    expect(db.prepare('SELECT document_id,length FROM sequences WHERE id=?').get(index)).toEqual({
      document_id: current.entity.id,
      length: 4,
    });
    expect(
      getFastaKindReadAuthorityInDb(db, { path: current.path, workspaceRoot: root })
    ).toMatchObject({
      status: 'legacy-compatible',
      storedKind: 'sequence',
      legacyReadView: 'sequence',
      readOnly: true,
    });
    expect(() => createEntityReferenceInDb(db, reference(current.entity.id))).toThrow(
      'FASTA_KIND_CLASSIFICATION_REQUIRED'
    );
    expect(historyCount().count).toBe(0);
  });

  it('refuses to manufacture a nucleotide index from an ambiguous historical protein view', () => {
    const current = source('Legacy.faa');
    expect(() =>
      ensureSequenceIndexInDb(db, {
        documentId: current.entity.id,
        filePath: current.path,
        workspaceRoot: root,
      })
    ).toThrow('FASTA_KIND_CLASSIFICATION_REQUIRED');
    expect(db.prepare('SELECT * FROM indexed_files').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM sequences').all()).toEqual([]);
    expect(historyCount().count).toBe(0);
  });

  it.each(['Legacy.faa', 'Legacy.fa'])(
    'refuses a forged ordinary sequence editor save of undeclared %s before publishing bytes',
    async (name) => {
      const current = source(name);
      const bytes = readFileSync(current.path);
      const write = vi.fn();
      await expect(
        saveSequenceDocumentWithLineage(saveInput(current.entity.id, current.path), {
          db,
          resolve: async () => ({
            documentId: current.entity.id,
            workspaceRoot: root,
            sourcePath: current.path,
          }),
          runDatabase: (operation) => operation(),
          write,
        })
      ).rejects.toThrow('FASTA_KIND_CLASSIFICATION_REQUIRED');
      expect(write).not.toHaveBeenCalled();
      expect(readFileSync(current.path)).toEqual(bytes);
      expect(db.prepare('SELECT * FROM catalog_entity_events').all()).toEqual([]);
    }
  );

  it('admits declared DNA with a .faa name for references and indexing while retaining the source format save policy', async () => {
    const current = source('DNA.faa');
    const inspected = await getFastaKindAuthorityInMain(db, {
      path: current.path,
      workspaceRoot: root,
    });
    await classifyFastaInMain(db, {
      path: current.path,
      workspaceRoot: root,
      kind: 'sequence',
      expectedRevision: inspected.revision,
    });
    const savedReference = createEntityReferenceInDb(db, reference(current.entity.id));
    expect(db.prepare('SELECT * FROM entity_references WHERE id=?').get(savedReference.id)).toEqual(
      savedReference
    );
    const index = ensureSequenceIndexInDb(db, {
      documentId: current.entity.id,
      filePath: current.path,
      workspaceRoot: root,
    });
    expect(db.prepare('SELECT length FROM sequences WHERE id=?').get(index)).toEqual({ length: 4 });
    const bytes = readFileSync(current.path);
    await expect(
      saveSequenceDocumentWithLineage(saveInput(current.entity.id, current.path), {
        db,
        resolve: async () => ({
          documentId: current.entity.id,
          workspaceRoot: root,
          sourcePath: current.path,
        }),
        runDatabase: (operation) => operation(),
      })
    ).rejects.toThrow('FASTA cannot preserve DNAForge annotations or topology');
    expect(readFileSync(current.path)).toEqual(bytes);
    expect(historyCount().count).toBe(1);
  });
});
