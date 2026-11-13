/** @vitest-environment node */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrimerLegacyProjectionInput } from '../../shared/primer-projection-ipc';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
}));

import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { registerDatabaseHandlers } from './database';
import { ensureWorkspaceOwnerInDb } from '../catalog-projection-commands';
import { registerCatalogEntityInDb } from '../catalog-entity-registration';
import { bindCatalogEntityFileInDb } from '../catalog-file-binding';
import {
  acquireWorkspaceSyncMutationLease,
  workspaceMutationWaiterCountForTest,
} from '../workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from './workspace-mutation-capability';
import {
  buildPrimerArtifact,
  primerLegacyProjectionFromArtifact,
  serializePrimerArtifact,
} from '../../features/primers/public/primer-artifact';

describe('primer projection IPC owner lease', () => {
  let db: Database.Database;
  let root: string;
  let other: string;
  let projection: PrimerLegacyProjectionInput;
  let release: (() => void) | undefined;
  const sender = Object.assign(new EventEmitter(), { id: 366163 });

  beforeEach(async () => {
    db = createTestDb();
    ensureSchema(db, ':memory:');
    handlers.clear();
    registerDatabaseHandlers(() => db);
    root = mkdtempSync(join(tmpdir(), 'dnaforge-primer-lease-'));
    other = mkdtempSync(join(tmpdir(), 'dnaforge-primer-other-'));
    const workspaceId = ensureWorkspaceOwnerInDb(db, root);
    ensureWorkspaceOwnerInDb(db, other);
    const path = join(root, 'Canonical.primer.json');
    const artifact = await buildPrimerArtifact({
      id: 'canonical-primer',
      catalogNumber: 'P901',
      name: 'Canonical',
      sequence: 'ATCGATCGATCGATCGATCG',
      workspaceRoot: root,
      artifactPath: path,
    });
    const content = serializePrimerArtifact(artifact);
    writeFileSync(path, content);
    registerCatalogEntityInDb(db, {
      id: artifact.id,
      type: 'primer',
      name: artifact.name,
      locator: `waypoint://primer/${artifact.id}`,
      storageType: 'file',
      workspaceRoot: root,
      metadata: { artifactRevision: artifact.artifactRevision },
    });
    bindCatalogEntityFileInDb(db, {
      entityId: artifact.id,
      path,
      fileKind: 'primer-artifact',
      workspaceRoot: root,
      contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    });
    projection = primerLegacyProjectionFromArtifact(artifact, workspaceId, []);
  });

  afterEach(() => {
    release?.();
    release = undefined;
    workspaceMutationCapabilities.releaseOwner(sender.id);
    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  function publish(declaredRoot?: string) {
    return Promise.resolve(
      handlers.get('db:replacePrimerProjection')!({ sender }, projection, declaredRoot)
    );
  }

  it('queues behind the native owner even when the caller omits its project path', async () => {
    release = await acquireWorkspaceSyncMutationLease(root);
    const pending = publish();
    await Promise.resolve();
    const queued = workspaceMutationWaiterCountForTest(root);
    const before = db.prepare('SELECT COUNT(*) AS count FROM primers').get();
    release();
    await pending;
    expect(queued).toBe(1);
    expect(before).toEqual({ count: 0 });
    expect(db.prepare('SELECT name FROM primers').get()).toEqual({ name: 'Canonical' });
  });

  it('rejects a different declared owner before publishing', async () => {
    await expect(publish(other)).rejects.toThrow('WORKSPACE_MUTATION_DECLARED_ROOT_MISMATCH');
    expect(db.prepare('SELECT COUNT(*) AS count FROM primers').get()).toEqual({ count: 0 });
  });

  it('revalidates canonical ownership after waiting for the project lease', async () => {
    release = await acquireWorkspaceSyncMutationLease(root);
    const pending = publish();
    await Promise.resolve();
    db.prepare('DELETE FROM catalog_entity_files WHERE entity_id=?').run(projection.id);
    release();
    await expect(pending).rejects.toThrow(/no native artifact binding/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM primers').get()).toEqual({ count: 0 });
  });

  it('can reconstruct a compatibility projection for reference-only source data', async () => {
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=?").run(
      projection.workspaceId
    );
    await publish();
    expect(db.prepare('SELECT name FROM primers').get()).toEqual({ name: 'Canonical' });
  });
});
