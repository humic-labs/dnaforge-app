import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';

import {
  buildSequencePackageDocument,
  sequencePackagePaths,
  serializeSequencePackageDocument,
} from '../../db/sequence-package';
import { MANAGED_SEQUENCE_DOCUMENT_FIELD } from '../../shared/managed-sequence-document';
import { archiveLimsEntityInDb, registerLimsEntityInDb, restoreLimsEntityInDb } from '../lims';
import { repairMissingAuthoritySequenceArchives } from '../lims-missing-authority-repair';
import { ensureSchema } from '../schema';
import { createTestDb } from './test-db';

const DEFECT_ACTOR = 'workspace-reconcile-missing-authority';

let db: Database.Database;
let root: string;
let workspaceId: number;

beforeEach(() => {
  db = createTestDb();
  ensureSchema(db, ':memory:');
  root = mkdtempSync(join(tmpdir(), 'lims-missing-authority-repair-'));
  workspaceId = Number(
    db
      .prepare(
        `INSERT INTO workspaces (name, path, repo_uuid, created_at, last_opened_at)
         VALUES ('Repair project', ?, ?, 1, 1)`
      )
      .run(root, `repair-project:${root}`).lastInsertRowid
  );
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function writeSequencePackage(input: {
  rowId: string;
  documentId?: string;
  includeProduct?: boolean;
  packageParent?: string;
}): string {
  const packageRoot = join(input.packageParent ?? root, input.rowId);
  const paths = sequencePackagePaths(packageRoot);
  mkdirSync(paths.metaDir, { recursive: true });
  const document = buildSequencePackageDocument({
    id: input.documentId ?? input.rowId,
    name: `Package ${input.rowId}`,
    product: { file: paths.productPath.split('/').pop() ?? `${input.rowId}.gb` },
  });
  writeFileSync(paths.metaPath, serializeSequencePackageDocument(document), 'utf8');
  if (input.includeProduct !== false) {
    writeFileSync(
      paths.productPath,
      'LOCUS       REPAIR 1 bp DNA\nORIGIN\n        1 a\n//\n',
      'utf8'
    );
  }
  return packageRoot;
}

function registerAndArchive(id: string, packageRoot: string): void {
  registerLimsEntityInDb(db, {
    id,
    kind: 'sequence',
    name: `Sequence ${id}`,
    fields: {
      [MANAGED_SEQUENCE_DOCUMENT_FIELD]: {
        kind: 'managed-sequence',
        packageId: id,
        packageRoot,
      },
    },
    workspaceId,
    actor: 'test-register',
  });
  archiveLimsEntityInDb(db, { id, actor: DEFECT_ACTOR });
}

function tombstone(id: string): number {
  return (
    db.prepare(`SELECT tombstone FROM lims_entity WHERE id = ?`).get(id) as {
      tombstone: number;
    }
  ).tombstone;
}

describe('repairMissingAuthoritySequenceArchives', () => {
  it('restores an exact package whose latest state event is the removed reconcile archive', () => {
    const id = 'sequence-to-repair';
    registerAndArchive(id, writeSequencePackage({ rowId: id }));

    expect(repairMissingAuthoritySequenceArchives(db)).toEqual({
      candidates: 1,
      restored: 1,
      skippedMissingAuthority: 0,
      skippedIdentityMismatch: 0,
      skippedInvalidPackage: 0,
    });
    expect(tombstone(id)).toBe(0);
    expect(
      db
        .prepare(
          `SELECT event_type, actor FROM lims_audit
           WHERE subject_id = ? ORDER BY event_seq DESC LIMIT 1`
        )
        .get(id)
    ).toEqual({
      event_type: 'entity_restored',
      actor: 'workspace-reconcile-missing-authority-repair',
    });
    expect(repairMissingAuthoritySequenceArchives(db).candidates).toBe(0);
  });

  it('never overrides a later user-authored archive', () => {
    const id = 'user-archived-sequence';
    registerAndArchive(id, writeSequencePackage({ rowId: id }));
    restoreLimsEntityInDb(db, { id, actor: 'local-user' });
    archiveLimsEntityInDb(db, { id, actor: 'local-user' });

    expect(repairMissingAuthoritySequenceArchives(db).candidates).toBe(0);
    expect(tombstone(id)).toBe(1);
  });

  it('refuses mismatched package identity and a package missing its sequence product', () => {
    const mismatched = 'mismatched-sequence';
    const missingProduct = 'missing-product-sequence';
    registerAndArchive(
      mismatched,
      writeSequencePackage({ rowId: mismatched, documentId: 'different-stable-id' })
    );
    registerAndArchive(
      missingProduct,
      writeSequencePackage({ rowId: missingProduct, includeProduct: false })
    );

    expect(repairMissingAuthoritySequenceArchives(db)).toEqual({
      candidates: 2,
      restored: 0,
      skippedMissingAuthority: 1,
      skippedIdentityMismatch: 1,
      skippedInvalidPackage: 0,
    });
    expect(tombstone(mismatched)).toBe(1);
    expect(tombstone(missingProduct)).toBe(1);
  });

  it('refuses a matching package outside the entity owning project', () => {
    const externalParent = mkdtempSync(join(tmpdir(), 'lims-repair-external-'));
    try {
      const id = 'outside-owning-project';
      registerAndArchive(id, writeSequencePackage({ rowId: id, packageParent: externalParent }));

      expect(repairMissingAuthoritySequenceArchives(db)).toEqual({
        candidates: 1,
        restored: 0,
        skippedMissingAuthority: 0,
        skippedIdentityMismatch: 1,
        skippedInvalidPackage: 0,
      });
      expect(tombstone(id)).toBe(1);
    } finally {
      rmSync(externalParent, { recursive: true, force: true });
    }
  });
});
