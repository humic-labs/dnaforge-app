// @vitest-environment node

import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { tableCommandFixture, identityTestPaths } from './__tests__/table-command-fixture';
import { NativeTableDocumentCommands } from './table-document-commands';
import {
  NativeNotebookWorkingCopyOwner,
  type NativeNotebookOptions,
  type NativeNotebookRecord,
  type NativeNotebookSource,
} from './notebook-document-owner';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import { publishNotebookPackageV2InMain } from './notebook-package-authority';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { notebookPackagePaths } from '../db/notebook-package';
import { NotebookDocumentModel } from '../shared/notebook-model/document';
import { contentFingerprint } from '../shared/content-fingerprint';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import { notebookTableReference, tableDocumentKey } from '../shared/table-document-reference';
import type { TableDocumentCommand } from '../shared/table-document-command';
import { tablePackagePaths, tablePackageHeadWithData } from '../shared/table-package';
import { publishTablePackageInMain, readTablePackageInMain } from './table-package';
import { writeWorkspaceTextFileAtomicInMain } from './primer-artifact-files';

vi.mock('electron', () => ({
  app: { getPath: (name: 'home' | 'userData') => identityTestPaths[name] },
}));

const notebookId = '25f50d05-6aa7-4f9d-b899-5f8d932ca0b0';
const documentId = `ws1::${notebookId}`;
const blockId = 'source-table';
const sourceReference = notebookTableReference(documentId, blockId);
const originalTable: JSONContent = {
  type: 'embed',
  attrs: {
    type: 'table',
    version: 1,
    refId: blockId,
    data: {
      name: 'Migration fixture',
      rows: 1,
      cols: 2,
      cells: [
        [
          {
            value: 'original-before-promotion',
            type: 'text',
            format: { bold: true },
          },
          { value: '=7+5', type: 'formula' },
        ],
      ],
      futureMetadata: { preserve: [1, { exact: true }] },
    },
  },
};
const fixtures: Awaited<ReturnType<typeof tableCommandFixture>>[] = [];
const nativeOwners: NativeNotebookWorkingCopyOwner[] = [];
afterEach(async () => {
  await Promise.all(nativeOwners.splice(0).map((owner) => owner.close()));
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

function selected(content: JSONContent): JSONContent {
  const matches = (content.content ?? []).filter((block) => block.attrs?.refId === blockId);
  expect(matches).toHaveLength(1);
  return matches[0];
}

async function fixture(options: { nativeIdentityPrefix?: string } = {}) {
  const f = await tableCommandFixture(options);
  fixtures.push(f);
  const root = () => f.roots[0];
  const notebookPath = () => join(root(), 'Notebook');
  const destination = () => ({
    workspaceRoot: root(),
    packageRoot: join(root(), 'Extracted table'),
  });
  await publishNotebookPackageV2InMain({
    workspaceRoot: root(),
    packageRoot: notebookPath(),
    id: notebookId,
    title: 'Notebook',
    sourceShape: 'new-package',
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Other notebook content retained.' }],
        },
        structuredClone(originalTable),
      ],
    },
  });
  const load = async (): Promise<NativeNotebookSource> => {
    const bytesRead = new Map<string, Buffer>();
    const current = await readCanonicalNotebookPackage(
      {
        async readTextFile(file) {
          const bytes = await readFile(file);
          bytesRead.set(file, bytes);
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
      notebookPath()
    );
    const sourceFileHashes: Record<string, string> = {};
    for (const [file, bytes] of bytesRead) {
      expect(await readFile(file)).toEqual(bytes);
      sourceFileHashes[relative(notebookPath(), file).split(sep).join('/')] = createHash('sha256')
        .update(bytes)
        .digest('hex');
    }
    return {
      content: new NotebookDocumentModel(current.parsed.content, current.parsed.title).content,
      title: current.parsed.title,
      fingerprint: contentFingerprint(current.markdown),
      metadataRaw: await readFile(notebookPackagePaths(notebookPath()).metaPath, 'utf8'),
      preservedPreamble: current.parsed.preservedPreamble,
      preservedTitleProjection: current.parsed.preservedTitleProjection,
      sourceShape: 'v2-package',
      sourceFileHashes,
    };
  };
  let sourcePublishFailure: Error | undefined;
  let record: NativeNotebookRecord | undefined;
  const notebookOptions: NativeNotebookOptions = {
    async resolve() {
      const workspaceRoot = root();
      const row = f.db
        .prepare('SELECT access_mode FROM workspaces WHERE path=?')
        .get(workspaceRoot) as { access_mode: string };
      return {
        documentId,
        path: notebookPath(),
        workspaceRoot,
        readOnly: row.access_mode !== 'writable',
        assertCurrent: f.options.captureWorkspace(workspaceRoot, false),
      };
    },
    load,
    async publish(scope, source, content, title) {
      scope.assertCurrent();
      if (sourcePublishFailure) throw sourcePublishFailure;
      const fresh = await load();
      if (fresh.fingerprint !== source.fingerprint)
        throw new NativeDocumentCommandError(
          'NOTEBOOK_EXTERNAL_CONFLICT',
          'The source changed on disk.',
          false
        );
      await publishNotebookPackageV2InMain(
        {
          workspaceRoot: root(),
          packageRoot: notebookPath(),
          id: notebookId,
          title,
          content,
          sourceShape: 'v2-package',
          existingMetadataRaw: fresh.metadataRaw,
          expectedCanonicalFingerprint: source.fingerprint,
          preservedPreamble: fresh.preservedPreamble,
          preservedTitleProjection: fresh.preservedTitleProjection,
        },
        scope.assertCurrent
      );
      return { source: await load() };
    },
    loadRecord: async () => record,
    storeRecord: async (value) => {
      record = structuredClone(value);
    },
    retainedDirty: async () => (record?.dirty ? [{ documentId, path: notebookPath() }] : []),
    normalizePath: (path) => path,
    prepareInsertion: async () => {
      throw new Error('No generic source insertion used.');
    },
    search: async () => [],
    list: async () => [],
    create: async () => {
      throw new Error('Fixture source already published.');
    },
  };
  let notebook = new NativeNotebookWorkingCopyOwner(notebookOptions);
  nativeOwners.push(notebook);
  f.options.notebookTables = notebook.tableTransitions;
  const inspectSource = () => notebook.execute({ documentId, operation: { kind: 'inspect-copy' } });
  const request = async (requestId = randomUUID()) => ({
    kind: 'promote' as const,
    requestId,
    source: sourceReference,
    expectedRevision: (await inspectSource()).revision,
    destination: destination(),
  });
  const recover = async (promotionId: string) =>
    new NativeTableDocumentCommands(f.options).execute({
      kind: 'recover-promotion',
      requestId: randomUUID(),
      workspaceRoot: root(),
      promotionId,
    });
  return {
    f,
    root,
    notebookPath,
    destination,
    load,
    inspectSource,
    request,
    recover,
    get notebook() {
      return notebook;
    },
    failSourcePublication(error?: Error) {
      sourcePublishFailure = error;
    },
    async restartNotebook() {
      await notebook.close();
      notebook = new NativeNotebookWorkingCopyOwner(notebookOptions);
      nativeOwners.push(notebook);
      f.options.notebookTables = notebook.tableTransitions;
    },
  };
}

async function incomplete(commands: NativeTableDocumentCommands, command: TableDocumentCommand) {
  const attempt = await commands.execute(command).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  if ('value' in attempt) expect(attempt.value.kind).toBe('promotion-pending');
  return attempt;
}

async function pending(f: Awaited<ReturnType<typeof fixture>>) {
  const actual = await readTablePackageInMain(f.destination());
  expect(actual.head.status).toBe('pending-promotion');
  expect(actual.head.promotionId).toBeTruthy();
  expect(actual.head.snapshot.data).toEqual(originalTable.attrs?.data);
  const copy = await f.f.inspect(tablePackagePaths(f.destination().packageRoot).headPath);
  expect(copy.readOnly).toBe(true);
  await expect(
    f.f.files.execute({
      target: { documentId: copy.documentId },
      expectedRevision: copy.revision,
      operation: {
        kind: 'table',
        command: {
          kind: 'set-cell',
          row: 0,
          column: 0,
          value: 'second writer forbidden',
        },
      },
    })
  ).rejects.toThrow();
  return actual;
}

async function completed(
  f: Awaited<ReturnType<typeof fixture>>,
  result: Awaited<ReturnType<NativeTableDocumentCommands['execute']>>
) {
  expect(result.kind).toBe('promoted');
  if (result.kind !== 'promoted') throw new Error('The source transition has not completed.');
  const actual = await readTablePackageInMain(f.destination());
  expect(actual.head.status).toBe('active');
  expect(actual.head.id).toBe(result.table.tableId);
  expect(actual.head.aliases).toContainEqual(
    expect.objectContaining({
      notebookId,
      blockId,
      legacyReference: sourceReference,
    })
  );
  const source = selected((await f.load()).content);
  expect(source).toMatchObject({
    attrs: { type: 'table-reference', refId: blockId },
  });
  expect(tableDocumentKey(source.attrs?.data.reference)).toBe(
    tableDocumentKey(result.table.reference)
  );
  expect((await f.inspectSource()).dirty).toBe(false);
  return { actual, result };
}

describe('recoverable native table promotion', () => {
  it('finishes recovery discovery when catalog and native file identifiers are independently scoped', async () => {
    const t = await fixture({ nativeIdentityPrefix: 'native-file:' });
    const { result } = await completed(
      t,
      await new NativeTableDocumentCommands(t.f.options).execute(await t.request())
    );
    if (result.kind !== 'promoted' || result.table.owner.kind !== 'file')
      throw new Error('Expected an active native table');
    const binding = t.f.db
      .prepare("SELECT entity_id FROM catalog_entity_files WHERE path=? AND status='current'")
      .get(result.table.owner.path) as { entity_id: string };
    expect(binding.entity_id).not.toBe(result.table.owner.documentId);
    const before = await readTablePackageInMain(t.destination());
    const source = await t.load();
    expect(
      await new NativeTableDocumentCommands(t.f.options).execute({
        kind: 'list-promotions',
        workspaceRoot: t.root(),
      })
    ).toEqual({ kind: 'promotions', promotions: [] });
    expect((await readTablePackageInMain(t.destination())).headText).toBe(before.headText);
    expect((await t.load()).sourceFileHashes).toEqual(source.sourceFileHashes);
  });

  it('makes no destination/source mutation when the durable intent cannot publish, then retries once with stable identity', async () => {
    const t = await fixture();
    const request = await t.request();
    const before = await t.load();
    t.f.options.io = {
      writeAtomic: async (input, options) => {
        if (input.path.endsWith(join('table-transitions', `${request.requestId}.json`)))
          throw Object.assign(new Error('intent write denied'), {
            code: 'EACCES',
          });
        return writeWorkspaceTextFileAtomicInMain(input, options);
      },
    };
    await incomplete(new NativeTableDocumentCommands(t.f.options), request);
    await expect(access(t.destination().packageRoot)).rejects.toThrow();
    expect((await t.load()).sourceFileHashes).toEqual(before.sourceFileHashes);
    expect(selected((await t.inspectSource()).copy.content).attrs?.type).toBe('table');
    t.f.options.io = undefined;
    const first = await completed(
      t,
      await new NativeTableDocumentCommands(t.f.options).execute(request)
    );
    const retry = await completed(
      t,
      await new NativeTableDocumentCommands(t.f.options).execute(request)
    );
    expect(retry.actual.headText).toBe(first.actual.headText);
    expect(retry.result.table.tableId).toBe(first.result.table.tableId);
    await expect(
      new NativeTableDocumentCommands(t.f.options).execute({
        ...request,
        destination: {
          ...request.destination,
          packageRoot: join(t.root(), 'Different destination'),
        },
      })
    ).rejects.toThrow();
  });

  it('recovers a pending package after interrupted staging without creating a writable second table', async () => {
    const t = await fixture();
    const request = await t.request();
    const before = await t.load();
    t.f.options.io = {
      publishPackage: async (input, dependencies) => {
        const result = await publishTablePackageInMain(input, dependencies);
        if (input.head.status === 'pending-promotion')
          throw new Error('receipt lost after pending package publication');
        return result;
      },
    };
    await incomplete(new NativeTableDocumentCommands(t.f.options), request);
    const staged = await pending(t);
    expect((await t.load()).sourceFileHashes).toEqual(before.sourceFileHashes);
    expect(selected((await t.inspectSource()).copy.content).attrs?.type).toBe('table');
    t.f.options.io = undefined;
    await t.restartNotebook();
    const final = await completed(t, await t.recover(staged.head.promotionId!));
    expect(final.actual.head.id).toBe(staged.head.id);
    expect(final.actual.snapshotText).toBe(staged.snapshotText);
  });

  it('keeps the inline original writable after source publication denial and recovers against its fresh native revision', async () => {
    const t = await fixture();
    const before = await t.load();
    t.failSourcePublication(
      Object.assign(new Error('source CAS publication denied'), {
        code: 'EACCES',
      })
    );
    await incomplete(new NativeTableDocumentCommands(t.f.options), await t.request());
    const staged = await pending(t);
    expect((await t.load()).sourceFileHashes).toEqual(before.sourceFileHashes);
    let source = await t.inspectSource();
    source = await t.notebook.execute({
      documentId,
      expectedRevision: source.revision,
      operation: {
        kind: 'table',
        tableId: blockId,
        command: {
          kind: 'set-cell',
          row: 0,
          column: 0,
          value: 'original remains writable',
        },
      },
    });
    expect(source.dirty).toBe(true);
    expect(selected(source.copy.content).attrs?.data.cells[0][0].value).toBe(
      'original remains writable'
    );
    await t.notebook.execute({
      documentId,
      expectedRevision: source.revision,
      operation: { kind: 'discard' },
    });
    t.failSourcePublication();
    await t.restartNotebook();
    const final = await completed(t, await t.recover(staged.head.promotionId!));
    expect(final.actual.head.id).toBe(staged.head.id);
  });

  it('finishes a durable source cutover after activation failure using actual pointer state and a fresh source owner', async () => {
    const t = await fixture();
    t.f.options.io = {
      publishPackage: async (input, dependencies) => {
        if (input.head.status === 'active')
          throw new Error('activation write denied after source cutover');
        return publishTablePackageInMain(input, dependencies);
      },
    };
    await incomplete(new NativeTableDocumentCommands(t.f.options), await t.request());
    const staged = await pending(t);
    expect(selected((await t.load()).content).attrs?.type).toBe('table-reference');
    const oldRevision = (await t.inspectSource()).revision;
    t.f.options.io = undefined;
    await t.restartNotebook();
    expect((await t.inspectSource()).revision).not.toBe(oldRevision);
    await completed(t, await t.recover(staged.head.promotionId!));
  });

  it('preserves legitimate newer table edits when recovery retries a lost catalog completion receipt', async () => {
    const t = await fixture();
    const reconcile = t.f.options.reconcileTablePackage;
    t.f.options.reconcileTablePackage = async (location) => {
      await reconcile(location);
      throw new Error('catalog completion receipt lost after verified registration');
    };
    await incomplete(new NativeTableDocumentCommands(t.f.options), await t.request());
    const initial = await readTablePackageInMain(t.destination());
    expect(initial.head.status).toBe('active');
    expect(initial.head.promotionId).toBeTruthy();
    expect(selected((await t.load()).content).attrs?.type).toBe('table-reference');
    let file = await t.f.inspect(initial.headPath);
    file = await t.f.files.execute({
      target: { documentId: file.documentId },
      expectedRevision: file.revision,
      operation: {
        kind: 'table',
        command: {
          kind: 'set-cell',
          row: 0,
          column: 0,
          value: 'later legitimate edit must survive',
        },
      },
    });
    await t.f.files.execute({
      target: { documentId: file.documentId },
      expectedRevision: file.revision,
      operation: { kind: 'save' },
    });
    const newer = await readTablePackageInMain(t.destination());
    expect(newer.head.snapshotSha256).not.toBe(initial.head.snapshotSha256);
    t.f.options.reconcileTablePackage = reconcile;
    await t.restartNotebook();
    const final = await completed(t, await t.recover(initial.head.promotionId!));
    expect(final.actual.snapshotText).toBe(newer.snapshotText);
    expect(final.actual.head.snapshotSha256).toBe(newer.head.snapshotSha256);
    expect(final.actual.head.aliases).toEqual(newer.head.aliases);
    expect(final.actual.head.snapshot.data.cells?.[0]?.[0]?.value).toBe(
      'later legitimate edit must survive'
    );
    const alias = await new NativeTableDocumentCommands(t.f.options).execute({
      kind: 'resolve',
      reference: sourceReference,
      context: { workspaceRoot: t.root() },
    });
    expect(alias.kind).toBe('resolved');
    if (alias.kind === 'resolved') expect(alias.table.tableId).toBe(newer.head.id);
  });

  it('recovers the same intent and identity after a project folder move rather than following stale absolute paths', async () => {
    const t = await fixture();
    t.failSourcePublication(new Error('source cutover deliberately withheld before move'));
    await incomplete(new NativeTableDocumentCommands(t.f.options), await t.request());
    const staged = await pending(t);
    const previousRoot = t.root();
    const movedRoot = join(t.f.home, 'Moved project');
    await t.notebook.close();
    await rename(previousRoot, movedRoot);
    t.f.db.prepare('UPDATE workspaces SET path=? WHERE path=?').run(movedRoot, previousRoot);
    t.f.roots[0] = movedRoot;
    t.failSourcePublication();
    await t.restartNotebook();
    const final = await completed(t, await t.recover(staged.head.promotionId!));
    expect(final.actual.head.id).toBe(staged.head.id);
    expect(final.actual.packageRoot).toBe(t.destination().packageRoot);
    await expect(access(previousRoot)).rejects.toThrow();
    expect(canonicalNotebookJson(selected((await t.load()).content))).not.toContain(previousRoot);
  });

  it('retains exact original source bytes and selected payload in its durable portable archive', async () => {
    const t = await fixture();
    const request = await t.request();
    const original = await t.load();
    const block = structuredClone(selected((await t.inspectSource()).copy.content));
    const bytes = Object.fromEntries(
      await Promise.all(
        Object.keys(original.sourceFileHashes!).map(
          async (member) => [member, await readFile(join(t.notebookPath(), member))] as const
        )
      )
    );
    await completed(t, await new NativeTableDocumentCommands(t.f.options).execute(request));
    const intent = JSON.parse(
      await readFile(
        join(t.root(), '.forge', 'table-transitions', `${request.requestId}.json`),
        'utf8'
      )
    );
    expect(intent.source).toMatchObject({
      notebookId,
      packagePath: 'Notebook',
      blockId,
      legacyReference: sourceReference,
      originalBlock: block,
      sourceFileHashes: original.sourceFileHashes,
    });
    expect(Object.keys(intent.source.originalFiles).sort()).toEqual(Object.keys(bytes).sort());
    for (const [member, originalBytes] of Object.entries(bytes)) {
      expect(intent.source.originalFiles[member].sha256).toBe(original.sourceFileHashes![member]);
      expect(Buffer.from(intent.source.originalFiles[member].base64, 'base64')).toEqual(
        originalBytes
      );
    }
  });

  it('refuses recovery over a separately saved source edit and preserves both the pending table and source', async () => {
    const t = await fixture();
    t.failSourcePublication(new Error('hold cutover before outside edit'));
    await incomplete(new NativeTableDocumentCommands(t.f.options), await t.request());
    const staged = await pending(t);
    t.failSourcePublication();
    const before = await t.inspectSource();
    const changed = await t.notebook.execute({
      documentId,
      expectedRevision: before.revision,
      operation: {
        kind: 'table',
        tableId: blockId,
        command: { kind: 'set-cell', row: 0, column: 0, value: 'separately saved notebook edit' },
      },
    });
    await t.notebook.execute({
      documentId,
      expectedRevision: changed.revision,
      operation: { kind: 'save' },
    });
    const saved = await t.load();
    await t.restartNotebook();
    await incomplete(new NativeTableDocumentCommands(t.f.options), {
      kind: 'recover-promotion',
      requestId: randomUUID(),
      workspaceRoot: t.root(),
      promotionId: staged.head.promotionId!,
    });
    expect((await t.load()).sourceFileHashes).toEqual(saved.sourceFileHashes);
    expect(selected((await t.load()).content).attrs?.data.cells[0][0].value).toBe(
      'separately saved notebook edit'
    );
    expect((await readTablePackageInMain(t.destination())).headText).toBe(staged.headText);
  });

  it('refuses an outside change to the pending destination after cutover rather than overwriting it', async () => {
    const t = await fixture();
    t.f.options.io = {
      publishPackage: async (input, dependencies) => {
        if (input.head.status === 'active') throw new Error('hold activation after cutover');
        return publishTablePackageInMain(input, dependencies);
      },
    };
    await incomplete(new NativeTableDocumentCommands(t.f.options), await t.request());
    const staged = await pending(t);
    const data = structuredClone(staged.head.snapshot.data);
    data.cells![0][0].value = 'outside pending table edit retained';
    const changed = tablePackageHeadWithData(staged.head, data);
    await publishTablePackageInMain(
      {
        ...t.destination(),
        head: changed,
        mode: 'replace',
        expectedContentHash: staged.headContentHash,
      },
      { assertCurrent: t.f.options.captureWorkspace(t.root(), true) }
    );
    const outside = await readTablePackageInMain(t.destination());
    const source = await t.load();
    t.f.options.io = undefined;
    await t.restartNotebook();
    await incomplete(new NativeTableDocumentCommands(t.f.options), {
      kind: 'recover-promotion',
      requestId: randomUUID(),
      workspaceRoot: t.root(),
      promotionId: staged.head.promotionId!,
    });
    expect((await t.load()).sourceFileHashes).toEqual(source.sourceFileHashes);
    expect((await readTablePackageInMain(t.destination())).headText).toBe(outside.headText);
  });

  it('refuses cross-project extraction before creating a destination identity or package', async () => {
    const t = await fixture();
    const request = await t.request();
    const otherRoot = join(t.f.home, 'Other project');
    await mkdir(otherRoot);
    t.f.db
      .prepare("INSERT INTO workspaces(name,path,created_at,access_mode) VALUES(?,?,1,'writable')")
      .run('Other project', otherRoot);
    t.f.roots.push(otherRoot);
    const before = await t.load();
    const target = { workspaceRoot: otherRoot, packageRoot: join(otherRoot, 'Extracted table') };
    await expect(
      new NativeTableDocumentCommands(t.f.options).execute({ ...request, destination: target })
    ).rejects.toThrow();
    expect((await t.load()).sourceFileHashes).toEqual(before.sourceFileHashes);
    await expect(access(target.packageRoot)).rejects.toThrow();
    await expect(access(join(otherRoot, '.forge', 'project.json'))).rejects.toThrow();
    await expect(access(join(otherRoot, '.git'))).rejects.toThrow();
  });

  it('discovers interrupted extraction after service restart without exposing its archive and omits it after completion', async () => {
    const t = await fixture();
    const request = await t.request();
    t.failSourcePublication(new Error('interrupted source publication'));
    await incomplete(new NativeTableDocumentCommands(t.f.options), request);
    const staged = await pending(t);
    const before = await t.load();
    const list = await new NativeTableDocumentCommands(t.f.options).execute({
      kind: 'list-promotions',
      workspaceRoot: t.root(),
    });
    expect(list.kind).toBe('promotions');
    if (list.kind !== 'promotions')
      throw new Error('Expected bounded discoverable extraction recovery');
    expect(list.promotions).toHaveLength(1);
    expect(list.promotions[0]).toMatchObject({
      promotionId: request.requestId,
      tableId: staged.head.id,
      sourceReference,
      sourcePath: 'Notebook',
      destinationPath: 'Extracted table',
      state: 'pending',
    });
    expect(JSON.stringify(list)).not.toMatch(
      /originalBlock|originalFiles|base64|sourceFileHashes|original-before-promotion/
    );
    expect((await t.load()).sourceFileHashes).toEqual(before.sourceFileHashes);
    expect((await readTablePackageInMain(t.destination())).headText).toBe(staged.headText);
    t.failSourcePublication();
    await t.restartNotebook();
    await completed(t, await t.recover(staged.head.promotionId!));
    const finished = await new NativeTableDocumentCommands(t.f.options).execute({
      kind: 'list-promotions',
      workspaceRoot: t.root(),
    });
    expect(finished).toEqual({ kind: 'promotions', promotions: [] });
  });

  it('extracts a natively edited and saved table while preserving optional cell metadata and saved JSON semantics', async () => {
    const t = await fixture();
    const before = await t.inspectSource();
    const changed = await t.notebook.execute({
      documentId,
      expectedRevision: before.revision,
      operation: {
        kind: 'table',
        tableId: blockId,
        command: {
          kind: 'set-cell',
          row: 0,
          column: 1,
          value: 'edited through native table owner',
        },
      },
    });
    const view = new NotebookDocumentModel(changed.copy.content, changed.title);
    let position = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'embed' && node.attrs.refId === blockId) position = pos;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    const node = view.state.doc.nodeAt(position)!;
    const transaction = view.state.tr.setNodeMarkup(position, undefined, {
      ...node.attrs,
      data: { ...node.attrs.data, _fresh: undefined },
    });
    const clearedFresh = await t.notebook.execute({
      documentId,
      expectedRevision: changed.revision,
      operation: {
        kind: 'apply-steps',
        baseFingerprint: contentFingerprint(canonicalNotebookJson(changed.copy.content)),
        steps: transaction.steps.map((step) => step.toJSON()),
        separateHistory: true,
      },
    });
    const saved = await t.notebook.execute({
      documentId,
      expectedRevision: clearedFresh.revision,
      operation: { kind: 'save' },
    });
    const savedData = JSON.parse(JSON.stringify(selected(saved.copy.content).attrs!.data));
    const request = await t.request();
    const result = await completed(
      t,
      await new NativeTableDocumentCommands(t.f.options).execute(request)
    );
    expect(result.actual.head.snapshot.data).toEqual(savedData);
    expect(result.actual.head.snapshot.data.cells?.[0]?.[1]?.value).toBe(
      'edited through native table owner'
    );
    expect(result.actual.head.snapshot.data.cells?.[0]?.[0]?.format).toEqual({ bold: true });
    const intent = JSON.parse(
      await readFile(
        join(t.root(), '.forge', 'table-transitions', `${request.requestId}.json`),
        'utf8'
      )
    );
    expect(intent.source.originalBlock.attrs.data).toEqual(savedData);
  });
});
