import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotebookEditorControl } from '../../page/public/notebook-editor-control';
import { MentionExtension } from '../../page/public/editor/extensions';
import { execTool } from './test-helpers';
import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  resolveOwner: vi.fn(),
  rename: vi.fn(),
  getReference: vi.fn(),
}));

vi.mock('../../page/public/store', () => ({
  usePageStore: { getState: mocks.getState },
}));

vi.mock('../../page/public/resolve-owning-root-for-page', () => ({
  resolveOwningRootForPage: mocks.resolveOwner,
}));
vi.mock('../../../db/entity-references', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/entity-references')>()),
  getEntityReference: mocks.getReference,
}));

import {
  createNotebookDocumentTool as uncheckedNotebookDocumentTool,
  notebookDocumentOutputSchema,
  notebookDocumentSchema,
} from './notebook-document';

const createNotebookDocumentTool = checkedToolFactory(
  uncheckedNotebookDocumentTool,
  notebookDocumentOutputSchema
);
describe('one native notebook insertion interface', () => {
  it.each([
    { kind: 'entity', type: 'sequence', entityId: 'native-sequence' },
    { kind: 'entity', type: 'page', entityId: 'native-page' },
    { kind: 'entity', type: 'primer', entityId: 'native-primer' },
    { kind: 'file', path: '/project/figure.png', expectedRevision: 'source-revision' },
    { kind: 'file', path: '/project/structure.pdb', expectedRevision: 'source-revision' },
    { kind: 'table', rows: 3, columns: 2 },
  ])('accepts a typed $kind source through insert', (source) => {
    expect(
      notebookDocumentSchema.safeParse({
        pageId: 'notebook',
        expectedRevision: 'draft',
        operation: { kind: 'insert', index: 1, source },
      }).success
    ).toBe(true);
  });

  it('refuses forged entity labels and uninspected source files', () => {
    for (const source of [
      { kind: 'entity', type: 'sequence', entityId: 'native-sequence', label: 'Forged label' },
      { kind: 'file', path: '/project/figure.png' },
    ]) {
      expect(
        notebookDocumentSchema.safeParse({
          pageId: 'notebook',
          expectedRevision: 'draft',
          operation: { kind: 'insert', index: 1, source },
        }).success
      ).toBe(false);
    }
  });
});

describe('native notebook save confirmation', () => {
  const pageId = 'ws1::11111111-1111-4111-8111-111111111111';
  const root = '/workspace/native-notebook';
  const content = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Human observations' }] }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const page = { id: pageId, title: 'Native notebook', content };
    mocks.getState.mockReturnValue({
      pages: { [pageId]: page },
      fetchPage: async () => page,
      dirtyIds: new Set<string>(),
      renamePageArtifact: mocks.rename,
    });
    mocks.resolveOwner.mockResolvedValue(root);
  });

  it.each(['save', 'rename'] as const)(
    'refuses %s when the native editor does not confirm its save',
    async (kind) => {
      const editor = new Editor({ extensions: [StarterKit], content });
      const save = vi.fn(async () => false);
      const unregister = registerNotebookEditorControl(pageId, { editor, save });
      try {
        const tool = createNotebookDocumentTool([
          { path: root, name: 'Native notebook', addedAt: 1 },
        ]);
        const inspection = await execTool<{ revision: string }>(tool, {
          pageId,
          operation: { kind: 'inspect', offset: 0, limit: 20 },
        });
        const operation = kind === 'rename' ? { kind, title: 'Renamed notebook' } : { kind };
        const result = await execTool<unknown>(tool, {
          pageId,
          expectedRevision: inspection.revision,
          operation,
        });
        expect(result).toMatchObject({
          ok: false,
          code: 'NOTEBOOK_SAVE_FAILED',
          stateChanged: 'unknown',
        });
        expect(save).toHaveBeenCalledOnce();
        expect(mocks.rename).not.toHaveBeenCalled();
      } finally {
        unregister();
        editor.destroy();
      }
    }
  );

  it.each(['insert-reference', 'splice-blocks'] as const)(
    '%s inserts a native saved-result chip without agent-authored chip formatting',
    async (kind) => {
      const referenceId = 'e8a02a98-2484-4080-9c6b-04ade0763803';
      const label = 'Read-derived allele fraction';
      const referenceUri = `dnaforge-chat://reference/${referenceId}`;
      mocks.getReference.mockResolvedValue({
        id: referenceId,
        display_label: label,
        entity_type: 'structure',
      });
      const editor = new Editor({ extensions: [StarterKit, MentionExtension], content });
      const unregister = registerNotebookEditorControl(pageId, { editor, save: async () => true });
      try {
        const tool = createNotebookDocumentTool([
          { path: root, name: 'Native notebook', addedAt: 1 },
        ]);
        const inspection = await execTool<{ revision: string }>(tool, {
          pageId,
          operation: { kind: 'inspect', offset: 0, limit: 20 },
        });
        const operation =
          kind === 'insert-reference'
            ? { kind, index: 1, referenceId }
            : {
                kind,
                index: 1,
                deleteCount: 0,
                blocks: [
                  {
                    type: 'paragraph',
                    content: [
                      {
                        type: 'text',
                        text: label,
                        marks: [{ type: 'link', attrs: { href: referenceUri } }],
                      },
                    ],
                  },
                ],
              };
        const result = await execTool<{ changed: boolean }>(tool, {
          pageId,
          expectedRevision: inspection.revision,
          operation,
        });
        expect(result).toMatchObject({ changed: true });
        expect(editor.getJSON().content?.[1].content?.[0]).toMatchObject({
          type: 'mention',
          attrs: { label, referenceUri },
        });
        expect(editor.getHTML()).not.toContain('<a ');
        expect(editor.commands.undo()).toBe(true);
        expect(editor.getJSON().content).toHaveLength(1);
      } finally {
        unregister();
        editor.destroy();
      }
    }
  );

  it('refuses a missing saved result before changing the notebook', async () => {
    mocks.getReference.mockResolvedValue(null);
    const editor = new Editor({ extensions: [StarterKit, MentionExtension], content });
    const unregister = registerNotebookEditorControl(pageId, { editor, save: async () => true });
    try {
      const tool = createNotebookDocumentTool([
        { path: root, name: 'Native notebook', addedAt: 1 },
      ]);
      const inspection = await execTool<{ revision: string }>(tool, {
        pageId,
        operation: { kind: 'inspect', offset: 0, limit: 20 },
      });
      const before = editor.getJSON();
      const result = await execTool(tool, {
        pageId,
        expectedRevision: inspection.revision,
        operation: {
          kind: 'insert-reference',
          index: 1,
          referenceId: 'e8a02a98-2484-4080-9c6b-04ade0763803',
        },
      });
      expect(result).toMatchObject({ ok: false, code: 'REFERENCE_NOT_FOUND', stateChanged: false });
      expect(editor.getJSON()).toEqual(before);
    } finally {
      unregister();
      editor.destroy();
    }
  });
});
