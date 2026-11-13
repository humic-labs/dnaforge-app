import { seedOriginalProjectFixture } from './original-project-fixture';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth/session-store', () => ({
  getActiveStoredSession: vi.fn(async () => null),
}));
import type Database from 'better-sqlite3';
import { createTestDb } from './test-db';
import { ensureSchema } from '../schema';
import {
  archiveLimsEntityInDb,
  registerLimsEntityInDb,
  relocateLimsEntityFileRefsInDb,
} from '../lims';
import {
  assertLimsProjectionReplayParityInDb,
  verifyLimsAuditHashChainInDb,
} from '../lims-projection-rebuild';

const HASH = (c: string) => `sha256:${c.repeat(64)}`;
const fileSeq = (relPath: string, workspaceId?: number) => ({
  mode: 'file' as const,
  relPath,
  ...(workspaceId != null ? { workspaceId } : {}),
  topology: 'circular' as const,
  length: 10,
  contentHash: HASH('a'),
  sourceFormat: 'gb' as const,
});

describe('relocateLimsEntityFileRefsInDb', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    seedOriginalProjectFixture(db);
    db.prepare(
      `INSERT INTO workspaces (id,name,path,created_at) VALUES (1,'W','/w',0),(2,'W2','/w2',0)`
    ).run();
  });

  const fields = (id: string): Record<string, any> =>
    JSON.parse(
      (db.prepare(`SELECT fields FROM lims_entity WHERE id=?`).get(id) as { fields: string }).fields
    );
  const relPathOf = (id: string): string | undefined => fields(id).sequence?.relPath;
  const updatedCount = () =>
    (
      db.prepare(`SELECT COUNT(*) n FROM lims_audit WHERE event_type='entity_updated'`).get() as {
        n: number;
      }
    ).n;
  const relocate = (oldPath: string, newPath: string, workspaceRoot = '/w') =>
    db.transaction(() => relocateLimsEntityFileRefsInDb(db, { workspaceRoot, oldPath, newPath }))();

  it('(a) rebases an absolute file sequence.relPath (single-file AND directory-prefix)', () => {
    const p = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq('/w/seqs/old.gb') },
    });
    const r1 = relocate('/w/seqs/old.gb', '/w/seqs/new.gb');
    expect(relPathOf(p.id)).toBe('/w/seqs/new.gb');
    expect(r1.rebasedEntityIds).toEqual([p.id]);

    relocate('/w/seqs', '/w/moved');
    expect(relPathOf(p.id)).toBe('/w/moved/new.gb');
  });

  it('(a2) resolves a RELATIVE relPath against the ref workspace root, stored back relative', () => {
    const p = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq('seqs/old.gb', 1) },
    });
    relocate('/w/seqs', '/w/moved');
    expect(relPathOf(p.id)).toBe('moved/old.gb');
  });

  it('(b)+(g) rebases artifact.relativePath only for THIS workspace; foreign/null skipped; contentHash untouched', () => {
    const mkOligo = (name: string, workspaceId: number | undefined, hash: string) =>
      registerLimsEntityInDb(db, {
        kind: 'oligo',
        name,
        ...(workspaceId != null ? { workspaceId } : {}),
        fields: {
          sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 },
          use: 'primer',
          artifact: {
            schema: 'dnaforge.primer',
            relativePath: 'primers/old.primer.json',
            contentHash: hash,
          },
        },
      });
    const mine = mkOligo('m', 1, HASH('b'));
    const foreign = mkOligo('f', 2, HASH('c'));

    const nullws = { id: 'legacy-unassigned-primer' };
    db.prepare(
      `INSERT INTO lims_entity (id, kind, schema_id, schema_revision_id, name, registry_id,
      fields, registration_status, domain_status, workspace_id, actor, event_seq, tombstone,
      created_at, updated_at, archived_at)
      SELECT ?, kind, schema_id, schema_revision_id, 'n', NULL, ?, registration_status,
        domain_status, NULL, 'legacy-fixture', NULL, 0, created_at, updated_at, NULL
      FROM lims_entity WHERE id = ?`
    ).run(
      nullws.id,
      JSON.stringify({
        ...fields(foreign.id),
        artifact: {
          ...fields(foreign.id).artifact,
          contentHash: HASH('d'),
        },
      }),
      foreign.id
    );

    relocate('/w/primers', '/w/moved');
    expect(fields(mine.id).artifact.relativePath).toBe('moved/old.primer.json');
    expect(fields(mine.id).artifact.contentHash).toBe(HASH('b'));
    expect(fields(foreign.id).artifact.relativePath).toBe('primers/old.primer.json');
    expect(fields(nullws.id).artifact.relativePath).toBe('primers/old.primer.json');
  });

  it('(c) rebases bindings[].target under oldPath, leaves the rest, exactly one entity_updated', () => {
    const binding = (rel: string, id: string) => ({
      id,
      relation: 'binds_to_sequence',
      target: {
        workspaceRelativePath: rel,
        topology: 'circular',
        length: 10,
        fileContentHash: 'x',
        normalizedSequenceHash: 'y',
      },
      coordinates: { system: 'zero_based_half_open', start: 0, end: 4, strand: 1 },
      source: 'manual',
    });
    const o = registerLimsEntityInDb(db, {
      kind: 'oligo',
      name: 'o',
      workspaceId: 1,
      fields: {
        sequence: { mode: 'inline', bases: 'ACGT', topology: 'linear', length: 4 },
        use: 'primer',
        bindings: [binding('seqs/target.gb', 'b1'), binding('other/keep.gb', 'b2')],
      },
    });
    const before = updatedCount();
    relocate('/w/seqs', '/w/moved');
    const b = fields(o.id).bindings;
    expect(b[0].target.workspaceRelativePath).toBe('moved/target.gb');
    expect(b[1].target.workspaceRelativePath).toBe('other/keep.gb');
    expect(updatedCount() - before).toBe(1);
  });

  it('(d) rebases an ARCHIVED entity and preserves archived_at', () => {
    const p = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'a',
      fields: { sequence: fileSeq('/w/seqs/a.gb') },
    });
    archiveLimsEntityInDb(db, { id: p.id });
    relocate('/w/seqs', '/w/moved');
    expect(relPathOf(p.id)).toBe('/w/moved/a.gb');
    expect(
      (
        db.prepare(`SELECT archived_at FROM lims_entity WHERE id=?`).get(p.id) as {
          archived_at: number | null;
        }
      ).archived_at
    ).not.toBeNull();
  });

  it('(e) an active-owner collision throws and rolls back the WHOLE relocation', () => {
    const a = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'a',
      fields: { sequence: fileSeq('/w/old.gb') },
    });
    registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'b',
      fields: { sequence: fileSeq('/w/new.gb') },
    });
    expect(() => relocate('/w/old.gb', '/w/new.gb')).toThrow(/already owned/i);
    expect(relPathOf(a.id)).toBe('/w/old.gb');
  });

  it('(f)+replay: audit-backed rebase keeps projection replay parity + hash chain', () => {
    registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq('/w/old.gb') },
    });
    relocate('/w/old.gb', '/w/new.gb');
    expect(() => assertLimsProjectionReplayParityInDb(db)).not.toThrow();
    expect(verifyLimsAuditHashChainInDb(db).ok).toBe(true);
  });

  it('(RED) a bare UPDATE with no audit event BREAKS replay parity — proving the audit path is load-bearing', () => {
    const p = registerLimsEntityInDb(db, {
      kind: 'plasmid',
      name: 'x',
      fields: { sequence: fileSeq('/w/old.gb') },
    });
    const f = fields(p.id);
    f.sequence.relPath = '/w/new.gb';
    db.prepare(`UPDATE lims_entity SET fields=? WHERE id=?`).run(JSON.stringify(f), p.id);
    expect(() => assertLimsProjectionReplayParityInDb(db)).toThrow();
  });
});
