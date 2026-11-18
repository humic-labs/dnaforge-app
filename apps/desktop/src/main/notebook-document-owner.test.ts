import { workTaskReferenceHref, containsWorkTaskPlacement } from '../shared/work-task-reference';
// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookOptions,
  type NativeNotebookRecord,
  type NativeNotebookSource,
} from './notebook-document-owner';
import { publishNotebookPackageV2InMain } from './notebook-package-authority';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { notebookPackagePaths } from '../db/notebook-package';
import { contentFingerprint } from '../shared/content-fingerprint';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import { NotebookDocumentModel } from '../shared/notebook-model/document';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import { NativeNotebookDocumentClient } from '../features/page/notebook-document-client';

const notebookPort = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({ notebook: { execute: notebookPort.execute } }),
}));
vi.mock('../features/workspace/public/file-document-client', () => ({
  registerNativeDocumentClientFlush() {},
  waitForNativeFileDocumentReadiness: async () => {},
}));
vi.mock('../features/page/store', () => ({
  usePageStore: { getState: () => ({ pages: {} }) },
}));
vi.mock('../stores/toast-store', () => ({
  useToastStore: { getState: () => ({ addRichToast() {} }) },
}));
vi.mock('../shared/unsaved-draft-recovery', () => ({
  readAllUnsavedDrafts: async () => [],
  deleteUnsavedDraft: async () => {},
}));

const directories: string[] = [];
afterEach(async () => {
  notebookPort.execute.mockReset();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture(pausePublish?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'native-notebook-'));
  directories.push(root);
  const path = join(root, 'Book'),
    recordPath = join(root, 'recovery.json');
  const content: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Original', marks: [{ type: 'bold' }] }],
      },
      { type: 'rawMarkdown', attrs: { source: ':::future\nkeep exact\n:::' } },
      {
        type: 'embed',
        attrs: {
          type: 'future-widget',
          version: 7,
          refId: 'future',
          data: { nested: [1, { keep: 'exact' }] },
        },
      },
    ],
  };
  await publishNotebookPackageV2InMain({
    workspaceRoot: root,
    packageRoot: path,
    id: 'book',
    title: 'Book',
    content,
    sourceShape: 'new-package',
  });
  let enrolled = true,
    writable = true,
    publishes = 0;
  const scope = () => ({
    documentId: 'book',
    path,
    workspaceRoot: root,
    readOnly: !writable,
    assertCurrent() {
      if (!enrolled)
        throw new NativeDocumentCommandError(
          'WORKSPACE_CHANGED',
          'The project enrollment changed.',
          false
        );
    },
  });
  const ops = {
    readTextFile: (path: string) => readFile(path, 'utf8'),
    exists: async (path: string) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
  const load = async (): Promise<NativeNotebookSource> => {
    const current = await readCanonicalNotebookPackage(ops, path);
    return {
      content: new NotebookDocumentModel(current.parsed.content, current.parsed.title).content,
      title: current.parsed.title,
      fingerprint: contentFingerprint(current.markdown),
      metadataRaw: JSON.stringify(current.metadata),
      preservedPreamble: current.parsed.preservedPreamble,
      preservedTitleProjection: current.parsed.preservedTitleProjection,
      sourceShape: 'v2-package',
    };
  };
  const options: NativeNotebookOptions = {
    resolve: async () => scope(),
    load,
    async publish(current, source, content, title) {
      await pausePublish?.();
      current.assertCurrent();
      const fresh = await load();
      if (fresh.fingerprint !== source.fingerprint)
        throw new NativeDocumentCommandError(
          'NOTEBOOK_EXTERNAL_CONFLICT',
          'The package changed on disk.',
          false
        );
      publishes++;
      await publishNotebookPackageV2InMain(
        {
          workspaceRoot: root,
          packageRoot: path,
          id: 'book',
          title,
          content,
          sourceShape: 'v2-package',
          existingMetadataRaw: fresh.metadataRaw,
          expectedCanonicalFingerprint: source.fingerprint,
          preservedPreamble: fresh.preservedPreamble,
          preservedTitleProjection: fresh.preservedTitleProjection,
        },
        current.assertCurrent
      );
      return { source: await load() };
    },
    async loadRecord() {
      try {
        return JSON.parse(await readFile(recordPath, 'utf8')) as NativeNotebookRecord;
      } catch {
        return undefined;
      }
    },
    async storeRecord(record) {
      await writeFile(recordPath, JSON.stringify(record));
    },
    async retainedDirty() {
      try {
        const record = JSON.parse(await readFile(recordPath, 'utf8')) as NativeNotebookRecord;
        return record.dirty ? [{ documentId: 'book', path }] : [];
      } catch {
        return [];
      }
    },
    normalizePath: (path) => path,
    prepareInsertion: async () => {
      throw new Error('unused');
    },
    search: async () => [],
    list: async () => [],
    create: async () => {
      throw new Error('unused');
    },
  };
  return {
    root,
    path,
    recordPath,
    options,
    load,
    owner: new NativeNotebookWorkingCopyOwner(options),
    ops,
    get publishes() {
      return publishes;
    },
    setEnrolled(value: boolean) {
      enrolled = value;
    },
    setWritable(value: boolean) {
      writable = value;
    },
  };
}
describe('native notebook working copy', () => {
  it('retains placement receipts through published Markdown, undo and native owner restart', async () => {
    const f = await fixture();
    const owner = new NativeNotebookWorkingCopyOwner({
      ...f.options,
      prepareReferenceInsertion: async (_scope, op) => ({
        block: {
          type: 'paragraph',
          content: [
            {
              type: 'mention',
              attrs: {
                entityType: 'reference',
                referenceUri: workTaskReferenceHref(op.workTask!),
                label: 'Check certificate',
              },
            },
          ],
        },
        verify: async () => {},
      }),
    });
    const initial = await owner.execute({
      documentId: 'book',
      operation: { kind: 'inspect-copy' },
    });
    const insert = {
      documentId: 'book',
      requestId: 'one',
      expectedRevision: initial.revision,
      operation: {
        kind: 'insert-reference' as const,
        index: 1,
        workTask: {
          projectId: 'science',
          taskId: 'certificate',
          placementId: 'fb79a995-2683-4647-ae35-f25cc3ef54d9',
        },
      },
    };
    const placed = await owner.execute(insert);
    expect(placed.result).toMatchObject({ changed: true, disposition: 'draft' });
    const saved = await owner.execute({
      documentId: 'book',
      expectedRevision: placed.revision,
      operation: { kind: 'save' },
    });
    const href = workTaskReferenceHref(insert.operation.workTask);
    expect(containsWorkTaskPlacement((await f.load()).content, href)).toBe(true);
    expect((await owner.execute(insert)).result).toMatchObject({
      changed: false,
      disposition: 'published',
    });
    const undone = await owner.execute({
      documentId: 'book',
      expectedRevision: saved.revision,
      operation: { kind: 'undo' },
    });
    expect(containsWorkTaskPlacement(undone.copy.content, href)).toBe(false);
    await owner.execute({
      documentId: 'book',
      expectedRevision: undone.revision,
      operation: { kind: 'save' },
    });
    const restarted = new NativeNotebookWorkingCopyOwner({
      ...f.options,
      prepareReferenceInsertion: async () => ({
        block: { type: 'paragraph' },
        verify: async () => {},
      }),
    });
    const replay = await restarted.execute(insert);
    expect(replay.result).toMatchObject({ changed: false, disposition: 'removed' });
    expect(containsWorkTaskPlacement((await f.load()).content, href)).toBe(false);
  });
  it('acknowledges an owned legacy cutover and reads the newer dirty copy across it', async () => {
    const f = await fixture();
    const releaseCutover = Promise.withResolvers<void>();
    const moved = Promise.withResolvers<void>();
    const releasePublish = Promise.withResolvers<void>();
    const receiptEntered = Promise.withResolvers<void>();
    const inspectionEntered = Promise.withResolvers<void>();
    const resolve = f.options.resolve;
    const publish = f.options.publish;
    let currentPath = f.path;
    let watchReads = false;
    f.options.load = async () => ({ ...(await f.load()), sourceShape: 'legacy-wpnote' });
    f.options.resolve = async (id, mutating) => {
      const original = await resolve(id, mutating);
      const path = currentPath;
      if (watchReads && !mutating) {
        if (path === f.path) receiptEntered.resolve();
        else inspectionEntered.resolve();
      }
      return {
        ...original,
        path,
        assertCurrent() {
          original.assertCurrent();
          if (path !== currentPath)
            throw new NativeDocumentCommandError(
              'NOTEBOOK_BINDING_CHANGED',
              'Notebook moved',
              false
            );
        },
      };
    };
    f.options.publish = async (scope, source, content, title) => {
      const saved = await publish(scope, source, content, title);
      await releaseCutover.promise;
      currentPath = join(f.root, 'Migrated Book');
      moved.resolve();
      await releasePublish.promise;
      return { ...saved, scope: await f.options.resolve('book', true) };
    };
    const execute = (
      operation: Parameters<typeof f.owner.execute>[0]['operation'],
      expectedRevision?: string
    ) => f.owner.execute({ documentId: 'book', operation, expectedRevision });
    const edit = (text: string, revision: string) =>
      execute(
        {
          kind: 'splice-blocks',
          index: 0,
          deleteCount: 1,
          blocks: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        },
        revision
      );
    const opened = await execute({ kind: 'inspect-copy' });
    const older = await edit('Captured edit', opened.revision);
    const capture = await execute({ kind: 'capture-save' }, older.revision);
    const newer = await edit('Newer edit', capture.revision);
    watchReads = true;
    const receipt = Promise.allSettled([
      execute({ kind: 'await-save', saveCaptureId: capture.saveCaptureId! }),
    ]);
    let inspection: Promise<PromiseSettledResult<Awaited<ReturnType<typeof execute>>>[]>;
    try {
      await receiptEntered.promise;
      releaseCutover.resolve();
      await moved.promise;
      inspection = Promise.allSettled([execute({ kind: 'inspect-copy' })]);
      await inspectionEntered.promise;
    } finally {
      releaseCutover.resolve();
      releasePublish.resolve();
    }
    for (const [result] of [await receipt, await inspection!]) {
      expect(result).toMatchObject({
        status: 'fulfilled',
        value: { revision: newer.revision, persistedRevision: capture.revision, dirty: true },
      });
    }
    expect((await f.load()).content.content?.[0].content?.[0].text).toBe('Captured edit');
    currentPath = join(f.root, 'Unexpected external path');
    await expect(execute({ kind: 'inspect-copy' })).rejects.toMatchObject({
      code: 'NOTEBOOK_BINDING_CHANGED',
    });
    await f.owner.close();
  });

  it('retains newer client typing before a held save finishes and keeps its shared close receipt dirty through restart', async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const f = await fixture(async () => {
      entered();
      await gate;
    });
    notebookPort.execute.mockImplementation(async (request) =>
      structuredClone(await f.owner.execute(request))
    );
    const client = new NativeNotebookDocumentClient('book'),
      unsubscribe = f.owner.subscribe((snapshot) => client.observe(structuredClone(snapshot)));
    await client.initialize();
    const a = new NotebookDocumentModel(client.snapshot!.copy.content, client.snapshot!.title);
    client.capture(a.state.tr.insertText('A', 1));
    await client.flush();
    const aRevision = client.snapshot!.revision,
      first = client.save(),
      duplicate = client.save();
    await started;
    const b = new NotebookDocumentModel(client.snapshot!.copy.content, client.snapshot!.title);
    client.capture(b.state.tr.insertText('B', 2));
    let retainedBeforeRelease = false,
      beforeRelease: NativeNotebookRecord;
    try {
      retainedBeforeRelease = await Promise.race([
        client.flush().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      beforeRelease = JSON.parse(await readFile(f.recordPath, 'utf8'));
    } finally {
      release();
    }
    const receipts = await Promise.all([first, duplicate]);
    await client.flush();
    expect(retainedBeforeRelease).toBe(true);
    expect(beforeRelease!.content.content?.[0].content?.[0].text).toBe('ABOriginal');
    expect(receipts).toEqual([false, false]);
    expect(f.publishes).toBe(1);
    expect((await f.load()).content.content?.[0].content?.[0].text).toBe('AOriginal');
    expect(client.snapshot).toMatchObject({
      dirty: true,
      saving: false,
      persistedRevision: aRevision,
    });
    unsubscribe();
    await f.owner.close();
    const restarted = new NativeNotebookWorkingCopyOwner(f.options),
      next = new NativeNotebookDocumentClient('book');
    notebookPort.execute.mockImplementation(async (request) =>
      structuredClone(await restarted.execute(request))
    );
    const stop = restarted.subscribe((snapshot) => next.observe(structuredClone(snapshot)));
    await next.initialize();
    expect(next.snapshot?.recovery?.baselineMismatch).toBe(false);
    expect(next.snapshot?.recovery?.content.content?.[0].content?.[0].text).toBe('ABOriginal');
    await next.command({ kind: 'restore-recovery' });
    expect(await next.save()).toBe(true);
    expect((await f.load()).content.content?.[0].content?.[0].text).toBe('ABOriginal');
    expect(f.publishes).toBe(2);
    stop();
    await restarted.close();
  });
  it('edits a closed rich package, keeps shared undo, saves canonical bytes and reopens the same rich nodes', async () => {
    const f = await fixture();
    let state = await f.owner.execute({ documentId: 'book', operation: { kind: 'inspect-copy' } });
    expect(state.dirty).toBe(false);
    const original = state.copy.content;
    state = await f.owner.execute({
      documentId: 'book',
      expectedRevision: state.revision,
      operation: { kind: 'insert-table', index: 1, rows: 2, columns: 2 },
    });
    const tableId = (state.result as { tableId: string }).tableId;
    expect(tableId).toBeTruthy();
    state = await f.owner.execute({
      documentId: 'book',
      expectedRevision: state.revision,
      operation: {
        kind: 'table',
        tableId,
        command: { kind: 'set-cell', row: 0, column: 0, value: '=2+3' },
      },
    });
    state = await f.owner.execute({
      documentId: 'book',
      expectedRevision: state.revision,
      operation: { kind: 'undo' },
    });
    expect(state.copy.content.content?.[1].attrs?.data.cells ?? []).toEqual([]);
    state = await f.owner.execute({
      documentId: 'book',
      expectedRevision: state.revision,
      operation: { kind: 'redo' },
    });
    const saved = await f.owner.execute({
      documentId: 'book',
      expectedRevision: state.revision,
      operation: { kind: 'save' },
    });
    expect(saved).toMatchObject({ dirty: false, saving: false });
    expect(f.publishes).toBe(1);
    const disk = await f.load();
    expect(disk.content.content?.[1].attrs?.data.cells[0][0]).toMatchObject({
      value: '=2+3',
      type: 'formula',
    });
    expect(disk.content.content?.slice(2)).toEqual(original.content?.slice(1));
    await f.owner.execute({
      documentId: 'book',
      expectedRevision: saved.revision,
      operation: { kind: 'save' },
    });
    expect(f.publishes).toBe(1);
    await f.owner.close();
    const reopened = await new NativeNotebookWorkingCopyOwner(f.options).execute({
      documentId: 'book',
      operation: { kind: 'inspect-copy' },
    });
    expect(reopened.copy.content).toEqual(disk.content);
    expect(reopened.dirty).toBe(false);
  });
  it('rejects stale revisions and outside edits without overwriting either version', async () => {
    const f = await fixture();
    const initial = await f.owner.execute({
      documentId: 'book',
      operation: { kind: 'inspect-copy' },
    });
    const changed = await f.owner.execute({
      documentId: 'book',
      expectedRevision: initial.revision,
      operation: {
        kind: 'splice-blocks',
        index: 0,
        deleteCount: 1,
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Draft' }] }],
      },
    });
    await expect(
      f.owner.execute({
        documentId: 'book',
        expectedRevision: initial.revision,
        operation: { kind: 'undo' },
      })
    ).rejects.toMatchObject({ stateChanged: false, code: 'STALE_NOTEBOOK' });
    const markdown = notebookPackagePaths(f.path).markdownPath;
    const external = (await readFile(markdown, 'utf8')).replace('Original', 'Outside');
    await writeFile(markdown, external);
    await expect(
      f.owner.execute({
        documentId: 'book',
        expectedRevision: changed.revision,
        operation: { kind: 'save' },
      })
    ).rejects.toMatchObject({ stateChanged: false, code: 'NOTEBOOK_EXTERNAL_CONFLICT' });
    expect(await readFile(markdown, 'utf8')).toBe(external);
    expect(
      (await f.owner.execute({ documentId: 'book', operation: { kind: 'inspect-copy' } })).copy
        .content.content?.[0].content?.[0].text
    ).toBe('Draft');
  });
  it('waits for native notebook initialization before an external refresh inspects its copy', async () => {
    const f = await fixture();
    notebookPort.execute.mockImplementation(async (request) =>
      structuredClone(await f.owner.execute(request))
    );
    let release!: () => void;
    const beforeLoad = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new NativeNotebookDocumentClient('book');
    const loading = client.initialize(beforeLoad);
    const refresh = client.command({ kind: 'inspect-copy' });
    const result = refresh.then(
      (snapshot) => ({ snapshot, error: null }),
      (error: unknown) => ({ snapshot: null, error })
    );
    await Promise.resolve();
    expect(notebookPort.execute).not.toHaveBeenCalled();
    release();
    await loading;
    expect(await result).toMatchObject({
      snapshot: { documentId: 'book', dirty: false, readOnly: false },
      error: null,
    });
    expect(client.error).toBeNull();
  });

  it('keeps local edits against the exact observed external source before an immediate client save', async () => {
    const f = await fixture();
    notebookPort.execute.mockImplementation(async (request) =>
      structuredClone(await f.owner.execute(request))
    );
    const client = new NativeNotebookDocumentClient('book');
    await client.initialize();
    const changed = await client.command({
      kind: 'splice-blocks',
      index: 0,
      deleteCount: 1,
      blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Local draft' }] }],
    });
    const markdown = notebookPackagePaths(f.path).markdownPath;
    const external = (await readFile(markdown, 'utf8')).replace('Original', 'Outside');
    await writeFile(markdown, external);
    expect(await client.save()).toBe(false);
    expect(await readFile(markdown, 'utf8')).toBe(external);
    const newer = external.replace('Outside', 'Newer outside');
    await writeFile(markdown, newer);
    f.setWritable(false);
    await expect(
      f.owner.executePublic({
        pageId: 'book',
        expectedRevision: client.snapshot!.revision,
        operation: { kind: 'keep-local', expectedCanonicalFingerprint: contentFingerprint(newer) },
      })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_READ_ONLY', stateChanged: false });
    f.setWritable(true);
    await expect(
      f.owner.executePublic({
        pageId: 'book',
        expectedRevision: client.snapshot!.revision,
        operation: {
          kind: 'keep-local',
          expectedCanonicalFingerprint: contentFingerprint(external),
        },
      })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXTERNAL_CONFLICT', stateChanged: false });
    expect(client.snapshot!.copy.content).toEqual(changed.copy.content);
    expect(await readFile(markdown, 'utf8')).toBe(newer);
    const adopting = client.command({
      kind: 'keep-local',
      expectedCanonicalFingerprint: contentFingerprint(newer),
    });
    const saving = client.save();
    const adopted = await adopting;
    expect(adopted.copy.content).toEqual(changed.copy.content);
    expect(adopted.dirty).toBe(true);
    expect(adopted.canUndo).toBe(true);
    expect(await saving).toBe(true);
    expect(await readFile(markdown, 'utf8')).toContain('Local draft');
    expect(await readFile(markdown, 'utf8')).not.toContain('Newer outside');
    const restarted = await new NativeNotebookWorkingCopyOwner(f.options).execute({
      documentId: 'book',
      operation: { kind: 'inspect-copy' },
    });
    expect(restarted.copy.content).toEqual(changed.copy.content);
    expect(restarted.dirty).toBe(false);
  });
  it('retains a closed draft across owner restart and fences recovery against changed source', async () => {
    const f = await fixture();
    let state = await f.owner.execute({ documentId: 'book', operation: { kind: 'inspect-copy' } });
    state = await f.owner.execute({
      documentId: 'book',
      expectedRevision: state.revision,
      operation: { kind: 'insert-table', index: 1, rows: 1, columns: 1 },
    });
    await f.owner.close();
    const restarted = new NativeNotebookWorkingCopyOwner(f.options);
    let recovered = await restarted.execute({
      documentId: 'book',
      operation: { kind: 'inspect-copy' },
    });
    expect(recovered.recovery?.baselineMismatch).toBe(false);
    expect(await restarted.listDirty()).toMatchObject([{ documentId: 'book', recovery: true }]);
    await expect(restarted.assertClean(f.path)).rejects.toMatchObject({ code: 'DIRTY_NOTEBOOK' });
    recovered = await restarted.execute({
      documentId: 'book',
      expectedRevision: recovered.revision,
      operation: { kind: 'restore-recovery' },
    });
    expect(recovered.copy.content).toEqual(state.copy.content);
    expect(recovered.dirty).toBe(true);
    await restarted.close();
    const markdown = notebookPackagePaths(f.path).markdownPath;
    await writeFile(markdown, (await readFile(markdown, 'utf8')).replace('Original', 'Outside'));
    const conflictedOwner = new NativeNotebookWorkingCopyOwner(f.options);
    const conflict = await conflictedOwner.execute({
      documentId: 'book',
      operation: { kind: 'inspect-copy' },
    });
    expect(conflict.recovery?.baselineMismatch).toBe(true);
    await expect(
      conflictedOwner.execute({
        documentId: 'book',
        expectedRevision: conflict.revision,
        operation: { kind: 'restore-recovery' },
      })
    ).rejects.toMatchObject({ code: 'NOTEBOOK_RECOVERY_CONFLICT', stateChanged: false });
  });
  it('rejects a second view transaction based on another document and replays mutation IDs without another effect', async () => {
    const f = await fixture();
    let state = await f.owner.execute({ documentId: 'book', operation: { kind: 'inspect-copy' } });
    const model = new NotebookDocumentModel(state.copy.content, state.title),
      transaction = model.state.tr.insertText('A', 1),
      operation = {
        kind: 'apply-steps' as const,
        steps: transaction.steps.map((step) => step.toJSON()),
        baseFingerprint: contentFingerprint(canonicalNotebookJson(transaction.before.toJSON())),
      };
    const input = {
      documentId: 'book',
      expectedRevision: state.revision,
      requestId: 'same-edit',
      operation,
    };
    state = await f.owner.execute(input);
    const replayed = await f.owner.execute(input);
    expect(replayed.revision).toBe(state.revision);
    expect(replayed.requestReceipt).toMatchObject({ replayed: true });
    expect(replayed.copy.content).toEqual(state.copy.content);
    await expect(
      f.owner.execute({ documentId: 'book', expectedRevision: state.revision, operation })
    ).rejects.toMatchObject({ code: 'STALE_NOTEBOOK_TRANSACTION', stateChanged: false });
  });
  it('rechecks enrollment after insertion preparation and freezes edits during actual lifecycle work', async () => {
    const f = await fixture();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.options.prepareInsertion = async () => {
      await wait;
      return { block: { type: 'paragraph' }, verify: async () => {} };
    };
    const state = await f.owner.execute({
      documentId: 'book',
      operation: { kind: 'inspect-copy' },
    });
    const pending = f.owner.execute({
      documentId: 'book',
      expectedRevision: state.revision,
      operation: { kind: 'insert', index: 1, source: { kind: 'table', rows: 1, columns: 1 } },
    });
    await Promise.resolve();
    f.setEnrolled(false);
    release();
    await expect(pending).rejects.toMatchObject({ stateChanged: false });
    f.setEnrolled(true);
    await f.owner.withCleanPaths([f.path], async () => {
      await expect(
        f.owner.execute({
          documentId: 'book',
          expectedRevision: state.revision,
          operation: { kind: 'insert-table', index: 1, rows: 1, columns: 1 },
        })
      ).rejects.toMatchObject({ code: 'NOTEBOOK_LIFECYCLE_BUSY', stateChanged: false });
    });
  });
});

describe('notebook write failure causes', () => {
  it('retains the original publication error cause and the dirty recovery', async () => {
    const f = await fixture();
    const initial = await f.owner.execute({
      documentId: 'book',
      operation: { kind: 'inspect-copy' },
    });
    const markdown = notebookPackagePaths(f.path).markdownPath;
    const before = await readFile(markdown, 'utf8');
    const changed = await f.owner.execute({
      documentId: 'book',
      expectedRevision: initial.revision,
      operation: {
        kind: 'splice-blocks',
        index: 0,
        deleteCount: 1,
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Retained local draft' }] }],
      },
    });
    const originalError = Object.assign(new Error('EPERM: notebook file is in use'), {
      code: 'EPERM',
      syscall: 'rename',
      path: markdown,
    });
    f.options.publish = async () => {
      throw originalError;
    };

    const failure: unknown = await f.owner
      .execute({
        documentId: 'book',
        expectedRevision: changed.revision,
        operation: { kind: 'save' },
      })
      .then(
        () => undefined,
        (error) => error
      );

    expect(await readFile(markdown, 'utf8')).toBe(before);
    const retained = await f.owner.execute({
      documentId: 'book',
      operation: { kind: 'inspect-copy' },
    });
    expect(retained).toMatchObject({ dirty: true, saving: false });
    expect(retained.copy.content).toEqual(changed.copy.content);
    expect(JSON.parse(await readFile(f.recordPath, 'utf8'))).toMatchObject({
      dirty: true,
      content: changed.copy.content,
    });
    expect(failure).toBeInstanceOf(NativeDocumentCommandError);
    expect(failure).toHaveProperty('code', 'NOTEBOOK_SAVE_FAILED');
    expect((failure as Error).cause).toBe(originalError);
  });
});
