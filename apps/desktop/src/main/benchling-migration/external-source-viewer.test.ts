import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { ensureSchema } from '../schema';
import { createTestDb } from '../__tests__/test-db';
import { readCatalogProviderSource } from '../catalog-provider-source';
import { buildSyntheticNativeExportZip } from './__fixtures__/native-export-zip-fixture';
import { selectExternalZipSource } from './external-zip-source';
import {
  EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES,
  viewExternalProviderSource,
  type ExternalSourceHistoryRecord,
} from './external-source-viewer';

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }));

describe('external provider source viewer', () => {
  let db: Database.Database;
  let root: string;
  let sourcePath: string;
  const roots: string[] = [];

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    root = await mkdtemp(join(tmpdir(), 'dnaforge-source-viewer-'));
    roots.push(root);
    sourcePath = join(root, 'benchling-export.zip');
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, last_opened_at)
       VALUES (1, 'Lab A', ?, 0, 0), (2, 'Lab B', ?, 0, 0)`
    ).run(join(root, 'lab-a'), join(root, 'lab-b'));
  });

  afterEach(async () => {
    db.close();
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('returns a verified text preview from the exact source record', async () => {
    const record = await sourceRecord([
      {
        path: 'Registry/Strain A (bfi_STRAINAA).txt',
        bytes: 'Genotype: MATa\nMarker: ura3\n',
      },
    ]);
    registerEntity({ sourceRecordId: 'bfi_STRAINAA' });

    await expect(view(record, 'bfi_STRAINAA')).resolves.toMatchObject({
      status: 'ready',
      originalPath: sourcePath,
      sourceDisplayName: 'benchling-export.zip',
      entryPath: 'Registry/Strain A (bfi_STRAINAA).txt',
      displayFilename: 'Strain A (bfi_STRAINAA).txt',
      mediaType: 'text/plain',
      text: 'Genotype: MATa\nMarker: ura3\n',
      truncated: false,
    });
  });

  it.each(['bfi_RECORD01', 'bfi_RECORD02'])(
    'previews only the exact original CSV row for %s',
    async (sourceRecordId) => {
      const record = await sourceRecord([
        {
          path: 'records.schema.json',
          bytes: JSON.stringify({
            schema: 'benchling.registry-schema.v1',
            sourceSchemaId: 'reagent',
            sourceRevisionId: 'r1',
            name: 'reagent',
            displayName: 'Reagent',
            recordPaths: ['records.csv'],
            fields: [
              {
                sourceFieldId: 'amount',
                definition: { key: 'amount', label: 'Amount', type: 'number' },
              },
            ],
          }),
        },
        {
          path: 'records.csv',
          bytes: 'id,name,amount\nbfi_RECORD01,Same name,0\nbfi_RECORD02,Same name,2.50\n',
        },
      ]);
      registerEntity({ sourceRecordId });
      const before = await readFile(sourcePath);
      const result = await view(record, sourceRecordId);
      expect(result).toMatchObject({ status: 'ready', entryPath: 'records.csv', truncated: false });
      if (result.status !== 'ready') throw new Error('Expected an exact original row');
      expect(JSON.parse(result.text)).toEqual({
        id: sourceRecordId,
        name: 'Same name',
        amount: sourceRecordId === 'bfi_RECORD01' ? '0' : '2.50',
      });
      expect(result.message).toContain(sourceRecordId === 'bfi_RECORD01' ? 'row 1' : 'row 2');
      expect(await readFile(sourcePath)).toEqual(before);
    }
  );

  it('derives a path-free Registry source request without user-defined source fields', () => {
    registerEntity({ sourceRecordId: 'bfi_RECORD01' });
    expect(readCatalogProviderSource(db, 'strain-entity')?.request).toEqual({
      workspaceId: 1,
      entityId: 'strain-entity',
      sourceRecordId: 'bfi_RECORD01',
    });
  });

  it('reports a malformed table as an integrity result instead of an unhandled read failure', async () => {
    const record = await sourceRecord([
      { path: 'records.schema.json', bytes: '{"schema":"benchling.registry-schema.v1"}' },
      { path: 'records.csv', bytes: 'id,name\nbfi_RECORD01,Record\n' },
    ]);
    registerEntity({ sourceRecordId: 'bfi_RECORD01' });
    await expect(view(record, 'bfi_RECORD01')).resolves.toMatchObject({
      status: 'source_integrity_error',
    });
  });

  it.each([
    'table-hash',
    'schema-hash',
    'table-size',
    'schema-size',
    'missing-schema',
    'duplicate-table',
  ])('retains member-evidence checks for a table row: %s', async (fault) => {
    const record = await registrySourceRecord();
    registerEntity({ sourceRecordId: 'bfi_RECORD01' });
    let entries = [...record.entries];
    const selectedPath =
      fault.startsWith('schema') || fault === 'missing-schema'
        ? 'records.schema.json'
        : 'records.csv';
    entries = entries.flatMap((entry) => {
      if (entry.entryPath !== selectedPath) return [entry];
      if (fault === 'missing-schema') return [];
      if (fault === 'duplicate-table') return [entry, entry];
      return [
        fault.endsWith('hash')
          ? { ...entry, entrySha256: `sha256:${'0'.repeat(64)}` as const }
          : { ...entry, sizeBytes: entry.sizeBytes + 1 },
      ];
    });
    expect(await view({ ...record, entries }, 'bfi_RECORD01')).toMatchObject({
      status: 'source_integrity_error',
    });
  });

  it.each([
    { extension: 'csv', bytes: 'id,name,amount\nbfi_RECORD01,Same name,2.50\n', amount: '2.50' },
    {
      extension: 'tsv',
      bytes: 'id\tname\tamount\nbfi_RECORD01\tSame name\t2.50\n',
      amount: '2.50',
    },
    {
      extension: 'json',
      bytes: '[{"id":"bfi_RECORD01","name":"Same name","amount":2.5}]',
      amount: 2.5,
    },
    {
      extension: 'jsonl',
      bytes: '{"id":"bfi_RECORD01","name":"Same name","amount":2.5}\n',
      amount: 2.5,
    },
  ])('shows the original $extension row values', async ({ extension, bytes, amount }) => {
    const record = await registrySourceRecord(bytes, extension);
    registerEntity({ sourceRecordId: 'bfi_RECORD01' });
    const result = await view(record, 'bfi_RECORD01');
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected original table row');
    expect(JSON.parse(result.text)).toEqual({ id: 'bfi_RECORD01', name: 'Same name', amount });
    expect(result.sizeBytes).toBe(Buffer.byteLength(result.text));
  });

  it('rejects duplicate exact row identities rather than selecting a same-name row', async () => {
    const record = await registrySourceRecord(
      'id,name,amount\nbfi_RECORD01,Same name,0\nbfi_RECORD01,Same name,9\n'
    );
    registerEntity({ sourceRecordId: 'bfi_RECORD01' });
    expect(await view(record, 'bfi_RECORD01')).toMatchObject({ status: 'source_integrity_error' });
  });

  it('bounds a large original row preview without breaking UTF-8', async () => {
    const record = await registrySourceRecord(
      `id,name,amount,note\nbfi_RECORD01,Same name,0,${'β'.repeat(EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES)}\n`
    );
    registerEntity({ sourceRecordId: 'bfi_RECORD01' });
    const result = await view(record, 'bfi_RECORD01');
    expect(result).toMatchObject({ status: 'ready', truncated: true });
    if (result.status !== 'ready') throw new Error('Expected bounded original row');
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(
      EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES
    );
    expect(result.text).toContain('bfi_RECORD01');
    expect(result.text).not.toContain('\uFFFD');
    expect(result.sizeBytes).toBeGreaterThan(EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES);
  });

  it('previews a direct original JSON source as text', async () => {
    const record = await sourceRecord([
      { path: 'Registry/Record (bfi_RECORD01).json', bytes: '{"name":"Original"}' },
    ]);
    registerEntity({ sourceRecordId: 'bfi_RECORD01' });
    expect(await view(record, 'bfi_RECORD01')).toMatchObject({
      status: 'ready',
      text: '{"name":"Original"}',
      mediaType: 'application/json',
    });
  });

  async function registrySourceRecord(
    bytes = 'id,name,amount\nbfi_RECORD01,Same name,0\n',
    extension = 'csv'
  ) {
    return sourceRecord([
      {
        path: 'records.schema.json',
        bytes: JSON.stringify({
          schema: 'benchling.registry-schema.v1',
          sourceSchemaId: 'reagent',
          sourceRevisionId: 'r1',
          name: 'reagent',
          displayName: 'Reagent',
          recordPaths: [`records.${extension}`],
          fields: [
            {
              sourceFieldId: 'amount',
              definition: { key: 'amount', label: 'Amount', type: 'number' },
            },
          ],
        }),
      },
      { path: `records.${extension}`, bytes },
    ]);
  }

  it.each(['wrong-class', 'conflicted-binding', 'invalid-evidence', 'archived'])(
    'rejects an unproven catalog source before exposing its path: %s',
    async (fault) => {
      const record = await sourceRecord([
        { path: 'Registry/Strain A (bfi_STRAINAA).txt', bytes: 'inert source text' },
      ]);
      registerEntity({ sourceRecordId: 'bfi_STRAINAA' });
      if (fault === 'wrong-class')
        db.prepare("UPDATE catalog_provider_bindings SET object_class='sequence'").run();
      if (fault === 'conflicted-binding')
        db.prepare('UPDATE catalog_provider_bindings SET evidence_json=?').run('{"conflict":true}');
      if (fault === 'invalid-evidence')
        db.prepare('UPDATE catalog_provider_bindings SET evidence_json=?').run('null');
      if (fault === 'archived') db.prepare("UPDATE catalog_entities SET status='archived'").run();
      expect(readCatalogProviderSource(db, 'strain-entity')).toBeNull();
      expect(await view(record, 'bfi_STRAINAA')).toMatchObject({
        status: 'source_integrity_error',
        originalPath: null,
      });
    }
  );

  it('rejects a cross-workspace entity request before exposing the source path', async () => {
    const record = await sourceRecord([
      { path: 'Registry/Strain A (bfi_STRAINAA).txt', bytes: 'inert source text' },
    ]);
    registerEntity({ workspaceId: 2, sourceRecordId: 'bfi_STRAINAA' });

    await expect(view(record, 'bfi_STRAINAA')).resolves.toMatchObject({
      status: 'source_integrity_error',
      originalPath: null,
    });
  });

  it('rejects a stale provider binding', async () => {
    const record = await sourceRecord([
      { path: 'Registry/Strain A (bfi_STRAINAA).txt', bytes: 'inert source text' },
    ]);
    registerEntity({ sourceRecordId: 'bfi_STRAINAA', bindingStableId: 'bfi_OLDSTRAIN' });

    await expect(view(record, 'bfi_STRAINAA')).resolves.toMatchObject({
      status: 'source_integrity_error',
      originalPath: null,
    });
  });

  it('does not expose a path from a mismatched history record', async () => {
    const record = await sourceRecord([
      { path: 'Registry/Strain A (bfi_STRAINAA).txt', bytes: 'inert source text' },
    ]);
    registerEntity({ sourceRecordId: 'bfi_STRAINAA' });
    db.prepare(
      `UPDATE catalog_entities
       SET metadata = json_set(metadata, '$.migrationSource.sourceId', ?)
       WHERE id = 'strain-entity'`
    ).run(record.source.sourceId);

    await expect(
      viewExternalProviderSource(
        db,
        { workspaceId: 1, entityId: 'strain-entity', sourceRecordId: 'bfi_STRAINAA' },
        {
          loadHistorySource: vi.fn(async () => ({
            ...record,
            source: { ...record.source, sourceId: 'external-zip-wrong' },
          })),
        }
      )
    ).resolves.toMatchObject({ status: 'source_integrity_error', originalPath: null });
  });

  it('distinguishes a missing or moved ZIP from a changed ZIP', async () => {
    const record = await sourceRecord([
      { path: 'Registry/Strain A (bfi_STRAINAA).txt', bytes: 'inert source text' },
    ]);
    registerEntity({ sourceRecordId: 'bfi_STRAINAA' });

    const movedPath = join(root, 'moved.zip');
    await rename(sourcePath, movedPath);
    await expect(view(record, 'bfi_STRAINAA')).resolves.toMatchObject({
      status: 'source_unavailable',
      originalPath: sourcePath,
    });

    await rename(movedPath, sourcePath);
    const changed = Buffer.from(await readFile(sourcePath));
    changed[42] = (changed[42] ?? 0) ^ 0x01;
    await writeFile(sourcePath, changed);
    await expect(view(record, 'bfi_STRAINAA')).resolves.toMatchObject({
      status: 'source_changed',
      originalPath: sourcePath,
    });
  });

  it('refuses a symlink even when it resolves to the original ZIP bytes', async () => {
    const record = await sourceRecord([
      { path: 'Registry/Strain A (bfi_STRAINAA).txt', bytes: 'inert source text' },
    ]);
    registerEntity({ sourceRecordId: 'bfi_STRAINAA' });
    const realPath = join(root, 'real.zip');
    await rename(sourcePath, realPath);
    await symlink(realPath, sourcePath);

    await expect(view(record, 'bfi_STRAINAA')).resolves.toMatchObject({
      status: 'source_unavailable',
      originalPath: sourcePath,
    });
  });

  it('returns a bounded, explicitly truncated text preview', async () => {
    const text = 'A'.repeat(EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES + 97);
    const record = await sourceRecord([
      { path: 'Registry/Strain A (bfi_STRAINAA).txt', bytes: text, compression: 'stored' },
    ]);
    registerEntity({ sourceRecordId: 'bfi_STRAINAA' });

    const result = await view(record, 'bfi_STRAINAA');
    expect(result).toMatchObject({ status: 'ready', truncated: true });
    if (result.status !== 'ready') throw new Error('Expected a ready preview.');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      EXTERNAL_PROVIDER_SOURCE_PREVIEW_MAX_BYTES
    );
  });

  it('returns a typed unsupported result for binary source records', async () => {
    const record = await sourceRecord([
      {
        path: 'Registry/Strain A (bfi_STRAINAA).png',
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      },
    ]);
    registerEntity({ sourceRecordId: 'bfi_STRAINAA' });

    await expect(view(record, 'bfi_STRAINAA')).resolves.toMatchObject({
      status: 'unsupported',
      mediaType: 'image/png',
      displayFilename: 'Strain A (bfi_STRAINAA).png',
    });
  });

  it('associates duplicate bytes by exact record identity, not by content hash', async () => {
    const record = await sourceRecord([
      { path: 'Registry/Strain A (bfi_STRAINAA).txt', bytes: 'same inert bytes' },
      { path: 'Registry/Strain B (bfi_STRAINBB).txt', bytes: 'same inert bytes' },
    ]);
    registerEntity({ sourceRecordId: 'bfi_STRAINBB' });

    await expect(view(record, 'bfi_STRAINBB')).resolves.toMatchObject({
      status: 'ready',
      entryPath: 'Registry/Strain B (bfi_STRAINBB).txt',
    });
  });

  it('reports entry evidence mismatch as source_integrity_error', async () => {
    const record = await sourceRecord([
      { path: 'Registry/Strain A (bfi_STRAINAA).txt', bytes: 'inert source text' },
    ]);
    registerEntity({ sourceRecordId: 'bfi_STRAINAA' });
    const entry = record.entries[0];
    if (!entry) throw new Error('Fixture has no entry.');
    const tampered: ExternalSourceHistoryRecord = {
      ...record,
      entries: [{ ...entry, entrySha256: `sha256:${'0'.repeat(64)}` }],
    };

    await expect(view(tampered, 'bfi_STRAINAA')).resolves.toMatchObject({
      status: 'source_integrity_error',
      originalPath: sourcePath,
    });
  });

  async function sourceRecord(
    entries: Parameters<typeof buildSyntheticNativeExportZip>[0]
  ): Promise<ExternalSourceHistoryRecord> {
    const zip = buildSyntheticNativeExportZip(entries);
    await writeFile(sourcePath, zip.bytes);
    const selected = await selectExternalZipSource({
      sourcePath,
      selectedAt: '2026-08-29T22:00:00.000Z',
    });
    return {
      workspaceId: 1,
      historyRunId: 'run-native-v2',
      source: selected.source,
      entries: selected.entries,
    };
  }

  function registerEntity(input: {
    workspaceId?: number;
    sourceRecordId: string;
    bindingStableId?: string;
  }): void {
    const workspaceId = input.workspaceId ?? 1;
    db.prepare(
      `INSERT INTO catalog_entities
         (id, type, name, locator, storage_type, status, workspace_id, metadata, created_at, updated_at)
       VALUES ('strain-entity', 'sample', 'Strain A', 'entity://lims/strain-entity',
               'database', 'active', ?, ?, 0, 0)`
    ).run(
      workspaceId,
      JSON.stringify({
        migrationSource: {
          historyRunId: 'run-native-v2',
          sourceId: `external-zip-placeholder`,
          sourceObjectId: input.sourceRecordId,
        },
      })
    );
    db.prepare(
      `INSERT INTO catalog_provider_bindings
         (id, provider, stable_object_id, object_class, entity_id, binding_kind,
          evidence_json, created_at, updated_at)
       VALUES ('binding-1', 'benchling', ?, 'registry_entity', 'strain-entity',
               'observed', '{}', 0, 0)`
    ).run(input.bindingStableId ?? input.sourceRecordId);
  }

  async function view(record: ExternalSourceHistoryRecord, sourceRecordId: string) {
    const effectiveRecord: ExternalSourceHistoryRecord = {
      ...record,
      source: { ...record.source },
    };
    db.prepare(
      `UPDATE catalog_entities
       SET metadata = json_set(metadata, '$.migrationSource.sourceId', ?)
       WHERE id = 'strain-entity'`
    ).run(effectiveRecord.source.sourceId);
    return viewExternalProviderSource(
      db,
      { workspaceId: 1, entityId: 'strain-entity', sourceRecordId },
      {
        loadHistorySource: vi.fn(async (request) =>
          request.workspacePath === join(root, 'lab-a') &&
          request.historyRunId === effectiveRecord.historyRunId &&
          request.sourceId === effectiveRecord.source.sourceId
            ? effectiveRecord
            : null
        ),
      }
    );
  }
});
