import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeNotebookDocumentClient } from './notebook-document-client';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookOptions,
  type NativeNotebookSource,
} from '../../main/notebook-document-owner';
import { NotebookDocumentModel } from '../../shared/notebook-model/document';
import { getNotebookBaseExtensions } from '../../shared/notebook-model/extensions/notebook-model-extensions';
import { NotebookMentionNode } from '../../shared/notebook-model/extensions/notebook-mention-model';
import { NotebookEmbedNode } from '../../shared/notebook-model/extensions/notebook-embed-model';
import { canonicalNotebookJson } from '../../db/notebook-markdown-codec';
import { contentFingerprint } from '../../shared/content-fingerprint';
import type { NativeNotebookRequest } from '../../shared/notebook-document';

const port = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../platform', () => ({ platform: () => ({ notebook: { execute: port.execute } }) }));
vi.mock('../workspace/public/file-document-client', () => ({
  registerNativeDocumentClientFlush() {},
  waitForNativeFileDocumentReadiness: async () => {},
}));
vi.mock('../../shared/unsaved-draft-recovery', () => ({
  readAllUnsavedDrafts: async () => [],
  deleteUnsavedDraft: async () => {},
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addRichToast() {} }) },
}));
vi.mock('./store', () => ({ usePageStore: { getState: () => ({ pages: {} }) } }));

afterEach(() => port.execute.mockReset());

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const legacyUri =
  'dnaforge-chat://workspace/Pownall%20Figure%204N%20%E2%80%94%20Evo2%20regulatory%20pilot/analyses/evo2-klf17/selection.json';
const target = {
  kind: 'path',
  projectId: '6a06aec1-382d-4a2f-8d2f-d08c98850cb6',
  path: 'analyses/evo2-klf17/selection.json',
  resourceKind: 'file',
};

async function fixture() {
  const content = new NotebookDocumentModel(
    {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: { entityType: 'reference', referenceUri: legacyUri, label: 'Pilot evidence' },
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Retained source.' }] },
      ],
    },
    'Notebook'
  ).content;
  const makeSource = (value: JSONContent): NativeNotebookSource => ({
    content: structuredClone(value),
    title: 'Notebook',
    fingerprint: contentFingerprint(canonicalNotebookJson(value)),
    metadataRaw: '{}',
    preservedPreamble: '',
    preservedTitleProjection: { kind: 'missing-heading', source: '', lineEnding: '\n' },
    sourceShape: 'v2-package',
  });
  let source = makeSource(content),
    published = 0;
  const canonical = (node: JSONContent): JSONContent =>
    node.type === 'mention' && node.attrs?.referenceUri === legacyUri
      ? {
          ...node,
          attrs: {
            ...node.attrs,
            entityType: 'project-resource',
            referenceUri: null,
            resourceReference: target,
          },
        }
      : node.content
        ? { ...node, content: node.content.map(canonical) }
        : node;
  const options: NativeNotebookOptions = {
    resolve: async () => ({
      documentId: 'notebook',
      path: '/registered/Notebook',
      workspaceRoot: '/registered',
      readOnly: false,
      assertCurrent() {},
    }),
    load: async () => source,
    publish: async (_scope, _source, value) => {
      published++;
      source = makeSource(value);
      return { source };
    },
    prepareResourceReferences: async (_scope, value) => ({
      content: canonical(value),
      verify: async () => {},
    }),
    loadRecord: async () => undefined,
    storeRecord: async () => {},
    retainedDirty: async () => [],
    normalizePath: (path) => path,
    prepareInsertion: async () => {
      throw new Error('Unused source insertion.');
    },
    search: async () => [],
    list: async () => [],
    create: async () => {
      throw new Error('Unused notebook creation.');
    },
  };
  const owner = new NativeNotebookWorkingCopyOwner(options);
  const client = new NativeNotebookDocumentClient('notebook');
  const applied = deferred(),
    acknowledgment = deferred();
  let calls = 0;
  port.execute.mockImplementation(async (request: NativeNotebookRequest) => {
    const result = await owner.execute(request);
    if (request.operation.kind === 'apply-steps' && ++calls === 1) {
      applied.release();
      await acknowledgment.promise;
    }
    return result;
  });
  client.observe(
    await owner.execute({ documentId: 'notebook', operation: { kind: 'inspect-copy' } })
  );
  const editor = new Editor({
    extensions: [...getNotebookBaseExtensions(), NotebookMentionNode, NotebookEmbedNode],
    content: client.snapshot!.copy.content,
    onUpdate: ({ transaction, editor }) => client.capture(transaction, editor.getJSON()),
  });
  const detach = client.attach(editor);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.insertContent(' one');
  await applied.promise;
  editor.commands.insertContent(' two');
  editor.commands.insertContent(' three');
  return {
    owner,
    client,
    editor,
    applied,
    acknowledgment,
    detach,
    persisted: () => source.content,
    published: () => published,
    calls: () => calls,
  };
}

it('queued editor input survives native reference canonicalization while an acknowledgment is held', async () => {
  const f = await fixture();
  try {
    const selection = f.editor.state.selection.toJSON();
    expect(f.editor.getText()).toContain('Retained source. one two three');
    expect(f.client.hasPending).toBe(true);
    f.acknowledgment.release();
    await f.client.flush();
    expect(f.client.error).toBeNull();
    expect(f.calls()).toBe(3);
    expect(f.editor.getText()).toContain('Retained source. one two three');
    expect(f.editor.state.selection.toJSON()).toEqual(selection);
    const current = await f.owner.execute({
      documentId: 'notebook',
      operation: { kind: 'inspect-copy' },
    });
    expect(f.editor.getJSON()).toEqual(current.copy.content);
    expect(current.copy.content.content?.[0].content?.[0].attrs).toMatchObject({
      entityType: 'project-resource',
      resourceReference: target,
    });
    const saved = await f.client.command({ kind: 'save' });
    expect(saved.dirty).toBe(false);
    expect(f.persisted()).toEqual(f.editor.getJSON());
    expect(f.published()).toBe(1);
    const savedContent = structuredClone(saved.copy.content);
    const undone = await f.client.command({ kind: 'undo' });
    expect(undone.copy.content).not.toEqual(savedContent);
    expect(undone.canRedo).toBe(true);
    expect(f.editor.getJSON()).toEqual(undone.copy.content);
    const redone = await f.client.command({ kind: 'redo' });
    expect(redone.copy.content).toEqual(savedContent);
    expect(f.editor.getJSON()).toEqual(savedContent);
  } finally {
    f.acknowledgment.release();
    f.detach();
    f.editor.destroy();
    await f.owner.close();
  }
});

it('external native text changes refuse queued rebasing and retain unsent local input', async () => {
  const f = await fixture();
  try {
    const local = structuredClone(f.editor.getJSON());
    const before = await f.owner.execute({
      documentId: 'notebook',
      operation: { kind: 'inspect-copy' },
    });
    const model = new NotebookDocumentModel(before.copy.content, before.title);
    const transaction = model.state.tr.insertText(' EXTERNAL', model.state.doc.content.size - 1);
    const external = await f.owner.execute({
      documentId: 'notebook',
      expectedRevision: before.revision,
      operation: {
        kind: 'apply-steps',
        steps: transaction.steps.map((step) => step.toJSON()),
        baseFingerprint: contentFingerprint(canonicalNotebookJson(transaction.before.toJSON())),
      },
    });
    f.client.observe(external);
    f.acknowledgment.release();
    await expect(f.client.flush()).rejects.toThrow();
    expect(f.client.error).not.toBeNull();
    expect(f.editor.getJSON()).toEqual(local);
    const retained = await f.owner.execute({
      documentId: 'notebook',
      operation: { kind: 'inspect-copy' },
    });
    expect(retained.copy.content).toEqual(external.copy.content);
    expect(f.published()).toBe(0);
  } finally {
    f.acknowledgment.release();
    f.detach();
    f.editor.destroy();
    await f.owner.close();
  }
});
