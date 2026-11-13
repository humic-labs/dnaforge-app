import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseWorkspaceIdentity,
  type ScientificWorkspaceSubmitRequest,
  type ScientificWorkspaceSubmitResult,
} from '@waypoint/domain-services';
import { defineScientificAssemblyDraft } from '@waypoint/scientific-objects';
import { serializeGenBank } from '@waypoint/sequence-utils';
import { parseResourceId } from '@waypoint/workspace-revisions';
import { workspaceScopeKey } from '../../shared/workspace-scoped-identity';
import { createFileTestDb } from '../__tests__/test-db';
import { ensureSchema } from '../schema';
import { ScientificObjectStore } from '../scientific-object-store';
import { submitScientificWorkspace } from '../scientific-workspace-service';
import {
  acquireWorkspaceSyncDatabaseFence,
  notifyRendererDatabaseStatementSettled,
} from '../workspace-sync-database-fence';
import { registerScientificObjectHandlers } from './scientific-objects';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
  app: { getPath: vi.fn(), getVersion: () => '1.0.0' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./database', () => ({ getDb: vi.fn() }));
vi.mock('../analytics', () => ({ trackEvent: vi.fn() }));

vi.mock('../scientific-migration-recovery', () => ({
  ensureScientificEnrollmentCheckpoint: vi.fn(async () => {}),
}));
vi.mock('../scientific-workspace-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scientific-workspace-service')>();
  return { ...actual, submitScientificWorkspace: vi.fn(actual.submitScientificWorkspace) };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  handlers.clear();
  vi.clearAllMocks();
});

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
const nativeText = serializeGenBank({
  id: 'product',
  name: 'Product',
  sequence: sequence.bases,
  length: sequence.bases.length,
  circular: false,
  annotations: [],
});

async function fixture() {
  const f = createFileTestDb('scientific-ipc');
  cleanups.push(f.cleanup);
  ensureSchema(f.db, f.dbPath);
  const root = join(f.tmpDir, 'project');
  await mkdir(root);
  const workspaceId = Number(
    f.db
      .prepare('INSERT INTO workspaces (name, path, repo_uuid, created_at) VALUES (?, ?, ?, ?)')
      .run('Science', root, 'scientific-ipc', 1).lastInsertRowid
  );
  registerScientificObjectHandlers(() => f.db);
  const handler = handlers.get('scientificObjects:submit');
  if (!handler) throw new Error('Scientific submit handler was not registered.');
  const request = (native: boolean): ScientificWorkspaceSubmitRequest => ({
    workspace: parseWorkspaceIdentity(workspaceScopeKey('scientific-ipc', workspaceId)),
    operationId: 'assembly-initial',
    expectedHead: null,
    source: {
      kind: 'accepted-assembly',
      entries: [
        { resourceId: 'source', path: 'source.json', document: sequence },
        native
          ? {
              resourceId: 'product',
              path: 'product.gb',
              representation: { format: 'genbank-v1', text: nativeText },
            }
          : {
              resourceId: 'product',
              path: 'product.json',
              document: { ...sequence, name: 'Product' },
            },
      ],
      assembly: defineScientificAssemblyDraft({
        resourceId: 'assembly-1',
        path: 'history/1.json',
        constructId: 'construct',
        parent: null,
        sources: [{ kind: 'submitted', resourceId: 'source' }],
        primers: [],
        product: { kind: 'submitted', resourceId: 'product' },
        recipe: { method: 'gibson', protocol: { preserve: 'complete recipe' } },
      }),
    },
  });
  const invoke = (input: ScientificWorkspaceSubmitRequest) =>
    handler(
      { sender: { id: 37 } },
      { workspaceRoot: root, request: input }
    ) as Promise<ScientificWorkspaceSubmitResult>;
  return {
    ...f,
    root,
    workspaceId,
    request,
    invoke,
    store: new ScientificObjectStore(f.db, workspaceId),
  };
}

describe('scientificObjects:submit assembly receipt', () => {
  it('returns a committed canonical assembly receipt and its replay without demanding native proof', async () => {
    const f = await fixture();
    const request = f.request(false);
    const result = await f.invoke(request);
    expect(result).toMatchObject({
      replayed: false,
      currentHead: f.store.read().head,
      receipt: { outcome: 'changed', version: f.store.read().head },
      delivery: { kind: 'complete' },
    });
    expect(result).not.toHaveProperty('accepted');
    expect(JSON.parse(await readFile(join(f.root, 'product.json'), 'utf8'))).toMatchObject({
      kind: 'sequence',
      name: 'Product',
    });
    expect(await f.invoke(request)).toMatchObject({ ...result, replayed: true });
  });

  it('returns exact accepted native product proof for an explicitly represented assembly', async () => {
    const f = await fixture();
    const result = await f.invoke(f.request(true));
    const productId = parseResourceId('product');
    if (!productId.ok) throw new Error('Invalid fixture product identity.');
    const product = f.store.read().reader.current(productId.value)!;
    expect(result).toMatchObject({
      receipt: { outcome: 'changed', version: f.store.read().head },
      delivery: { kind: 'complete' },
      accepted: {
        kind: 'accepted-object',
        resourceId: 'product',
        resourceRevisionId: product.revisionId,
        workspaceVersionId: f.store.read().head,
        contentSha256: createHash('sha256').update(nativeText).digest('hex'),
      },
    });
    expect(await readFile(join(f.root, 'product.gb'), 'utf8')).toBe(nativeText);
  });

  it('still refuses a native promise when the accepted product has no native representation', async () => {
    const f = await fixture();
    const committed = await submitScientificWorkspace({
      db: f.db,
      workspaceId: f.workspaceId,
      request: f.request(false),
    });

    vi.mocked(submitScientificWorkspace).mockResolvedValueOnce(committed);
    await expect(f.invoke(f.request(true))).rejects.toThrow(
      'Accepted native publication is unavailable.'
    );
  });
});

describe('scientific read IPC during native publication', () => {
  const channels = ['catalog', 'list', 'read'] as const;

  it.each(channels)(
    'queues %s until the native database owner releases its fence',
    async (channel) => {
      const f = await fixture();
      const accepted = await f.invoke(f.request(false));
      const workspace = f.request(false).workspace;
      const handler = handlers.get(`scientificObjects:${channel}`)!;
      const release = await acquireWorkspaceSyncDatabaseFence(f.db);
      const settled = vi.fn();
      const pending = Promise.resolve()
        .then(() =>
          handler(
            { sender: { id: 37 } },
            {
              workspaceRoot: f.root,
              request: { workspace, ...(channel === 'read' ? { resourceId: 'product' } : {}) },
            }
          )
        )
        .then(
          (result) => {
            settled();
            return result;
          },
          (error) => {
            settled(error);
            throw error;
          }
        );

      void pending.catch(() => {});
      try {
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        release();
        const result = await pending;
        if (channel === 'read') {
          expect(result).toMatchObject({
            resourceId: 'product',
            document: { ...sequence, name: 'Product' },
          });
        } else {
          expect(result).toMatchObject({
            workspace,
            head: accepted.currentHead,
            entries: expect.arrayContaining([expect.objectContaining({ resourceId: 'product' })]),
          });
        }
        expect(f.db.inTransaction).toBe(false);
      } finally {
        release();
      }
    }
  );

  it.each(channels)("refuses %s inside another renderer's transaction", async (channel) => {
    const f = await fixture();
    await f.invoke(f.request(false));
    const handler = handlers.get(`scientificObjects:${channel}`)!;
    f.db.exec('BEGIN');
    notifyRendererDatabaseStatementSettled(f.db, { senderId: 71, wasInTransaction: false });
    try {
      await expect(
        Promise.resolve().then(() =>
          handler(
            { sender: { id: 37 } },
            {
              workspaceRoot: f.root,
              request: {
                workspace: f.request(false).workspace,
                ...(channel === 'read' ? { resourceId: 'product' } : {}),
              },
            }
          )
        )
      ).rejects.toThrow('DATABASE_TRANSACTION_OWNED_BY_ANOTHER_RENDERER');
      expect(f.db.inTransaction).toBe(true);
    } finally {
      f.db.exec('ROLLBACK');
      notifyRendererDatabaseStatementSettled(f.db);
    }
  });
});
