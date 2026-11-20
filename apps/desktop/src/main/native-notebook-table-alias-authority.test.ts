// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type Database from 'better-sqlite3';
import type { JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tableCommandFixture, identityTestPaths } from './__tests__/table-command-fixture';
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import type { NativeNotebookWorkingCopyOwner } from './notebook-document-owner';
import { createWorkspaceFileRelocator } from './workspace-file-relocation';
import { NativeDocumentDispatcher } from './native-document-dispatcher';
import { nativeNotebookDocumentAdapter } from './native-notebook-document-adapter';
import { NativeTableDocumentCommands } from './table-document-commands';
import { publishNotebookPackageV2InMain } from './notebook-package-authority';
import { readCanonicalNotebookPackage } from '../db/notebook-package-migration';
import { notebookPackagePaths } from '../db/notebook-package';
import { NotebookDocumentModel } from '../shared/notebook-model/document';
import { canonicalNotebookJson } from '../db/notebook-markdown-codec';
import { contentFingerprint } from '../shared/content-fingerprint';
import { stripWorkspaceScope } from '../shared/workspace-scoped-identity';
import { notebookTableReference, tableDocumentKey } from '../shared/table-document-reference';
import {
  parseTablePackageHead,
  parseTableSnapshot,
  tableSnapshotSha256,
} from '../shared/table-package';
import { writeTablePackageFiles, readTablePackageInMain } from './table-package';
import type { NativeNotebookRequest, NotebookDocumentSnapshot } from '../shared/notebook-document';

let activeDb: Database.Database;
vi.mock('./ipc/database', () => ({ getDb: () => activeDb }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getPath: (name: 'home' | 'userData') => identityTestPaths[name],
    getVersion: () => 'test',
  },
  dialog: { showErrorBox: vi.fn() },
}));

const fixtures: Awaited<ReturnType<typeof tableCommandFixture>>[] = [];
const owners: NativeNotebookWorkingCopyOwner[] = [];
const blockId = 'retired-inline-table';
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

function sourceTable(value = 'original selected value'): JSONContent {
  return {
    type: 'embed',
    attrs: {
      type: 'table',
      version: 1,
      refId: blockId,
      data: {
        name: 'Durable table',
        rows: 1,
        cols: 2,
        cells: [
          [
            { value, type: 'text', format: { italic: true } },
            { value: '=4+8', type: 'formula' },
          ],
        ],
        futureData: { retained: ['opaque', { exact: true }] },
      },
    },
  };
}

function selected(content: JSONContent): JSONContent {
  const matches: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === 'embed' && node.attrs?.refId === blockId) matches.push(node);
    node.content?.forEach(visit);
  };
  visit(content);
  expect(matches).toHaveLength(1);
  return matches[0];
}

async function packageBytes(root: string): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {};
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) result[relative(root, file)] = await readFile(file);
      else throw new Error('The controlled notebook package unexpectedly contains a link.');
    }
  };
  await visit(root);
  return result;
}

function replacementSteps(snapshot: NotebookDocumentSnapshot, block: JSONContent) {
  const model = new NotebookDocumentModel(snapshot.copy.content, snapshot.title);
  let position: number | undefined;
  model.state.doc.descendants((node, pos) => {
    if (node.type.name === 'embed' && node.attrs.refId === blockId) position = pos;
  });
  expect(position).toBeDefined();
  const node = model.state.doc.nodeAt(position!);
  expect(node?.type.name).toBe('embed');
  const transaction = model.state.tr.setNodeMarkup(position!, undefined, block.attrs);
  return {
    kind: 'apply-steps' as const,
    baseFingerprint: contentFingerprint(canonicalNotebookJson(snapshot.copy.content)),
    steps: transaction.steps.map((step) => step.toJSON()),
    separateHistory: true,
  };
}

async function fixture() {
  const f = await tableCommandFixture();
  fixtures.push(f);
  activeDb = f.db;
  let commands: NativeTableDocumentCommands;
  const makeOwner = () => {
    const relocation = createWorkspaceFileRelocator({
      db: f.options.db,
      fileDocuments: () => documents,
    });
    const notebook = createNativeNotebookWorkingCopies({
      db: f.options.db,
      workspaceRoots: f.options.workspaceRoots,
      writableWorkspaceRoots: f.options.writableWorkspaceRoots,
      captureWorkspace: f.options.captureWorkspace,
      profileDirectory: () => join(f.userData, 'native-notebooks'),
      tableDocuments: () => commands,
      relocateEntityFile: (input) => relocation.relocateEntityFile(input),
    });
    const documents = new NativeDocumentDispatcher({
      db: f.options.db,
      workspaceRoots: f.options.workspaceRoots,
      ordinary: f.files,
      adapters: [nativeNotebookDocumentAdapter(notebook)],
    });
    owners.push(notebook);
    f.options.notebookTables = notebook.tableTransitions;
    return notebook;
  };
  let native = makeOwner();
  commands = new NativeTableDocumentCommands(f.options);
  let saved = await native.create({
    title: 'Alias authority notebook',
    workspaceRoot: f.workspaceRoot,
    requestId: randomUUID(),
  });
  const documentId = saved.documentId;
  saved = await native.execute({
    documentId,
    expectedRevision: saved.revision,
    operation: {
      kind: 'splice-blocks',
      index: 0,
      deleteCount: saved.blockCount,
      blocks: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Other notebook content remains.' }],
        },
        sourceTable(),
      ],
    },
  });
  saved = await native.execute({
    documentId,
    expectedRevision: saved.revision,
    operation: { kind: 'save' },
  });
  const originalContent = structuredClone(saved.copy.content);
  const originalBlock = structuredClone(selected(saved.copy.content));
  const sourceReference = notebookTableReference(documentId, blockId);
  const destination = {
    workspaceRoot: f.workspaceRoot,
    packageRoot: join(f.workspaceRoot, 'Independent table'),
  };
  const promoted = await commands.execute({
    kind: 'promote',
    requestId: randomUUID(),
    source: sourceReference,
    expectedRevision: saved.revision,
    destination,
  });
  expect(promoted.kind).toBe('promoted');
  if (promoted.kind !== 'promoted' || promoted.table.owner.kind !== 'file')
    throw new Error('This alias acceptance requires completed real promotion.');
  const table = promoted.table;
  const inspect = () => native.execute({ documentId, operation: { kind: 'inspect-copy' } });
  const execute = (operation: NativeNotebookRequest['operation'], expectedRevision: string) =>
    native.execute({ documentId, operation, expectedRevision });
  const restart = async () => {
    await native.close();
    native = makeOwner();
    commands = new NativeTableDocumentCommands(f.options);
  };
  const restoreOutside = async (block: JSONContent) => {
    await native.close();
    const ops = {
      readTextFile: (path: string) => readFile(path, 'utf8'),
      exists: async (path: string) => {
        try {
          await access(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return false;
        }
      },
    };
    const current = await readCanonicalNotebookPackage(ops, saved.path);
    const content = structuredClone(originalContent);
    const index = content.content!.findIndex((item) => item.attrs?.refId === blockId);
    content.content![index] = structuredClone(block);
    await publishNotebookPackageV2InMain({
      workspaceRoot: f.workspaceRoot,
      packageRoot: saved.path,
      id: stripWorkspaceScope(documentId),
      title: current.parsed.title,
      content,
      sourceShape: 'v2-package',
      existingMetadataRaw: await readFile(notebookPackagePaths(saved.path).metaPath, 'utf8'),
      expectedCanonicalFingerprint: contentFingerprint(current.markdown),
      preservedPreamble: current.parsed.preservedPreamble,
      preservedTitleProjection: current.parsed.preservedTitleProjection,
    });
    return content;
  };
  return {
    f,
    table,
    sourceReference,
    originalBlock,
    originalContent,
    destination,
    documentId,
    sourcePath: saved.path,
    inspect,
    execute,
    restart,
    restoreOutside,
    get commands() {
      return commands;
    },
  };
}

function assertCanonical(
  snapshot: NotebookDocumentSnapshot,
  t: Awaited<ReturnType<typeof fixture>>
) {
  const block = selected(snapshot.copy.content);
  expect(block.attrs?.type).toBe('table-reference');
  expect(tableDocumentKey(block.attrs?.data.reference)).toBe(tableDocumentKey(t.table.reference));
  expect(block.attrs?.data).not.toHaveProperty('cells');
}

async function attempt(operation: () => Promise<unknown>) {
  return operation().then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

describe('retired inline table native authority', () => {
  it('keeps exact Undo and Redo inside the rich table owner and prevents a fresh inline writer', async () => {
    const t = await fixture();
    const original = await readTablePackageInMain(t.destination);
    for (const kind of ['undo', 'redo'] as const) {
      const before = await t.inspect();
      await attempt(() => t.execute({ kind }, before.revision));
      const after = await t.inspect();
      assertCanonical(after, t);
      expect(after.dirty).toBe(false);
      expect((await readTablePackageInMain(t.destination)).headText).toBe(original.headText);
    }
    const before = await t.inspect();
    const changed = await attempt(() =>
      t.execute(
        {
          kind: 'table',
          tableId: blockId,
          command: {
            kind: 'set-cell',
            row: 0,
            column: 0,
            value: 'edit through retired alias',
          },
        },
        before.revision
      )
    );
    const after = await t.inspect();
    assertCanonical(after, t);
    expect(after.dirty).toBe(false);
    if ('value' in changed) {
      if (t.table.owner.kind !== 'file') throw new Error('Expected a real file owner.');
      const rich = await t.f.inspect(t.table.owner.path);
      const head = parseTablePackageHead(rich.content!);
      expect(head.snapshot.data.cells?.[0]?.[0]?.value).toBe('edit through retired alias');
    }
  });

  it('canonicalizes exact originals inserted by splice or renderer transaction before they can become writable', async () => {
    const t = await fixture();
    const richBefore = await readTablePackageInMain(t.destination);
    for (const route of ['splice', 'steps'] as const) {
      const before = await t.inspect();
      const index = before.copy.content.content!.findIndex(
        (block) => block.attrs?.refId === blockId
      );
      const operation =
        route === 'splice'
          ? {
              kind: 'splice-blocks' as const,
              index,
              deleteCount: 1,
              blocks: [structuredClone(t.originalBlock)],
            }
          : replacementSteps(before, t.originalBlock);
      await attempt(() => t.execute(operation, before.revision));
      const after = await t.inspect();
      assertCanonical(after, t);
      expect(after.dirty).toBe(false);
      expect((await readTablePackageInMain(t.destination)).headText).toBe(richBefore.headText);
    }
    const resolved = await t.commands.execute({
      kind: 'resolve',
      reference: t.sourceReference,
      context: { workspaceRoot: t.f.workspaceRoot },
    });
    expect(resolved.kind).toBe('resolved');
    if (resolved.kind === 'resolved')
      expect(tableDocumentKey(resolved.table.reference)).toBe(tableDocumentKey(t.table.reference));
  });

  it('preserves a divergent outside restoration and makes the whole notebook read-only across every native mutation route', async () => {
    const t = await fixture();
    const divergent = structuredClone(t.originalBlock);
    divergent.attrs!.data.cells[0][0].value = 'outside divergent version must remain exact';
    const restored = await t.restoreOutside(divergent);
    const sourceBytes = await packageBytes(t.sourcePath);
    const rich = await readTablePackageInMain(t.destination);
    await t.restart();
    let state = await t.inspect();
    expect(state.readOnly).toBe(true);
    expect(selected(state.copy.content).attrs?.data).toEqual(selected(restored).attrs?.data);
    const index = state.copy.content.content!.findIndex((block) => block.attrs?.refId === blockId);
    const operations: NativeNotebookRequest['operation'][] = [
      {
        kind: 'table',
        tableId: blockId,
        command: {
          kind: 'set-cell',
          row: 0,
          column: 0,
          value: 'must not overwrite conflict',
        },
      },
      { kind: 'undo' },
      { kind: 'redo' },
      { kind: 'save' },
      {
        kind: 'splice-blocks',
        index,
        deleteCount: 1,
        blocks: [t.originalBlock],
      },
      replacementSteps(state, t.originalBlock),
    ];
    for (const operation of operations) {
      await expect(t.execute(operation, state.revision)).rejects.toThrow();
      state = await t.inspect();
      expect(state.readOnly).toBe(true);
      expect(selected(state.copy.content).attrs?.data).toEqual(selected(restored).attrs?.data);
    }
    expect(await packageBytes(t.sourcePath)).toEqual(sourceBytes);
    expect((await readTablePackageInMain(t.destination)).headText).toBe(rich.headText);
    await t.restart();
    expect((await t.inspect()).readOnly).toBe(true);
    expect(await packageBytes(t.sourcePath)).toEqual(sourceBytes);
  });

  it('refuses two verified active packages claiming one old alias without picking or changing either table', async () => {
    const t = await fixture();
    const original = await readTablePackageInMain(t.destination);
    const id = randomUUID();
    const snapshot = parseTableSnapshot(
      JSON.stringify({
        ...original.snapshot,
        documentId: id,
        title: 'Second alias claimant',
      })
    );
    const head = parseTablePackageHead(
      JSON.stringify({
        ...original.head,
        id,
        snapshot,
        snapshotSha256: await tableSnapshotSha256(snapshot),
      })
    );
    const otherLocation = {
      workspaceRoot: t.f.workspaceRoot,
      packageRoot: join(t.f.workspaceRoot, 'Conflicting alias'),
    };
    await writeTablePackageFiles(
      { ...otherLocation, head, mode: 'create' },
      { assertCurrent: t.f.options.captureWorkspace(t.f.workspaceRoot, true) }
    );
    const second = await readTablePackageInMain(otherLocation);
    await expect(
      t.commands.execute({
        kind: 'resolve',
        reference: t.sourceReference,
        context: { workspaceRoot: t.f.workspaceRoot },
      })
    ).rejects.toThrow();
    await t.restoreOutside(t.originalBlock);
    const sourceBytes = await packageBytes(t.sourcePath);
    await t.restart();
    const inspected = await attempt(t.inspect);
    if ('value' in inspected) {
      const state = inspected.value as NotebookDocumentSnapshot;
      expect(state.readOnly).toBe(true);
      expect(selected(state.copy.content).attrs?.data).toEqual(t.originalBlock.attrs?.data);
      await expect(
        t.execute(
          {
            kind: 'table',
            tableId: blockId,
            command: {
              kind: 'set-cell',
              row: 0,
              column: 0,
              value: 'must not choose a claimant',
            },
          },
          state.revision
        )
      ).rejects.toThrow();
    } else expect(String(inspected.error)).toMatch(/alias|ambigu|multiple/i);
    expect(await packageBytes(t.sourcePath)).toEqual(sourceBytes);
    expect((await readTablePackageInMain(t.destination)).headText).toBe(original.headText);
    expect((await readTablePackageInMain(otherLocation)).headText).toBe(second.headText);
  });

  it('retains a divergent legacy recovery record without restoring another writable inline authority', async () => {
    const t = await fixture();
    const divergent = structuredClone(t.originalContent);
    selected(divergent).attrs!.data.cells[0][0].value = 'retained pre-extraction draft';
    const sourceBytes = await packageBytes(t.sourcePath);
    const rich = await readTablePackageInMain(t.destination);
    const before = await t.inspect();
    const retained = await t.execute(
      {
        kind: 'retain-legacy-recovery',
        baseline: canonicalNotebookJson(t.originalContent),
        content: divergent,
      },
      before.revision
    );
    expect(retained.recovery?.content).toEqual(divergent);
    expect(retained.readOnly).toBe(true);
    await expect(t.execute({ kind: 'restore-recovery' }, retained.revision)).rejects.toThrow();
    const after = await t.inspect();
    expect(after.readOnly).toBe(true);
    expect(after.recovery?.content).toEqual(divergent);
    assertCanonical(after, t);
    expect(await packageBytes(t.sourcePath)).toEqual(sourceBytes);
    expect((await readTablePackageInMain(t.destination)).headText).toBe(rich.headText);
    await t.restart();
    const restarted = await t.inspect();
    expect(restarted.readOnly).toBe(true);
    expect(restarted.recovery?.content).toEqual(divergent);
    assertCanonical(restarted, t);
  });
});
