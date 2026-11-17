import * as fs from 'node:fs';
import * as git from 'isomorphic-git';
import { mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { registerCatalogEntityInDb } from '../catalog-entity-registration';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import { recoverComputeResult } from './compute-result-recovery';
import { inventoryComputeSource } from './compute-result-retention';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

it('automatically packages a catalog-bound legacy compute sequence while keeping its exact identity and binding', async () => {
  const f = createFileTestDb('compute-bound-sequence');
  cleanups.push(f.cleanup);
  ensureSchema(f.db, f.dbPath);
  const root = join(realpathSync(f.tmpDir), 'project');
  const source = join(root, 'compute/provider/job');
  mkdirSync(source, { recursive: true });
  const original = 'LOCUS       Bound 12 bp DNA linear SYN\nORIGIN\n        1 acgtacgtacgt\n//\n';
  const file = join(source, 'Bound.gb');
  writeFileSync(file, original);
  await git.init({ fs, dir: root });
  await git.add({ fs, dir: root, filepath: '.' });
  await git.commit({
    fs,
    dir: root,
    message: 'Original bound compute sequence',
    author: { name: 'Test', email: 'test@example.invalid' },
  });
  const workspace = Number(
    f.db
      .prepare('INSERT INTO workspaces(name,path,repo_uuid,created_at) VALUES(?,?,?,1)')
      .run('Project', root, 'bound-compute-workspace').lastInsertRowid
  );
  const id = 'bound-legacy-compute-sequence';
  registerCatalogEntityInDb(f.db, {
    id,
    type: 'sequence',
    name: 'Bound',
    locator: `entity://sequence/${id}`,
    workspaceRoot: root,
    storageType: 'file',
  });
  bindCatalogEntityFileInDb(f.db, {
    entityId: id,
    path: file,
    workspaceRoot: root,
    fileKind: 'genbank',
    status: 'current',
  });
  const before = f.db
    .prepare(
      "SELECT id,entity_id,object_uuid FROM catalog_entity_files WHERE entity_id=? AND status='current'"
    )
    .get(id);
  f.db
    .prepare(
      "INSERT INTO compute_jobs(id,provider,tool_id,settings_hash,settings_json,provider_job_ref,state,workspace_root,imported_paths_json,created_at,updated_at) VALUES('job','provider','tool',?,'{}','job','imported',?,?,1,1)"
    )
    .run('a'.repeat(64), root, JSON.stringify([file]));
  const inventory = await inventoryComputeSource(source);

  await recoverComputeResult(f.db, { workspaceRoot: root, provider: 'provider', remoteId: 'job' });

  const binding = f.db
    .prepare(
      "SELECT id,entity_id,object_uuid,path,file_kind,workspace_id FROM catalog_entity_files WHERE entity_id=? AND status='current'"
    )
    .get(id) as {
    id: string;
    entity_id: string;
    object_uuid: string;
    path: string;
    file_kind: string;
    workspace_id: number;
  };
  expect(binding).toMatchObject({
    ...(before as object),
    workspace_id: workspace,
    file_kind: 'waypoint-sequence',
  });
  const marker = JSON.parse(readFileSync(join(binding.path, '.forge/plasmid.json'), 'utf8'));
  expect(marker.id).toBe(id);
  expect(readFileSync(join(binding.path, marker.product.file), 'utf8')).toBe(original);
  expect((await inventoryComputeSource(source)).treeSha256).toBe(inventory.treeSha256);
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM catalog_entities').get()).toEqual({
    count: 1,
  });
});
