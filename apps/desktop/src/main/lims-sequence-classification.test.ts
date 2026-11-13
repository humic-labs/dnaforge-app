import { seedOriginalProjectFixture } from './__tests__/original-project-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { limsEntityFromRow } from '../shared/lims';
import {
  classifyLimsSequenceInsideTx,
  getEntityRowById,
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
  updateLimsEntityInsideTx,
} from './lims-engine-core';
import { rebuildLimsProjectionInDb, verifyLimsAuditHashChainInDb } from './lims-projection-rebuild';

describe('explicit sequence classification transaction', () => {
  let db: Database.Database;
  const sequence = {
    mode: 'file',
    documentId: 'same-document',
    relPath: '/fixtures/Candidate.gb',
    length: 24,
    topology: 'linear',
    contentHash: `sha256:${'a'.repeat(64)}`,
    sourceFormat: 'gb',
  };
  const register = (kind = 'dna_sequence', fields = { sequence, notes: 'Keep these notes' }) =>
    db.transaction(() =>
      registerLimsEntityInsideTx(db, {
        id: 'same-entity',
        kind,
        name: 'Candidate',
        fields,
        registrationStatus: 'tracked',
        domainStatus: 'observed',
      })
    )();
  const classify = (expectedEventSeq: number | null, use: 'primer' | null = 'primer') =>
    db.transaction(() =>
      classifyLimsSequenceInsideTx(db, {
        entityId: 'same-entity',
        expectedEventSeq,
        use,
        actor: 'local-user',
      })
    )();
  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    seedOriginalProjectFixture(db);
    seedLimsBuiltinsInDb(db);
  });
  afterEach(() => db.close());
  it.each([
    ['dna_sequence', 'oligo'],
    ['rna_sequence', 'rna_oligo'],
  ])('classifies %s without changing identity or molecule', (kind, target) => {
    const before = register(kind);
    const after = classify(before.eventSeq);
    expect(after).toMatchObject({
      ...before,
      kind: target,
      schemaId: `schema-entity-${target}`,
      schemaRevisionId: `schema-entity-${target}-v1`,
      fields: { ...before.fields, use: 'primer' },
      actor: 'local-user',
      eventSeq: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(after.eventSeq).toBeGreaterThan(before.eventSeq!);
    expect(after.fields.status).toBeUndefined();
    expect(after.registryId).toBe(before.registryId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM lims_entity').get()).toEqual({ n: 1 });
    rebuildLimsProjectionInDb(db);
    expect(limsEntityFromRow(getEntityRowById(db, before.id))).toEqual(after);
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });
  it('allows an explicit oligo with no asserted use', () => {
    const before = register();
    expect(classify(before.eventSeq, null).fields.use).toBeUndefined();
  });
  it('rejects stale edits and keeps the later data', () => {
    const before = register();
    const edited = db.transaction(() =>
      updateLimsEntityInsideTx(db, { id: before.id, fields: { notes: 'Later edit' } })
    )();
    expect(() => classify(before.eventSeq)).toThrow(/changed/i);
    expect(limsEntityFromRow(getEntityRowById(db, before.id))).toEqual(edited);
  });
  it.each(['plasmid', 'oligo', 'protein'])('does not reclassify a specialized %s', (kind) => {
    const before = register();
    db.prepare('UPDATE lims_entity SET kind = ? WHERE id = ?').run(kind, before.id);
    expect(() => classify(before.eventSeq)).toThrow(/generic/i);
  });
  it.each([
    { ...sequence, topology: 'circular' },
    { ...sequence, length: 0 },
    { mode: 'unresolved' },
  ])('refuses incomplete or circular sequences', (value) => {
    const before = register();
    db.prepare('UPDATE lims_entity SET fields = ? WHERE id = ?').run(
      JSON.stringify({ sequence: value }),
      before.id
    );
    expect(() => classify(before.eventSeq)).toThrow(/linear sequence/i);
  });
  it('requires a transaction and an active record', () => {
    const before = register();
    expect(() =>
      classifyLimsSequenceInsideTx(db, {
        entityId: before.id,
        expectedEventSeq: before.eventSeq,
        use: null,
      })
    ).toThrow(/transaction/i);
    db.prepare('UPDATE lims_entity SET tombstone = 1 WHERE id = ?').run(before.id);
    expect(() => classify(before.eventSeq)).toThrow(/archived/i);
  });
});
