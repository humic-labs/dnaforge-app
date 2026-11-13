import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./ipc/database', () => ({ getDb: () => db }));

import { serializeSequenceForInPlaceSave } from '@waypoint/sequence-utils';
import { createTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { registerCatalogEntityInDb } from './catalog-entity-registration';
import { saveSequenceDocumentWithLineage } from './sequence-document-save';
import { commitSequenceDocumentHistory } from './sequence-document-history';
import {
  commitAllIfDirty,
  commitOwnedPathsIfDirty,
  initManagedRepo,
  resolveHeadCommit,
} from './workspace-git';
import { withDeclaredRendererWorkspaceMutation } from './ipc/workspace-mutation-authority';
import {
  acquireWorkspaceMutationShared,
  workspaceMutationRootIdentity,
  workspaceMutationWaiterCountForTest,
} from './workspace-sync-mutation-lease';
import { workspaceMutationCapabilities } from './ipc/workspace-mutation-capability';
import { executeManagedGit } from './workspace-git/native';
import type { SequenceDocumentHistoryInput } from '../shared/sequence-edit-lineage';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';

let db: ReturnType<typeof createTestDb>;

describe('native acknowledged sequence history', () => {
  let root: string;
  let sourcePath: string;
  let input: SequenceDocumentHistoryInput;
  const id = 'history-document';
  const sequence = (bases: string) => ({
    id,
    name: 'history',
    sequence: bases,
    length: bases.length,
    circular: false,
    annotations: [],
  });
  const resolve = async () => ({ documentId: id, workspaceRoot: root, sourcePath });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sequence-history-'));
    sourcePath = join(root, 'sequence.gb');
    db = createTestDb();
    ensureSchema(db, ':memory:');
    ensureWorkspaceOwnerInDb(db, root);
    db.prepare("UPDATE workspaces SET id=7, repo_uuid='history-project' WHERE path=?").run(root);
    registerCatalogEntityInDb(db, {
      id,
      type: 'sequence',
      name: 'history',
      locator: `entity://sequence/${id}`,
      storageType: 'file',
      workspaceRoot: root,
    });
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES ('history-source',?,7,?,'genbank','current',1,1)"
    ).run(id, sourcePath);
    db.exec('DELETE FROM catalog_entity_events');
    await writeFile(sourcePath, serializeSequenceForInPlaceSave(sequence('AACC'), sourcePath));
    await initManagedRepo(root);
    await commitAllIfDirty(root, 'baseline');
    const saved = await saveSequenceDocumentWithLineage(
      {
        documentId: id,
        sourcePath,
        capture: {
          sequence: sequence('AATTCC'),
          draftBaseline: { sequence: 'AACC', length: 4, circular: false },
          draftSequence: 'AATTCC',
          insertedRanges: [{ start: 2, end: 4 }],
          deletedRanges: [],
          substitutedRanges: [],
          draftLineageId: 'history-draft',
        },
      },
      { db, resolve, runDatabase: (operation) => operation(), includeWriteReceipt: true }
    );
    if (saved.status !== 'saved' || !saved.writeReceipt)
      throw new Error('native save receipt missing');
    input = {
      documentId: id,
      sourcePath,
      ...saved.writeReceipt,
      message: 'Save intended revision',
    };
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('checkpoints history while the renderer publication still owns its admitted workspace lease', async () => {
    const bytes = await readFile(sourcePath);
    const before = await resolveHeadCommit(root);
    const commit = vi.fn(commitOwnedPathsIfDirty);
    let heldLease: (() => void) | undefined;
    const pending = withDeclaredRendererWorkspaceMutation({
      db,
      ownerId: 3349,
      workspaceRoot: root,
      mutationPaths: [sourcePath],
      fileWrite: true,
      operation: (mutationLease) => {
        heldLease = mutationLease;
        return commitSequenceDocumentHistory(input, { db, resolve, commit, mutationLease });
      },
    });
    try {
      await vi.waitFor(() => {
        expect(
          workspaceMutationWaiterCountForTest(root) + commit.mock.calls.length
        ).toBeGreaterThan(0);
      });
      expect(workspaceMutationWaiterCountForTest(root)).toBe(0);
      await expect(pending).resolves.toMatchObject({ status: 'committed' });
      expect(commit).toHaveBeenCalledOnce();
      expect(await resolveHeadCommit(root)).not.toBe(before);
      expect(await readFile(sourcePath)).toEqual(bytes);
      expect(await executeManagedGit(root, ['show', 'HEAD:sequence.gb'])).toBe(
        bytes.toString('utf8')
      );
    } finally {
      heldLease?.();
      await pending;
    }
  });

  it('checkpoints history inside the existing renderer mutation token without reacquiring its lease', async () => {
    const release = await acquireWorkspaceMutationShared(root);
    const ownerId = 3349;
    const mutationToken = workspaceMutationCapabilities.issue(
      ownerId,
      workspaceMutationRootIdentity(root),
      release
    );
    const commit = vi.fn(commitOwnedPathsIfDirty);
    const pending = withDeclaredRendererWorkspaceMutation({
      db,
      ownerId,
      workspaceRoot: root,
      mutationPaths: [sourcePath],
      mutationToken,
      fileWrite: true,
      operation: () =>
        commitSequenceDocumentHistory(input, {
          db,
          resolve,
          commit,
          renderer: { ownerId, mutationToken },
        }),
    });
    try {
      await vi.waitFor(() => {
        expect(
          workspaceMutationWaiterCountForTest(root) + commit.mock.calls.length
        ).toBeGreaterThan(0);
      });
      expect(workspaceMutationWaiterCountForTest(root)).toBe(0);
      await expect(pending).resolves.toMatchObject({ status: 'committed' });
      expect(commit).toHaveBeenCalledOnce();
    } finally {
      release();
      await pending;
      workspaceMutationCapabilities.release(mutationToken, ownerId);
    }
  });

  it.each(['forged', 'released', 'other-project'] as const)(
    'refuses a %s workspace lease before committing history',
    async (kind) => {
      const before = await resolveHeadCommit(root);
      const bytes = await readFile(sourcePath);
      const commit = vi.fn(commitOwnedPathsIfDirty);
      const mutationLease =
        kind === 'forged'
          ? () => undefined
          : await acquireWorkspaceMutationShared(
              kind === 'other-project' ? join(root, 'other') : root
            );
      if (kind === 'released') mutationLease();
      try {
        await expect(
          commitSequenceDocumentHistory(input, { db, resolve, commit, mutationLease })
        ).resolves.toMatchObject({ status: 'failed' });
        expect(commit).not.toHaveBeenCalled();
        expect(workspaceMutationWaiterCountForTest(root)).toBe(0);
        expect(await resolveHeadCommit(root)).toBe(before);
        expect(await readFile(sourcePath)).toEqual(bytes);
      } finally {
        mutationLease();
      }
    }
  );

  it('refuses an admitted lease released before the final history publication', async () => {
    const before = await resolveHeadCommit(root);
    const mutationLease = await acquireWorkspaceMutationShared(root);
    const commit = vi.fn(commitOwnedPathsIfDirty);
    const assertCurrent = vi.fn(() => {
      if (assertCurrent.mock.calls.length === 2) mutationLease();
    });
    try {
      await expect(
        commitSequenceDocumentHistory(input, { db, resolve, commit, mutationLease, assertCurrent })
      ).resolves.toMatchObject({ status: 'failed' });
      expect(commit).not.toHaveBeenCalled();
      expect(await resolveHeadCommit(root)).toBe(before);
    } finally {
      mutationLease();
    }
  });

  it('retains disk bytes through failed history and retries one intended commit without Save', async () => {
    const bytes = await readFile(sourcePath);
    const before = await resolveHeadCommit(root);
    const failed = await commitSequenceDocumentHistory(input, {
      db,
      resolve,
      commit: vi.fn().mockRejectedValue(new Error('injected Git failure')),
    });
    expect(failed.status).toBe('failed');
    expect(await readFile(sourcePath)).toEqual(bytes);
    expect(await resolveHeadCommit(root)).toBe(before);
    expect((await commitSequenceDocumentHistory(input, { db, resolve })).status).toBe('committed');
    const after = await resolveHeadCommit(root);
    expect(after).not.toBe(before);
    expect((await commitSequenceDocumentHistory(input, { db, resolve })).status).toBe(
      'already-committed'
    );
    expect(await resolveHeadCommit(root)).toBe(after);
    expect(await readFile(sourcePath)).toEqual(bytes);
    expect(await executeManagedGit(root, ['show', 'HEAD:sequence.gb'])).toBe(
      bytes.toString('utf8')
    );
    expect((await executeManagedGit(root, ['log', '--format=%s'])).trim().split('\n')).toEqual([
      'Save intended revision',
      'baseline',
    ]);
  });

  it('refuses a later external revision without committing or overwriting it', async () => {
    const before = await resolveHeadCommit(root);
    await writeFile(sourcePath, 'later external bytes');
    expect((await commitSequenceDocumentHistory(input, { db, resolve })).status).toBe(
      'revision-changed'
    );
    expect(await resolveHeadCommit(root)).toBe(before);
    expect(await readFile(sourcePath, 'utf8')).toBe('later external bytes');
  });

  it('refuses an alternate path for the same document binding', async () => {
    const other = join(root, 'other.gb');
    await writeFile(other, await readFile(sourcePath));
    const before = await resolveHeadCommit(root);
    expect(
      (await commitSequenceDocumentHistory({ ...input, sourcePath: other }, { db, resolve })).status
    ).toBe('revision-changed');
    expect(await resolveHeadCommit(root)).toBe(before);
  });

  it('refuses a project demoted after Save without committing or rewriting bytes', async () => {
    const bytes = await readFile(sourcePath);
    const before = await resolveHeadCommit(root);
    const commit = vi.fn();
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=7").run();
    expect((await commitSequenceDocumentHistory(input, { db, resolve, commit })).status).toBe(
      'failed'
    );
    expect(commit).not.toHaveBeenCalled();
    expect(await readFile(sourcePath)).toEqual(bytes);
    expect(await resolveHeadCommit(root)).toBe(before);
  });

  it('commits a managed Save with its marker and immutable revision snapshots', async () => {
    const packageRoot = join(root, 'package');
    await mkdir(join(packageRoot, '.forge'), { recursive: true });
    sourcePath = join(packageRoot, 'product.gb');
    db.prepare("UPDATE catalog_entity_files SET path=? WHERE id='history-source'").run(sourcePath);
    await writeFile(sourcePath, serializeSequenceForInPlaceSave(sequence('AACC'), sourcePath));
    await writeFile(
      join(packageRoot, '.forge', 'plasmid.json'),
      serializeSequencePackageDocument(
        buildSequencePackageDocument({ id, name: 'history', product: { file: 'product.gb' } })
      )
    );
    await commitAllIfDirty(root, 'package baseline');
    const result = await saveSequenceDocumentWithLineage(
      {
        documentId: id,
        sourcePath,
        capture: {
          sequence: sequence('AATTCC'),
          draftBaseline: { sequence: 'AACC', length: 4, circular: false },
          draftSequence: 'AATTCC',
          insertedRanges: [{ start: 2, end: 4 }],
          deletedRanges: [],
          substitutedRanges: [],
          draftLineageId: 'managed-history',
        },
      },
      { db, resolve, runDatabase: (operation) => operation(), includeWriteReceipt: true }
    );
    if (result.status !== 'saved' || !result.writeReceipt)
      throw new Error('Managed receipt missing');
    const request = { documentId: id, sourcePath, ...result.writeReceipt, message: 'Managed Save' };
    expect((await commitSequenceDocumentHistory(request, { db, resolve })).status).toBe(
      'committed'
    );
    expect(await executeManagedGit(root, ['status', '--porcelain', '--', 'package'])).toBe('');
    const paths = await executeManagedGit(root, ['show', '--format=', '--name-only', 'HEAD']);
    expect(paths).toContain('package/product.gb');
    expect(paths).toContain('package/.forge/plasmid.json');
    expect(paths).toContain('package/contents/sequence-snapshot-');
    const head = await resolveHeadCommit(root);
    expect((await commitSequenceDocumentHistory(request, { db, resolve })).status).toBe(
      'already-committed'
    );
    expect(await resolveHeadCommit(root)).toBe(head);
  });
});
