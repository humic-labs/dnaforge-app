import { actOnAcceptedScientificEntity } from './scientific-resource-lifecycle';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseResourceId,
  listWorkspaceResources,
  inspectResourceRevision,
} from '@waypoint/workspace-revisions';
import { serializeGenBank } from '@waypoint/sequence-utils';
import {
  defineScientificAssemblyDraft,
  scientificIdentityPath,
  serializeScientificHistory,
} from '@waypoint/scientific-objects';
import { createFileTestDb, openFileTestDb } from './__tests__/test-db';
import { ScientificObjectStore } from './scientific-object-store';
import {
  buildPrimerArtifact,
  revisePrimerArtifactContent,
  serializePrimerArtifact,
} from '../features/primers/public/primer-artifact';
import { parseIdtOligoNotation } from '../features/primers/public/oligo-modifications';
import { serializeEntityArtifact } from '../features/lims/public/entity-artifact';
import { submitScientificWorkspace } from './scientific-workspace-service';
import { reconcileScientificNativeProjectionsInsideTx } from './scientific-native-projection';
import { actOnAcceptedScientificEntity } from './scientific-resource-lifecycle';
import { scientificCopyResourceId } from './scientific-resource-operations';
import { runWorkspaceFileTrash } from './workspace-file-trash';
import { allocatePrimerCatalogNumberInDb } from './primer-projection';
import { repairAcceptedSequencePackageCaches } from './scientific-package-cache-migration';
import { materializeScientificWorkspace } from './scientific-object-materializer';
import * as scientificDelivery from './scientific-object-materializer';
import { readScientificDocumentInMain } from './ipc/scientific-documents';
import { defineBlob, defineResourceState } from '@waypoint/workspace-revisions';
import {
  registerLimsEntityInsideTx,
  seedLimsBuiltinsInDb,
  linkLimsEntitiesInsideTx,
} from './lims-engine-core';
import { queryLimsEntitiesInDb, getLimsRegistryPreviewInDb } from './lims';
import { loadEntitySequence } from './lims-sequence-io';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
  sequencePackagePaths,
} from '../db/sequence-package';
import {
  acquireWorkspaceSyncDatabaseFence,
  assertRendererDatabaseStatementAllowed,
} from './workspace-sync-database-fence';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(), getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
  shell: { trashItem: vi.fn(async (path: string) => rm(path, { recursive: true })) },
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

vi.mock('./scientific-migration-recovery', () => ({
  ensureScientificEnrollmentCheckpoint: vi.fn(async () => {}),
}));
import { ensureScientificEnrollmentCheckpoint } from './scientific-migration-recovery';
import { ensureSchema } from './schema';

const primer = {
  formatVersion: 1,
  kind: 'primer',
  name: 'Shared',
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
const strain = {
  formatVersion: 1,
  kind: 'strain',
  name: 'BY4741',
  taxon: 'Saccharomyces cerevisiae',
  fields: {},
};
const entries = [
  { resourceId: 'p', path: 'p.json', document: primer },
  { resourceId: 's', path: 's.json', document: sequence },
  { resourceId: 'host', path: 'host.json', document: strain },
];
const id = (value: string) => {
  const parsed = parseResourceId(value);
  if (!parsed.ok) throw Error(value);
  return parsed.value;
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
async function fixture() {
  const f = createFileTestDb('scientific-service');
  cleanups.push(f.cleanup);
  ensureSchema(f.db, f.dbPath);
  const root = join(f.tmpDir, 'project');
  await mkdir(root);
  const workspaceId = Number(
    f.db
      .prepare('INSERT INTO workspaces (name, path, repo_uuid, created_at) VALUES (?, ?, ?, ?)')
      .run('Science', root, 'scientific-project', 1).lastInsertRowid
  );
  const store = new ScientificObjectStore(f.db, workspaceId);
  const submit = (request: Parameters<typeof submitScientificWorkspace>[0]['request']) =>
    submitScientificWorkspace({ db: f.db, workspaceId, request });
  const initial = () =>
    submit({ operationId: 'initial', expectedHead: null, source: { kind: 'documents', entries } });
  return { ...f, root, workspaceId, store, submit, initial };
}

async function missingNativeHistoryFixture() {
  const f = await fixture();
  await f.initial();
  await mkdir(join(f.root, '.git'));
  const resourceId = 'native-history-primer';
  const path = `primers/${resourceId}.primer.json`;
  const artifact = await buildPrimerArtifact({
    id: resourceId,
    catalogNumber: 'PR-000098',
    name: 'Native history primer',
    sequence: 'ACGTACGTACGTACGTACGT',
    workspaceRoot: f.root,
    artifactPath: join(f.root, path),
    source: 'manual',
  });
  const text = serializePrimerArtifact(artifact);
  expect(
    await f.submit({
      operationId: 'native-history-create',
      expectedHead: f.store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: { resourceId, path, representation: { format: 'primer-v2', text } },
      },
    })
  ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
  const baseline = f.store.read();
  const inspected = await runWorkspaceFileTrash({
    kind: 'inspect',
    workspaceRoot: f.root,
    path: join(f.root, path),
  });
  if (inspected.kind !== 'inspect') throw new Error('Native primer inspection failed.');
  const trashed = await runWorkspaceFileTrash({
    kind: 'trash',
    workspaceRoot: f.root,
    path: join(f.root, path),
    expectedRevision: inspected.source.revision,
  });
  expect(trashed).toMatchObject({ kind: 'trash', changed: true });
  await expect(readFile(join(f.root, path))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.store.read().reader.current(id(resourceId))).toEqual(
    baseline.reader.current(id(resourceId))
  );
  return { ...f, resourceId, path, text, baseline };
}

describe('scientific workspace operation owner', () => {
  it('keeps saved primer inventory and lifecycle through accepted publication and cache reconstruction', async () => {
    const f = await fixture();
    const resourceId = 'inventory-primer';
    const path = `primers/${resourceId}.primer.json`;
    const inventory = {
      origin: 'manual',
      originDetails: { receivedFrom: 'verified-supplier' },
      vendor: 'IDT',
      orderDate: 1700000000000,
      scale: '25nm',
      purification: 'HPLC',
      modifications: 'verified chemistry',
      stockLocation: 'Freezer B / rack 3',
      concentration: 12.5,
    };
    const artifact = await revisePrimerArtifactContent(
      await buildPrimerArtifact({
        id: resourceId,
        catalogNumber: 'PR-000096',
        name: 'Received primer',
        sequence: 'ACGTACGTACGTACGTACGT',
        workspaceRoot: f.root,
        artifactPath: join(f.root, path),
        source: 'manual',
        inventory,
      }),
      {
        name: 'Received primer',
        sequence: 'ACGTACGTACGTACGTACGT',
        inventory,
        entityState: {
          registrationStatus: 'registered',
          domainStatus: 'received',
          archived: false,
          archivedAt: null,
          status: 'received',
          source: null,
        },
      }
    );
    artifact.registryRelationships = [
      {
        id: 'retained-primer-reference',
        fromEntityId: resourceId,
        toEntityId: 's',
        type: 'references',
        payload: { purpose: 'retained' },
        project: { status: 'assigned', repoUuid: 'scientific-project' },
        actor: 'original-producer',
        sourceEventSeq: 17,
        archived: false,
        createdAt: 1700000000000,
        updatedAt: 1700000000100,
        archivedAt: null,
      },
    ];
    const text = serializePrimerArtifact(artifact);
    expect(
      await f.submit({
        operationId: 'preserved-primer',
        expectedHead: null,
        source: {
          kind: 'documents',
          entries: [
            ...entries,
            { resourceId, path, representation: { format: 'primer-v2', text } },
          ],
        },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    const assertProjection = () => {
      const entity = f.db
        .prepare(
          'SELECT registration_status,domain_status,fields,tombstone FROM lims_entity WHERE id=?'
        )
        .get(resourceId) as {
        registration_status: string;
        domain_status: string;
        fields: string;
        tombstone: number;
      };
      expect(entity).toMatchObject({
        registration_status: 'registered',
        domain_status: 'received',
        tombstone: 0,
      });
      expect(JSON.parse(entity.fields)).toMatchObject({ status: 'received', source: null });
      const row = f.db.prepare('SELECT * FROM primers WHERE id=?').get(resourceId) as Record<
        string,
        unknown
      >;
      expect(row).toMatchObject({
        name: 'Received primer',
        origin: 'manual',
        status: 'received',
        vendor: 'IDT',
        order_date: inventory.orderDate,
        scale: inventory.scale,
        purification: inventory.purification,
        modifications: inventory.modifications,
        stock_location: inventory.stockLocation,
        concentration: inventory.concentration,
      });
      expect(JSON.parse(row.origin_details as string)).toMatchObject(inventory.originDetails);
    };
    assertProjection();
    const linkBefore = f.db
      .prepare('SELECT * FROM lims_link WHERE id=?')
      .get('retained-primer-reference') as Record<string, unknown>;
    expect(linkBefore).toMatchObject({
      from_entity_id: resourceId,
      to_entity_id: 's',
      type: 'references',
      actor: 'original-producer',
      tombstone: 0,
    });
    f.db.prepare('DELETE FROM lims_link WHERE id=?').run('retained-primer-reference');
    f.db.transaction(() => reconcileScientificNativeProjectionsInsideTx(f.db, f.workspaceId))();
    assertProjection();
    const linkAfter = f.db
      .prepare('SELECT * FROM lims_link WHERE id=?')
      .get('retained-primer-reference') as Record<string, unknown>;
    const { event_seq: beforeSeq, ...beforeLink } = linkBefore;
    const { event_seq: afterSeq, ...afterLink } = linkAfter;
    expect(afterLink).toEqual(beforeLink);
    expect(Number(afterSeq)).toBeGreaterThan(Number(beforeSeq));
    expect(await readFile(join(f.root, path), 'utf8')).toBe(text);
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([false, true])(
    'restores missing native working files from history with other accepted changes=%s',
    async (otherChanges) => {
      const f = await missingNativeHistoryFixture();
      if (otherChanges) {
        expect(
          await f.submit({
            operationId: 'move-history-stock',
            expectedHead: f.store.read().head,
            source: {
              kind: 'relocate',
              sourcePath: 'host.json',
              destinationPath: 'renamed-host.json',
            },
          })
        ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
      }
      const request = {
        operationId: 'native-complete-history-restore',
        expectedHead: f.store.read().head,
        source: { kind: 'restore-workspace' as const, version: f.baseline.head! },
      };
      expect(await f.submit(request)).toMatchObject({
        acceptance: { kind: otherChanges ? 'changed' : 'no-op' },
        delivery: { kind: 'complete' },
      });
      expect(await readFile(join(f.root, f.path), 'utf8')).toBe(f.text);
      expect(f.store.read().reader.current(id(f.resourceId))).toEqual(
        f.baseline.reader.current(id(f.resourceId))
      );
      expect(JSON.parse(await readFile(join(f.root, 'host.json'), 'utf8'))).toEqual(
        f.baseline.reader.current(id('host'))!.document
      );
      expect(await f.submit(request)).toMatchObject({
        acceptance: { kind: 'replay' },
        delivery: { kind: 'complete' },
      });
      expect(await readFile(join(f.root, f.path), 'utf8')).toBe(f.text);
      expect(await runWorkspaceFileTrash({ kind: 'list', workspaceRoot: f.root })).toMatchObject({
        entries: [expect.objectContaining({ originalPath: f.path })],
      });
    }
  );

  it.each([false, true])(
    'restores unchanged accepted files from native File Trash with later edits %s',
    async (laterEdits) => {
      const f = await fixture();
      execFileSync('git', ['init', f.root], { stdio: 'pipe' });
      await f.initial();
      const baseline = f.store.read().head;
      if (!baseline) throw new Error('The accepted project has no baseline.');
      const path = join(f.root, 'p.json');
      const original = await readFile(path, 'utf8');
      const inspected = await runWorkspaceFileTrash({
        kind: 'inspect',
        workspaceRoot: f.root,
        path,
      });
      if (inspected.kind !== 'inspect') throw new Error('The native file was not inspected.');
      expect(
        await runWorkspaceFileTrash({
          kind: 'trash',
          workspaceRoot: f.root,
          path,
          expectedRevision: inspected.source.revision,
        })
      ).toMatchObject({ kind: 'trash', changed: true });
      expect(await readFile(path).catch(() => null)).toBeNull();
      expect(f.store.read().reader.current(id('p'))?.document).toEqual(primer);
      if (laterEdits)
        await f.submit({
          operationId: 'later-host-edit',
          expectedHead: baseline,
          source: {
            kind: 'documents',
            entries: entries.map((entry) =>
              entry.resourceId === 'host'
                ? { ...entry, document: { ...strain, name: 'Later host' } }
                : entry
            ),
          },
        });
      expect(
        await f.submit({
          operationId: 'restore-file-trash-history',
          expectedHead: f.store.read().head,
          source: { kind: 'restore-workspace', version: baseline },
        })
      ).toMatchObject({ delivery: { kind: 'complete' } });
      expect(await readFile(path, 'utf8')).toBe(original);
      expect(f.store.read().reader.current(id('p'))?.document).toEqual(primer);
      expect(f.store.read().reader.current(id('host'))?.document).toEqual(strain);
      expect(f.store.pendingMaterializations()).toEqual([]);
    }
  );
  it('retains missing-file restore delivery across restart and refuses a new working occupant', async () => {
    const f = await missingNativeHistoryFixture();
    const deliver = materializeScientificWorkspace;
    const interrupted = vi
      .spyOn(scientificDelivery, 'materializeScientificWorkspace')
      .mockImplementationOnce(deliver)
      .mockRejectedValueOnce(new Error('interrupted before restored file delivery'));
    try {
      await expect(
        f.submit({
          operationId: 'durable-missing-history-repair',
          expectedHead: f.store.read().head,
          source: { kind: 'restore-workspace', version: f.baseline.head! },
        })
      ).rejects.toThrow('interrupted before restored file delivery');
    } finally {
      interrupted.mockRestore();
    }
    expect(f.store.pendingMaterializations()).toHaveLength(1);
    f.db.close();
    const db = openFileTestDb(f.dbPath);
    cleanups.push(() => db.close());
    const store = new ScientificObjectStore(db, f.workspaceId);
    await writeFile(join(f.root, f.path), 'new unsubmitted working file');
    expect(await materializeScientificWorkspace(store)).toMatchObject({ kind: 'blocked' });
    expect(await readFile(join(f.root, f.path), 'utf8')).toBe('new unsubmitted working file');
    await unlink(join(f.root, f.path));
    expect(await materializeScientificWorkspace(store)).toMatchObject({ kind: 'complete' });
    expect(await readFile(join(f.root, f.path), 'utf8')).toBe(f.text);
    expect(store.read().head).toBe(f.baseline.head);
    expect(store.read().reader.current(id(f.resourceId))).toEqual(
      f.baseline.reader.current(id(f.resourceId))
    );
  });

  it('blocks complete history restoration on an unchanged accepted file with unsaved bytes', async () => {
    const f = await fixture();
    await f.initial();
    const baseline = f.store.read().head;
    if (!baseline) throw new Error('The accepted project has no baseline.');
    await f.submit({
      operationId: 'edit-host-before-restore',
      expectedHead: baseline,
      source: {
        kind: 'documents',
        entries: entries.map((entry) =>
          entry.resourceId === 'host'
            ? { ...entry, document: { ...strain, name: 'Later host' } }
            : entry
        ),
      },
    });
    await writeFile(join(f.root, 'p.json'), 'unsubmitted primer draft');
    expect(
      await f.submit({
        operationId: 'restore-with-unsaved-primer',
        expectedHead: f.store.read().head,
        source: { kind: 'restore-workspace', version: baseline },
      })
    ).toMatchObject({
      delivery: { kind: 'blocked', error: 'Unsubmitted working change at p.json' },
    });
    expect(await readFile(join(f.root, 'p.json'), 'utf8')).toBe('unsubmitted primer draft');
  });
  it('does not accept scientific state when its mandatory enrollment checkpoint fails', async () => {
    const f = await fixture();
    vi.mocked(ensureScientificEnrollmentCheckpoint).mockRejectedValueOnce(
      new Error('recovery checkpoint fsync failed')
    );
    await expect(f.initial()).rejects.toThrow('recovery checkpoint fsync failed');
    expect(f.store.read().head).toBeNull();
    expect(f.store.pendingMaterializations()).toEqual([]);
    expect(await readFile(join(f.root, 'p.json')).catch(() => null)).toBeNull();
  });
  it('projects declared genetic code from accepted annotation facts and preserves acceptance when malformed qualifiers are refused', async () => {
    const f = await fixture();
    const scientificSequence = {
      ...sequence,
      annotations: [{ type: 'CDS', qualifiers: { transl_table: ['11'] } }],
    };
    await f.submit({
      operationId: 'annotation-facts',
      expectedHead: null,
      source: {
        kind: 'documents',
        entries: entries.map((entry) =>
          entry.resourceId === 's' ? { ...entry, document: scientificSequence } : entry
        ),
      },
    });
    expect(getLimsRegistryPreviewInDb(f.db, { entityId: 's' }).summary.fieldValues).toMatchObject({
      sequence: { length: 8, topology: 'linear', geneticCode: 11 },
    });
    const accepted = serializeScientificHistory(f.store.exportHistory());
    const head = f.store.read().head;
    await expect(
      f.submit({
        operationId: 'invalid-annotation-qualifier',
        expectedHead: head,
        source: {
          kind: 'documents',
          entries: entries.map((entry) =>
            entry.resourceId === 's'
              ? {
                  ...entry,
                  document: {
                    ...scientificSequence,
                    annotations: [{ type: 'CDS', qualifiers: { transl_table: '1' } }],
                  },
                }
              : entry
          ),
        },
      })
    ).rejects.toThrow('qualifiers must be string lists');
    expect(f.store.read().head).toBe(head);
    expect(serializeScientificHistory(f.store.exportHistory())).toEqual(accepted);
    expect(getLimsRegistryPreviewInDb(f.db, { entityId: 's' }).summary.fieldValues).toMatchObject({
      sequence: { geneticCode: 11 },
    });
  });

  it('accepts captured package metadata and header changes together while retaining DNA, custom data and exact history', async () => {
    const f = await fixture();
    await f.initial();
    const text = serializeGenBank({
      id: 'metadata-sequence',
      name: 'Recorded locus',
      sequence: 'ACGT',
      length: 4,
      circular: false,
      annotations: [],
    });
    const metadata = {
      ...buildSequencePackageDocument({
        id: 'metadata-sequence',
        name: 'Metadata sequence',
        product: {
          file: 'product.gb',
          topology: 'linear',
          genBankChecksum: defineBlob(new TextEncoder().encode(text)).hash,
        },
      }),
      supplierData: { retained: ['original'] },
    };
    await f.submit({
      operationId: 'metadata-create',
      expectedHead: f.store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId: metadata.id,
          path: 'Metadata sequence/product.gb',
          representation: { format: 'genbank-v1', text },
          sequencePackageText: JSON.stringify(metadata),
        },
      },
    });
    const before = f.store.read();
    expect(
      getLimsRegistryPreviewInDb(f.db, { entityId: metadata.id }).summary.fieldValues
    ).toMatchObject({
      size: 4,
      topology: 'linear',
      geneticCode: 1,
    });
    const product = before.reader.current(id(metadata.id))!;
    const packageSlot = f.store
      .catalog()
      .entries.find((entry) => entry.path === 'Metadata sequence/.forge/plasmid.json')!;
    const next = {
      ...metadata,
      name: 'Renamed package',
      entity: {
        ...metadata.entity,
        fields: { ...metadata.entity.fields, notes: 'Retained metadata edit' },
      },
    };
    const source = {
      kind: 'sequence-metadata' as const,
      resourceId: metadata.id,
      expectedRevisionId: product.revisionId,
      expectedPackageRevisionId: packageSlot.revisionId,
      metadataText: JSON.stringify(next),
    };

    await writeFile(join(f.root, packageSlot.path!), JSON.stringify(next));
    const blocked = await f.submit({
      operationId: 'metadata-rename',
      expectedHead: before.head,
      source,
    });
    expect(blocked, JSON.stringify(blocked.acceptance)).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'blocked' },
    });
    const retained = serializeScientificHistory(f.store.exportHistory());
    await expect(
      f.submit({
        operationId: 'metadata-rename',
        expectedHead: before.head,
        source: {
          ...source,
          expectedWorkingMetadataSha256: '0'.repeat(64),
        },
      })
    ).rejects.toThrow('working metadata changed');
    expect(serializeScientificHistory(f.store.exportHistory())).toEqual(retained);
    expect(await readFile(join(f.root, packageSlot.path!), 'utf8')).toBe(JSON.stringify(next));
    const unknownWorking = JSON.stringify({
      ...next,
      versionHistory: { ...next.versionHistory, retainedCustomMember: { source: 'saved draft' } },
    });
    await writeFile(join(f.root, packageSlot.path!), unknownWorking);
    await expect(
      f.submit({
        operationId: 'metadata-rename',
        expectedHead: before.head,
        source: {
          ...source,
          expectedWorkingMetadataSha256: defineBlob(
            new TextEncoder().encode(unknownWorking)
          ).hash.slice('sha256:'.length),
        },
      })
    ).rejects.toThrow('raw changes outside this Save');
    expect(serializeScientificHistory(f.store.exportHistory())).toEqual(retained);
    expect(await readFile(join(f.root, packageSlot.path!), 'utf8')).toBe(unknownWorking);
    await writeFile(join(f.root, packageSlot.path!), JSON.stringify(next));
    expect(
      await f.submit({
        operationId: 'metadata-rename',
        expectedHead: before.head,
        source: {
          ...source,
          expectedWorkingMetadataSha256: defineBlob(
            new TextEncoder().encode(JSON.stringify(next))
          ).hash.slice('sha256:'.length),
        },
      })
    ).toMatchObject({ acceptance: { kind: 'replay' }, delivery: { kind: 'complete' } });
    expect(serializeScientificHistory(f.store.exportHistory())).toEqual(retained);
    expect(f.store.read().reader.current(id(metadata.id))?.revisionId).toBe(product.revisionId);
    expect(JSON.parse(await readFile(join(f.root, packageSlot.path!), 'utf8'))).toMatchObject({
      name: next.name,
      supplierData: metadata.supplierData,
      entity: { fields: next.entity.fields },
    });
    const currentHead = f.store.read().head;
    expect(
      await f.submit({
        operationId: 'metadata-stale',
        expectedHead: before.head,
        source: { ...source, metadataText: JSON.stringify({ ...next, name: 'Stale writer' }) },
      })
    ).toMatchObject({ acceptance: { kind: 'conflict' } });
    expect(f.store.read().head).toBe(currentHead);
    const freshPackage = f.store
      .catalog()
      .entries.find((entry) => entry.resourceId === packageSlot.resourceId)!;
    const publishedMetadata = JSON.parse(await readFile(join(f.root, freshPackage.path!), 'utf8'));
    const changed = {
      ...publishedMetadata,
      product: { ...publishedMetadata.product, topology: 'circular' as const },
    };
    expect(
      await f.submit({
        operationId: 'metadata-header',
        expectedHead: currentHead,
        source: {
          ...source,
          expectedPackageRevisionId: freshPackage.revisionId,
          metadataText: JSON.stringify(changed),
          geneticCode: 11,
        },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    expect(f.store.read().reader.current(id(metadata.id))?.document).toMatchObject({
      bases: 'ACGT',
      topology: 'circular',
    });
    expect(
      getLimsRegistryPreviewInDb(f.db, { entityId: metadata.id }).summary.fieldValues
    ).toMatchObject({
      size: 4,
      topology: 'circular',
      geneticCode: 11,
    });
    const acceptedHead = f.store.read().head;
    const acceptedRevision = f.store.read().reader.current(id(metadata.id))?.revisionId;
    const cached = f.db.prepare('SELECT fields FROM lims_entity WHERE id=?').get(metadata.id) as {
      fields: string;
    };
    const oldFields = JSON.parse(cached.fields);
    delete oldFields._managedSequenceContent.length;
    delete oldFields._managedSequenceContent.topology;
    delete oldFields._managedSequenceContent.geneticCode;
    f.db
      .prepare('UPDATE lims_entity SET fields=? WHERE id=?')
      .run(JSON.stringify(oldFields), metadata.id);
    f.db
      .transaction(() => reconcileScientificNativeProjectionsInsideTx(f.db, f.workspaceId))
      .immediate();
    expect(
      getLimsRegistryPreviewInDb(f.db, { entityId: metadata.id }).summary.fieldValues
    ).toMatchObject({
      size: 4,
      topology: 'circular',
      geneticCode: 11,
    });
    expect(f.store.read().head).toBe(acceptedHead);
    expect(f.store.read().reader.current(id(metadata.id))?.revisionId).toBe(acceptedRevision);
    expect(f.store.read().reader.revision(product)?.representation?.text).toBe(text);
    expect(
      f.db
        .prepare(
          "SELECT payload FROM catalog_entity_events WHERE entity_id=? AND event_type='sequence_edit_transition_v1'"
        )
        .all(metadata.id)
    ).toHaveLength(1);
    await writeFile(join(f.root, freshPackage.path!), 'unsubmitted metadata draft\n');
    const acceptedRead = await readScientificDocumentInMain(
      {
        operationId: 'read-accepted-package-test',
        workspace: 'scientific-project' as never,
        workspaceRoot: f.root,
        document: freshPackage.path! as never,
      },
      { database: f.db }
    );
    expect(acceptedRead).toMatchObject({
      ok: true,
      document: { revision: { kind: 'accepted-object' } },
    });
    if (acceptedRead.ok)
      expect(JSON.parse(acceptedRead.document.content)).toMatchObject({ name: next.name });
    expect(await readFile(join(f.root, freshPackage.path!), 'utf8')).toBe(
      'unsubmitted metadata draft\n'
    );
  });

  it('refuses an omitted saved identity in a submitted or on-disk snapshot', async () => {
    const f = await fixture();
    await f.initial();
    const before = f.store.read();
    const primerBytes = await readFile(join(f.root, 'p.json'));
    const primerBefore = before.reader.current(id('p'));
    await expect(
      f.submit({
        operationId: 'omit-saved-primer',
        expectedHead: before.head,
        source: { kind: 'documents', entries: entries.filter((entry) => entry.resourceId !== 'p') },
      })
    ).rejects.toThrow('SAVED_ENTITY_CONTENT');
    const identityPath = join(f.root, scientificIdentityPath);
    const identity = JSON.parse(await readFile(identityPath, 'utf8'));
    identity.entries = identity.entries.filter(
      (entry: { resourceId: string }) => entry.resourceId !== 'p'
    );
    await writeFile(identityPath, JSON.stringify(identity));
    await expect(
      f.submit({
        operationId: 'omit-on-disk',
        expectedHead: before.head,
        source: { kind: 'working-files' },
      })
    ).rejects.toThrow('SAVED_ENTITY_CONTENT');
    const after = f.store.read();
    expect(after.head).toBe(before.head);
    expect(after.reader.current(id('p'))).toEqual(primerBefore);
    expect(await readFile(join(f.root, 'p.json'))).toEqual(primerBytes);
  });

  it('repairs and restores a deleted legacy checksum cache without rewriting historical metadata or DNA', async () => {
    const f = await fixture();
    await f.initial();
    const text = serializeGenBank({
      id: 'cache-sequence',
      name: 'Cache sequence',
      sequence: 'ACGT',
      length: 4,
      circular: false,
      annotations: [],
    });
    const metadata = buildSequencePackageDocument({
      id: 'cache-sequence',
      name: 'Cache sequence',
      product: {
        file: 'product.gb',
        genBankChecksum: defineBlob(new TextEncoder().encode(text)).hash,
      },
    });
    await f.submit({
      operationId: 'cache-create',
      expectedHead: f.store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId: metadata.id,
          path: 'Cache sequence/product.gb',
          representation: { format: 'genbank-v1', text },
          sequencePackageText: JSON.stringify(metadata),
        },
      },
    });
    const product = f.store.read().reader.current(id(metadata.id))!;
    const slot = f.store
      .catalog()
      .entries.find((entry) => entry.path === 'Cache sequence/.forge/plasmid.json')!;
    const oldBytes = new TextEncoder().encode(
      JSON.stringify({
        ...metadata,
        formatVersion: 6,
        product: { ...metadata.product, genBankChecksum: `sha256:${'0'.repeat(64)}` },
      })
    );
    const state = defineResourceState({
      layout: 'file',
      resourceKind: 'dnaforge.sequence-package.v6',
      mediaType: 'application/json',
      blob: defineBlob(oldBytes),
    });
    if (!state.ok) throw new Error('Invalid historical metadata fixture');
    f.store.submit({
      operationId: 'historical-cache-writer' as never,
      expectedHead: f.store.read().head,
      mutations: [
        {
          kind: 'edit-resource',
          resourceId: id(slot.resourceId),
          expectedRevision: slot.revisionId as never,
          state: state.value,
        },
      ],
      blobs: [oldBytes],
    });
    await materializeScientificWorkspace(f.store);
    const beforeRepair = f.store.read();
    expect(repairAcceptedSequencePackageCaches(f.db, f.store, f.workspaceId)).toBe(true);
    expect(await materializeScientificWorkspace(f.store)).toMatchObject({ kind: 'complete' });
    expect(f.store.read().head).not.toBe(beforeRepair.head);
    expect(f.store.read().reader.current(id(metadata.id))?.revisionId).toBe(product.revisionId);
    expect(
      JSON.parse(await readFile(join(f.root, slot.path!), 'utf8')).product.genBankChecksum
    ).toBe(metadata.product.genBankChecksum);
    expect(repairAcceptedSequencePackageCaches(f.db, f.store, f.workspaceId)).toBe(false);
    expect(new TextDecoder().decode(f.store.readBlob(defineBlob(oldBytes))!)).toBe(
      new TextDecoder().decode(oldBytes)
    );
    await expect(
      f.submit({
        operationId: 'delete-legacy-package',
        expectedHead: f.store.read().head,
        source: { kind: 'delete', sourcePath: 'Cache sequence' },
      })
    ).rejects.toThrow('SAVED_ENTITY_CONTENT');
    const archived = await actOnAcceptedScientificEntity({
      db: f.db,
      action: 'archive',
      input: { id: metadata.id },
    });
    expect(archived?.entity.id).toBe(metadata.id);
    const deleted = f.store.read();
    expect(deleted.reader.current(id(metadata.id))).toBeNull();
    expect(
      await f.submit({
        operationId: 'restore-legacy-package',
        expectedHead: deleted.head,
        source: { kind: 'restore-workspace', version: beforeRepair.head! },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    expect(await readFile(join(f.root, 'Cache sequence/product.gb'), 'utf8')).toBe(text);
    expect(
      JSON.parse(await readFile(join(f.root, slot.path!), 'utf8')).product.genBankChecksum
    ).toBe(metadata.product.genBankChecksum);
    expect(f.store.readBlob(defineBlob(oldBytes))).toEqual(Buffer.from(oldBytes));
  });

  it('ordinary scientific relocation preserves all three identities and history and rejects unsubmitted bytes before acceptance', async () => {
    const f = await fixture();
    await f.initial();
    for (const entry of entries) {
      const before = f.store.read();
      const snapshot = before.reader.current(id(entry.resourceId))!;
      const bytes = await readFile(join(f.root, entry.path), 'utf8');
      const destinationPath = `relocated/${entry.path}`;
      expect(
        await f.submit({
          operationId: `move-${entry.resourceId}`,
          expectedHead: before.head,
          source: { kind: 'relocate', sourcePath: entry.path, destinationPath },
        })
      ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
      const after = f.store.read();
      expect(after.reader.current(id(entry.resourceId))?.revisionId).toBe(snapshot.revisionId);
      expect(
        f.store.catalog().entries.find((slot) => slot.resourceId === entry.resourceId)?.path
      ).toBe(destinationPath);
      expect(after.reader.revision(snapshot)?.document).toEqual(snapshot.document);
      expect(await readFile(join(f.root, destinationPath), 'utf8')).toBe(bytes);
      await expect(readFile(join(f.root, entry.path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    for (const entry of entries) {
      const before = f.store.read();
      const original = before.reader.current(id(entry.resourceId))!;
      const operationId = `copy-${entry.resourceId}`;
      const copiedId = scientificCopyResourceId(operationId, entry.resourceId);
      const request = {
        operationId,
        expectedHead: before.head,
        source: {
          kind: 'copy' as const,
          resourceId: entry.resourceId,
          destinationPath: `copies/${entry.path}`,
          copiedAt: '2026-10-10T21:00:00.000Z',
        },
      };
      expect(await f.submit(request)).toMatchObject({
        acceptance: { kind: 'changed' },
        delivery: { kind: 'complete' },
      });
      const after = f.store.read();
      const copied = after.reader.current(copiedId)!;
      expect(copied.document).toMatchObject({
        kind: entry.document.kind,
        fields: { copySource: { resourceId: entry.resourceId, revisionId: original.revisionId } },
      });
      expect(after.reader.current(id(entry.resourceId))).toEqual(original);
      expect(inspectResourceRevision(after.graph, copied.revisionId)).toMatchObject({
        ok: true,
        value: { origin: { kind: 'derived', relation: 'copy', sources: [original.revisionId] } },
      });
      const copiedHead = after.head;
      expect(await f.submit(request)).toMatchObject({
        acceptance: { kind: 'replay' },
        delivery: { kind: 'complete' },
      });
      expect(f.store.read().head).toBe(copiedHead);
      expect(JSON.parse(await readFile(join(f.root, `copies/${entry.path}`), 'utf8'))).toEqual(
        copied.document
      );
    }
    const accepted = f.store.read().head;
    await writeFile(join(f.root, 'relocated/p.json'), 'unsubmitted working edit');
    await expect(
      f.submit({
        operationId: 'move-dirty',
        expectedHead: accepted,
        source: { kind: 'relocate', sourcePath: 'relocated/p.json', destinationPath: 'p.json' },
      })
    ).rejects.toThrow('Save or submit the working changes');
    expect(f.store.read().head).toBe(accepted);
    expect(await readFile(join(f.root, 'relocated/p.json'), 'utf8')).toBe(
      'unsubmitted working edit'
    );
  });

  it('delivers a native primer through an existing directory with different case and reads the same accepted file on resubmission', async () => {
    const f = await fixture();
    await f.initial();
    await mkdir(join(f.root, 'primers'));
    const before = f.store.read();
    const resourceId = 'case-directory-primer';
    const path = 'Primers/Construction/case-directory.primer.json';
    const artifact = await buildPrimerArtifact({
      id: resourceId,
      catalogNumber: 'PR-000099',
      name: 'Case directory oligo',
      sequence: 'ACGTACGTACGTACGTACGT',
      workspaceRoot: f.root,
      artifactPath: join(f.root, path),
      source: 'manual',
    });
    const text = serializePrimerArtifact(artifact);
    expect(
      await f.submit({
        operationId: 'case-directory-create',
        expectedHead: before.head,
        source: {
          kind: 'native-artifact',
          expectedRevisionId: null,
          entry: { resourceId, path, representation: { format: 'primer-v2', text } },
        },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    const accepted = f.store.read();
    expect(accepted.reader.current(id(resourceId))?.representation?.text).toBe(text);
    expect(await readFile(join(f.root, path), 'utf8')).toBe(text);
    expect(
      await f.submit({
        operationId: 'case-directory-readback',
        expectedHead: accepted.head,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({ acceptance: { kind: 'no-op' }, delivery: { kind: 'complete' } });
    expect(f.store.read().head).toBe(accepted.head);
    const operationId = 'copy-native-primer';
    const copiedId = scientificCopyResourceId(operationId, resourceId);
    const copiedPath = 'copied-case-directory.primer.json';
    const catalogNumber = allocatePrimerCatalogNumberInDb(f.db, f.workspaceId);
    expect(
      await f.submit({
        operationId,
        expectedHead: accepted.head,
        source: {
          kind: 'copy',
          resourceId,
          destinationPath: copiedPath,
          catalogNumber,
          copiedAt: '2026-10-10T21:00:00.000Z',
        },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    expect(JSON.parse(await readFile(join(f.root, copiedPath), 'utf8'))).toMatchObject({
      id: copiedId,
      name: `${artifact.name} copy`,
      catalogNumber,
      registry: { entityId: copiedId },
      file: { workspaceRelativePath: copiedPath },
      copySource: { resourceId, revisionId: accepted.reader.current(id(resourceId))!.revisionId },
    });
    expect(f.db.prepare('SELECT name FROM lims_entity WHERE id=?').get(copiedId)).toEqual({
      name: `${artifact.name} copy`,
    });
    expect(await readFile(join(f.root, path), 'utf8')).toBe(text);
  });

  it('reconstructs accepted managed sequence carriage without replacing its native Registry representation', async () => {
    const f = await fixture();
    await f.initial();
    const resourceId = 'managed-rescue-source';
    const text = serializeGenBank({
      id: resourceId,
      name: 'Rescue source',
      sequence: sequence.bases,
      length: sequence.bases.length,
      circular: true,
      annotations: [],
    });
    const metadata = buildSequencePackageDocument({
      id: resourceId,
      name: 'Rescue source',
      product: {
        file: 'source.gb',
        genBankChecksum: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      },
    });
    metadata.entity.fields.notes = 'Preserve declared source metadata';
    await f.submit({
      operationId: 'managed-strain-source',
      expectedHead: f.store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId,
          path: 'Rescue source/source.gb',
          representation: { format: 'genbank-v1', text },
          sequencePackageText: serializeSequencePackageDocument(metadata),
        },
      },
    });
    const sourceRevision = f.store.read().reader.current(id(resourceId))!.revisionId;
    f.db.transaction(() => {
      seedLimsBuiltinsInDb(f.db);
      registerLimsEntityInsideTx(f.db, {
        id: resourceId,
        kind: metadata.entity.schema.name,
        name: metadata.name,
        workspaceId: f.workspaceId,
        fields: {
          ...metadata.entity.fields,
          _managedSequenceDocument: {
            kind: 'managed-sequence',
            packageId: resourceId,
            packageRoot: join(f.root, 'Rescue source'),
          },
        },
      });
    })();
    const planned = {
      schema: 'waypoint.entity.v1' as const,
      id: 'managed-assay',
      kind: 'strain',
      name: 'Planned empty vector assay',
      fields: { genotypeCanonical: 'MATa ura3Δ0' },
      registrationStatus: 'tracked' as const,
      domainStatus: 'planned',
      source: { type: 'manual' as const, values: {} },
      relationships: [
        {
          type: 'carried_by',
          fromEntityId: resourceId,
          toEntityId: 'managed-assay',
          payload: { assertion: 'planned', targetRevisionId: sourceRevision },
        },
      ],
    };
    await f.submit({
      operationId: 'managed-assay',
      expectedHead: f.store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId: planned.id,
          path: 'assay.entity.json',
          representation: { format: 'strain-entity-v1', text: serializeEntityArtifact(planned) },
        },
      },
    });
    const rebuild = () =>
      f.db
        .transaction(() => reconcileScientificNativeProjectionsInsideTx(f.db, f.workspaceId))
        .immediate();
    expect(rebuild()).toMatchObject({ relationships: 1 });
    const projected = queryLimsEntitiesInDb(f.db, { id: resourceId })[0];
    expect(projected.fields).toMatchObject({
      notes: 'Preserve declared source metadata',
      _managedSequenceDocument: {
        packageId: resourceId,
        packageRoot: join(f.root, 'Rescue source'),
      },
    });
    expect(projected.fields).not.toHaveProperty('sequence');
    expect(rebuild()).toMatchObject({ relationships: 1 });
    expect(queryLimsEntitiesInDb(f.db, { id: resourceId })[0]).toEqual(projected);
    const copiedSequenceId = scientificCopyResourceId('copy-managed-source', resourceId);
    expect(
      await f.submit({
        operationId: 'copy-managed-source',
        expectedHead: f.store.read().head,
        source: {
          kind: 'copy',
          resourceId,
          destinationPath: 'Rescue source copy',
          copiedAt: '2026-10-10T21:00:00.000Z',
        },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    expect(await readFile(join(f.root, 'Rescue source copy/source.gb'), 'utf8')).toBe(text);
    expect(queryLimsEntitiesInDb(f.db, { id: copiedSequenceId })[0].fields).toMatchObject({
      notes: 'Preserve declared source metadata',
      _managedSequenceDocument: {
        packageId: copiedSequenceId,
        packageRoot: join(f.root, 'Rescue source copy'),
      },
    });
    const copiedStrainId = scientificCopyResourceId('copy-managed-assay', planned.id);
    expect(
      await f.submit({
        operationId: 'copy-managed-assay',
        expectedHead: f.store.read().head,
        source: {
          kind: 'copy',
          resourceId: planned.id,
          destinationPath: 'assay-copy.entity.json',
          copiedAt: '2026-10-10T21:00:00.000Z',
        },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    const copiedAssociation = f.store
      .read()
      .reader.listCurrent()
      .find(
        (snapshot) =>
          snapshot.document.kind === 'strain-sequence' &&
          snapshot.document.strainId === copiedStrainId
      )!;
    expect(copiedAssociation.document).toMatchObject({
      sequence: { resourceId, revisionId: sourceRevision },
    });
    expect(queryLimsEntitiesInDb(f.db, { id: copiedStrainId })[0]).toMatchObject({
      name: `${planned.name} copy`,
      domainStatus: 'planned',
      fields: planned.fields,
    });
    const prior = f.store.read();
    const association = prior.reader
      .listCurrent()
      .find(
        (snapshot) =>
          snapshot.document.kind === 'strain-sequence' && snapshot.document.strainId === planned.id
      )!;
    const bytes = await readFile(join(f.root, 'Rescue source/source.gb'), 'utf8');
    expect(
      await actOnAcceptedScientificEntity({
        db: f.db,
        action: 'archive',
        input: { id: resourceId },
      })
    ).toMatchObject({ entity: { id: resourceId, tombstone: true } });
    expect(f.store.read().reader.current(id(resourceId))).toBeNull();
    expect(f.store.read().reader.current(association.resourceId)).toEqual(association);
    await expect(readFile(join(f.root, 'Rescue source/source.gb'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await actOnAcceptedScientificEntity({
        db: f.db,
        action: 'restore',
        input: { id: resourceId },
      })
    ).toMatchObject({ entity: { id: resourceId, tombstone: false, fields: projected.fields } });
    expect(await readFile(join(f.root, 'Rescue source/source.gb'), 'utf8')).toBe(bytes);
    expect(f.store.read().reader.current(association.resourceId)).toEqual(association);
    expect(
      await actOnAcceptedScientificEntity({
        db: f.db,
        action: 'archive',
        input: { id: planned.id },
      })
    ).toMatchObject({ entity: { id: planned.id, tombstone: true } });
    expect(f.store.read().reader.current(association.resourceId)).toBeNull();
    expect(
      await actOnAcceptedScientificEntity({
        db: f.db,
        action: 'restore',
        input: { id: planned.id },
      })
    ).toMatchObject({ entity: { id: planned.id, tombstone: false } });
    expect(f.store.read().reader.current(association.resourceId)?.document).toEqual(
      association.document
    );
    expect(f.store.read().reader.revision(association)).toEqual(association);
    const beforeEdit = f.store.read().reader.current(id(planned.id))!;
    const edited = {
      ...planned,
      name: 'Revised planned assay',
      relationships: [
        {
          ...planned.relationships[0],
          fromEntityId: copiedSequenceId,
          payload: {
            ...planned.relationships[0].payload,
            targetRevisionId: f.store.read().reader.current(copiedSequenceId)!.revisionId,
          },
        },
      ],
    };
    expect(
      await f.submit({
        operationId: 'edit-assay-before-revert',
        expectedHead: f.store.read().head,
        source: {
          kind: 'native-artifact',
          expectedRevisionId: beforeEdit.revisionId,
          entry: {
            resourceId: planned.id,
            path: 'assay.entity.json',
            representation: { format: 'strain-entity-v1', text: serializeEntityArtifact(edited) },
          },
        },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    const replacement = f.store
      .read()
      .reader.listCurrent()
      .find(
        (snapshot) =>
          snapshot.document.kind === 'strain-sequence' && snapshot.document.strainId === planned.id
      )!;
    expect(
      await actOnAcceptedScientificEntity({ db: f.db, action: 'revert', input: { id: planned.id } })
    ).toMatchObject({ reverted: true, entity: { name: planned.name } });
    expect(f.store.read().reader.current(id(planned.id))?.representation?.text).toBe(
      beforeEdit.representation?.text
    );
    expect(f.store.read().reader.current(replacement.resourceId)).toBeNull();
    expect(f.store.read().reader.current(association.resourceId)?.document).toEqual(
      association.document
    );
    const copiedStrain = f.store.read().reader.current(copiedStrainId)?.document;
    if (copiedStrain?.kind !== 'strain') throw new Error('Expected accepted copied strain.');
    expect(copiedStrain.name).toBe(`${planned.name} copy`);
  });

  it('accepts the exact new GenBank and format-6 package together before blocked delivery, then replays without another version', async () => {
    const f = await fixture();
    await f.initial();
    const before = f.store.read();
    const resourceId = 'new-sequence';
    const packageRoot = join(f.root, 'New sequence');
    const paths = sequencePackagePaths(packageRoot, { productFile: 'New sequence.gb' });
    const text = serializeGenBank({
      id: resourceId,
      name: 'New sequence',
      sequence: '',
      length: 0,
      circular: false,
      annotations: [],
    });
    const sequencePackageText = serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: resourceId,
        name: 'New sequence',
        product: {
          file: 'New sequence.gb',
          genBankChecksum: `sha256:${createHash('sha256').update(text).digest('hex')}`,
        },
        updatedAt: '2026-10-08T21:00:00.000Z',
      })
    );
    const request = {
      operationId: 'create-native-sequence-package',
      expectedHead: before.head,
      source: {
        kind: 'native-artifact' as const,
        expectedRevisionId: null,
        entry: {
          resourceId,
          path: 'New sequence/New sequence.gb',
          representation: { format: 'genbank-v1' as const, text },
          sequencePackageText,
        },
      },
    };
    await mkdir(packageRoot);
    await writeFile(paths.productPath, 'external sequence arrived before delivery\n');
    expect(await f.submit(request)).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'blocked' },
    });
    const pending = f.store.read();
    expect(pending.reader.current(id(resourceId))?.representation?.text).toBe(text);
    const slots = listWorkspaceResources(pending.graph, pending.head!);
    if (!slots.ok) throw Error('Missing accepted package namespace');
    const metadata = slots.value.find((slot) => slot.path === relative(f.root, paths.metaPath));
    expect(metadata).toBeDefined();
    expect(await readFile(paths.productPath, 'utf8')).toBe(
      'external sequence arrived before delivery\n'
    );
    await unlink(paths.productPath);
    expect(await f.submit(request)).toMatchObject({
      acceptance: { kind: 'replay' },
      delivery: { kind: 'complete' },
    });
    expect(f.store.read().head).toBe(pending.head);
    expect(await readFile(paths.productPath, 'utf8')).toBe(text);
    expect(await readFile(paths.metaPath, 'utf8')).toBe(sequencePackageText);
    expect(f.store.read().reader.current(id('s'))?.revisionId).toBe(
      before.reader.current(id('s'))?.revisionId
    );
  });

  it('accepts a new native identity before delivery, retains a conflicting working file, and retries the same creation without another identity or revision', async () => {
    const f = await fixture();
    await f.initial();
    const before = f.store.read();
    const catalogBefore = f.store.catalog();
    const resourceId = 'new-native-primer';
    const path = `${resourceId}.primer.json`;
    const artifact = await buildPrimerArtifact({
      id: resourceId,
      catalogNumber: 'PR-000099',
      name: 'New oligo',
      sequence: 'ACGTACGTACGTACGTACGT',
      workspaceRoot: f.root,
      artifactPath: join(f.root, path),
      source: 'manual',
    });
    const text = serializePrimerArtifact(artifact);
    const request = {
      operationId: 'new-native',
      expectedHead: before.head,
      source: {
        kind: 'native-artifact' as const,
        expectedRevisionId: null,
        entry: { resourceId, path, representation: { format: 'primer-v2' as const, text } },
      },
    };
    await writeFile(join(f.root, path), 'external file arrived during creation\n');
    expect(await f.submit(request)).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'blocked' },
    });
    const accepted = f.store.read();
    expect(accepted.reader.current(id(resourceId))?.representation?.text).toBe(text);
    expect(accepted.reader.current(id('s'))?.revisionId).toBe(
      before.reader.current(id('s'))?.revisionId
    );
    expect(await readFile(join(f.root, path), 'utf8')).toBe(
      'external file arrived during creation\n'
    );
    await unlink(join(f.root, path));
    expect(await f.submit(request)).toMatchObject({
      acceptance: { kind: 'replay' },
      delivery: { kind: 'complete' },
    });
    expect(f.store.read().head).toBe(accepted.head);
    expect(f.store.catalog().entries).toHaveLength(catalogBefore.entries.length + 1);
    expect(
      f.store.catalog().entries.filter((slot) => slot.resourceId === id(resourceId))
    ).toHaveLength(1);
    expect(await readFile(join(f.root, path), 'utf8')).toBe(text);
  });

  it('publishes one captured native artifact without deleting other accepted objects, rejects stale ownership, and replays without rewinding later history', async () => {
    const f = await fixture();
    const resourceId = 'native-editor-primer';
    const path = `primers/${resourceId}.primer.json`;
    const artifact = await buildPrimerArtifact({
      id: resourceId,
      catalogNumber: 'PR-000094',
      name: 'Original primer',
      sequence: 'ACGTACGTACGTACGTACGT',
      workspaceRoot: f.root,
      artifactPath: join(f.root, path),
      source: 'manual',
    });
    const original = serializePrimerArtifact(artifact);
    await f.submit({
      operationId: 'native-initial',
      expectedHead: null,
      source: {
        kind: 'documents',
        entries: [
          ...entries,
          {
            resourceId,
            path,
            representation: { format: 'primer-v2', text: original },
          },
        ],
      },
    });
    const before = f.store.read();
    const revision = before.reader.current(id(resourceId))!.revisionId;
    const sequenceRevision = before.reader.current(id('s'))!.revisionId;
    const revised = await revisePrimerArtifactContent(artifact, {
      name: 'Renamed primer',
      sequence: artifact.sequence.bases,
    });
    const proposal = {
      operationId: 'native-edit',
      expectedHead: before.head,
      source: {
        kind: 'native-artifact' as const,
        expectedRevisionId: revision,
        entry: {
          resourceId,
          path,
          representation: {
            format: 'primer-v2' as const,
            text: serializePrimerArtifact(revised),
          },
        },
      },
    };
    expect(await f.submit(proposal)).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    const current = f.store.read();
    expect(current.reader.listCurrent()).toHaveLength(4);
    expect(current.reader.current(id('s'))!.revisionId).toBe(sequenceRevision);
    expect(
      current.reader.revision({ resourceId: id(resourceId), revisionId: revision })!.representation!
        .text
    ).toBe(original);
    await expect(
      f.submit({ ...proposal, operationId: 'stale-native', expectedHead: current.head })
    ).rejects.toThrow(/revision/iu);
    await expect(
      f.submit({
        ...proposal,
        operationId: 'forged-create',
        expectedHead: current.head,
        source: { ...proposal.source, expectedRevisionId: null },
      })
    ).rejects.toThrow(/already|identity/iu);
    expect(f.store.read().head).toBe(current.head);
    expect(
      await f.submit({
        ...proposal,
        operationId: 'already-accepted-native',
        expectedHead: current.head,
        source: {
          ...proposal.source,
          expectedRevisionId: current.reader.current(id(resourceId))!.revisionId,
        },
      })
    ).toMatchObject({ acceptance: { kind: 'no-op' } });
    expect(f.store.read().head).toBe(current.head);
    const later = serializePrimerArtifact(
      await revisePrimerArtifactContent(revised, {
        name: 'Later primer',
        sequence: revised.sequence.bases,
      })
    );
    await f.submit({
      ...proposal,
      operationId: 'later-native',
      expectedHead: current.head,
      source: {
        ...proposal.source,
        expectedRevisionId: current.reader.current(id(resourceId))!.revisionId,
        entry: { ...proposal.source.entry, representation: { format: 'primer-v2', text: later } },
      },
    });
    const laterHead = f.store.read().head;
    expect(await f.submit(proposal)).toMatchObject({ acceptance: { kind: 'replay' } });
    expect(f.store.read().head).toBe(laterHead);
    expect(await readFile(join(f.root, path), 'utf8')).toBe(later);
    const protectedBefore = f.store.exportHistory();
    const nested = Number(
      f.db
        .prepare('INSERT INTO workspaces(name,path,created_at) VALUES (?,?,1)')
        .run('Independent nested owner', join(f.root, 'primers')).lastInsertRowid
    );
    const pendingName = serializePrimerArtifact(
      await revisePrimerArtifactContent(JSON.parse(later), {
        name: 'Another name',
        sequence: revised.sequence.bases,
      })
    );
    const currentProposal = {
      ...proposal,
      expectedHead: laterHead,
      source: {
        ...proposal.source,
        expectedRevisionId: f.store.read().reader.current(id(resourceId))!.revisionId,
        entry: {
          ...proposal.source.entry,
          representation: { format: 'primer-v2' as const, text: pendingName },
        },
      },
    };
    await expect(
      f.submit({ ...currentProposal, operationId: 'nested-owner-name-save' })
    ).rejects.toThrow(/own|workspace/iu);
    expect(f.store.exportHistory()).toEqual(protectedBefore);
    expect(await readFile(join(f.root, path), 'utf8')).toBe(later);
    f.db.prepare('DELETE FROM workspaces WHERE id=?').run(nested);
    f.db
      .prepare(
        "INSERT INTO lims_safety_quarantine(id,status,reason,evidence_kind,evidence_workspace_id,evidence_json,detected_at) VALUES (1,'quarantined','test native safety','cloud_restore',?,'{}',1)"
      )
      .run(f.workspaceId);
    await expect(
      f.submit({
        ...proposal,
        operationId: 'quarantined-name-save',
        expectedHead: laterHead,
        source: {
          ...proposal.source,
          expectedRevisionId: f.store.read().reader.current(id(resourceId))!.revisionId,
          entry: {
            ...proposal.source.entry,
            representation: {
              format: 'primer-v2',
              text: serializePrimerArtifact(
                await revisePrimerArtifactContent(JSON.parse(later), {
                  name: 'Quarantined name',
                  sequence: revised.sequence.bases,
                })
              ),
            },
          },
        },
      })
    ).rejects.toThrow(/quarantin|safety|blocked/iu);
    expect(f.store.exportHistory()).toEqual(protectedBefore);
    expect(await readFile(join(f.root, path), 'utf8')).toBe(later);
  });

  it('retains the embedded frozen schema when accepting an older native strain artifact', async () => {
    const f = await fixture();
    seedLimsBuiltinsInDb(f.db);
    f.db.transaction(() =>
      registerLimsEntityInsideTx(f.db, {
        id: 'schema-source',
        kind: 'strain',
        name: 'Schema source',
        fields: {},
        workspaceId: f.workspaceId,
      })
    )();
    const schemaSnapshot = getLimsRegistryPreviewInDb(f.db, {
      entityId: 'schema-source',
    }).schemaSnapshot;
    const artifact = {
      schema: 'waypoint.entity.v1' as const,
      id: 'frozen-v1-strain',
      kind: 'strain',
      name: 'Frozen older stock',
      schemaSnapshot,
      fields: { genotypeCanonical: 'MATa ura3Δ0' },
      registrationStatus: 'tracked' as const,
      domainStatus: 'planned',
      relationships: [],
      source: { type: 'manual' as const, values: {} },
    };
    const text = serializeEntityArtifact(artifact);
    await f.submit({
      operationId: 'frozen-v1-schema',
      expectedHead: null,
      source: {
        kind: 'documents',
        entries: [
          {
            resourceId: artifact.id,
            path: 'Frozen.entity.json',
            representation: { format: 'strain-entity-v1', text },
          },
        ],
      },
    });
    expect(queryLimsEntitiesInDb(f.db, { id: artifact.id })[0]).toMatchObject({
      schemaRevisionId: schemaSnapshot.schemaRevisionId,
      fields: artifact.fields,
    });
    expect(getLimsRegistryPreviewInDb(f.db, { entityId: artifact.id }).schemaSnapshot).toEqual(
      schemaSnapshot
    );
    expect(f.store.read().reader.current(id(artifact.id))?.representation?.text).toBe(text);
  });

  it('projects native strain Registry records during submission, preserves other owners, and rolls back acceptance when projection fails', async () => {
    const f = await fixture();
    const parent = {
      schema: 'waypoint.entity.v1' as const,
      id: 'native-parent',
      kind: 'strain',
      name: 'BY4741',
      fields: { species: 'Saccharomyces cerevisiae', genotypeCanonical: 'MATa ura3Δ0' },
      registrationStatus: 'tracked' as const,
      domainStatus: 'planned',
      source: { type: 'manual' as const, values: {} },
      relationships: [],
    };
    const child = {
      ...parent,
      id: 'native-child',
      name: 'Planned derivative',
      relationships: [
        {
          type: 'derives_from',
          fromEntityId: 'native-child',
          toEntityId: parent.id,
          payload: { assertion: 'planned', source: { preserve: ['stock', 12] } },
        },
        {
          type: 'carried_by',
          fromEntityId: 's',
          toEntityId: 'native-child',
          payload: { assertion: 'planned', marker: 'URA3' },
        },
      ],
    };
    await f.submit({
      operationId: 'project-native-strains',
      expectedHead: null,
      source: {
        kind: 'documents',
        entries: [
          ...entries,
          {
            resourceId: parent.id,
            path: 'parent.entity.json',
            representation: { format: 'strain-entity-v1', text: serializeEntityArtifact(parent) },
          },
          {
            resourceId: child.id,
            path: 'child.entity.json',
            representation: { format: 'strain-entity-v1', text: serializeEntityArtifact(child) },
          },
        ],
      },
    });
    expect(queryLimsEntitiesInDb(f.db, { id: child.id })[0].name).toBe(child.name);
    expect(getLimsRegistryPreviewInDb(f.db, { entityId: child.id }).incomingLinks).toHaveLength(1);
    f.db.transaction(() => {
      seedLimsBuiltinsInDb(f.db);
      registerLimsEntityInsideTx(f.db, {
        id: 'outside-strain',
        kind: 'strain',
        name: 'Outside this accepted set',
        fields: parent.fields,
        workspaceId: f.workspaceId,
      });
    })();
    const rebuild = () =>
      f.db
        .transaction(() => reconcileScientificNativeProjectionsInsideTx(f.db, f.workspaceId))
        .immediate();
    const first = rebuild();
    const sourceEntity = queryLimsEntitiesInDb(f.db, { id: 's' })[0];
    expect(sourceEntity).toMatchObject({
      kind: 'dna_sequence',
      fields: {
        sequence: {
          mode: 'file',
          documentId: 's',
          acceptedRevisionId: f.store.read().reader.current(id('s'))!.revisionId,
          length: sequence.bases.length,
          topology: 'linear',
        },
      },
    });
    await writeFile(join(f.root, 's.json'), 'Unsubmitted invalid sequence file');
    expect(loadEntitySequence(sourceEntity, 'accepted source', f.db).sequence.sequence).toBe(
      sequence.bases
    );
    expect(() =>
      loadEntitySequence(
        {
          ...sourceEntity,
          fields: {
            ...sourceEntity.fields,
            sequence: {
              ...(sourceEntity.fields.sequence as Record<string, unknown>),
              acceptedRevisionId: f.store.read().reader.current(id(parent.id))!.revisionId,
            },
          },
        },
        'wrong owner',
        f.db
      )
    ).toThrow(/unavailable/iu);
    expect(() =>
      loadEntitySequence(
        {
          ...sourceEntity,
          fields: {
            ...sourceEntity.fields,
            sequence: {
              ...(sourceEntity.fields.sequence as Record<string, unknown>),
              fileContentHash: 'sha256:' + 'f'.repeat(64),
            },
          },
        },
        'wrong hash',
        f.db
      )
    ).toThrow(/exact revision/iu);
    await writeFile(join(f.root, 's.json'), JSON.stringify(sequence));
    f.db.transaction(() =>
      linkLimsEntitiesInsideTx(f.db, {
        id: 'outside-link',
        type: 'carried_by',
        fromEntityId: 's',
        toEntityId: 'outside-strain',
        payload: { preserve: true },
        workspaceId: f.workspaceId,
      })
    )();
    expect(first).toMatchObject({ head: f.store.read().head, relationships: 2 });
    expect([...first.projectedPaths].sort()).toEqual(['child.entity.json', 'parent.entity.json']);
    const preview = () => getLimsRegistryPreviewInDb(f.db, { entityId: child.id });
    expect(preview().nativeRecord?.scientificAuthority).toMatchObject({
      workspaceRoot: f.root,
      workspaceId: f.workspaceId,
      artifactPath: join(f.root, 'child.entity.json'),
      revision: {
        resourceId: child.id,
        resourceRevisionId: f.store.read().reader.current(id(child.id))!.revisionId,
        workspaceVersionId: f.store.read().head,
      },
    });
    expect(preview().outgoingLinks[0].link.payload).toMatchObject({
      source: { preserve: ['stock', 12] },
      targetRevisionId: f.store.read().reader.current(id(parent.id))!.revisionId,
    });
    expect(preview().incomingLinks[0].link.payload).toMatchObject({
      assertion: 'planned',
      marker: 'URA3',
      targetRevisionId: f.store.read().reader.current(id('s'))!.revisionId,
    });
    const auditCount = () =>
      Number(
        (f.db.prepare('SELECT COUNT(*) AS count FROM lims_audit').get() as { count: number }).count
      );
    const firstAuditCount = auditCount();
    await writeFile(
      join(f.root, 'child.entity.json'),
      serializeEntityArtifact({ ...child, name: 'Unsubmitted file name' })
    );
    expect(rebuild()).toEqual(first);
    expect(queryLimsEntitiesInDb(f.db, { id: child.id })[0].name).toBe(child.name);
    expect(auditCount()).toBe(firstAuditCount);
    const edited = {
      ...child,
      name: 'Accepted revised derivative',
      relationships: child.relationships.map((link) => ({
        ...link,
        payload: { ...link.payload, note: 'Accepted method clarification' },
      })),
    };
    await writeFile(join(f.root, 'child.entity.json'), serializeEntityArtifact(edited));
    const previousHead = f.store.read().head;
    const editRequest = {
      operationId: 'project-native-strain-edit',
      expectedHead: previousHead,
      source: { kind: 'working-files' as const },
    };
    f.db.exec(
      "CREATE TRIGGER block_scientific_projection BEFORE INSERT ON lims_link BEGIN SELECT RAISE(ABORT, 'projection unavailable'); END"
    );
    await expect(f.submit(editRequest)).rejects.toThrow(/projection unavailable/iu);
    expect(f.store.read().head).toBe(previousHead);
    expect(queryLimsEntitiesInDb(f.db, { id: child.id })[0].name).toBe(child.name);
    expect(auditCount()).toBe(firstAuditCount);
    f.db.exec('DROP TRIGGER block_scientific_projection');
    expect(await f.submit(editRequest)).toMatchObject({ acceptance: { kind: 'changed' } });
    const acceptedHead = f.store.read().head;
    expect(queryLimsEntitiesInDb(f.db, { id: child.id })[0].name).toBe(edited.name);
    expect(preview().incomingLinks[0].link.payload).toMatchObject({
      note: 'Accepted method clarification',
    });
    const retriedAuditCount = auditCount();
    rebuild();
    expect(auditCount()).toBe(retriedAuditCount);
    await writeFile(
      join(f.root, 'child.entity.json'),
      serializeEntityArtifact({ ...edited, relationships: [] })
    );
    await f.submit({
      operationId: 'project-native-strain-remove-links',
      expectedHead: acceptedHead,
      source: { kind: 'working-files' },
    });
    expect(rebuild().relationships).toBe(0);
    expect(preview().outgoingLinks).toEqual([]);
    expect(preview().incomingLinks).toEqual([]);
    expect(f.db.prepare("SELECT tombstone FROM lims_link WHERE id = 'outside-link'").get()).toEqual(
      { tombstone: 0 }
    );
  });
  it('refuses missing, wrong-kind, duplicate and unqualified native strain links and removes a planned link without losing its historical version', async () => {
    const f = await fixture();
    await f.initial();

    f.db.transaction(() => {
      seedLimsBuiltinsInDb(f.db);
      registerLimsEntityInsideTx(f.db, {
        id: 'host',
        kind: 'strain',
        name: strain.name,
        fields: { species: strain.taxon },
        workspaceId: f.workspaceId,
      });
    })();
    const head = f.store.read().head;
    const artifact = {
      schema: 'waypoint.entity.v1' as const,
      id: 'native-child',
      kind: 'strain',
      name: 'Planned child',
      fields: { species: 'Saccharomyces cerevisiae', genotypeCanonical: 'MATa ura3Δ0' },
      registrationStatus: 'tracked' as const,
      domainStatus: 'planned',
      source: { type: 'manual' as const, values: { origin: 'recorded plan' } },
      relationships: [],
    };
    const planned = {
      type: 'derives_from',
      fromEntityId: artifact.id,
      toEntityId: 'host',
      payload: { assertion: 'planned', custom: { preserve: [1, 'source'] } },
    };
    const cases = [
      {
        name: 'missing',
        links: [{ ...planned, toEntityId: 'missing' }],
        error: /target|unavailable/iu,
      },
      { name: 'wrong-kind', links: [{ ...planned, toEntityId: 'p' }], error: /kind/iu },
      { name: 'duplicate', links: [planned, planned], error: /more than once/iu },
      {
        name: 'unsupported',
        links: [{ ...planned, type: 'unsupported_link' }],
        error: /unsupported/iu,
      },
      {
        name: 'unqualified',
        links: [{ ...planned, payload: {} }],
        error: /assertion|qualification/iu,
      },
      {
        name: 'observed',
        links: [{ ...planned, payload: { assertion: 'observed' } }],
        error: /physical evidence/iu,
      },
    ];
    for (const invalid of cases) {
      const text = serializeEntityArtifact({ ...artifact, relationships: invalid.links });
      await writeFile(join(f.root, 'child.entity.json'), text);
      await expect(
        f.submit({
          operationId: `native-strain-invalid-${invalid.name}`,
          expectedHead: head,
          source: {
            kind: 'documents',
            entries: [
              ...entries,
              {
                resourceId: artifact.id,
                path: 'child.entity.json',
                representation: { format: 'strain-entity-v1', text },
              },
            ],
          },
        })
      ).rejects.toThrow(invalid.error);
      expect(f.store.read().head).toBe(head);
      expect(await readFile(join(f.root, 'child.entity.json'), 'utf8')).toBe(text);
    }
    const text = serializeEntityArtifact({ ...artifact, relationships: [planned] });
    await writeFile(join(f.root, 'child.entity.json'), text);
    expect(
      await f.submit({
        operationId: 'native-strain-valid-plan',
        expectedHead: head,
        source: {
          kind: 'documents',
          entries: [
            ...entries,
            {
              resourceId: artifact.id,
              path: 'child.entity.json',
              representation: { format: 'strain-entity-v1', text },
            },
          ],
        },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    const accepted = f.store.read();
    const link = accepted.reader
      .listCurrent()
      .find((snapshot) => snapshot.document.kind === 'strain-descent')!;
    expect(link.document).toMatchObject({ fields: { payload: planned.payload } });
    await writeFile(join(f.root, 'child.entity.json'), serializeEntityArtifact(artifact));
    expect(
      await f.submit({
        operationId: 'native-strain-remove-link',
        expectedHead: accepted.head,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    expect(f.store.read().reader.current(link.resourceId)).toBeNull();
    expect(f.store.read().reader.revision(link)).toEqual(link);
  });
  it('pins native planned strain descent and sequence carriage together, preserves complete link provenance and old parents, and rejects unqualified links or cycles atomically', async () => {
    const f = await fixture();
    const parent = {
      schema: 'waypoint.entity.v1' as const,
      id: 'native-parent',
      kind: 'strain',
      name: 'BY4741',
      fields: {
        genotypeCanonical: 'MATa his3Δ1 leu2Δ0 met15Δ0 ura3Δ0',
        species: 'Saccharomyces cerevisiae',
      },
      registrationStatus: 'tracked' as const,
      domainStatus: 'planned',
      source: { type: 'manual' as const, values: { origin: 'parent stock' } },
      relationships: [],
    };
    const child = {
      ...parent,
      id: 'native-child',
      name: 'Planned derivative',
      relationships: [
        {
          type: 'derives_from',
          fromEntityId: 'native-child',
          toEntityId: 'native-parent',
          payload: {
            assertion: 'planned',
            method: 'homologous recombination',
            source: { preserve: ['stock', 12] },
          },
        },
        {
          type: 'carried_by',
          fromEntityId: 's',
          toEntityId: 'native-child',
          payload: { assertion: 'planned', marker: 'URA3' },
        },
      ],
    };
    const parentText = serializeEntityArtifact(parent),
      childText = serializeEntityArtifact(child);
    const initialRequest = {
      operationId: 'native-strain-links-import',
      expectedHead: null,
      source: {
        kind: 'documents' as const,
        entries: [
          ...entries,
          {
            resourceId: parent.id,
            path: 'parent.entity.json',
            representation: { format: 'strain-entity-v1', text: parentText },
          },
          {
            resourceId: child.id,
            path: 'child.entity.json',
            representation: { format: 'strain-entity-v1', text: childText },
          },
        ],
      },
    };
    expect(await f.submit(initialRequest)).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    expect(await readFile(join(f.root, 'child.entity.json'), 'utf8')).toBe(childText);
    const old = f.store.read();
    const links = old.reader
      .listCurrent()
      .filter(
        (snapshot) =>
          snapshot.document.kind === 'strain-descent' ||
          snapshot.document.kind === 'strain-sequence'
      );
    expect(links).toHaveLength(2);
    const oldParent = old.reader.current(id(parent.id))!,
      oldSequence = old.reader.current(id('s'))!;
    const descent = links.find((snapshot) => snapshot.document.kind === 'strain-descent')!;
    const carriage = links.find((snapshot) => snapshot.document.kind === 'strain-sequence')!;
    expect(descent.document).toMatchObject({
      kind: 'strain-descent',
      strainId: child.id,
      parent: { resourceId: parent.id, revisionId: oldParent.revisionId },
      assertion: 'planned',
      evidence: [],
      fields: { nativeRelationshipType: 'derives_from', payload: child.relationships[0].payload },
    });
    expect(carriage.document).toMatchObject({
      kind: 'strain-sequence',
      strainId: child.id,
      sequence: { resourceId: 's', revisionId: oldSequence.revisionId },
      fields: { nativeRelationshipType: 'carried_by', payload: { marker: 'URA3' } },
    });
    await writeFile(
      join(f.root, 'parent.entity.json'),
      serializeEntityArtifact({ ...parent, name: 'Renamed parent stock' })
    );
    expect(
      await f.submit({
        operationId: 'native-strain-parent-edit',
        expectedHead: old.head,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' } });
    expect(f.store.read().reader.current(descent.resourceId)).toEqual(descent);
    const head = f.store.read().head;
    const cyclic = serializeEntityArtifact({
      ...parent,
      relationships: [
        {
          type: 'derives_from',
          fromEntityId: parent.id,
          toEntityId: child.id,
          payload: { assertion: 'planned' },
        },
      ],
    });
    await writeFile(join(f.root, 'parent.entity.json'), cyclic);
    expect(
      await f.submit({
        operationId: 'native-strain-cycle',
        expectedHead: head,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({ acceptance: { kind: 'rejected' }, delivery: null });
    expect(f.store.read().head).toBe(head);
    expect(await readFile(join(f.root, 'parent.entity.json'), 'utf8')).toBe(cyclic);
    await writeFile(
      join(f.root, 'parent.entity.json'),
      serializeEntityArtifact({ ...parent, name: 'Renamed parent stock' })
    );
    const unqualified = serializeEntityArtifact({
      ...child,
      relationships: child.relationships.map((relationship) => ({ ...relationship, payload: {} })),
    });
    await writeFile(join(f.root, 'child.entity.json'), unqualified);
    await expect(
      f.submit({
        operationId: 'native-strain-unqualified',
        expectedHead: head,
        source: { kind: 'working-files' },
      })
    ).rejects.toThrow(/assertion|qualification/iu);
    expect(f.store.read().head).toBe(head);
    expect(await readFile(join(f.root, 'child.entity.json'), 'utf8')).toBe(unqualified);
    expect(await f.submit(initialRequest)).toMatchObject({ acceptance: { kind: 'replay' } });
    expect(f.store.read().head).toBe(head);
    expect(f.store.read().reader.revision(descent)).toEqual(descent);
  });
  it('migrates native placements atomically against a closed target, preserves old pins after source edits, and only reattaches on an explicit matching native edit', async () => {
    const f = await fixture();
    const source = await readFile(
      resolve(import.meta.dirname, '../../../../test-fixtures/sequences/circular/pUC19.gb'),
      'utf8'
    );
    const { parseGenBankFull } = await import('@waypoint/sequence-utils');
    const { defineBlob } = await import('@waypoint/workspace-revisions');
    const sequence = parseGenBankFull(source);
    const hash = (text: string) => defineBlob(new TextEncoder().encode(text)).hash;
    const artifact = await buildPrimerArtifact({
      id: 'native-bound',
      catalogNumber: 'PR-000093',
      name: 'Native placed primer',
      sequence: sequence.sequence.slice(100, 120),
      workspaceRoot: f.root,
      artifactPath: join(f.root, 'placed.primer.json'),
      source: 'manual',
      binding: {
        id: 'native-placement',
        targetDocumentId: 'closed-source',
        targetFilePath: join(f.root, 'closed.gb'),
        targetLength: sequence.sequence.length,
        targetTopology: 'circular',
        targetFileContentHash: hash(source),
        targetNormalizedSequenceHash: hash(sequence.sequence.toUpperCase()),
        start: 100,
        end: 120,
        strand: 1,
      },
    });
    const nativeText = serializePrimerArtifact(artifact);
    const initialRequest = {
      operationId: 'native-placement-import',
      expectedHead: null,
      source: {
        kind: 'documents' as const,
        entries: [
          {
            resourceId: artifact.id,
            path: 'placed.primer.json',
            representation: { format: 'primer-v2', text: nativeText },
          },
          {
            resourceId: 'closed-source',
            path: 'closed.gb',
            representation: { format: 'genbank-v1', text: source },
          },
        ],
      },
    };
    expect(await f.submit(initialRequest)).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    expect(await readFile(join(f.root, 'placed.primer.json'), 'utf8')).toBe(nativeText);
    const old = f.store.read();
    const binding = old.reader.current(id('native-placement'))!;
    const target = old.reader.current(id('closed-source'))!;
    expect(binding.document).toMatchObject({
      kind: 'primer-binding',
      primerId: artifact.id,
      target: { resourceId: target.resourceId, revisionId: target.revisionId },
      coordinates: { start: 100, end: 120, strand: 1 },
    });
    const edited = source.replace(/(ORIGIN\s*\n\s*\d+\s+)[acgt]/iu, '$1n');
    await writeFile(join(f.root, 'closed.gb'), edited);
    expect(
      await f.submit({
        operationId: 'native-placement-source-edit',
        expectedHead: old.head,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' } });
    expect(f.store.read().reader.current(id('native-placement'))).toEqual(binding);
    const currentSource = f.store.read().reader.current(id('closed-source'))!;
    expect(currentSource.revisionId).not.toBe(target.revisionId);
    const reattached = {
      ...artifact,
      bindings: artifact.bindings.map((binding) => ({
        ...binding,
        target: {
          ...binding.target,
          fileContentHash: hash(edited),
          normalizedSequenceHash: hash(parseGenBankFull(edited).sequence.toUpperCase()),
        },
      })),
    };
    await writeFile(join(f.root, 'placed.primer.json'), serializePrimerArtifact(reattached));
    expect(
      await f.submit({
        operationId: 'native-placement-reattach',
        expectedHead: f.store.read().head,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' } });
    expect(f.store.read().reader.current(id('native-placement'))?.document).toMatchObject({
      target: { resourceId: currentSource.resourceId, revisionId: currentSource.revisionId },
    });
    const head = f.store.read().head;
    const forged = {
      ...reattached,
      bindings: reattached.bindings.map((binding) => ({
        ...binding,
        target: { ...binding.target, normalizedSequenceHash: hash('wrong bases') },
      })),
    };
    const forgedText = serializePrimerArtifact(forged);
    await writeFile(join(f.root, 'placed.primer.json'), forgedText);
    await expect(
      f.submit({
        operationId: 'native-placement-forged',
        expectedHead: head,
        source: { kind: 'working-files' },
      })
    ).rejects.toThrow(/pinned|snapshot|match/iu);
    expect(f.store.read().head).toBe(head);
    expect(await readFile(join(f.root, 'placed.primer.json'), 'utf8')).toBe(forgedText);
    expect(await f.submit(initialRequest)).toMatchObject({ acceptance: { kind: 'replay' } });
    expect(f.store.read().head).toBe(head);
    expect(await readFile(join(f.root, 'placed.primer.json'), 'utf8')).toBe(forgedText);
    await writeFile(join(f.root, 'placed.primer.json'), serializePrimerArtifact(reattached));
    const map = JSON.parse(await readFile(join(f.root, scientificIdentityPath), 'utf8')) as {
      entries: { resourceId: string; path: string }[];
    };
    const bindingPath = map.entries.find((entry) => entry.resourceId === 'native-placement')!.path;
    const bindingText = await readFile(join(f.root, bindingPath), 'utf8');
    const competing = JSON.stringify({
      ...JSON.parse(bindingText),
      coordinates: { start: 101, end: 121, strand: 1 },
    });
    await writeFile(join(f.root, bindingPath), competing);
    await expect(
      f.submit({
        operationId: 'native-placement-competing-proposals',
        expectedHead: head,
        source: { kind: 'working-files' },
      })
    ).rejects.toThrow(/Competing/iu);
    expect(f.store.read().head).toBe(head);
    expect(await readFile(join(f.root, bindingPath), 'utf8')).toBe(competing);
    await writeFile(join(f.root, bindingPath), bindingText);
    await writeFile(
      join(f.root, 'placed.primer.json'),
      serializePrimerArtifact({ ...reattached, bindings: [] })
    );
    expect(
      await f.submit({
        operationId: 'native-placement-remove',
        expectedHead: head,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    expect(f.store.read().reader.current(id('native-placement'))).toBeNull();
    await expect(readFile(join(f.root, bindingPath), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(f.store.read().reader.revision(binding)).toEqual(binding);
    expect(f.store.read().reader.revision(target)).toEqual(target);
  });
  it('accepts native modified DNA, RNA and strain files with exact embedded identities, then preserves earlier bytes through edit, rejection and reopen', async () => {
    const f = await fixture();
    const nativeEntries = [];
    for (const [resourceId, notation, orderType] of [
      ['native-dna', '/5Phos/acgtACGTacgtACGTacgt/3SpC3/', 'dna'],
      ['native-rna', '/5Phos/rArCrG/i2FU/rArCrGrUrArCrGrU/3SpC3/', 'rna'],
    ] as const) {
      const parsed = parseIdtOligoNotation(notation, { orderType });
      expect(parsed.errors).toEqual([]);
      const path = `${resourceId}.primer.json`;
      const artifact = await buildPrimerArtifact({
        id: resourceId,
        catalogNumber: resourceId === 'native-dna' ? 'PR-000091' : 'PR-000092',
        name: resourceId,
        sequence: parsed.bases,
        ...(parsed.composition ? { oligo: parsed.composition } : {}),
        workspaceRoot: f.root,
        artifactPath: join(f.root, path),
        source: 'manual',
      });
      const text = serializePrimerArtifact(artifact);
      await writeFile(join(f.root, path), text);
      nativeEntries.push({ resourceId, path, representation: { format: 'primer-v2', text } });
    }
    const strainText = serializeEntityArtifact({
      schema: 'waypoint.entity.v1',
      id: 'native-strain',
      kind: 'strain',
      name: 'BY4741',
      fields: {
        genotypeCanonical: 'MATa his3Δ1 leu2Δ0 met15Δ0 ura3Δ0',
        species: 'Saccharomyces cerevisiae',
        customField: { source: 'SGD', preserve: true },
      },
      registrationStatus: 'tracked',
      domainStatus: 'planned',
      relationships: [],
      source: { type: 'manual', values: { origin: 'parent stock' } },
    });
    await writeFile(join(f.root, 'BY4741.entity.json'), strainText);
    const all = [
      ...nativeEntries,
      {
        resourceId: 'native-strain',
        path: 'BY4741.entity.json',
        representation: { format: 'strain-entity-v1', text: strainText },
      },
    ];
    expect(
      await f.submit({
        operationId: 'native-three',
        expectedHead: null,
        source: { kind: 'documents', entries: all },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    const old = f.store.read().reader.current(id('native-dna'))!;
    expect(old.document).toMatchObject({
      kind: 'primer',
      molecule: 'DNA',
      bases: 'acgtACGTacgtACGTacgt',
    });
    expect(f.store.read().reader.current(id('native-rna'))?.document).toMatchObject({
      molecule: 'RNA',
      bases: 'ACGUACGUACGU',
      fields: { computed: { tmC: null } },
    });
    expect(f.store.read().reader.current(id('native-strain'))?.document).toMatchObject({
      kind: 'strain',
      taxon: 'Saccharomyces cerevisiae',
      fields: {
        values: { customField: { source: 'SGD', preserve: true } },
        source: { values: { origin: 'parent stock' } },
      },
    });
    const { parsePrimerArtifact } = await import('../features/primers/public/primer-artifact');
    const artifact = parsePrimerArtifact(nativeEntries[0].representation.text);
    const revised = serializePrimerArtifact(
      await revisePrimerArtifactContent(artifact, {
        name: 'renamed modified primer',
        sequence: artifact.sequence.bases,
        oligo: artifact.oligo,
      })
    );
    await writeFile(join(f.root, nativeEntries[0].path), revised);
    expect(
      await f.submit({
        operationId: 'native-primer-edit',
        expectedHead: f.store.read().head,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' } });
    expect(f.store.read().reader.current(id('native-dna'))?.bindingInputHash).toBe(
      old.bindingInputHash
    );
    const head = f.store.read().head;
    const forged = revised
      .replace('"id": "native-dna"', '"id": "different-native-id"')
      .replace('"entityId": "native-dna"', '"entityId": "different-native-id"');
    await writeFile(join(f.root, nativeEntries[0].path), forged);
    await expect(
      f.submit({
        operationId: 'native-identity-forgery',
        expectedHead: head,
        source: { kind: 'working-files' },
      })
    ).rejects.toThrow(/identity/i);
    expect(f.store.read().head).toBe(head);
    expect(await readFile(join(f.root, nativeEntries[0].path), 'utf8')).toBe(forged);
    f.db.close();
    const db = openFileTestDb(f.dbPath);
    cleanups.push(() => db.close());
    expect(new ScientificObjectStore(db, f.workspaceId).read().reader.revision(old)).toEqual(old);
  });
  it('preserves a real native GenBank file through acceptance, file and Git submissions, and immutable historical reads', async () => {
    const f = await fixture();
    const original = await readFile(
      resolve(import.meta.dirname, '../../../../test-fixtures/sequences/circular/pUC19.gb'),
      'utf8'
    );
    const path = join(f.root, 'source.gb');
    await writeFile(path, original);
    const all = [
      ...entries,
      {
        resourceId: 'native-source',
        path: 'source.gb',
        representation: { format: 'genbank-v1', text: original },
      },
    ];
    expect(
      await f.submit({
        operationId: 'native-initial',
        expectedHead: null,
        source: { kind: 'documents', entries: all },
      })
    ).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    expect(await readFile(path, 'utf8')).toBe(original);
    const old = f.store.read().reader.current(id('native-source'))!;
    const edited = original
      .replace('SYNPUC19CV', 'Renamed-source')
      .replace(/(ORIGIN\s*\n\s*\d+\s+)[acgt]/iu, '$1n');
    await writeFile(path, edited);
    expect(f.store.read().reader.current(id('native-source'))).toEqual(old);
    expect(
      await f.submit({
        operationId: 'native-files',
        expectedHead: f.store.read().head,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    expect(await readFile(path, 'utf8')).toBe(edited);
    expect(f.store.read().reader.current(id('native-source'))?.document).toMatchObject({
      name: 'Renamed-source',
    });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=Scientific fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Accepted native source'
    );
    const commit = git('rev-parse', 'HEAD');
    await writeFile(path, 'Unsubmitted broken record');
    const head = f.store.read().head;
    await expect(
      f.submit({
        operationId: 'native-broken',
        expectedHead: head,
        source: { kind: 'working-files' },
      })
    ).rejects.toThrow();
    expect(f.store.read().head).toBe(head);
    expect(await readFile(path, 'utf8')).toBe('Unsubmitted broken record');
    expect(
      await f.submit({
        operationId: 'native-git',
        expectedHead: head,
        source: { kind: 'git-commit', commit },
      })
    ).toMatchObject({
      acceptance: { kind: 'no-op' },
      delivery: { kind: 'complete' },
    });
    expect(await readFile(path, 'utf8')).toBe('Unsubmitted broken record');
    f.db.close();
    const db = openFileTestDb(f.dbPath);
    cleanups.push(() => db.close());
    expect(new ScientificObjectStore(db, f.workspaceId).read().reader.revision(old)).toEqual(old);
  });
  it('accepts a product and its exact history together, rejects an invalid parent, and retries after newer history without rewinding', async () => {
    const f = await fixture();
    const all = [
      ...entries,
      { resourceId: 'product', path: 'product.json', document: { ...sequence, name: 'Product' } },
    ];
    const assembly = defineScientificAssemblyDraft({
      resourceId: 'assembly-1',
      path: 'history/1.json',
      constructId: 'construct',
      parent: null,
      sources: [{ kind: 'submitted', resourceId: 's' }],
      primers: [{ kind: 'submitted', resourceId: 'p' }],
      product: { kind: 'submitted', resourceId: 'product' },
      recipe: { method: 'gibson', protocol: { preserve: 'complete recipe' } },
    });
    const original = {
      operationId: 'assembly-initial',
      expectedHead: null,
      source: { kind: 'accepted-assembly' as const, entries: all, assembly },
    };
    expect(await f.submit(original)).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    const old = f.store.read(),
      parent = old.reader.current(id('assembly-1'))!,
      oldPrimer = old.reader.current(id('p'))!,
      oldSequence = old.reader.current(id('s'))!,
      oldHost = old.reader.current(id('host'))!,
      oldProduct = old.reader.current(id('product'))!;
    expect(parent.document).toMatchObject({
      sources: [{ resourceId: 's', revisionId: old.reader.current(id('s'))!.revisionId }],
      primers: [{ resourceId: 'p', revisionId: oldPrimer.revisionId }],
      product: { resourceId: 'product', revisionId: oldProduct.revisionId },
      recipe: assembly.recipe,
    });
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) AS count FROM scientific_revision_records WHERE record_kind = 'workspace-version'"
        )
        .get()
    ).toEqual({ count: 1 });
    const changed = [
      ...all.map((entry) =>
        entry.resourceId === 'p'
          ? { ...entry, document: { ...primer, bases: 'TTTT' } }
          : entry.resourceId === 'product'
            ? { ...entry, document: { ...sequence, name: 'Product', bases: 'TTTTACGT' } }
            : entry
      ),
      { resourceId: parent.resourceId, path: 'history/1.json', document: parent.document },
    ];
    const child = defineScientificAssemblyDraft({
      ...assembly,
      resourceId: 'assembly-2',
      path: 'history/2.json',
      parent: { resourceId: parent.resourceId, revisionId: parent.revisionId },
    });
    expect(
      await f.submit({
        operationId: 'assembly-bad-parent',
        expectedHead: old.head,
        source: {
          kind: 'accepted-assembly',
          entries: changed,
          assembly: defineScientificAssemblyDraft({ ...child, constructId: 'another-construct' }),
        },
      })
    ).toMatchObject({ acceptance: { kind: 'rejected' }, delivery: null });
    expect(f.store.read().head).toBe(old.head);
    expect(f.store.read().reader.current(id('product'))).toEqual(oldProduct);
    expect(f.store.read().reader.current(id('assembly-2'))).toBeNull();
    expect(JSON.parse(await readFile(join(f.root, 'product.json'), 'utf8'))).toEqual(
      oldProduct.document
    );
    expect(
      await f.submit({
        operationId: 'assembly-child',
        expectedHead: old.head,
        source: { kind: 'accepted-assembly', entries: changed, assembly: child },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    const head = f.store.read().head;
    expect(await f.submit(original)).toMatchObject({
      acceptance: { kind: 'replay' },
      currentHead: head,
      delivery: { kind: 'complete' },
    });
    f.db.close();
    const db = openFileTestDb(f.dbPath);
    cleanups.push(() => db.close());
    const reopened = new ScientificObjectStore(db, f.workspaceId).read();
    expect(reopened.head).toBe(head);
    expect(reopened.reader.revision(parent)).toEqual(parent);
    expect(reopened.reader.revision(oldPrimer)).toEqual(oldPrimer);
    expect(reopened.reader.revision(oldProduct)).toEqual(oldProduct);
    expect(reopened.reader.current(id('assembly-2'))?.document).toMatchObject({
      primers: [{ resourceId: 'p', revisionId: reopened.reader.current(id('p'))!.revisionId }],
    });
    const childBeforeRestore = reopened.reader.current(id('assembly-2'))!;
    const restored = await submitScientificWorkspace({
      db,
      workspaceId: f.workspaceId,
      request: {
        operationId: 'assembly-history-restore',
        expectedHead: reopened.head,
        source: { kind: 'restore-workspace', version: old.head! },
      },
    });
    expect(restored).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    const restoredState = new ScientificObjectStore(db, f.workspaceId).read();
    for (const original of [oldPrimer, oldProduct, oldSequence, oldHost])
      expect(restoredState.reader.current(original.resourceId)?.document).toEqual(
        original.document
      );
    expect(restoredState.reader.current(id('assembly-1'))).toEqual(parent);
    expect(restoredState.reader.current(id('assembly-2'))).toEqual(childBeforeRestore);
    expect(restoredState.reader.revision(oldPrimer)).toEqual(oldPrimer);
    expect(JSON.parse(await readFile(join(f.root, 'product.json'), 'utf8'))).toEqual(
      oldProduct.document
    );
    const removed = await submitScientificWorkspace({
      db,
      workspaceId: f.workspaceId,
      request: {
        operationId: 'remove-primer-before-restore',
        expectedHead: restoredState.head,
        source: {
          kind: 'documents',
          entries: new ScientificObjectStore(db, f.workspaceId)
            .catalog()
            .entries.filter((slot) => !slot.tombstone && slot.path && slot.resourceId !== id('p'))
            .flatMap((slot) => {
              const snapshot = restoredState.reader.current(slot.resourceId);
              return snapshot && slot.path
                ? [{ resourceId: slot.resourceId, path: slot.path, document: snapshot.document }]
                : [];
            }),
        },
      },
    });
    expect(removed).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    const afterDelete = new ScientificObjectStore(db, f.workspaceId).read();
    expect(afterDelete.reader.current(id('p'))).toBeNull();
    expect(
      await submitScientificWorkspace({
        db,
        workspaceId: f.workspaceId,
        request: {
          operationId: 'restore-tombstoned-primer',
          expectedHead: afterDelete.head,
          source: { kind: 'restore-workspace', version: old.head! },
        },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'complete' } });
    const revived = new ScientificObjectStore(db, f.workspaceId).read();
    expect(revived.reader.current(id('p'))?.document).toEqual(oldPrimer.document);
    expect(revived.reader.current(id('p'))?.revisionId).not.toBe(oldPrimer.revisionId);
    expect(revived.reader.current(id('assembly-2'))).toEqual(childBeforeRestore);
  });
  it('rolls back the whole compound command when its durable file job cannot be recorded', async () => {
    const f = await fixture();
    const request = {
      operationId: 'assembly-rollback',
      expectedHead: null,
      source: {
        kind: 'accepted-assembly' as const,
        entries,
        assembly: defineScientificAssemblyDraft({
          resourceId: 'assembly',
          path: 'history/assembly.json',
          constructId: 'construct',
          parent: null,
          sources: [{ kind: 'submitted', resourceId: 's' }],
          primers: [{ kind: 'submitted', resourceId: 'p' }],
          product: { kind: 'submitted', resourceId: 's' },
          recipe: { method: 'fixture' },
        }),
      },
    };
    f.db.exec(
      "CREATE TRIGGER fail_scientific_outbox BEFORE INSERT ON scientific_materialization_jobs BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END"
    );
    await expect(f.submit(request)).rejects.toThrow('outbox unavailable');
    expect(f.store.read().head).toBeNull();
    expect(f.store.read().reader.listCurrent()).toEqual([]);
    for (const table of [
      'scientific_revision_records',
      'scientific_revision_blobs',
      'scientific_materialization_jobs',
    ])
      expect(f.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    await expect(readFile(join(f.root, 'p.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    f.db.exec('DROP TRIGGER fail_scientific_outbox');
    expect(await f.submit(request)).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
  });
  it('delivers an app submission, accepts complete ordinary file edits and a move, and preserves exact old versions after reopen', async () => {
    const f = await fixture();
    expect(await f.initial()).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    const old = f.store.read().reader.current(id('p'))!;
    await mkdir(join(f.root, 'primers'));
    await rename(join(f.root, 'p.json'), join(f.root, 'primers/p.json'));
    await writeFile(
      join(f.root, 'primers/p.json'),
      JSON.stringify({ ...primer, bases: 'AAAA' }, null, 2)
    );
    const mapPath = join(f.root, scientificIdentityPath);
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    map.entries.find((row: { resourceId: string }) => row.resourceId === 'p').path =
      'primers/p.json';
    await writeFile(mapPath, JSON.stringify(map, null, 2));
    const result = await f.submit({
      operationId: 'files',
      expectedHead: f.store.read().head,
      source: { kind: 'working-files' },
    });
    expect(result).toMatchObject({
      acceptance: { kind: 'changed' },
      delivery: { kind: 'complete' },
    });
    expect(f.store.read().reader.current(id('p'))?.document).toMatchObject({ bases: 'AAAA' });
    expect(f.store.read().reader.revision(old)).toEqual(old);
    expect(await readFile(join(f.root, 'primers/p.json'), 'utf8')).toContain('AAAA');
    f.db.close();
    const db = openFileTestDb(f.dbPath);
    cleanups.push(() => db.close());
    expect(new ScientificObjectStore(db, f.workspaceId).read().reader.revision(old)).toEqual(old);
  });
  it('keeps every working file and the accepted ref when one relationship makes a complete submission invalid', async () => {
    const f = await fixture();
    await f.initial();
    const oldHead = f.store.read().head,
      pin = f.store.read().reader.current(id('p'))!;
    const changed = JSON.stringify({ ...primer, bases: 'TTTT' }, null, 2);
    const invalid = JSON.stringify({
      formatVersion: 1,
      kind: 'strain-sequence',
      strainId: 'host',
      sequence: { resourceId: 'p', revisionId: pin.revisionId },
      assertion: 'planned',
      evidence: [],
    });
    await writeFile(join(f.root, 'p.json'), changed);
    await writeFile(join(f.root, 'link.json'), invalid);
    const mapPath = join(f.root, scientificIdentityPath),
      map = JSON.parse(await readFile(mapPath, 'utf8'));
    map.entries.push({ resourceId: 'link', path: 'link.json' });
    const mapText = JSON.stringify(map);
    await writeFile(mapPath, mapText);
    expect(
      await f.submit({
        operationId: 'bad',
        expectedHead: oldHead,
        source: { kind: 'working-files' },
      })
    ).toMatchObject({ acceptance: { kind: 'rejected' }, delivery: null });
    expect(f.store.read().head).toBe(oldHead);
    expect(f.store.read().reader.current(id('link'))).toBeNull();
    expect(f.store.pendingMaterializations()).toHaveLength(0);
    expect(await readFile(join(f.root, 'p.json'), 'utf8')).toBe(changed);
    expect(await readFile(join(f.root, 'link.json'), 'utf8')).toBe(invalid);
    expect(await readFile(mapPath, 'utf8')).toBe(mapText);
  });
  it('uses an immutable real Git commit as input and preserves later uncommitted work', async () => {
    const f = await fixture();
    await f.initial();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    await writeFile(join(f.root, 'p.json'), JSON.stringify({ ...primer, bases: 'AAAA' }, null, 2));
    git('add', '.');
    git(
      '-c',
      'user.name=Scientific fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Planned donor primer'
    );
    const commit = git('rev-parse', 'HEAD');
    const uncommitted = JSON.stringify({ ...primer, bases: 'TTTT' });
    await writeFile(join(f.root, 'p.json'), uncommitted);
    const base = f.store.read().head;
    expect(
      await f.submit({
        operationId: 'git',
        expectedHead: base,
        source: { kind: 'git-commit', commit },
      })
    ).toMatchObject({ acceptance: { kind: 'changed' }, delivery: { kind: 'blocked' } });
    expect(f.store.read().reader.current(id('p'))?.document).toMatchObject({ bases: 'AAAA' });
    expect(await readFile(join(f.root, 'p.json'), 'utf8')).toBe(uncommitted);
    expect(f.store.pendingMaterializations()).toHaveLength(1);
    expect(
      await f.submit({
        operationId: 'git',
        expectedHead: base,
        source: { kind: 'git-commit', commit },
      })
    ).toMatchObject({ acceptance: { kind: 'replay' }, delivery: { kind: 'blocked' } });
    expect(await readFile(join(f.root, 'p.json'), 'utf8')).toBe(uncommitted);
  });
  it('retries an earlier app acceptance without rewinding a newer accepted head', async () => {
    const f = await fixture();
    await f.initial();
    const base = f.store.read().head;
    await f.submit({
      operationId: 'edit',
      expectedHead: base,
      source: {
        kind: 'documents',
        entries: entries.map((entry) =>
          entry.resourceId === 'p' ? { ...entry, document: { ...primer, bases: 'AAAA' } } : entry
        ),
      },
    });
    const head = f.store.read().head;
    expect(await f.initial()).toMatchObject({
      acceptance: { kind: 'replay' },
      delivery: { kind: 'complete' },
    });
    expect(f.store.read().head).toBe(head);
    expect(JSON.parse(await readFile(join(f.root, 'p.json'), 'utf8')).bases).toBe('AAAA');
  });
  it('does not wait on an open renderer database transaction or borrow its uncommitted workspace state', async () => {
    const f = await fixture();
    f.db.exec('BEGIN');
    await expect(f.initial()).rejects.toThrow(/transaction/i);
    expect(f.db.inTransaction).toBe(true);
    expect(f.store.read().head).toBeNull();
    f.db.exec('ROLLBACK');
    expect(await f.initial()).toMatchObject({ acceptance: { kind: 'changed' } });
  });
  it('serializes behind the real database fence and releases it after rejection', async () => {
    const f = await fixture(),
      release = await acquireWorkspaceSyncDatabaseFence(f.db);
    let settled = false;
    const pending = f.initial().finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
    const head = f.store.read().head;
    expect(
      await f.submit({
        operationId: 'stale',
        expectedHead: null,
        source: { kind: 'documents', entries },
      })
    ).toMatchObject({ acceptance: { kind: 'conflict' }, delivery: null });
    expect(f.store.read().head).toBe(head);
    expect(() => assertRendererDatabaseStatementAllowed(f.db, 71)).not.toThrow();
  });
  it('refuses symlink and nested-workspace inputs without reading another workspace into this one', async () => {
    const f = await fixture();
    await f.initial();
    const outside = join(f.tmpDir, 'outside.json');
    await writeFile(outside, JSON.stringify(primer));
    await rename(join(f.root, 'p.json'), join(f.root, 'original.json'));
    await symlink(outside, join(f.root, 'p.json'));
    const head = f.store.read().head;
    await expect(
      f.submit({ operationId: 'escape', expectedHead: head, source: { kind: 'working-files' } })
    ).rejects.toThrow(/workspace|symbolic/i);
    expect(f.store.read().head).toBe(head);
    f.db
      .prepare('INSERT INTO workspaces (name, path, repo_uuid, created_at) VALUES (?, ?, ?, ?)')
      .run('Nested', join(f.root, 'nested'), 'nested', 1);
    await expect(
      f.submit({
        operationId: 'nested',
        expectedHead: head,
        source: {
          kind: 'documents',
          entries: [{ resourceId: 'p', path: 'nested/p.json', document: primer }],
        },
      })
    ).rejects.toThrow(/root|workspace/i);
    expect(f.store.read().head).toBe(head);
  });
  it('blocks inactive and reference workspaces before accepting or writing', async () => {
    for (const column of ['archived_at', 'trashed_at', 'access_mode']) {
      const f = await fixture();
      f.db
        .prepare(`UPDATE workspaces SET ${column} = ? WHERE id = ?`)
        .run(column === 'access_mode' ? 'reference' : 1, f.workspaceId);
      await expect(f.initial()).rejects.toThrow(/workspace|read.only/i);
      expect(
        f.db.prepare('SELECT COUNT(*) AS count FROM scientific_revision_records').get()
      ).toEqual({ count: 0 });
    }
  });
});
