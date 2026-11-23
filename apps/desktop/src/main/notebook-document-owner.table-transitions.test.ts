// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookOptions,
  type NativeNotebookRecord,
  type NativeNotebookSource,
} from './notebook-document-owner';
import type { NativeNotebookTableTransitionSource } from './table-document-commands';
import { createFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { publishNotebookPackageV2InMain } from './notebook-package-authority';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { notebookPackagePaths } from '../db/notebook-package';
import { contentFingerprint } from '../shared/content-fingerprint';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import { NotebookDocumentModel } from '../shared/notebook-model/document';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import {
  notebookTableReference,
  richTableReference,
  type TableDocumentReference,
} from '../shared/table-document-reference';
import type { NativeNotebookRequest } from '../shared/notebook-document';

const notebookId = 'bca2cae1-6147-4846-8031-7b68f8141d78';
const documentId = `ws7::${notebookId}`;
const blockId = 'selected-table';
const inlineReference = notebookTableReference(documentId, blockId);
const destinationReference = richTableReference(
  'ea8214db-4c80-47e1-9f29-2be2ddf386ba',
  'c0331488-a3fd-4091-bda9-4bc79517228a'
);
const cleanupDatabases: Array<() => void> = [];
const owners: NativeNotebookWorkingCopyOwner[] = [];

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  for (const cleanup of cleanupDatabases.splice(0)) cleanup();
});

function inlineTable(id = blockId): JSONContent {
  return {
    type: 'embed',
    attrs: {
      type: 'table',
      version: 1,
      refId: id,
      data: {
        name: 'Migration source',
        rows: 2,
        cols: 2,
        cells: [
          [
            { value: 'exact-original', type: 'text', format: { bold: true } },
            { value: '=1+2', type: 'formula' },
          ],
          [
            { value: '19', type: 'number' },
            { value: 'linked', type: 'text', futureCell: { retain: [1, 2] } },
          ],
        ],
        futureTable: { keep: 'exact' },
      },
    },
  };
}

function selectedBlocks(content: JSONContent): JSONContent[] {
  return [
    ...(content.type === 'embed' && content.attrs?.refId === blockId ? [content] : []),
    ...(content.content ?? []).flatMap(selectedBlocks),
  ];
}

async function fixture(blocks: JSONContent[] = [inlineTable()]) {
  const { db, dbPath, tmpDir, cleanup } = createFileTestDb('native-table-transition');
  cleanupDatabases.push(cleanup);
  ensureSchema(db, dbPath);
  const root = join(await realpath(tmpDir), 'Project');
  await mkdir(root);
  db.prepare("INSERT INTO workspaces(id,name,path,created_at) VALUES(7,'Project',?,1)").run(root);
  const path = join(root, 'Book');
  const recordPath = join(root, 'recovery.json');
  const content: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Keep before', marks: [{ type: 'bold' }] }],
      },
      ...blocks,
      { type: 'rawMarkdown', attrs: { source: ':::future\nretain this untouched\n:::' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'Keep after' }] },
    ],
  };
  await publishNotebookPackageV2InMain(
    {
      workspaceRoot: root,
      packageRoot: path,
      id: notebookId,
      title: 'Book',
      content,
      sourceShape: 'new-package',
    },
    undefined,
    db
  );
  let enrolled = true;
  let writable = true;
  let publishes = 0;
  let publishFailure: { when: 'before' | 'after'; error: Error } | undefined;
  let beforePublish: (() => Promise<void>) | undefined;
  const scope = () => ({
    documentId,
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
  const load = async (): Promise<NativeNotebookSource> => {
    const readBytes = new Map<string, Buffer>();
    const current = await readCanonicalNotebookPackage(
      {
        async readTextFile(file) {
          const bytes = await readFile(file);
          readBytes.set(file, bytes);
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        },
        async exists(file) {
          try {
            await access(file);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return false;
          }
        },
      },
      path
    );
    const hashes: Record<string, string> = {};
    for (const [file, bytes] of readBytes) {
      expect(await readFile(file)).toEqual(bytes);
      const member = relative(path, file).split(sep).join('/');
      expect(isAbsolute(member) || member.split('/').includes('..')).toBe(false);
      hashes[member] = createHash('sha256').update(bytes).digest('hex');
    }
    return {
      content: new NotebookDocumentModel(current.parsed.content, current.parsed.title).content,
      title: current.parsed.title,
      fingerprint: contentFingerprint(current.markdown),
      metadataRaw: await readFile(notebookPackagePaths(path).metaPath, 'utf8'),
      preservedPreamble: current.parsed.preservedPreamble,
      preservedTitleProjection: current.parsed.preservedTitleProjection,
      sourceShape: 'v2-package',
      sourceFileHashes: hashes,
    };
  };
  const options: NativeNotebookOptions = {
    resolve: async () => scope(),
    load,
    async publish(current, source, candidate, title) {
      await beforePublish?.();
      current.assertCurrent();
      if (publishFailure?.when === 'before') throw publishFailure.error;
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
          id: notebookId,
          title,
          content: candidate,
          sourceShape: 'v2-package',
          existingMetadataRaw: fresh.metadataRaw,
          expectedCanonicalFingerprint: source.fingerprint,
          preservedPreamble: fresh.preservedPreamble,
          preservedTitleProjection: fresh.preservedTitleProjection,
        },
        current.assertCurrent,
        db
      );
      if (publishFailure?.when === 'after') throw publishFailure.error;
      return { source: await load() };
    },
    async loadRecord() {
      try {
        return JSON.parse(await readFile(recordPath, 'utf8')) as NativeNotebookRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      }
    },
    async storeRecord(record) {
      await writeFile(recordPath, JSON.stringify(record));
    },
    async retainedDirty() {
      const record = await options.loadRecord(documentId);
      return record?.dirty ? [{ documentId, path }] : [];
    },
    normalizePath: (file) => file,
    prepareInsertion: async () => {
      throw new Error('No generic insertion is used by this acceptance.');
    },
    search: async () => [],
    list: async () => [],
    create: async () => {
      throw new Error('The real package was created before opening its owner.');
    },
  };
  const owner = new NativeNotebookWorkingCopyOwner(options);
  owners.push(owner);
  const execute = (operation: NativeNotebookRequest['operation'], expectedRevision?: string) =>
    owner.execute({ documentId, operation, expectedRevision });
  return {
    root,
    path,
    recordPath,
    owner,
    options,
    load,
    execute,
    setWritable(value: boolean) {
      writable = value;
    },
    setEnrolled(value: boolean) {
      enrolled = value;
    },
    setBeforePublish(callback?: () => Promise<void>) {
      beforePublish = callback;
    },
    failPublication(when: 'before' | 'after', error: Error) {
      publishFailure = { when, error };
    },
    clearPublicationFailure() {
      publishFailure = undefined;
    },
    get publishes() {
      return publishes;
    },
  };
}

function assertReferenceBlock(block: JSONContent, reference: TableDocumentReference) {
  expect(block).toMatchObject({
    type: 'embed',
    attrs: { type: 'table-reference', version: 1, refId: blockId, data: { reference } },
  });
  expect(block.attrs?.data).not.toHaveProperty('cells');
}

describe('native notebook table transitions', () => {
  it('captures one exact saved source and publishes only its selected placement through the native owner', async () => {
    const f = await fixture();
    const before = await f.execute({ kind: 'inspect-copy' });
    const diskBefore = await f.load();
    const archive = structuredClone(selectedBlocks(before.copy.content)[0]);
    const callback = vi.fn(async (source: NativeNotebookTableTransitionSource) => {
      expect(source).toMatchObject({
        reference: inlineReference,
        workspaceRoot: f.root,
        notebookId,
        blockId,
        revision: before.revision,
        sourceFingerprint: diskBefore.fingerprint,
        sourceFileHashes: diskBefore.sourceFileHashes,
        originalBlock: archive,
        tableData: archive.attrs?.data,
      });
      for (const [member, hash] of Object.entries(source.sourceFileHashes)) {
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
        expect(hash).toBe(
          createHash('sha256')
            .update(await readFile(join(f.path, member)))
            .digest('hex')
        );
      }
      return source.publishReference(destinationReference);
    });
    const result = await f.owner.withTableSource(
      { reference: inlineReference, expectedRevision: before.revision },
      callback
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.publishes).toBe(1);
    const after = await f.execute({ kind: 'inspect-copy' });
    const diskAfter = await f.load();
    expect(after).toMatchObject({ dirty: false, saving: false, persistedRevision: after.revision });
    expect(after.copy.content).toEqual(diskAfter.content);
    expect(result).toMatchObject({
      revision: after.revision,
      sourceFingerprint: diskAfter.fingerprint,
      sourceFileHashes: diskAfter.sourceFileHashes,
    });
    const untouched = (doc: JSONContent) =>
      (doc.content ?? []).filter((block) => block.attrs?.refId !== blockId);
    expect(untouched(after.copy.content)).toEqual(untouched(before.copy.content));
    assertReferenceBlock(selectedBlocks(after.copy.content)[0], destinationReference);
    expect(archive).toEqual(selectedBlocks(before.copy.content)[0]);
  });

  it('exposes the same transaction through the narrow coordinator capability', async () => {
    const f = await fixture();
    const before = await f.execute({ kind: 'inspect-copy' });
    const source = await f.owner.tableTransitions.inspectSource(inlineReference);
    expect(source).toMatchObject({
      revision: before.revision,
      originalBlock: selectedBlocks(before.copy.content)[0],
    });
    await f.owner.tableTransitions.withSource(
      { reference: inlineReference, expectedRevision: before.revision },
      async (captured) => {
        await captured.publishReference(destinationReference);
      }
    );
    expect(await f.owner.inspectTableSource(inlineReference)).toMatchObject({
      originalBlock: null,
      currentReference: destinationReference,
    });
  });

  it('refuses dirty or stale sources before calling the transition or changing any package bytes', async () => {
    const f = await fixture();
    const before = await f.execute({ kind: 'inspect-copy' });
    const disk = await f.load();
    const callback = vi.fn(async () => undefined);
    await expect(
      f.owner.withTableSource({ reference: inlineReference, expectedRevision: 'stale' }, callback)
    ).rejects.toThrow();
    const changed = await f.execute(
      {
        kind: 'table',
        tableId: blockId,
        command: { kind: 'set-cell', row: 0, column: 0, value: 'unsaved retained' },
      },
      before.revision
    );
    await expect(
      f.owner.withTableSource(
        { reference: inlineReference, expectedRevision: changed.revision },
        callback
      )
    ).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(f.publishes).toBe(0);
    expect((await f.load()).sourceFileHashes).toEqual(disk.sourceFileHashes);
    expect(
      selectedBlocks((await f.execute({ kind: 'inspect-copy' })).copy.content)[0].attrs?.data
        .cells[0][0].value
    ).toBe('unsaved retained');
  });

  it.each(['read-only', 'unenrolled', 'duplicate-block', 'missing-block'] as const)(
    'refuses %s before invoking the transition',
    async (mode) => {
      const f = await fixture(
        mode === 'duplicate-block'
          ? [inlineTable(), inlineTable()]
          : mode === 'missing-block'
            ? []
            : undefined
      );
      const before = await f.execute({ kind: 'inspect-copy' });
      const disk = await f.load();
      if (mode === 'read-only') f.setWritable(false);
      if (mode === 'unenrolled') f.setEnrolled(false);
      const callback = vi.fn(async () => undefined);
      await expect(
        f.owner.withTableSource(
          { reference: inlineReference, expectedRevision: before.revision },
          callback
        )
      ).rejects.toThrow();
      expect(callback).not.toHaveBeenCalled();
      expect(f.publishes).toBe(0);
      expect((await f.load()).sourceFileHashes).toEqual(disk.sourceFileHashes);
    }
  );

  it('refuses a retained recovery candidate instead of migrating either version', async () => {
    const f = await fixture();
    const disk = await f.load();
    const recovery: NativeNotebookRecord = {
      version: 1,
      documentId,
      path: f.path,
      baselineFingerprint: disk.fingerprint,
      baselineContent: disk.content,
      content: {
        ...disk.content,
        content: [
          ...(disk.content.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'retained other version' }] },
        ],
      },
      title: 'Book',
      dirty: true,
    };
    await writeFile(f.recordPath, JSON.stringify(recovery));
    const before = await f.execute({ kind: 'inspect-copy' });
    const callback = vi.fn(async () => undefined);
    await expect(
      f.owner.withTableSource(
        { reference: inlineReference, expectedRevision: before.revision },
        callback
      )
    ).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect((await f.execute({ kind: 'inspect-copy' })).recovery?.content).toEqual(recovery.content);
    expect((await f.load()).sourceFileHashes).toEqual(disk.sourceFileHashes);
  });

  it('requires exact source hashes and never fabricates migration evidence from decoded content', async () => {
    const f = await fixture();
    f.options.load = async () => {
      const { sourceFileHashes: _hashes, ...withoutHashes } = await f.load();
      return withoutHashes;
    };
    const before = await f.execute({ kind: 'inspect-copy' });
    const callback = vi.fn(async () => undefined);
    await expect(
      f.owner.withTableSource(
        { reference: inlineReference, expectedRevision: before.revision },
        callback
      )
    ).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
    expect(f.publishes).toBe(0);
  });

  it('holds concurrent native mutations through cutover and rejects their captured stale revision', async () => {
    const f = await fixture();
    const before = await f.execute({ kind: 'inspect-copy' });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transition = f.owner.withTableSource(
      { reference: inlineReference, expectedRevision: before.revision },
      async (source) => {
        entered.resolve();
        await release.promise;
        return source.publishReference(destinationReference);
      }
    );
    await entered.promise;
    let mutationSettled = false;
    const mutation = f
      .execute(
        {
          kind: 'table',
          tableId: blockId,
          command: { kind: 'set-cell', row: 0, column: 0, value: 'must not race' },
        },
        before.revision
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
      .finally(() => {
        mutationSettled = true;
      });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mutationSettled).toBe(false);
      expect(selectedBlocks((await f.load()).content)[0].attrs?.type).toBe('table');
    } finally {
      release.resolve();
    }
    await transition;
    const result = await mutation;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ code: 'STALE_NOTEBOOK' });
    assertReferenceBlock(
      selectedBlocks((await f.execute({ kind: 'inspect-copy' })).copy.content)[0],
      destinationReference
    );
  });

  it('does not begin while a captured native save is still pending', async () => {
    const f = await fixture();
    const before = await f.execute({ kind: 'inspect-copy' });
    const changed = await f.execute({ kind: 'set-title', title: 'Saved title' }, before.revision);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.setBeforePublish(async () => {
      entered.resolve();
      await release.promise;
    });
    const captured = await f.execute({ kind: 'capture-save' }, changed.revision);
    await entered.promise;
    const callback = vi.fn(async () => undefined);
    const attempt = Promise.resolve()
      .then(() =>
        f.owner.withTableSource(
          { reference: inlineReference, expectedRevision: captured.revision },
          callback
        )
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
    try {
      const result = await attempt;
      expect(result.ok).toBe(false);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await f.execute({ kind: 'await-save', saveCaptureId: captured.saveCaptureId! });
  });

  it('preserves the original source and original failure when publication fails before cutover', async () => {
    const f = await fixture();
    const before = await f.execute({ kind: 'inspect-copy' });
    const disk = await f.load();
    const refusal = Object.assign(new Error('injected disk write denial'), { code: 'EACCES' });
    f.failPublication('before', refusal);
    const attempt = await f.owner
      .withTableSource(
        { reference: inlineReference, expectedRevision: before.revision },
        (source) => source.publishReference(destinationReference)
      )
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      );
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(String(attempt.error)).toContain(refusal.message);
    const after = await f.execute({ kind: 'inspect-copy' });
    expect(after.copy.content).toEqual(before.copy.content);
    expect((await f.load()).sourceFileHashes).toEqual(disk.sourceFileHashes);
    expect(after).toMatchObject({ dirty: false, saving: false });
    f.clearPublicationFailure();
    await f.owner.withTableSource(
      { reference: inlineReference, expectedRevision: after.revision },
      (source) => source.publishReference(destinationReference)
    );
    assertReferenceBlock(selectedBlocks((await f.load()).content)[0], destinationReference);
  });

  it('rejects an outside exact-byte change even when the decoded notebook content is identical', async () => {
    const f = await fixture();
    const before = await f.execute({ kind: 'inspect-copy' });
    const disk = await f.load();
    const member = Object.keys(disk.sourceFileHashes!).find(
      (name) => name.endsWith('.json') && name !== '.forge/notebook.json'
    );
    expect(member).toBeTruthy();
    const file = join(f.path, member!);
    const original = await readFile(file);
    const outside = Buffer.concat([original, Buffer.from('\n ')]);
    await f.owner.withTableSource(
      { reference: inlineReference, expectedRevision: before.revision },
      async (source) => {
        await writeFile(file, outside);
        expect(canonicalNotebookJson((await f.load()).content)).toBe(
          canonicalNotebookJson(disk.content)
        );
        await expect(source.publishReference(destinationReference)).rejects.toThrow();
      }
    );
    expect(await readFile(file)).toEqual(outside);
    expect(f.publishes).toBe(0);
    expect(selectedBlocks((await f.load()).content)[0].attrs?.type).toBe('table');
  });

  it('re-inspects actual disk after a lost cutover receipt so the old inline source cannot remain writable', async () => {
    const f = await fixture();
    const before = await f.execute({ kind: 'inspect-copy' });
    const lostReceipt = new NativeDocumentCommandError(
      'NOTEBOOK_PUBLICATION_UNCERTAIN',
      'injected lost cutover receipt',
      'unknown'
    );
    f.failPublication('after', lostReceipt);
    await expect(
      f.owner.withTableSource(
        { reference: inlineReference, expectedRevision: before.revision },
        (source) => source.publishReference(destinationReference)
      )
    ).rejects.toThrow(/lost cutover receipt/);
    assertReferenceBlock(selectedBlocks((await f.load()).content)[0], destinationReference);
    const inspected = await f.owner.inspectTableSource(inlineReference);
    expect(inspected).toMatchObject({
      originalBlock: null,
      currentReference: destinationReference,
    });
    const state = await f.execute({ kind: 'inspect-copy' });
    assertReferenceBlock(selectedBlocks(state.copy.content)[0], destinationReference);
    await expect(
      f.execute(
        {
          kind: 'table',
          tableId: blockId,
          command: { kind: 'set-cell', row: 0, column: 0, value: 'second writable source' },
        },
        state.revision
      )
    ).rejects.toThrow();
    f.clearPublicationFailure();
    await f.owner.close();
    const restarted = new NativeNotebookWorkingCopyOwner(f.options);
    owners.push(restarted);
    const fresh = await restarted.inspectTableSource(inlineReference);
    expect(fresh).toMatchObject({
      originalBlock: null,
      currentReference: destinationReference,
      sourceFileHashes: (await f.load()).sourceFileHashes,
    });
    expect(fresh.revision).not.toBe(inspected.revision);
    const callback = vi.fn(async () => undefined);
    await expect(
      restarted.withTableSource(
        { reference: inlineReference, expectedRevision: before.revision },
        callback
      )
    ).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });

  it('blocks further native edits when cutover acknowledgment and immediate disk reread both fail', async () => {
    const f = await fixture();
    const before = await f.execute({ kind: 'inspect-copy' });
    const publish = f.options.publish;
    let readsUnavailable = false;
    const uncertain = new NativeDocumentCommandError(
      'NOTEBOOK_PUBLICATION_UNCERTAIN',
      'cutover receipt unavailable',
      'unknown'
    );
    f.options.load = async () => {
      if (readsUnavailable) throw new Error('disk read temporarily unavailable');
      return f.load();
    };
    f.options.publish = async (...args) => {
      await publish(...args);
      readsUnavailable = true;
      throw uncertain;
    };
    await expect(
      f.owner.withTableSource(
        { reference: inlineReference, expectedRevision: before.revision },
        (source) => source.publishReference(destinationReference)
      )
    ).rejects.toThrow(/cutover receipt unavailable/);
    assertReferenceBlock(selectedBlocks((await f.load()).content)[0], destinationReference);
    const inspected = await f.execute({ kind: 'inspect-copy' }).then(
      (state) => ({ state }),
      (error: unknown) => ({ error })
    );
    if ('state' in inspected) expect(inspected.state.readOnly).toBe(true);
    const revision = 'state' in inspected ? inspected.state.revision : before.revision;
    for (const operation of [
      {
        kind: 'table' as const,
        tableId: blockId,
        command: {
          kind: 'set-cell' as const,
          row: 0,
          column: 0,
          value: 'must not regain old writer',
        },
      },
      { kind: 'undo' as const },
      { kind: 'save' as const },
    ])
      await expect(f.execute(operation, revision)).rejects.toThrow();
    readsUnavailable = false;
    const actual = await f.owner.inspectTableSource(inlineReference);
    expect(actual).toMatchObject({ originalBlock: null, currentReference: destinationReference });
    assertReferenceBlock(
      selectedBlocks((await f.execute({ kind: 'inspect-copy' })).copy.content)[0],
      destinationReference
    );
  });
});
