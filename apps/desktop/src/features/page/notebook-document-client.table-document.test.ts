import type { JSONContent } from '@tiptap/core';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeNotebookDocumentClient } from './notebook-document-client';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookOptions,
  type NativeNotebookSource,
} from '../../main/notebook-document-owner';
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
afterEach(() => {
  port.execute.mockReset();
  vi.restoreAllMocks();
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  const original: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'embed',
        attrs: {
          type: 'table',
          version: 1,
          refId: 'retained-block',
          data: {
            rows: 1,
            cols: 2,
            cells: [
              [
                { value: 'original', type: 'text' },
                { value: 'untouched', type: 'text' },
              ],
            ],
            opaque: { retain: ['exact'] },
          },
        },
      },
    ],
  };
  const sourceFor = (content: JSONContent): NativeNotebookSource => ({
    content: structuredClone(content),
    title: 'Table owner',
    fingerprint: contentFingerprint(canonicalNotebookJson(content)),
    metadataRaw: '{}',
    preservedPreamble: '',
    preservedTitleProjection: { kind: 'missing-heading', source: '', lineEnding: '\n' },
    sourceShape: 'v2-package',
  });
  let saved = sourceFor(original);
  let publishError: Error | undefined;
  const options: NativeNotebookOptions = {
    resolve: async () => ({
      documentId: 'notebook',
      path: '/registered/Book',
      workspaceRoot: '/registered',
      readOnly: false,
      assertCurrent() {},
    }),
    load: async () => saved,
    publish: async (_scope, _previous, content) => {
      if (publishError) throw publishError;
      saved = sourceFor(content);
      return { source: saved };
    },
    loadRecord: async () => undefined,
    storeRecord: async () => {},
    retainedDirty: async () => [],
    normalizePath: (path) => path,
    prepareInsertion: async () => {
      throw new Error('Unused insertion');
    },
    search: async () => [],
    list: async () => [],
    create: async () => {
      throw new Error('Unused creation');
    },
  };
  const owner = new NativeNotebookWorkingCopyOwner(options);
  port.execute.mockImplementation((request: NativeNotebookRequest) => owner.execute(request));
  const client = new NativeNotebookDocumentClient('notebook');
  client.observe(
    await owner.execute({ documentId: 'notebook', operation: { kind: 'inspect-copy' } })
  );
  const patch = (value: string) => ({
    cells: [
      [
        { value, type: 'text' },
        { value: 'untouched', type: 'text' },
      ],
    ],
  });
  return {
    owner,
    client,
    patch,
    saved: () => saved,
    failPublish: (error?: Error) => {
      publishError = error;
    },
  };
}

it('serializes table edits and saves through the real native owner with no mounted editor', async () => {
  const f = await fixture();
  const applied = deferred(),
    acknowledgement = deferred();
  let edits = 0;
  port.execute.mockImplementation(async (request: NativeNotebookRequest) => {
    const snapshot = await f.owner.execute(request);
    if (request.operation.kind === 'apply-steps' && ++edits === 1) {
      applied.release();
      await acknowledgement.promise;
    }
    return snapshot;
  });
  f.client.updateTable('retained-block', f.patch('first'));
  await applied.promise;
  f.client.updateTable('retained-block', f.patch('latest'));
  expect(f.client.content!.content![0].attrs!.data.cells[0][0].value).toBe('latest');
  expect(f.saved().content.content![0].attrs!.data.cells[0][0].value).toBe('original');
  acknowledgement.release();
  await f.client.flush();
  expect(edits).toBe(2);
  expect(await f.client.save()).toBe(true);
  expect(f.saved().content.content![0].attrs!.data.cells[0][0].value).toBe('latest');
  expect(f.saved().content.content![0].attrs!.data.opaque).toEqual({ retain: ['exact'] });
  expect(f.client.dirty).toBe(false);
});

it('keeps a denied table Save retryable with its draft and previous saved content', async () => {
  const f = await fixture();
  f.client.updateTable('retained-block', f.patch('retained-draft'));
  await f.client.flush();
  f.failPublish(Object.assign(new Error('EPERM: real cause retained'), { code: 'EPERM' }));
  expect(await f.client.save()).toBe(false);
  expect(f.client.dirty).toBe(true);
  expect(f.client.content!.content![0].attrs!.data.cells[0][0].value).toBe('retained-draft');
  expect(f.saved().content.content![0].attrs!.data.cells[0][0].value).toBe('original');
  f.failPublish();
  expect(await f.client.save()).toBe(true);
  expect(f.saved().content.content![0].attrs!.data.cells[0][0].value).toBe('retained-draft');
});

it('publishes same-revision saving and access changes to table subscribers', async () => {
  const f = await fixture();
  const snapshot = f.client.snapshot!;
  const initial = f.client.viewRevision;
  f.client.observe({ ...snapshot, saving: true });
  const saving = f.client.viewRevision;
  expect(saving).not.toBe(initial);
  f.client.observe({ ...snapshot, readOnly: true });
  expect(f.client.viewRevision).not.toBe(saving);
  expect(() => f.client.updateTable('retained-block', f.patch('refused'))).toThrow();
  expect(f.client.content).toEqual(snapshot.copy.content);
});

it('dispatches a table edit and notifies remaining views when one subscriber throws', async () => {
  const f = await fixture();
  const failure = new Error('Subscriber failed');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let observed = 0;
  f.client.subscribe(() => {
    throw failure;
  });
  f.client.subscribe(() => {
    observed++;
  });
  expect(() => f.client.updateTable('retained-block', f.patch('not-stranded'))).not.toThrow();
  await f.client.flush();
  expect(f.client.snapshot!.copy.content.content![0].attrs!.data.cells[0][0].value).toBe(
    'not-stranded'
  );
  expect(observed).toBeGreaterThan(0);
  expect(errors.mock.calls.some((call) => call.includes(failure))).toBe(true);
  expect(await f.client.save()).toBe(true);
  expect(f.client.dirty).toBe(false);
});

it('retains native dispatch and Save when a failed subscriber and logging sink both throw', async () => {
  const f = await fixture();
  vi.spyOn(console, 'error').mockImplementation(() => {
    throw new Error('Logging sink failed');
  });
  f.client.subscribe(() => {
    throw new Error('Subscriber failed');
  });
  expect(() => f.client.updateTable('retained-block', f.patch('still-dispatched'))).not.toThrow();
  await f.client.flush();
  expect(await f.client.save()).toBe(true);
  expect(f.saved().content.content![0].attrs!.data.cells[0][0].value).toBe('still-dispatched');
});
