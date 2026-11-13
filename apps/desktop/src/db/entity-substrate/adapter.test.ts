// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const bases = new Map<string, string>();
vi.mock('../../platform', () => ({
  platform: () => ({
    db: {
      settleEntityProjectionSource: async ({
        key,
        fingerprint,
      }: {
        key: {
          adapterKind: string;
          entityId: string;
          workspaceKey: string;
          relativePath: string;
          projectionVersion: number;
        };
        fingerprint: string;
      }) => {
        bases.set(
          JSON.stringify([
            key.adapterKind,
            key.entityId,
            key.workspaceKey,
            key.relativePath,
            key.projectionVersion,
          ]),
          fingerprint
        );
      },
      select: async (_sql: string, params: unknown[]) => {
        const base = bases.get(JSON.stringify(params));
        return base ? [{ synchronized_fingerprint: base }] : [];
      },
      execute: async (_sql: string, params: unknown[]) => {
        bases.set(JSON.stringify(params.slice(0, 5)), params[5] as string);
      },
    },
  }),
}));

import {
  __resetEntityAdapterRegistryForTests,
  contentFingerprint,
  getEntityAdapterForKind,
  getEntityAdapterForPath,
  getEntityAdapterForSchema,
  listEntityAdapters,
  reconcileEntityFile,
  registerEntityAdapter,
  type EntityProjectionState,
  type WorkspaceEntityAdapter,
} from './adapter';

type FakeDoc = { id: string; body: string };

function makeFakeAdapter(store: Map<string, { fingerprint: string; updatedAtMs: number }>) {
  const writes: Array<{ id: string; body: string; mtime: number }> = [];
  const adapter: WorkspaceEntityAdapter<FakeDoc> = {
    kind: 'fake',
    schema: 'waypoint.fake.v1',
    matchesPath: (p) => p.endsWith('.fake'),
    parse: (bytes) => JSON.parse(bytes) as FakeDoc,
    serialize: (doc) => JSON.stringify(doc),
    identity: (doc) => doc.id,
    projectionFingerprint: (doc) => contentFingerprint(doc.body),
    getProjection: async (id): Promise<EntityProjectionState | null> => store.get(id) ?? null,
    writeProjection: async (doc, id, fileMtimeMs) => {
      store.set(id, { fingerprint: contentFingerprint(doc.body), updatedAtMs: fileMtimeMs });
      writes.push({ id, body: doc.body, mtime: fileMtimeMs });
    },
  };
  return { adapter, writes };
}

afterEach(() => {
  __resetEntityAdapterRegistryForTests();
  bases.clear();
});

describe('entity-adapter registry', () => {
  it('registers and resolves adapters by kind, path, and schema', () => {
    const { adapter } = makeFakeAdapter(new Map());
    registerEntityAdapter(adapter);
    expect(getEntityAdapterForKind('fake')).toBe(adapter);
    expect(getEntityAdapterForPath('/ws/thing.fake')).toBe(adapter);
    expect(getEntityAdapterForPath('/ws/thing.gb')).toBeNull();
    expect(getEntityAdapterForSchema('waypoint.fake.v1')).toBe(adapter);
    expect(listEntityAdapters()).toHaveLength(1);
  });

  it('fails fast on a duplicate kind registration', () => {
    const { adapter } = makeFakeAdapter(new Map());
    registerEntityAdapter(adapter);
    expect(() => registerEntityAdapter(adapter)).toThrow(/already registered/);
  });

  it('throws when a path matches two adapters (disjoint-ownership invariant)', () => {
    registerEntityAdapter({ ...makeFakeAdapter(new Map()).adapter, kind: 'a' });
    registerEntityAdapter({ ...makeFakeAdapter(new Map()).adapter, kind: 'b' });
    expect(() => getEntityAdapterForPath('/ws/x.fake')).toThrow(/matched both/);
  });
});

describe('contentFingerprint', () => {
  it('is stable and changes with content', () => {
    expect(contentFingerprint('hello')).toBe(contentFingerprint('hello'));
    expect(contentFingerprint('hello')).not.toBe(contentFingerprint('hello!'));
    expect(contentFingerprint('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('reconcileEntityFile — content-based convergence', () => {
  const ctx = { workspaceRoot: '/ws' };
  const file = (doc: FakeDoc) => JSON.stringify(doc);

  it('projects a file with no existing projection (created)', async () => {
    const store = new Map();
    const { adapter, writes } = makeFakeAdapter(store);
    const r = await reconcileEntityFile(
      adapter,
      file({ id: 'n1', body: 'v1' }),
      '/ws/a.fake',
      100,
      ctx
    );
    expect(r).toEqual({ id: 'n1', outcome: 'created' });
    expect(writes).toHaveLength(1);
  });

  it('awaits a content digest before publishing or acknowledging an asynchronous projection', async () => {
    const store = new Map<string, { fingerprint: string; updatedAtMs: number }>();
    const { adapter, writes } = makeFakeAdapter(store);
    adapter.projectionFingerprint = async (doc) => contentFingerprint(doc.body);
    const publish = adapter.writeProjection;
    adapter.writeProjection = async (...args) => {
      await publish(...args);
      return { sourceDocument: args[0] };
    };
    const bytes = file({ id: 'n1', body: 'complete saved document' });
    await expect(reconcileEntityFile(adapter, bytes, '/ws/a.fake', 100, ctx)).resolves.toEqual({
      id: 'n1',
      outcome: 'created',
    });
    await expect(reconcileEntityFile(adapter, bytes, '/ws/a.fake', 200, ctx)).resolves.toEqual({
      id: 'n1',
      outcome: 'in-sync',
    });
    expect(writes).toHaveLength(1);
    expect([...bases.values()]).toContain(contentFingerprint('complete saved document'));
  });

  it('no-ops when the projection already matches the file (in-sync fast path)', async () => {
    const store = new Map();
    const { adapter, writes } = makeFakeAdapter(store);
    await reconcileEntityFile(adapter, file({ id: 'n1', body: 'v1' }), '/ws/a.fake', 100, ctx);
    const r = await reconcileEntityFile(
      adapter,
      file({ id: 'n1', body: 'v1' }),
      '/ws/a.fake',
      200,
      ctx
    );
    expect(r.outcome).toBe('in-sync');
    expect(writes).toHaveLength(1);
  });

  it('updates the projection after a file-only change regardless of its timestamp', async () => {
    const store = new Map([['n1', { fingerprint: contentFingerprint('old'), updatedAtMs: 100 }]]);
    const { adapter, writes } = makeFakeAdapter(store);
    await reconcileEntityFile(adapter, file({ id: 'n1', body: 'old' }), '/ws/a.fake', 100, ctx);
    const r = await reconcileEntityFile(
      adapter,
      file({ id: 'n1', body: 'new' }),
      '/ws/a.fake',
      1,
      ctx
    );
    expect(r.outcome).toBe('updated-from-file');
    expect(writes.at(-1)?.body).toBe('new');
    expect(store.get('n1')?.updatedAtMs).toBe(1);
  });

  it('does NOT clobber a projection that is newer than the file (unsynced in-app edit) → conflict', async () => {
    const store = new Map([
      ['n1', { fingerprint: contentFingerprint('db-edit'), updatedAtMs: 900 }],
    ]);
    const { adapter, writes } = makeFakeAdapter(store);
    const r = await reconcileEntityFile(
      adapter,
      file({ id: 'n1', body: 'stale-file' }),
      '/ws/a.fake',
      300,
      ctx
    );
    expect(r.outcome).toBe('conflict');
    expect(writes).toHaveLength(0);
    expect(store.get('n1')?.fingerprint).toBe(contentFingerprint('db-edit'));
  });
});
