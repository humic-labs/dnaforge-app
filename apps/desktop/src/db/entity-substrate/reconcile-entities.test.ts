import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();
const dirs = new Map<string, Array<{ name: string; isDirectory: boolean; isFile: boolean }>>();
const mtimes = new Map<string, number>();
const pages = new Map<string, { id: string; title: string; content: string; updated_at: number }>();
const bases = new Map<string, string>();
let afterRead: ((path: string) => void | Promise<void>) | undefined;
const limsMocks = vi.hoisted(() => ({
  queryEntities: vi.fn().mockResolvedValue([]),
  registerEntity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    lims: limsMocks,
    fs: {
      readDir: async (dir: string) => dirs.get(dir.replace(/\/+$/, '')) ?? [],
      exists: async (p: string) => files.has(p),
      readTextFile: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT ${p}`);
        const content = files.get(p)!;
        await afterRead?.(p);
        return content;
      },
      stat: async (p: string) => ({ size: (files.get(p) ?? '').length, mtime: mtimes.get(p) ?? 0 }),
    },
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
      replaceNotebookProjection: async (input: { pageId: string; sourcePath: string }) => {
        const source = await readNotebookProjectionSource(
          {
            exists: async (path: string) => files.has(path),
            readTextFile: async (path: string) => files.get(path)!,
          },
          input.sourcePath
        );
        const packageRoot = input.sourcePath.replace(/\/\.forge\/notebook\.json$/iu, '');
        const authorityPath =
          source.document.authority &&
          typeof source.document.authority === 'object' &&
          'path' in source.document.authority
            ? `${packageRoot}/${source.document.authority.path}`
            : input.sourcePath;
        pages.set(input.pageId, {
          id: input.pageId,
          title: source.document.title,
          content: JSON.stringify(source.document.content),
          updated_at: mtimes.get(authorityPath) ?? 0,
        });
        return pages.get(input.pageId);
      },
      select: async (sql: string, params: unknown[]) => {
        if (sql.includes('entity_projection_sources')) {
          const base = bases.get(JSON.stringify(params));
          return base ? [{ synchronized_fingerprint: base }] : [];
        }
        const id = params[0] as string;
        const row = pages.get(id);
        if (!row) return [];
        if (/SELECT id FROM pages/.test(sql)) return [{ id: row.id }];
        return [{ title: row.title, content: row.content, updated_at: row.updated_at }];
      },
      execute: async (sql: string, params: unknown[]) => {
        if (sql.includes('entity_projection_sources')) {
          bases.set(JSON.stringify(params.slice(0, 5)), params[5] as string);
          return;
        }
        if (/^INSERT INTO pages/.test(sql)) {
          const [id, title, content, , , updated_at] = params as [
            string,
            string,
            string,
            null,
            number,
            number,
          ];
          pages.set(id, { id, title, content, updated_at });
        } else if (/^UPDATE pages/.test(sql)) {
          const [title, content, updated_at, id] = params as [string, string, number, string];
          pages.set(id, { ...pages.get(id)!, title, content, updated_at });
        }
      },
    },
  }),
}));

vi.mock('../workspace-artifacts', () => ({
  resolveArtifactFile: vi.fn().mockResolvedValue({ repaired: false }),
}));

vi.mock('../workspace-catalog', () => ({
  resolveWorkspaceId: vi.fn().mockResolvedValue(1),
  resolveWorkspaceScope: vi.fn().mockResolvedValue(null),
  getCatalogEntity: vi.fn().mockResolvedValue({ name: 'Mounted' }),
}));

vi.mock('../../lib/renderer-interaction-activity', () => ({
  cooperateWithRendererInteraction: vi.fn().mockResolvedValue(undefined),
}));

import { readNotebookProjectionSource } from '../notebook-projection-source';
import {
  serializeNotebookPackageDocument,
  buildNotebookPackageMetadata,
  serializeNotebookPackageMetadata,
  type NotebookPackageDocument,
} from '../notebook-package';
import { serializeNotebookMarkdown } from '../notebook-markdown-codec';
import {
  __resetEntityAdapterRegistryForTests,
  registerEntityAdapter,
  type EntityReconcileContext,
  type WorkspaceEntityAdapter,
} from './adapter';
import { notebookEntityAdapter } from './notebook-adapter';
import { limsEntityArtifactAdapter } from './lims-entity-adapter';
import { reconcileWorkspaceEntities } from './reconcile-entities';
import { resolveArtifactFile } from '../workspace-artifacts';
import { cooperateWithRendererInteraction } from '../../lib/renderer-interaction-activity';

function notebookBytes(id: string, title: string, body: string): string {
  return serializeNotebookPackageDocument({
    schema: 'waypoint.notebook.v1',
    kind: 'notebook',
    id,
    title,
    storage: { type: 'database', table: 'pages', id },
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    },
  } as NotebookPackageDocument);
}

beforeEach(() => {
  files.clear();
  dirs.clear();
  mtimes.clear();
  pages.clear();
  bases.clear();
  afterRead = undefined;
  limsMocks.queryEntities.mockClear();
  limsMocks.registerEntity.mockClear();
  __resetEntityAdapterRegistryForTests();
  registerEntityAdapter(notebookEntityAdapter);
  dirs.set('/ws', [{ name: 'notebooks', isDirectory: true, isFile: false }]);
  dirs.set('/ws/notebooks', [{ name: 'N', isDirectory: true, isFile: false }]);
  dirs.set('/ws/notebooks/N', [
    { name: '.forge', isDirectory: true, isFile: false },
    { name: 'N.md', isDirectory: false, isFile: true },
  ]);
  const meta = '/ws/notebooks/N/.forge/notebook.json';
  files.set(meta, notebookBytes('p1', 'Mounted', 'from-file'));
  mtimes.set(meta, 500);
});

afterEach(() => __resetEntityAdapterRegistryForTests());

describe('reconcileWorkspaceEntities (mount-time file→DB rebuild)', () => {
  it.each([
    { metadataMtime: 500, markdownMtime: 3000, pageMtime: 2000, expected: 'file' },
    { metadataMtime: 500, markdownMtime: 3000, pageMtime: 4000, expected: 'page' },
    { metadataMtime: 5000, markdownMtime: 1000, pageMtime: 2000, expected: 'page' },
    {
      metadataMtime: 500,
      markdownMtime: 1000,
      payloadMtime: 3000,
      pageMtime: 2000,
      expected: 'page',
    },
  ])(
    'uses a content base, not metadata $metadataMtime or page time $pageMtime',
    async ({ metadataMtime, markdownMtime, payloadMtime, pageMtime, expected }) => {
      const root = '/ws/notebooks/N';
      const metadata = `${root}/.forge/notebook.json`;
      files.set(
        metadata,
        serializeNotebookPackageMetadata(
          buildNotebookPackageMetadata({
            id: 'p1',
            title: 'Mounted',
            markdownFileName: 'N.md',
          })
        )
      );
      const source = serializeNotebookMarkdown({
        identity: { id: 'p1', title: 'Mounted', formatVersion: 2 },
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'external edit' }] }],
        },
      });
      files.set(`${root}/N.md`, source.markdown);
      for (const payload of source.payloads) {
        files.set(`${root}/${payload.relativePath}`, payload.content);
        mtimes.set(`${root}/${payload.relativePath}`, payloadMtime ?? markdownMtime);
      }
      mtimes.set(metadata, metadataMtime);
      mtimes.set(`${root}/N.md`, markdownMtime);
      const prior = {
        id: 'p1',
        title: 'Unsaved',
        content: JSON.stringify({ type: 'doc', content: [] }),
        updated_at: pageMtime,
      };
      pages.set('p1', prior);
      if (expected === 'file') {
        const originalMarkdown = files.get(`${root}/N.md`)!;
        files.set(
          `${root}/N.md`,
          serializeNotebookMarkdown({
            identity: { id: 'p1', title: 'Unsaved', formatVersion: 2 },
            content: { type: 'doc', content: [] },
          }).markdown
        );
        pages.delete('p1');
        await reconcileWorkspaceEntities('/ws');
        files.set(`${root}/N.md`, originalMarkdown);
      }
      const result = await reconcileWorkspaceEntities('/ws');
      expect(result.errors).toEqual([]);
      if (expected === 'file') {
        expect(result).toMatchObject({ reconciled: 1, conflicts: 0 });
        expect(pages.get('p1')).toMatchObject({
          title: 'Mounted',
          updated_at: markdownMtime,
        });
        expect(pages.get('p1')?.content).toContain('external edit');
      } else {
        expect(result).toMatchObject({ reconciled: 0, conflicts: 1 });
        expect(pages.get('p1')).toEqual(prior);
      }
    }
  );
  it.each(['same-stamp-markdown', 'metadata', 'timestamp', 'payload'] as const)(
    'preserves the page when a v2 source changes during read: %s',
    async (fault) => {
      const root = '/ws/notebooks/N';
      const metadata = `${root}/.forge/notebook.json`;
      const markdown = `${root}/N.md`;
      files.set(
        metadata,
        serializeNotebookPackageMetadata(
          buildNotebookPackageMetadata({
            id: 'p1',
            title: 'Mounted',
            markdownFileName: 'N.md',
          })
        )
      );
      const source = serializeNotebookMarkdown({
        identity: { id: 'p1', title: 'Mounted', formatVersion: 2 },
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'external edit' }] }],
        },
      });
      files.set(markdown, source.markdown);
      mtimes.set(markdown, 3000);
      for (const payload of source.payloads)
        files.set(`${root}/${payload.relativePath}`, payload.content);
      const prior = {
        id: 'p1',
        title: 'Retain page',
        content: '{"type":"doc","content":[]}',
        updated_at: 2000,
      };
      pages.set('p1', prior);
      afterRead = (path) => {
        if (
          fault === 'payload'
            ? !path.includes('/.forge/blocks/')
            : path !== (fault === 'metadata' ? metadata : markdown)
        )
          return;
        afterRead = undefined;
        if (fault === 'timestamp') mtimes.set(path, 4000);
        else
          files.set(
            path,
            files
              .get(path)!
              .replace(
                fault === 'metadata' ? 'Mounted' : 'external edit',
                fault === 'metadata' ? 'Changed' : 'changed! edit'
              )
          );
      };
      const result = await reconcileWorkspaceEntities('/ws');
      expect(result.reconciled).toBe(0);
      expect(result.errors).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(/changed during reconciliation/),
        }),
      ]);
      expect(pages.get('p1')).toEqual(prior);
    }
  );
  it('does not let an ignored block payload timestamp overwrite a newer unsaved page', async () => {
    const root = '/ws/notebooks/N';
    files.set(
      `${root}/.forge/notebook.json`,
      serializeNotebookPackageMetadata(
        buildNotebookPackageMetadata({
          id: 'p1',
          title: 'Mounted',
          markdownFileName: 'N.md',
        })
      )
    );
    const source = serializeNotebookMarkdown({
      identity: { id: 'p1', title: 'Mounted', formatVersion: 2 },
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original text' }] }],
      },
    });
    files.set(`${root}/N.md`, source.markdown.replace('original text', 'external edit'));
    mtimes.set(`${root}/N.md`, 1000);
    for (const payload of source.payloads) {
      files.set(`${root}/${payload.relativePath}`, payload.content);
      mtimes.set(`${root}/${payload.relativePath}`, 3000);
    }
    const prior = {
      id: 'p1',
      title: 'Unsaved',
      content: '{"type":"doc","content":[]}',
      updated_at: 2000,
    };
    pages.set('p1', prior);
    const result = await reconcileWorkspaceEntities('/ws');
    expect(result).toMatchObject({ reconciled: 0, conflicts: 1, errors: [] });
    expect(pages.get('p1')).toEqual(prior);
  });
  it.each([1, 40])(
    'bounds rechecks for %s notebook blocks and waits for every read',
    async (blocks) => {
      const root = '/ws/notebooks/N';
      files.set(
        `${root}/.forge/notebook.json`,
        serializeNotebookPackageMetadata(
          buildNotebookPackageMetadata({
            id: 'p1',
            title: 'Mounted',
            markdownFileName: 'N.md',
          })
        )
      );
      const source = serializeNotebookMarkdown({
        identity: { id: 'p1', title: 'Mounted', formatVersion: 2 },
        content: {
          type: 'doc',
          content: Array.from({ length: blocks }, (_, index) => ({
            type: 'paragraph',
            content: [{ type: 'text', text: `checked content ${index}` }],
          })),
        },
      });
      files.set(`${root}/N.md`, source.markdown);
      for (const payload of source.payloads)
        files.set(`${root}/${payload.relativePath}`, payload.content);
      const counts = new Map<string, number>();
      let active = 0;
      let maximum = 0;
      let initialActive = 0;
      let initialMaximum = 0;
      afterRead = async (path) => {
        const count = (counts.get(path) ?? 0) + 1;
        counts.set(path, count);
        if (path.includes('/.forge/blocks/') && count === 1) {
          initialActive++;
          initialMaximum = Math.max(initialMaximum, initialActive);
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          initialActive--;
        }
        if (path.endsWith('/.forge/notebook.json') || count !== 2) return;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        active--;
      };
      expect(await reconcileWorkspaceEntities('/ws')).toMatchObject({ reconciled: 1, errors: [] });
      expect(maximum).toBeGreaterThanOrEqual(2);
      expect(maximum).toBeLessThanOrEqual(16);
      expect(active).toBe(0);
      expect(initialMaximum).toBe(blocks === 1 ? 1 : 16);
      expect(initialActive).toBe(0);
      for (const payload of source.payloads)
        expect(counts.get(`${root}/${payload.relativePath}`)).toBe(2);
      expect(pages.get('p1')?.content).toContain('checked content');
    }
  );
  it('discovers a .forge/notebook.json package (NOT hidden-skipped) and projects it into pages', async () => {
    const r = await reconcileWorkspaceEntities('/ws');
    expect(r.errors).toEqual([]);
    expect(r.scanned).toBe(1);
    expect(r.reconciled).toBe(1);
    expect(pages.get('p1')?.title).toBe('Mounted');
    expect(cooperateWithRendererInteraction).toHaveBeenCalled();
  });

  it('uses an authoritative managed-Git candidate list without walking directories again', async () => {
    dirs.clear();
    const metaPath = '/ws/notebooks/N/.forge/notebook.json';

    const r = await reconcileWorkspaceEntities('/ws', {
      candidatePaths: [metaPath],
      mutationToken: 'mount-reconcile-token',
    });

    expect(r).toMatchObject({ scanned: 1, reconciled: 1, errors: [] });
    expect(pages.get('p1')?.title).toBe('Mounted');
    expect(resolveArtifactFile).toHaveBeenCalledWith({
      path: metaPath,
      workspaceRoot: '/ws',
      mutationToken: 'mount-reconcile-token',
    });
    expect(limsMocks.registerEntity).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', kind: 'notebook', workspaceId: 1 }),
      'mount-reconcile-token'
    );
  });

  it('registers a mounted notebook using the held workspace mutation token', async () => {
    const result = await reconcileWorkspaceEntities('/ws', {
      candidatePaths: ['/ws/notebooks/N/.forge/notebook.json'],
      mutationToken: 'outer-workspace-mutation',
    });

    expect(result).toMatchObject({ scanned: 1, reconciled: 1, errors: [] });
    expect(limsMocks.registerEntity).toHaveBeenCalledExactlyOnceWith(
      {
        id: 'p1',
        kind: 'notebook',
        name: 'Mounted',
        fields: { packagePath: '/ws/notebooks/N' },
        workspaceId: 1,
        registrationStatus: 'registered',
      },
      'outer-workspace-mutation'
    );
  });

  it('carries the outer mutation token through both entity projection passes', async () => {
    __resetEntityAdapterRegistryForTests();
    const observedContexts: EntityReconcileContext[] = [];
    let projected = false;
    const adapter: WorkspaceEntityAdapter<{ id: string }> = {
      kind: 'mutation-token-probe',
      matchesPath: (path) => path.endsWith('.token-probe'),
      parse: async () => ({ id: 'token-probe-entity' }),
      serialize: (doc) => JSON.stringify(doc),
      identity: (doc) => doc.id,
      projectionFingerprint: () => 'file-fingerprint',
      getProjection: async (_id, ctx) => {
        observedContexts.push(ctx);
        return projected ? { fingerprint: 'file-fingerprint', updatedAtMs: 0 } : null;
      },
      writeProjection: async (_doc, _id, _mtime, _path, ctx) => {
        observedContexts.push(ctx);
        projected = true;
      },
      reconcileRelationships: async (doc, _id, _path, ctx) => {
        expect(doc.id).toBe('token-probe-entity');
        observedContexts.push(ctx);
      },
    };
    registerEntityAdapter(adapter);
    const path = '/ws/records/entity.token-probe';
    files.set(path, '{}');
    mtimes.set(path, 500);

    const result = await reconcileWorkspaceEntities('/ws', {
      candidatePaths: [path],
      mutationToken: 'outer-workspace-mutation',
    });

    expect(result).toMatchObject({ scanned: 1, reconciled: 1, errors: [] });
    expect(observedContexts).toHaveLength(4);
    expect(observedContexts.every((ctx) => ctx.mutationToken === 'outer-workspace-mutation')).toBe(
      true
    );
  });

  it('does not start a stale mount scan after its renderer lifecycle is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      reconcileWorkspaceEntities('/ws', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does NOT CREATE a page when the catalog binding fails and no page exists (no orphan)', async () => {
    vi.mocked(resolveArtifactFile).mockRejectedValueOnce(new Error('bind failed'));
    const r = await reconcileWorkspaceEntities('/ws');
    expect(r.errors.some((e) => e.message.includes('bind'))).toBe(true);
    expect(r.reconciled).toBe(0);
    expect(pages.get('p1')).toBeUndefined();
  });

  it('still REFRESHES an EXISTING page when the bind fails (no orphan risk — 2nd-round review)', async () => {
    const meta = '/ws/notebooks/N/.forge/notebook.json';
    files.set(meta, notebookBytes('p1', 'Stale', 'old'));
    await reconcileWorkspaceEntities('/ws');
    files.set(meta, notebookBytes('p1', 'Mounted', 'from-file'));
    vi.mocked(resolveArtifactFile).mockRejectedValueOnce(new Error('bind failed'));
    await reconcileWorkspaceEntities('/ws');
    expect(pages.get('p1')?.title).toBe('Mounted');
  });

  it('refreshes a pages row from a file-only edit on mount', async () => {
    const meta = '/ws/notebooks/N/.forge/notebook.json';
    files.set(meta, notebookBytes('p1', 'Stale', 'old'));
    await reconcileWorkspaceEntities('/ws');
    files.set(meta, notebookBytes('p1', 'Mounted', 'from-file'));
    const r = await reconcileWorkspaceEntities('/ws');
    expect(r.reconciled).toBe(1);
    expect(pages.get('p1')?.title).toBe('Mounted');
  });

  it('does NOT reconcile a package under a hidden dir (.waypoint/trash) — no resurrect (codex #8)', async () => {
    dirs.set('/ws', [
      { name: 'notebooks', isDirectory: true, isFile: false },
      { name: '.waypoint', isDirectory: true, isFile: false },
    ]);
    dirs.set('/ws/.waypoint', [{ name: 'trash', isDirectory: true, isFile: false }]);
    dirs.set('/ws/.waypoint/trash', [{ name: 'Deleted-1', isDirectory: true, isFile: false }]);
    const trashMeta = '/ws/.waypoint/trash/Deleted-1/.forge/notebook.json';
    files.set(trashMeta, notebookBytes('deleted-page', 'Deleted', 'gone'));
    mtimes.set(trashMeta, 999);

    const r = await reconcileWorkspaceEntities('/ws');
    expect(r.scanned).toBe(1);
    expect(pages.has('deleted-page')).toBe(false);
  });

  it('does not descend into package internals (no double scan of the .forge dir)', async () => {
    dirs.set('/ws/notebooks/N/.forge', [
      { name: 'notebook.json', isDirectory: false, isFile: true },
    ]);
    const r = await reconcileWorkspaceEntities('/ws');
    expect(r.scanned).toBe(1);
  });

  it('treats an empty discovery result as no new evidence, never as archive intent', async () => {
    const result = await reconcileWorkspaceEntities('/ws', { candidatePaths: [] });

    expect(result).toEqual({ scanned: 0, reconciled: 0, conflicts: 0, errors: [] });
  });

  it('reports an unreadable candidate without turning absence into archive intent', async () => {
    __resetEntityAdapterRegistryForTests();
    registerEntityAdapter(limsEntityArtifactAdapter);

    const result = await reconcileWorkspaceEntities('/ws', {
      candidatePaths: ['/ws/records/strain/unreadable.entity.json'],
    });

    expect(result.errors).toHaveLength(1);
  });
});
