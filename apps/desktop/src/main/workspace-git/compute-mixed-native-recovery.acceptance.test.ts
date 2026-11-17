import * as fs from 'node:fs';
import * as git from 'isomorphic-git';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
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
