import { actOnAcceptedScientificEntity } from '../scientific-resource-lifecycle';
import * as fs from 'node:fs';
import * as git from 'isomorphic-git';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { serializeGenBank } from '@waypoint/sequence-utils';
import { defineBlob } from '@waypoint/workspace-revisions';

vi.mock('electron', () => ({
  shell: { trashItem: async (path: string) => rmSync(path, { recursive: true }) },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

import { createFileTestDb, openFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { recoverComputeResult } from './compute-result-recovery';
import { inventoryComputeSource } from './compute-result-retention';
import {
  buildSequencePackageDocument,
  SEQUENCE_PACKAGE_FILE_KIND,
} from '../../db/sequence-package';
import { buildDefaultMolecularDocument } from '../../shared/default-molecular-view';
import { serializeMolecularDocument } from '../../shared/molecular-document';
import { registerCatalogEntityInDb } from '../catalog-entity-registration';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import { linkCatalogEntitiesInDb } from '../catalog-association-commands';
import { createEntityReferenceInDb } from '../entity-reference-commands';
import { prepareEntityReferenceRow } from '../../shared/entity-reference-ipc';
import { discoverWorkspaceArtifacts } from '../workspace-artifact-discovery';
import { collectManagedCatalogHeadIndex } from './head-index';
import { ScientificObjectStore } from '../scientific-object-store';
import { submitScientificWorkspace } from '../scientific-workspace-service';
import { captureSequenceMigrationAdmission } from './sequence-migration-admission';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sequence =
  'LOCUS       Native  12 bp    DNA     linear SYN\nORIGIN\n        1 acgtacgtacgt\n//\n';
const pdb = 'HEADER    NATIVE COMPUTE VIEW\nATOM      1  CA  ALA A   1\nEND\n';

it('recovers mixed old compute outputs with existing native IDs, bindings, links and complete original bytes across restart', async () => {
  const f = createFileTestDb('compute-mixed-native-recovery');
  cleanup.push(f.cleanup);
  ensureSchema(f.db, f.dbPath);
  const root = join(realpathSync(f.tmpDir), 'project');
  const source = join(root, 'compute/boltz/remote-1');
  const packageRoot = join(source, 'Existing sequence');
  mkdirSync(join(packageRoot, '.forge'), { recursive: true });
  const sequenceId = 'existing-native-sequence';
  const molecularId = '10000000-0000-4000-8000-000000000001';
  const marker = JSON.stringify(
    buildSequencePackageDocument({
      id: sequenceId,
      name: 'Existing sequence',
      product: {
        file: 'Native.gb',
        topology: 'linear',
        genBankChecksum: `sha256:${hash(sequence)}`,
      },
    })
  );
  writeFileSync(join(packageRoot, '.forge/plasmid.json'), marker);
  writeFileSync(join(packageRoot, 'Native.gb'), sequence);
  const molecularPath = join(source, 'Existing view.dnaforge-molecular.json');
  const molecular = serializeMolecularDocument(
    await buildDefaultMolecularDocument({
      name: 'Existing view',
      format: 'pdb',
      text: pdb,
      createdAt: 1,
      documentId: molecularId,
      referenceId: '10000000-0000-4000-8000-000000000002',
    })
  );
  writeFileSync(molecularPath, molecular);
  writeFileSync(join(source, 'New.gb'), sequence.replace('Native', 'New'));
  writeFileSync(join(source, 'New.pdb'), pdb);
  writeFileSync(join(source, 'data.bin'), Buffer.from([255, 0, 128]));
  writeFileSync(join(source, '.receipt'), 'original provider receipt');
  mkdirSync(join(source, 'empty'));
  await git.init({ fs, dir: root });
  await git.add({ fs, dir: root, filepath: '.' });
  await git.commit({
    fs,
    dir: root,
    message: 'mixed historical compute source',
    author: { name: 'Test', email: 'test@example.invalid' },
  });
  const repoUuid = randomUUID();
  const workspaceId = Number(
    f.db
      .prepare('INSERT INTO workspaces(name,path,created_at,repo_uuid) VALUES(?,?,?,?)')
      .run('Project', root, 1, repoUuid).lastInsertRowid
  );
  for (const entry of [
    {
      id: sequenceId,
      type: 'sequence' as const,
      name: 'Existing sequence',
      path: packageRoot,
      fileKind: SEQUENCE_PACKAGE_FILE_KIND,
      locator: `entity://sequence/${sequenceId}`,
    },
    {
      id: molecularId,
      type: 'molecular-document' as const,
      name: 'Existing view',
      path: molecularPath,
      fileKind: 'dnaforge-molecular-document',
      locator: `file://${molecularPath}`,
    },
  ]) {
    registerCatalogEntityInDb(f.db, {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      locator: entry.locator,
      workspaceRoot: root,
      storageType: 'file',
    });
    bindCatalogEntityFileInDb(f.db, {
      entityId: entry.id,
      path: entry.path,
      workspaceRoot: root,
      fileKind: entry.fileKind,
      status: 'current',
    });
  }
  const link = linkCatalogEntitiesInDb(f.db, {
    sourceEntityId: molecularId,
    relation: 'derived_from',
    targetEntityId: sequenceId,
    confidence: 'confirmed',
    evidence: { retained: 'provider metadata' },
  });
  const reference = createEntityReferenceInDb(
    f.db,
    prepareEntityReferenceRow({
      entityType: 'sequence',
      displayLabel: 'Existing compute sequence',
      locator: `entity://sequence/${sequenceId}`,
      source: 'ai',
      workspaceScope: repoUuid,
      workspaceRootPath: root,
      data: { documentId: sequenceId },
    })
  );
  f.db
    .prepare(
      `INSERT INTO compute_jobs(id,provider,tool_id,settings_hash,settings_json,provider_job_ref,state,workspace_root,imported_paths_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      'job',
      'boltz',
      'boltz-2',
      'a'.repeat(64),
      '{}',
      'remote-1',
      'imported',
      root,
      JSON.stringify([
        join(packageRoot, 'Native.gb'),
        molecularPath,
        join(source, 'New.gb'),
        join(source, 'New.pdb'),
      ]),
      1,
      1
    );
  const original = await inventoryComputeSource(source);
  const result = await recoverComputeResult(f.db, {
    workspaceRoot: root,
    provider: 'boltz',
    remoteId: 'remote-1',
  });
  expect(result.kind).toBe('committed');
  const target = join(root, result.targetRelativePath);
  expect(readFileSync(join(target, 'Existing sequence/.forge/plasmid.json'), 'utf8')).toBe(marker);
  expect(readFileSync(join(target, 'Existing sequence/Native.gb'), 'utf8')).toBe(sequence);
  expect(readFileSync(join(target, 'Existing view.dnaforge-molecular.json'), 'utf8')).toBe(
    molecular
  );
  const output = await inventoryComputeSource(target);
  expect(output.entries.some((entry) => entry.relativePath === 'New/.forge/plasmid.json')).toBe(
    true
  );
  expect(output.entries.some((entry) => entry.relativePath === 'New.dnaforge-molecular.json')).toBe(
    true
  );
  expect((await inventoryComputeSource(source)).treeSha256).toBe(original.treeSha256);
  expect((await inventoryComputeSource(join(root, result.retainedRelativePath))).treeSha256).toBe(
    original.treeSha256
  );
  const discovery = await discoverWorkspaceArtifacts({ rootPath: root, knownFiles: [] });
  expect(discovery.errors).toEqual([]);
  const discovered = [
    ...discovery.entityArtifactPaths,
    ...(discovery.catalogProjection?.candidates.map((entry) => entry.path) ?? []),
  ];
  expect(
    discovered.some((path) => path.startsWith(`${source}/`)),
    'retained original compute bytes cannot become canonical artifacts again'
  ).toBe(false);
  expect(discovery.entityArtifactPaths).toContain(
    join(target, 'Existing sequence/.forge/plasmid.json')
  );
  const headIndex = await collectManagedCatalogHeadIndex(root, [], { healWorkingTree: false });
  expect(
    headIndex.files.some((entry) => entry.relPath.startsWith('compute/boltz/remote-1/')),
    'committed retained originals are excluded from canonical HEAD candidates'
  ).toBe(false);
  expect(headIndex.files.map((entry) => entry.relPath)).toContain(
    `${result.targetRelativePath}/Existing sequence/.forge/plasmid.json`
  );
  expect((await inventoryComputeSource(source)).treeSha256).toBe(original.treeSha256);
  const active = f.db
    .prepare(
      'SELECT id,type,workspace_id FROM catalog_entities WHERE id IN (?,?) AND status=? ORDER BY id'
    )
    .all(sequenceId, molecularId, 'active');
  expect(active).toEqual([
    { id: molecularId, type: 'molecular-document', workspace_id: workspaceId },
    { id: sequenceId, type: 'sequence', workspace_id: workspaceId },
  ]);
  const bindings = f.db
    .prepare(
      "SELECT entity_id,path FROM catalog_entity_files WHERE entity_id IN (?,?) AND status='current' ORDER BY entity_id"
    )
    .all(sequenceId, molecularId);
  expect(bindings).toEqual([
    { entity_id: molecularId, path: join(target, 'Existing view.dnaforge-molecular.json') },
    { entity_id: sequenceId, path: join(target, 'Existing sequence') },
  ]);
  expect(f.db.prepare('SELECT * FROM catalog_entity_links WHERE id=?').get(link.id)).toEqual(link);
  expect(f.db.prepare('SELECT * FROM entity_references WHERE id=?').get(reference.id)).toEqual(
    reference
  );
  const head = await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
  f.db.close();
  const reopened = openFileTestDb(f.dbPath);
  cleanup.push(() => reopened.close());
  const retry = await recoverComputeResult(reopened, {
    workspaceRoot: root,
    provider: 'boltz',
    remoteId: 'remote-1',
  });
  expect(retry).toEqual({ ...result, kind: 'already-committed' });
  expect(await git.resolveRef({ fs, dir: root, ref: 'HEAD' })).toBe(head);
  expect((await inventoryComputeSource(target)).treeSha256).toBe(output.treeSha256);
  expect((await inventoryComputeSource(source)).treeSha256).toBe(original.treeSha256);
  expect(
    reopened
      .prepare(
        "SELECT COUNT(*) AS n FROM catalog_entity_files WHERE entity_id IN (?,?) AND status='current'"
      )
      .get(sequenceId, molecularId)
  ).toEqual({ n: 2 });
  expect(reopened.prepare('SELECT * FROM entity_references WHERE id=?').get(reference.id)).toEqual(
    reference
  );
});

it.each(['current', 'tombstoned'] as const)(
  'preserves the %s accepted compute source owner while recovering only unowned output across restart',
  async (state) => {
    const f = createFileTestDb(`compute-accepted-${state}`);
    cleanup.push(f.cleanup);
    ensureSchema(f.db, f.dbPath);
    const root = join(realpathSync(f.tmpDir), 'project');
    mkdirSync(root);
    const repoUuid = randomUUID();
    const workspaceId = Number(
      f.db
        .prepare('INSERT INTO workspaces(name,path,created_at,repo_uuid) VALUES(?,?,?,?)')
        .run('Accepted compute', root, 1, repoUuid).lastInsertRowid
    );
    const store = new ScientificObjectStore(f.db, workspaceId);
    const submit = (request: Parameters<typeof submitScientificWorkspace>[0]['request']) =>
      submitScientificWorkspace({ db: f.db, workspaceId, request });
    await submit({
      operationId: 'enroll-accepted-compute',
      expectedHead: null,
      source: {
        kind: 'documents',
        entries: [
          {
            resourceId: 'seed-primer',
            path: 'seed.json',
            document: {
              formatVersion: 1,
              kind: 'primer',
              name: 'Seed',
              molecule: 'DNA',
              bases: 'ACGT',
              modifications: [],
              fields: {},
            },
          },
        ],
      },
    });
    const sourceRelativePath = 'compute/boltz/accepted-result';
    const packageRelativePath = `${sourceRelativePath}/Accepted sequence`;
    const source = join(root, sourceRelativePath);
    const packageRoot = join(root, packageRelativePath);
    const productPath = join(packageRoot, 'Accepted.gb');
    const markerPath = join(packageRoot, '.forge/plasmid.json');
    const sequenceId = 'accepted-compute-sequence';
    const text = serializeGenBank({
      id: sequenceId,
      name: 'Accepted sequence',
      sequence: 'ACGTACGTACGT',
      length: 12,
      circular: false,
      annotations: [],
    });
    await submit({
      operationId: 'create-accepted-compute-sequence',
      expectedHead: store.read().head,
      source: {
        kind: 'native-artifact',
        expectedRevisionId: null,
        entry: {
          resourceId: sequenceId,
          path: `${packageRelativePath}/Accepted.gb`,
          representation: { format: 'genbank-v1', text },
          sequencePackageText: JSON.stringify(
            buildSequencePackageDocument({
              id: sequenceId,
              name: 'Accepted sequence',
              product: {
                file: 'Accepted.gb',
                topology: 'linear',
                genBankChecksum: defineBlob(new TextEncoder().encode(text)).hash,
              },
            })
          ),
        },
      },
    });
    const marker = readFileSync(markerPath, 'utf8');
    const reference = createEntityReferenceInDb(
      f.db,
      prepareEntityReferenceRow({
        entityType: 'sequence',
        displayLabel: 'Accepted compute sequence',
        locator: `entity://sequence/${sequenceId}`,
        source: 'ai',
        workspaceScope: repoUuid,
        workspaceRootPath: root,
        data: { documentId: sequenceId },
      })
    );
    if (state === 'tombstoned') {
      expect(
        await actOnAcceptedScientificEntity({
          db: f.db,
          action: 'archive',
          input: { id: sequenceId, operationId: 'delete-accepted-compute-sequence' },
        })
      ).not.toBeNull();
      mkdirSync(join(packageRoot, '.forge'), { recursive: true });
      writeFileSync(productPath, text);
      writeFileSync(markerPath, marker);
    }
    writeFileSync(join(source, 'New.gb'), sequence.replace('Native', 'New'));
    writeFileSync(join(source, 'New.pdb'), pdb);
    writeFileSync(join(source, '.provider-receipt'), 'historical original receipt');
    writeFileSync(join(source, 'data.bin'), Buffer.from([0, 128, 255]));
    mkdirSync(join(source, 'empty'));
    const importedPaths = [productPath, join(source, 'New.gb'), join(source, 'New.pdb')];
    f.db
      .prepare(
        `INSERT INTO compute_jobs(id,provider,tool_id,settings_hash,settings_json,provider_job_ref,state,workspace_root,imported_paths_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        'accepted-job',
        'boltz',
        'boltz-2',
        'a'.repeat(64),
        '{}',
        'accepted-result',
        'imported',
        root,
        JSON.stringify(importedPaths),
        1,
        1
      );
    await git.init({ fs, dir: root });
    await git.add({ fs, dir: root, filepath: '.' });
    await git.commit({
      fs,
      dir: root,
      message: 'accepted historical compute owner',
      author: { name: 'Test', email: 'test@example.invalid' },
    });
    const before = {
      catalog: store.catalog(),
      history: store.exportHistory(),
      entity: f.db.prepare('SELECT * FROM catalog_entities WHERE id=?').get(sequenceId),
      bindings: f.db
        .prepare('SELECT * FROM catalog_entity_files WHERE entity_id=? ORDER BY id')
        .all(sequenceId),
      source: await inventoryComputeSource(source),
    };
    expect(before.catalog.entries.find((entry) => entry.resourceId === sequenceId)?.tombstone).toBe(
      state === 'tombstoned'
    );
    const result = await recoverComputeResult(f.db, {
      workspaceRoot: root,
      provider: 'boltz',
      remoteId: 'accepted-result',
    });
    expect(result.kind).toBe('committed');
    const target = join(root, result.targetRelativePath);
    expect(existsSync(join(target, 'Accepted sequence'))).toBe(false);
    expect(existsSync(join(target, 'New/.forge/plasmid.json'))).toBe(true);
    expect(existsSync(join(target, 'New.dnaforge-molecular.json'))).toBe(true);
    expect(readFileSync(markerPath, 'utf8')).toBe(marker);
    expect(readFileSync(productPath, 'utf8')).toBe(text);
    expect((await inventoryComputeSource(source)).treeSha256).toBe(before.source.treeSha256);
    expect((await inventoryComputeSource(join(root, result.retainedRelativePath))).treeSha256).toBe(
      before.source.treeSha256
    );
    expect(store.catalog()).toEqual(before.catalog);
    expect(store.exportHistory()).toEqual(before.history);
    expect(f.db.prepare('SELECT * FROM catalog_entities WHERE id=?').get(sequenceId)).toEqual(
      before.entity
    );
    expect(
      f.db
        .prepare('SELECT * FROM catalog_entity_files WHERE entity_id=? ORDER BY id')
        .all(sequenceId)
    ).toEqual(before.bindings);
    expect(f.db.prepare('SELECT * FROM entity_references WHERE id=?').get(reference.id)).toEqual(
      reference
    );
    const admission = captureSequenceMigrationAdmission(f.db, root);
    const discovery = await discoverWorkspaceArtifacts(
      {
        rootPath: root,
        knownFiles: [{ path: packageRoot, contentHash: null, sizeBytes: null, modifiedAt: null }],
      },
      { activeAcceptedPaths: admission.activeAcceptedPaths }
    );
    expect(discovery.errors).toEqual([]);
    expect(discovery.entityArtifactPaths.includes(markerPath)).toBe(state === 'current');
    expect(discovery.catalogProjection?.missingPaths).not.toContain(packageRoot);
    const headIndex = await collectManagedCatalogHeadIndex(
      root,
      [`${packageRelativePath}/.forge/plasmid.json`, `${packageRelativePath}/Accepted.gb`],
      { ...admission, healWorkingTree: false }
    );
    expect(
      headIndex.files.some(
        (entry) => entry.relPath === `${packageRelativePath}/.forge/plasmid.json`
      )
    ).toBe(state === 'current');
    const job = f.db
      .prepare('SELECT imported_paths_json FROM compute_jobs WHERE id=?')
      .get('accepted-job') as { imported_paths_json: string };
    expect((JSON.parse(job.imported_paths_json) as string[]).includes(productPath)).toBe(
      state === 'current'
    );
    const head = await git.resolveRef({ fs, dir: root, ref: 'HEAD' });
    const output = await inventoryComputeSource(target);
    f.db.close();
    const reopened = openFileTestDb(f.dbPath);
    cleanup.push(() => reopened.close());
    const retried = await recoverComputeResult(reopened, {
      workspaceRoot: root,
      provider: 'boltz',
      remoteId: 'accepted-result',
    });
    expect(retried).toEqual({ ...result, kind: 'already-committed' });
    expect(await git.resolveRef({ fs, dir: root, ref: 'HEAD' })).toBe(head);
    expect(new ScientificObjectStore(reopened, workspaceId).catalog()).toEqual(before.catalog);
    expect(new ScientificObjectStore(reopened, workspaceId).exportHistory()).toEqual(
      before.history
    );
    expect(
      reopened
        .prepare('SELECT * FROM catalog_entity_files WHERE entity_id=? ORDER BY id')
        .all(sequenceId)
    ).toEqual(before.bindings);
    expect(
      reopened.prepare('SELECT * FROM entity_references WHERE id=?').get(reference.id)
    ).toEqual(reference);
    expect((await inventoryComputeSource(source)).treeSha256).toBe(before.source.treeSha256);
    expect((await inventoryComputeSource(target)).treeSha256).toBe(output.treeSha256);
  }
);
