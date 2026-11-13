import type Database from 'better-sqlite3';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import {
  acquireWorkspaceMutationShared,
  acquireWorkspaceSyncMutationLease,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from './workspace-mutation-capability';
import { withDeclaredRendererWorkspaceMutation } from './workspace-mutation-authority';

const OWNER_ID = 41;
const OTHER_OWNER_ID = 42;

let database: Database.Database | null = null;

afterEach(() => {
  workspaceMutationCapabilities.releaseOwner(OWNER_ID);
  workspaceMutationCapabilities.releaseOwner(OTHER_OWNER_ID);
  database?.close();
  database = null;
});

function workspaceDatabase(root: string): Database.Database {
  const db = createTestDb();
  ensureSchema(db, join(root, 'dnaforge.db'));
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at, last_opened_at) VALUES (1, 'Test', ?, 1, 1)`
  ).run(root);
  database = db;
  return db;
}

describe('withDeclaredRendererWorkspaceMutation', () => {
  it('lets only the owning renderer finish nested work while a replica pull waits', async () => {
    const root = `/tmp/primer-mutation-${crypto.randomUUID()}`;
    const artifactPath = `${root}/primers/test.primer.json`;
    const db = workspaceDatabase(root);
    const rootIdentity = workspaceMutationRootIdentity(root);
    const releaseShared = await acquireWorkspaceMutationShared(rootIdentity);
    const token = workspaceMutationCapabilities.issue(OWNER_ID, rootIdentity, releaseShared);
    let pullEntered = false;
    const pendingPull = acquireWorkspaceSyncMutationLease(rootIdentity).then((release) => {
      pullEntered = true;
      return release;
    });

    await expect(
      withDeclaredRendererWorkspaceMutation({
        db,
        ownerId: OWNER_ID,
        workspaceRoot: root,
        mutationPaths: [artifactPath],
        mutationToken: token,
        operation: async () => 'primer write completed',
      })
    ).resolves.toBe('primer write completed');
    await expect(
      withDeclaredRendererWorkspaceMutation({
        db,
        ownerId: OTHER_OWNER_ID,
        workspaceRoot: root,
        mutationPaths: [artifactPath],
        mutationToken: token,
        operation: async () => 'wrong renderer entered',
      })
    ).rejects.toThrow('WORKSPACE_MUTATION_TOKEN_INVALID');
    let tokenlessMutationEntered = false;
    const tokenlessMutation = withDeclaredRendererWorkspaceMutation({
      db,
      ownerId: OTHER_OWNER_ID,
      workspaceRoot: root,
      mutationPaths: [artifactPath],
      operation: async () => {
        tokenlessMutationEntered = true;
        return 'tokenless mutation entered';
      },
    });
    await Promise.resolve();
    expect(tokenlessMutationEntered).toBe(false);
    expect(pullEntered).toBe(false);

    expect(workspaceMutationCapabilities.release(token, OWNER_ID)).toBe(true);
    const releasePull = await pendingPull;
    expect(pullEntered).toBe(true);
    expect(tokenlessMutationEntered).toBe(false);
    releasePull();
    await expect(tokenlessMutation).resolves.toBe('tokenless mutation entered');
    expect(tokenlessMutationEntered).toBe(true);
  });
});
