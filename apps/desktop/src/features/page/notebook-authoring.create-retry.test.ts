import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { parseNotebookMarkdown, serializeNotebookMarkdown } from '../../db/notebook-markdown-codec';

const disk = vi.hoisted(() => ({
  notebook: null as null | {
    id: string;
    title: string;
    markdown: string;
    payloads: Map<string, string>;
  },
  writes: 0,
}));

vi.mock('../../platform', () => ({ platform: () => ({ fs: { readTextFile: async () => '{}' } }) }));
vi.mock('../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/workspace-catalog')>()),
  getCatalogEntityForWorkspaceRoot: async (id: string) =>
    disk.notebook?.id === id ? { type: 'notebook', status: 'active', workspace_id: 1 } : null,
  getCurrentCatalogFileForEntity: async () => ({
    file_kind: 'waypoint-notebook',
    workspace_id: 1,
    path: '/project/Native authoring acceptance',
  }),
  resolveWorkspaceScope: async () => 'owner',
}));
vi.mock('../../db/entity-references', () => ({
  getEntityReferencesByIds: async (ids: string[]) =>
    ids.map((id) => ({ id, status: 'created', workspace_root_path: '/project' })),
  createEntityReference: async () => ({ id: '0d6a1c3e-2b7f-4c1a-9e55-3f2d8b6a4c10' }),
}));
vi.mock('../../services/entity-navigation', () => ({ referenceNavigationLinks: async () => ({}) }));
vi.mock('../../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: (_root: string, run: (token: string) => unknown) =>
    run('mutation-token'),
}));
vi.mock('../../db/workspace-artifacts', () => ({
  createNotebookArtifactFile: async (input: {
    entityId: string;
    title: string;
    content: JSONContent;
  }) => {
    disk.writes += 1;
    const serialized = serializeNotebookMarkdown({
      identity: { id: input.entityId, title: input.title, formatVersion: 2 },
      content: input.content,
    });
    disk.notebook = {
      id: input.entityId,
      title: input.title,
      markdown: serialized.markdown,
      payloads: new Map(serialized.payloads.map((item) => [item.relativePath, item.content])),
    };
    return { path: '/project/Native authoring acceptance' };
  },
}));
vi.mock('../../db/entity-substrate/notebook-source-snapshot', () => ({
  readNotebookSourceSnapshot: async () => {
    const notebook = disk.notebook!;
    return {
      markdown: notebook.markdown,
      parsed: parseNotebookMarkdown({
        markdown: notebook.markdown,
        payloads: notebook.payloads,
        expected: { id: notebook.id, title: notebook.title, formatVersion: 2 },
      }),
      metadata: { provenance: [{ actor: 'agent', operationId: 'first-operation' }] },
    };
  },
}));
vi.mock('./store', () => ({
  usePageStore: { getState: () => ({ upsertPageFromArtifact: async () => true }) },
}));
vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ bumpFileTreeRefresh: () => undefined }) },
}));

import { createAuthoredNotebook } from './notebook-authoring';

const referenceId = 'e18c3ba4-9448-4589-8309-710c13a0261b';
const request = {
  workspaceRoot: '/project',
  mountedRoots: ['/project'],
  title: 'Native authoring acceptance',
  intentId: 'one-authoring-intent',
  operationId: 'first-operation',
  blocks: [
    {
      type: 'table' as const,
      header: true,
      rows: [
        [[{ text: 'Primer' }], [{ text: 'Exact bases' }]],
        [[{ text: 'primer', referenceId }], [{ text: 'CAGCTTTTGTTCCCTTTAGTGAGGGTTAATTG' }]],
      ],
    },
    {
      type: 'paragraph' as const,
      content: [{ text: 'Saved through ' }, { text: 'native', bold: true }],
    },
  ],
};

describe('create_notebook retries with the same intent', () => {
  beforeEach(() => {
    disk.notebook = null;
    disk.writes = 0;
  });

  it('returns the existing notebook for an identical retry that contains references', async () => {
    const first = await createAuthoredNotebook(request);
    const retry = await createAuthoredNotebook({ ...request, operationId: 'retry-operation' });
    expect(retry.notebookId).toBe(first.notebookId);
    expect(retry.revision).toBe(first.revision);
    expect(disk.writes).toBe(1);
  });

  it('still refuses a retry whose intent now carries different content', async () => {
    await createAuthoredNotebook(request);
    await expect(
      createAuthoredNotebook({
        ...request,
        blocks: [{ type: 'paragraph' as const, content: [{ text: 'Different content' }] }],
      })
    ).rejects.toThrow('already created different content');
    await expect(createAuthoredNotebook({ ...request, title: 'Another title' })).rejects.toThrow(
      'already created different content'
    );
    expect(disk.writes).toBe(1);
  });

  it('returns an identical historical document-table intent without rewriting its saved package', async () => {
    const first = await createAuthoredNotebook(request);
    const legacy = serializeNotebookMarkdown({
      identity: { id: first.notebookId, title: request.title, formatVersion: 2 },
      content: {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: ['Primer', 'Exact bases'].map((text) => ({
                  type: 'tableHeader',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [] }] }],
                })),
              },
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [
                      {
                        type: 'paragraph',
                        content: [
                          {
                            type: 'text',
                            text: 'primer',
                            marks: [
                              {
                                type: 'link',
                                attrs: { href: `dnaforge-chat://reference/${referenceId}` },
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  {
                    type: 'tableCell',
                    content: [
                      {
                        type: 'paragraph',
                        content: [
                          { type: 'text', text: 'CAGCTTTTGTTCCCTTTAGTGAGGGTTAATTG', marks: [] },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Saved through ', marks: [] },
              { type: 'text', text: 'native', marks: [{ type: 'bold' }] },
            ],
          },
        ],
      },
    });
    disk.notebook = {
      id: first.notebookId,
      title: request.title,
      markdown: legacy.markdown,
      payloads: new Map(legacy.payloads.map((payload) => [payload.relativePath, payload.content])),
    };
    const original = structuredClone(disk.notebook);
    const retry = await createAuthoredNotebook({ ...request, operationId: 'historical-retry' });
    expect(retry.notebookId).toBe(first.notebookId);
    expect(disk.writes).toBe(1);
    expect(disk.notebook).toEqual(original);
    expect(retry.content.content?.[0].type).toBe('table');
  });
});
