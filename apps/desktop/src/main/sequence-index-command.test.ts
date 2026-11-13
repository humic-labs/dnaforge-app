import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { ensureSequenceIndexInDb } from './sequence-index-command';
import {
  buildSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../db/sequence-package';

vi.mock('electron', () => ({ app: { getPath: vi.fn(), getVersion: () => 'test' } }));

let db: Database.Database;
let root: string;
let other: string;
let file: string;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'sequence-index-authority-')));
  other = join(root, 'other-project');
  mkdirSync(other);
  db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(7,?,?,1)').run('Owner', root);
  db.prepare('INSERT INTO workspaces(id,name,path,created_at) VALUES(8,?,?,1)').run('Other', other);
  file = join(root, 'sample.fa');
  writeFileSync(file, '>Disk name\nACGTACGT\n');
  addCatalog('document-a', file, 7);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addCatalog(id: string, path: string, owner: number, kind = 'fasta') {
  db.prepare(
    `INSERT INTO catalog_entities(id,type,name,locator,storage_type,workspace_id,created_at,updated_at)
    VALUES(?,'sequence',?,?,'file',?,1,1)`
  ).run(id, id, `file://${path}`, owner);
  db.prepare(
    `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,object_uuid,created_at,updated_at)
    VALUES(?,?,?,?,?,?,1,1)`
  ).run(`file-${id}`, id, owner, path, kind, `object-${id}`);
}

const request = () => ({ documentId: 'document-a', filePath: file, workspaceRoot: root });

function existingIndex(documentId = 'document-a', owner = 7, path = file) {
  db.prepare(
    `INSERT INTO indexed_files(id,workspace_id,path,name,extension,indexed_at) VALUES(10,?,?,?,'fa',1)`
  ).run(owner, path, basename(path));
  db.prepare(
    `INSERT INTO sequences(id,file_id,document_id,name,length,circular) VALUES(24,10,?,'Before',4,1)`
  ).run(documentId);
}

function snapshot() {
  return {
    files: db.prepare('SELECT * FROM indexed_files ORDER BY id').all(),
    sequences: db.prepare('SELECT * FROM sequences ORDER BY id').all(),
  };
}

describe('native sequence index authority', () => {
  it('derives the sequence projection from authoritative bytes and is idempotent', () => {
    const id = ensureSequenceIndexInDb(db, request());
    expect(ensureSequenceIndexInDb(db, request())).toBe(id);
    expect(db.prepare('SELECT document_id,name,length,circular FROM sequences').get()).toEqual({
      document_id: 'document-a',
      name: 'Disk',
      length: 8,
      circular: 0,
    });
    expect(db.prepare('SELECT workspace_id,path FROM indexed_files').get()).toEqual({
      workspace_id: 7,
      path: file,
    });
  });

  it('preserves the numeric legacy sequence row and primer binding when adopting its canonical file', () => {
    existingIndex('legacy-sequence:24');
    db.prepare(
      `INSERT INTO primers(id,name,sequence,length,created_at,updated_at) VALUES('primer-a','Primer','ACGT',4,1,1)`
    ).run();
    db.prepare(
      `INSERT INTO primer_bindings(id,primer_id,sequence_id,binding_start,binding_end,strand,created_at,updated_at) VALUES('binding-a','primer-a',24,0,4,1,1,1)`
    ).run();
    expect(ensureSequenceIndexInDb(db, request())).toBe(24);
    expect(db.prepare('SELECT sequence_id FROM primer_bindings').get()).toEqual({
      sequence_id: 24,
    });
    expect(db.prepare('SELECT document_id FROM sequences').get()).toEqual({
      document_id: 'document-a',
    });
  });

  it('repairs a legacy indexed owner only when that owner never contained the canonical file', () => {
    db.prepare('UPDATE workspaces SET path=? WHERE id=8').run(join(root, 'unrelated'));
    existingIndex('legacy-sequence:24', 8);
    expect(ensureSequenceIndexInDb(db, request())).toBe(24);
    expect(db.prepare('SELECT workspace_id FROM indexed_files').get()).toEqual({ workspace_id: 7 });
  });

  it('rejects changing a stable sequence document to another project with byte-identical content', () => {
    existingIndex();
    const replacement = join(other, 'sample.fa');
    writeFileSync(replacement, '>Disk name\nACGTACGT\n');
    addCatalog('other-document', replacement, 8);
    const before = snapshot();
    expect(() =>
      ensureSequenceIndexInDb(db, { ...request(), filePath: replacement, workspaceRoot: other })
    ).toThrow(/identity|owner/i);
    expect(snapshot()).toEqual(before);
  });

  it('rejects catalog ownership takeover even if a caller supplies the new owning root', () => {
    existingIndex();
    const before = snapshot();
    expect(() => ensureSequenceIndexInDb(db, { ...request(), workspaceRoot: other })).toThrow(
      /owner|project/i
    );
    expect(snapshot()).toEqual(before);
  });

  it('accepts a checked current catalog move while retaining the numeric sequence identity', () => {
    existingIndex();
    const moved = join(root, 'moved.fa');
    renameSync(file, moved);
    db.prepare(
      "UPDATE catalog_entity_files SET status='historical' WHERE entity_id='document-a'"
    ).run();
    db.prepare(
      `INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,created_at,updated_at)
      VALUES('moved','document-a',7,?,'fasta',2,2)`
    ).run(moved);
    db.prepare("UPDATE catalog_entities SET locator=? WHERE id='document-a'").run(
      `file://${moved}`
    );
    expect(ensureSequenceIndexInDb(db, { ...request(), filePath: moved })).toBe(24);
    expect(
      db.prepare('SELECT f.path FROM sequences s JOIN indexed_files f ON f.id=s.file_id').get()
    ).toEqual({ path: moved });
  });

  it('keeps a catalog-proven relocation whose native owner rebased its binding in place', () => {
    existingIndex();
    const moved = join(root, 'rebased.fa');
    renameSync(file, moved);
    db.prepare("UPDATE catalog_entity_files SET path=? WHERE entity_id='document-a'").run(moved);
    db.prepare("UPDATE catalog_entities SET locator=? WHERE id='document-a'").run(
      `file://${moved}`
    );
    expect(ensureSequenceIndexInDb(db, { ...request(), filePath: moved })).toBe(24);
  });

  it('refuses an unchecked replacement while the previous source is still live', () => {
    existingIndex();
    const replacement = join(root, 'replacement.fa');
    writeFileSync(replacement, '>Disk name\nACGTACGT\n');
    db.prepare("UPDATE catalog_entity_files SET path=? WHERE entity_id='document-a'").run(
      replacement
    );
    db.prepare("UPDATE catalog_entities SET locator=? WHERE id='document-a'").run(
      `file://${replacement}`
    );
    const before = snapshot();
    expect(() => ensureSequenceIndexInDb(db, { ...request(), filePath: replacement })).toThrow(
      /identity|owner/i
    );
    expect(snapshot()).toEqual(before);
  });

  it('keeps one numeric identity for historical file UUID and catalog ID aliases', () => {
    existingIndex('object-document-a');
    expect(ensureSequenceIndexInDb(db, request())).toBe(24);
    expect(db.prepare('SELECT document_id FROM sequences').get()).toEqual({
      document_id: 'object-document-a',
    });
  });

  it('translates a portable sequence ID only when its native manifest proves the scoped catalog binding', () => {
    const scoped = 'ws7::portable-sequence';
    db.prepare("DELETE FROM catalog_entity_files WHERE entity_id='document-a'").run();
    db.prepare("DELETE FROM catalog_entities WHERE id='document-a'").run();
    addCatalog(scoped, file, 7);
    mkdirSync(join(root, '.forge'));
    writeFileSync(
      join(root, '.forge', 'catalog.json'),
      JSON.stringify({
        schema: 'dnaforge.native-workspace-manifest.v1',
        entities: [
          {
            id: 'portable-sequence',
            type: 'sequence',
            name: 'Source',
            path: 'sample.fa',
            fileKind: 'fasta',
          },
        ],
        links: [],
      })
    );
    existingIndex(scoped);
    expect(ensureSequenceIndexInDb(db, { ...request(), documentId: 'portable-sequence' })).toBe(24);
    rmSync(join(root, '.forge', 'catalog.json'));
    expect(() =>
      ensureSequenceIndexInDb(db, { ...request(), documentId: 'portable-sequence' })
    ).toThrow(/identity/i);
  });

  it('rejects takeover from an indexed row with another canonical document', () => {
    existingIndex('unrelated-document');
    const before = snapshot();
    expect(() => ensureSequenceIndexInDb(db, request())).toThrow(/different|identity/i);
    expect(snapshot()).toEqual(before);
  });

  it('rejects an alias path that traverses a symbolic link', () => {
    const target = join(root, 'real.fa');
    writeFileSync(target, '>Other\nACGT\n');
    rmSync(file);
    symlinkSync(target, file);
    expect(() => ensureSequenceIndexInDb(db, request())).toThrow(/symbolic/i);
    expect(snapshot().files).toEqual([]);
  });

  it('projects the exact package product with differing portable and workspace projection IDs', () => {
    const packageRoot = join(root, 'Package');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'product.gb' });
    mkdirSync(paths.metaDir, { recursive: true });
    const document = buildSequencePackageDocument({
      id: 'portable-package',
      name: 'Package',
      product: { file: 'product.gb' },
    });
    writeFileSync(paths.metaPath, serializeSequencePackageDocument(document));
    writeFileSync(
      paths.productPath,
      'LOCUS       Package 8 bp DNA linear\nORIGIN\n        1 aaccggtt\n//\n'
    );
    addCatalog('ws7::portable-package', packageRoot, 7, 'waypoint-sequence');
    expect(
      ensureSequenceIndexInDb(db, {
        documentId: 'portable-package',
        filePath: paths.productPath,
        workspaceRoot: root,
      })
    ).toBeGreaterThan(0);
    expect(
      db
        .prepare("SELECT document_id,length FROM sequences WHERE document_id='portable-package'")
        .get()
    ).toEqual({ document_id: 'portable-package', length: 8 });
    const sibling = join(packageRoot, 'different.fa');
    writeFileSync(sibling, '>Package product\nAACCGGTT\n');
    expect(() =>
      ensureSequenceIndexInDb(db, {
        documentId: 'portable-package',
        filePath: sibling,
        workspaceRoot: root,
      })
    ).toThrow(/product|identity/i);
  });
});
