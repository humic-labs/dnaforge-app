import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import {
  parseOperationId,
  parseResourceId,
  parseWorkspacePath,
  type WorkspaceMutation,
} from '@waypoint/workspace-revisions';
import { defineScientificDocument } from '@waypoint/scientific-objects';
import { importCanonicalRecords } from '@waypoint/workspace-revisions/codec';

vi.mock('@waypoint/workspace-revisions/codec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/workspace-revisions/codec')>();
  return { ...actual, importCanonicalRecords: vi.fn(actual.importCanonicalRecords) };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
import { ensureSchema } from './schema';
import { ScientificObjectStore } from './scientific-object-store';

const must = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }) => {
  if (!value.ok) throw Error(JSON.stringify(value.error));
  return value.value;
};
const id = (value: string) => must(parseResourceId(value));
const op = (value: string) => must(parseOperationId(value));
const primer = {
  formatVersion: 1,
  kind: 'primer',
  name: 'Shared PCR primer',
  molecule: 'DNA',
  bases: 'ACGT',
  modifications: [],
  fields: {},
};
const sequence = {
  formatVersion: 1,
  kind: 'sequence',
  name: 'Donor',
  molecule: 'DNA',
  bases: 'ACGTACGT',
  topology: 'linear',
  annotations: [],
  fields: {},
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const file = createFileTestDb('scientific-objects');
  cleanups.push(file.cleanup);
  ensureSchema(file.db, file.dbPath);
  const workspaceId = Number(
    file.db
      .prepare('INSERT INTO workspaces (name, path, repo_uuid, created_at) VALUES (?, ?, ?, ?)')
      .run('Science', `${file.tmpDir}/project`, 'scientific-project', 1).lastInsertRowid
  );
  const store = new ScientificObjectStore(file.db, workspaceId);
  return { ...file, store, workspaceId };
}
function create(
  resource: string,
  document: unknown
): { mutation: Extract<WorkspaceMutation, { kind: 'create-resource' }>; bytes: Uint8Array } {
  const defined = defineScientificDocument(document);
  return {
    mutation: {
      kind: 'create-resource',
      resourceId: id(resource),
      path: must(parseWorkspacePath(`${resource}.json`)),
      state: defined.state,
      origin: { kind: 'created' },
    },
    bytes: new TextEncoder().encode(defined.text),
  };
}
function initial() {
  const f = fixture(),
    entries = [
      create('primer', primer),
      create('source', sequence),
      create('strain', { formatVersion: 1, kind: 'strain', name: 'Host', taxon: null, fields: {} }),
    ];
  const result = f.store.submit({
    operationId: op('initial'),
    expectedHead: null,
    mutations: entries.map((entry) => entry.mutation),
    blobs: entries.map((entry) => entry.bytes),
  });
  if (result.kind !== 'changed') throw Error('Fixture acceptance');
  return { ...f, entries, result };
}

describe('scientific SQLite acceptance', () => {
  it('validates complete workspace delivery against unchanged accepted files', () => {
    const f = initial();
    const next = create('next', sequence);
    const result = f.store.submit({
      operationId: op('complete-workspace'),
      expectedHead: f.result.version.id,
      mutations: [next.mutation],
      blobs: [next.bytes],
      completeWorkspace: true,
    });
    expect(result.kind).toBe('changed');
    const job = f.store
      .pendingMaterializations()
      .find((job) => job.operation_id === 'complete-workspace');
    if (!job) throw new Error('The complete workspace delivery was not queued.');
    const manifest = JSON.parse(job.manifest_json);
    expect(manifest.completeWorkspace).toBe(true);
    expect(
      manifest.files.some((file: { resourceId: string }) => file.resourceId === 'primer')
    ).toBe(true);
    expect(() => f.store.validateMaterialization(job, manifest)).not.toThrow();
    expect(() =>
      f.store.validateMaterialization(job, {
        ...manifest,
        files: manifest.files.filter(
          (file: { resourceId: string }) => file.resourceId !== 'primer'
        ),
      })
    ).toThrow('Scientific file delivery differs from its accepted version.');
  });
  it('uses the validated publication for reads and file delivery without reimporting history', () => {
    const f = initial(),
      next = create('next', sequence);
    vi.mocked(importCanonicalRecords).mockClear();
    expect(
      f.store.submit({
        operationId: op('next'),
        expectedHead: f.result.version.id,
        mutations: [next.mutation],
        blobs: [next.bytes],
      }).kind
    ).toBe('changed');
    expect(f.store.read().reader.current(id('next'))?.document).toEqual(sequence);
    expect(
      f.store
        .catalog()
        .entries.map((entry) => entry.resourceId)
        .sort()
    ).toEqual([...f.entries, next].map((entry) => entry.mutation.resourceId).sort());
    for (const job of f.store.pendingMaterializations())
      f.store.validateMaterialization(job, JSON.parse(job.manifest_json));
    expect(importCanonicalRecords).not.toHaveBeenCalled();
  });

  it('reads namespace pins and deleted identities without reading scientific blobs', () => {
    const empty = fixture();
    expect(empty.store.catalog()).toEqual({ head: null, entries: [] });
    const f = initial();
    const before = f.store.catalog();
    expect(before.head).toBe(f.result.version.id);
    expect(before.entries).toHaveLength(3);
    const source = before.entries.find((slot) => slot.resourceId === id('source'))!;
    expect(
      f.store.submit({
        operationId: op('delete-source'),
        expectedHead: before.head,
        mutations: [
          {
            kind: 'delete-resource',
            resourceId: source.resourceId,
            expectedRevision: source.revisionId,
            expectedPath: must(parseWorkspacePath('source.json')),
          },
        ],
        blobs: [],
      }).kind
    ).toBe('changed');
    const failBlobRead = vi.spyOn(f.store, 'readBlob').mockImplementation(() => {
      throw new Error('Catalog must not load a sequence');
    });
    const deleted = f.store
      .catalog()
      .entries.find((slot) => slot.resourceId === source.resourceId)!;
    expect(deleted).toMatchObject({
      resourceId: source.resourceId,
      path: null,
      lastPath: 'source.json',
      tombstone: true,
    });
    expect(deleted.revisionId).not.toBe(source.revisionId);
    expect(failBlobRead).not.toHaveBeenCalled();
  });

  it('commits all entity bytes, records, ref, receipt and pending file delivery, then reopens exactly', () => {
    const f = initial();
    expect(
      f.store
        .read()
        .reader.listCurrent()
        .map((s) => s.document.kind)
        .sort()
    ).toEqual(['primer', 'sequence', 'strain']);
    expect(f.store.pendingMaterializations()).toHaveLength(1);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM scientific_revision_blobs').get()).toEqual({
      count: 3,
    });
    f.db.close();
    const db = openFileTestDb(f.dbPath);
    cleanups.push(() => db.close());
    const reopened = new ScientificObjectStore(db, f.workspaceId);
    expect(reopened.read().head).toBe(f.result.version.id);
    expect(reopened.read().reader.current(id('primer'))?.document).toEqual(primer);
    const replay = reopened.submit({
      operationId: op('initial'),
      expectedHead: null,
      mutations: f.entries.map((entry) => entry.mutation),
      blobs: [],
    });
    expect(replay.kind).toBe('replay');
    expect(reopened.pendingMaterializations()).toHaveLength(1);
  });
  it('durably rejects an invalid relationship without storing the earlier product or unused blobs', () => {
    const f = initial(),
      current = f.store.read();
    const pin = current.reader.current(id('primer'))!;
    const entries = [
      create('product', sequence),
      create('binding', {
        formatVersion: 1,
        kind: 'primer-binding',
        primerId: id('primer'),
        target: { resourceId: pin.resourceId, revisionId: pin.revisionId },
        coordinates: { start: 0, end: 4, strand: 1 },
      }),
    ];
    const result = f.store.submit({
      operationId: op('bad-relationship'),
      expectedHead: current.head,
      mutations: entries.map((entry) => entry.mutation),
      blobs: entries.map((entry) => entry.bytes),
    });
    expect(result.kind).toBe('rejected');
    expect(f.store.read().head).toBe(current.head);
    expect(f.store.read().reader.current(id('product'))).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM scientific_revision_blobs').get()).toEqual({
      count: 3,
    });
    expect(f.store.pendingMaterializations()).toHaveLength(1);
    expect(
      f.store.submit({
        operationId: op('bad-relationship'),
        expectedHead: current.head,
        mutations: entries.map((entry) => entry.mutation),
        blobs: [],
      }).kind
    ).toBe('replay');
  });
  it('rolls back every accepted write if durable file delivery cannot be recorded', () => {
    const f = fixture(),
      entry = create('primer', primer);
    f.db.exec(
      "CREATE TRIGGER fail_scientific_outbox BEFORE INSERT ON scientific_materialization_jobs BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END"
    );
    expect(() =>
      f.store.submit({
        operationId: op('failed-commit'),
        expectedHead: null,
        mutations: [entry.mutation],
        blobs: [entry.bytes],
      })
    ).toThrow('outbox unavailable');
    expect(f.store.read().head).toBeNull();
    for (const table of [
      'scientific_revision_records',
      'scientific_revision_blobs',
      'scientific_materialization_jobs',
    ])
      expect(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    f.db.exec('DROP TRIGGER fail_scientific_outbox');
    expect(
      f.store.submit({
        operationId: op('failed-commit'),
        expectedHead: null,
        mutations: [entry.mutation],
        blobs: [entry.bytes],
      }).kind
    ).toBe('changed');
  });
  it('discards a snapshot observed by a failing acceptance callback after rollback', () => {
    const f = fixture();
    const entry = create('primer', primer);
    expect(() =>
      f.store.submit(
        {
          operationId: op('failed-projection'),
          expectedHead: null,
          mutations: [entry.mutation],
          blobs: [entry.bytes],
        },
        () => {
          expect(f.store.read().reader.current(id('primer'))?.document).toEqual(primer);
          throw new Error('projection unavailable');
        }
      )
    ).toThrow('projection unavailable');
    expect(f.store.read().head).toBeNull();
    expect(f.store.read().reader.current(id('primer'))).toBeNull();
  });
  it('fences stale submissions from another real SQLite connection', () => {
    const f = initial(),
      db = openFileTestDb(f.dbPath);
    cleanups.push(() => db.close());
    db.pragma('foreign_keys = ON');
    const other = new ScientificObjectStore(db, f.workspaceId);
    const old = other.read().head,
      a = create('a', sequence),
      b = create('b', sequence);
    expect(
      f.store.submit({
        operationId: op('a'),
        expectedHead: old,
        mutations: [a.mutation],
        blobs: [a.bytes],
      }).kind
    ).toBe('changed');
    const conflict = other.submit({
      operationId: op('b'),
      expectedHead: old,
      mutations: [b.mutation],
      blobs: [b.bytes],
    });
    expect(conflict).toMatchObject({
      kind: 'conflict',
      conflicts: [{ kind: 'ref-head-mismatch' }],
    });
    expect(other.read().reader.current(id('b'))).toBeNull();
    expect(
      other.submit({ operationId: op('b'), expectedHead: old, mutations: [b.mutation], blobs: [] })
        .kind
    ).toBe('replay');
  });
  it('replays an older success after newer edits without rewinding accepted state', () => {
    const f = initial(),
      old = f.store.read().reader.current(id('primer'))!;
    const changed = defineScientificDocument({ ...primer, bases: 'AAAA' });
    const result = f.store.submit({
      operationId: op('edit'),
      expectedHead: f.result.version.id,
      mutations: [
        {
          kind: 'edit-resource',
          resourceId: id('primer'),
          expectedRevision: old.revisionId,
          state: changed.state,
        },
      ],
      blobs: [new TextEncoder().encode(changed.text)],
    });
    expect(result.kind).toBe('changed');
    const head = f.store.read().head;
    expect(
      f.store.submit({
        operationId: op('initial'),
        expectedHead: null,
        mutations: f.entries.map((entry) => entry.mutation),
        blobs: [],
      }).kind
    ).toBe('replay');
    expect(f.store.read().head).toBe(head);
    expect(f.store.read().reader.revision(old)?.document).toEqual(primer);
    expect(f.store.read().reader.current(id('primer'))?.document).toMatchObject({ bases: 'AAAA' });
    expect(f.store.pendingMaterializations()).toHaveLength(2);
  });
  it('rejects operation-ID reuse, missing content and corrupt persistence without guessing a recovery state', () => {
    const f = initial(),
      bad = create('other', primer);
    expect(
      f.store.submit({
        operationId: op('initial'),
        expectedHead: null,
        mutations: [bad.mutation],
        blobs: [bad.bytes],
      })
    ).toMatchObject({ kind: 'rejected', error: { kind: 'operation-id-reused' } });
    const entry = create('missing', { ...primer, bases: 'TTTT' });
    expect(() =>
      f.store.submit({
        operationId: op('missing'),
        expectedHead: f.result.version.id,
        mutations: [entry.mutation],
        blobs: [],
      })
    ).toThrow(/blob/i);
    expect(f.store.read().head).toBe(f.result.version.id);
    f.db
      .prepare(
        "UPDATE scientific_revision_records SET canonical_json = '{}' WHERE record_kind = 'resource-state'"
      )
      .run();
    expect(() => f.store.read()).toThrow(/history/i);
  });
  it('scopes identical object and operation IDs to their owning workspace', () => {
    const f = initial();
    const workspaceId = Number(
      f.db
        .prepare('INSERT INTO workspaces (name, path, repo_uuid, created_at) VALUES (?, ?, ?, ?)')
        .run('Other', `${f.tmpDir}/other`, 'other-project', 1).lastInsertRowid
    );
    const other = new ScientificObjectStore(f.db, workspaceId),
      entry = create('primer', { ...primer, bases: 'TTTT' });
    expect(
      other.submit({
        operationId: op('initial'),
        expectedHead: null,
        mutations: [entry.mutation],
        blobs: [entry.bytes],
      }).kind
    ).toBe('changed');
    expect(other.read().reader.current(id('primer'))?.document).toMatchObject({ bases: 'TTTT' });
    expect(f.store.read().reader.current(id('primer'))?.document).toMatchObject({ bases: 'ACGT' });
    f.db.prepare("UPDATE workspaces SET access_mode = 'reference' WHERE id = ?").run(workspaceId);
    expect(() =>
      other.submit({
        operationId: op('blocked'),
        expectedHead: other.read().head,
        mutations: [create('new', primer).mutation],
        blobs: [],
      })
    ).toThrow(/read.only/i);
  });
});
