import { beforeEach, describe, expect, it, vi } from 'vitest';

type PageRow = {
  id: string;
  title: string;
  content: string;
  date: null;
  created_at: number;
  updated_at: number;
};
const pages = new Map<string, PageRow>();
const bases = new Map<string, string>();
const sources = new Map<string, NotebookPackageDocument>();

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
      replaceNotebookProjection: async (input: { pageId: string; sourceFingerprint: string }) => {
        const source = sources.get(input.sourceFingerprint)!;
        if (!source) throw new Error('Unknown mocked source fingerprint.');
        const previous = pages.get(input.pageId);
        pages.set(input.pageId, {
          id: input.pageId,
          title: source.title,
          content: JSON.stringify(source.content),
          date: null,
          created_at: previous?.created_at ?? 100,
          updated_at: 100,
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
          const [id, title, content, date, created_at, updated_at] = params as [
            string,
            string,
            string,
            null,
            number,
            number,
          ];
          pages.set(id, { id, title, content, date, created_at, updated_at });
        } else if (/^UPDATE pages/.test(sql)) {
          const [title, content, updated_at, id] = params as [string, string, number, string];
          const prev = pages.get(id)!;
          pages.set(id, { ...prev, title, content, updated_at });
        }
      },
    },
  }),
}));

import {
  serializeNotebookPackageDocument,
  type NotebookPackageDocument,
} from '../notebook-package';
import { reconcileEntityFile } from './adapter';
import { notebookEntityAdapter } from './notebook-adapter';
import { notebookProjectionFingerprint } from '../../shared/notebook-projection';

const ctx = { workspaceRoot: '/ws' };
function notebookFile(id: string, title: string, body: string): string {
  const doc: NotebookPackageDocument = {
    schema: 'waypoint.notebook.v1',
    kind: 'notebook',
    id,
    title,
    storage: { type: 'database', table: 'pages', id },
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }],
    },
  } as NotebookPackageDocument;
  sources.set(notebookProjectionFingerprint(doc.title, doc.content), doc);
  return serializeNotebookPackageDocument(doc);
}
const META = '/ws/notebooks/N/.forge/notebook.json';

beforeEach(() => {
  pages.clear();
  bases.clear();
  sources.clear();
});

describe('notebook entity adapter', () => {
  it('claims .forge/notebook.json and legacy .wpnote.json paths', () => {
    expect(notebookEntityAdapter.matchesPath('/ws/x/.forge/notebook.json')).toBe(true);
    expect(notebookEntityAdapter.matchesPath('/ws/old.wpnote.json')).toBe(true);
    expect(notebookEntityAdapter.matchesPath('/ws/seq.gb')).toBe(false);
  });

  it('projects a file into the pages table (created), then reads it back in-sync', async () => {
    const r1 = await reconcileEntityFile(
      notebookEntityAdapter,
      notebookFile('p1', 'Title', 'hello'),
      META,
      100,
      ctx
    );
    expect(r1.outcome).toBe('created');
    expect(pages.get('p1')?.title).toBe('Title');
    const r2 = await reconcileEntityFile(
      notebookEntityAdapter,
      notebookFile('p1', 'Title', 'hello'),
      META,
      200,
      ctx
    );
    expect(r2.outcome).toBe('in-sync');
  });

  it('refreshes a pages row after a file-only edit with a preserved timestamp', async () => {
    await reconcileEntityFile(
      notebookEntityAdapter,
      notebookFile('p1', 'Old', 'old'),
      META,
      100,
      ctx
    );
    const r = await reconcileEntityFile(
      notebookEntityAdapter,
      notebookFile('p1', 'New', 'fresh'),
      META,
      100,
      ctx
    );
    expect(r.outcome).toBe('updated-from-file');
    expect(pages.get('p1')?.title).toBe('New');
    expect(JSON.parse(pages.get('p1')!.content)).toMatchObject({
      content: [{ content: [{ text: 'fresh' }] }],
    });
  });

  it('does NOT clobber a pages row edited in-app but not yet mirrored to the file', async () => {
    pages.set('p1', {
      id: 'p1',
      title: 'In-app edit',
      content: JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsynced' }] }],
      }),
      date: null,
      created_at: 10,
      updated_at: 900,
    });
    const r = await reconcileEntityFile(
      notebookEntityAdapter,
      notebookFile('p1', 'Stale file', 'oldfile'),
      META,
      300,
      ctx
    );
    expect(r.outcome).toBe('conflict');
    expect(pages.get('p1')?.title).toBe('In-app edit');
  });

  it('detects a file-only TITLE change (fingerprint covers title, not content alone)', async () => {
    pages.set('p1', {
      id: 'p1',
      title: 'Old Title',
      content: JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'same' }] }],
      }),
      date: null,
      created_at: 10,
      updated_at: 100,
    });
    await reconcileEntityFile(
      notebookEntityAdapter,
      notebookFile('p1', 'Old Title', 'same'),
      META,
      100,
      ctx
    );
    const r = await reconcileEntityFile(
      notebookEntityAdapter,
      notebookFile('p1', 'New Title', 'same'),
      META,
      500,
      ctx
    );
    expect(r.outcome).toBe('updated-from-file');
    expect(pages.get('p1')?.title).toBe('New Title');
  });

  it('PARITY: drop the projection, rebuild from the file → identical row (rebuildable-from-files invariant)', async () => {
    const file = notebookFile('p1', 'Parity', 'content-body');
    await reconcileEntityFile(notebookEntityAdapter, file, META, 100, ctx);
    const before = pages.get('p1')!;
    pages.delete('p1');
    await reconcileEntityFile(notebookEntityAdapter, file, META, 100, ctx);
    const after = pages.get('p1')!;
    expect(after.title).toBe(before.title);
    expect(after.content).toBe(before.content);
  });
});
