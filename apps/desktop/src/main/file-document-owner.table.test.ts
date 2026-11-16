// @vitest-environment node

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NativeFileDocumentOwner,
  type NativeFileDocumentOwnerOptions,
  type NativeFileDocumentRecord,
} from './file-document-owner';
import { FileDocumentClient } from '../features/workspace/file-document-client';
import type {
  FileDocumentClientOperation,
  FileDocumentRequest,
  FileDocumentSnapshot,
} from '../shared/file-document';
import {
  parseTablePackageHead,
  parseTableSnapshot,
  serializeTableSnapshot,
  tablePackagePaths,
  tablePackageRevisionPath,
} from '../shared/table-package';
import { publishTablePackageInMain, readTablePackageInMain } from './table-package';
import type { TableData } from '../shared/table-document-types';

const port = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: {
      fileDocument: port.execute,
      subscribeFileDocuments: () => () => {},
    },
  }),
}));
const roots: string[] = [];
afterEach(async () => {
  port.execute.mockReset();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const documentId = '8b42f5f1-635e-4cda-a07b-8fc2531fc97e';

async function fixture() {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'rich-table-owner-')));
  roots.push(workspaceRoot);
  const packageRoot = join(workspaceRoot, 'Samples');
  const snapshot = parseTableSnapshot(
    JSON.stringify({
      schema: 'dnaforge.table-snapshot.v1',
      documentId,
      title: 'Samples',
      data: {
        rows: 1,
        cols: 2,
        cells: [
          [
            { value: 'original', type: 'text', format: { bold: true }, extension: { keep: [42] } },
            { value: '=2+3', type: 'formula', computed: 5 },
          ],
        ],
        retained: { exact: 'table metadata' },
      },
      optionalSnapshotExtension: ['retain'],
    })
  );
  const original = parseTablePackageHead(
    JSON.stringify({
      schema: 'dnaforge.table.v1',
      id: documentId,
      snapshot,
      snapshotSha256: createHash('sha256').update(serializeTableSnapshot(snapshot)).digest('hex'),
      aliases: [],
      status: 'active',
      optionalHeadExtension: ['retain'],
    })
  );
  await publishTablePackageInMain(
    { workspaceRoot, packageRoot, head: original, mode: 'create' },
    { assertCurrent() {} }
  );
  const paths = tablePackagePaths(packageRoot);
  const recordPath = join(workspaceRoot, 'recovery-record.json');
  let failure: Error | undefined;
  let pause: (() => Promise<void>) | undefined;
  const options: NativeFileDocumentOwnerOptions = {
    admit: async (path) => ({ path, workspaceRoot, readOnly: false, assertCurrent() {} }),
    identityForPath: async () => 'native-file-routing-identity',
    read: async (path) => readFile(path),
    verifyTablePackage: async (_admission, content) => {
      const verified = await readTablePackageInMain({ workspaceRoot, packageRoot });
      if (verified.headText !== content)
        throw new Error('The admitted table head changed during inspection');
    },
    write: async (input, admission) => {
      if (failure) throw failure;
      await pause?.();
      if (!input.expectedContentHash)
        throw new Error('A rich Save must capture its previous head hash');
      await publishTablePackageInMain(
        {
          workspaceRoot,
          packageRoot,
          head: parseTablePackageHead(input.content),
          mode: 'replace',
          expectedContentHash: input.expectedContentHash.replace(/^sha256:/, ''),
        },
        { assertCurrent: admission.assertCurrent }
      );
    },
    loadRecord: async () => {
      try {
        return JSON.parse(await readFile(recordPath, 'utf8')) as NativeFileDocumentRecord;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    storeRecord: async (record) => {
      await writeFile(recordPath, JSON.stringify(record));
    },
  };
  const owner = new NativeFileDocumentOwner(options);
  const inspect = (current = owner) =>
    current.execute({
      target: { path: paths.headPath },
      projection: 'document',
      operation: {
        kind: 'inspect',
        offset: 0,
        limit: 2000,
        rowOffset: 0,
        rowLimit: 20,
        columnOffset: 0,
        columnLimit: 20,
      },
    });
  const command = (before: FileDocumentSnapshot, operation: FileDocumentClientOperation) =>
    owner.execute({
      target: { documentId: before.documentId },
      expectedRevision: before.revision,
      projection: 'document',
      operation,
    });
  const client = new FileDocumentClient(paths.headPath);
  owner.subscribe((value) => client.observe(value));
  port.execute.mockImplementation((request: FileDocumentRequest) => owner.execute(request));
  return {
    workspaceRoot,
    packageRoot,
    original,
    paths,
    owner,
    options,
    client,
    inspect,
    command,
    deny: (error?: Error) => {
      failure = error;
    },
    pause: (value?: () => Promise<void>) => {
      pause = value;
    },
  };
}

async function activationFixture() {
  const f = await fixture();
  let identity = 'pending-file-binding';
  let retirementFails = true;
  let retirements = 0;
  f.options.identityForPath = async () => identity;
  f.options.retireReboundIdentity = async () => {
    retirements++;
    if (retirementFails) throw new Error('injected pending identity retirement failure');
  };
  const original = await readTablePackageInMain(f);
  const pendingHead = parseTablePackageHead(
    JSON.stringify({ ...original.head, status: 'pending-promotion', promotionId: randomUUID() })
  );
  await publishTablePackageInMain(
    { ...f, head: pendingHead, mode: 'replace', expectedContentHash: original.headContentHash },
    { assertCurrent() {} }
  );
  const pending = await f.inspect();
  expect(pending.readOnly).toBe(true);
  identity = 'active-file-binding';
  const staged = await readTablePackageInMain(f);
  await publishTablePackageInMain(
    {
      ...f,
      head: { ...pendingHead, status: 'active' },
      mode: 'replace',
      expectedContentHash: staged.headContentHash,
    },
    { assertCurrent() {} }
  );
  const active = await readTablePackageInMain(f);
  return {
    ...f,
    pending,
    active,
    get retirements() {
      return retirements;
    },
    allowRetirement() {
      retirementFails = false;
    },
  };
}

describe('rich table file working copy', () => {
  it('uses the ordinary native table owner while retaining a separate portable identity', async () => {
    const f = await fixture();
    const first = await f.inspect();
    expect(first).toMatchObject({
      type: 'table',
      ready: true,
      readOnly: false,
      dirty: false,
      tableDocument: {
        id: documentId,
        snapshotSha256: f.original.snapshotSha256,
        persistedSnapshotSha256: f.original.snapshotSha256,
        status: 'active',
      },
    });
    expect(first.documentId).not.toBe(documentId);
    expect(first.capabilities).toContain('table');
    expect(first.capabilities).not.toContain('replace-text');
    const changed = await f.command(first, {
      kind: 'table',
      command: { kind: 'set-cell', row: 0, column: 0, value: 'native edit' },
    });
    expect(changed.dirty).toBe(true);
    expect(changed.tableDocument!.persistedSnapshotSha256).toBe(f.original.snapshotSha256);
    expect(changed.tableDocument!.snapshotSha256).not.toBe(f.original.snapshotSha256);
    expect((await f.owner.listDirty())[0].kind).toBe('table');
    await expect(
      f.command(changed, { kind: 'replace-text', from: 0, to: 1, text: 'not JSON editing' })
    ).rejects.toThrow();
    const saved = await f.command(changed, { kind: 'save' });
    const actual = await readTablePackageInMain({
      workspaceRoot: f.workspaceRoot,
      packageRoot: f.packageRoot,
    });
    expect(actual.head.snapshot.data.cells![0][0]).toMatchObject({
      value: 'native edit',
      format: { bold: true },
      extension: { keep: [42] },
    });
    expect(saved.tableDocument!.persistedSnapshotSha256).toBe(actual.head.snapshotSha256);
    expect(saved.dirty).toBe(false);
  });

  it('shares the rich envelope with the renderer client instead of serializing it as CSV', async () => {
    const f = await fixture();
    await f.client.load();
    const next = structuredClone(f.client.snapshot!.tableData!) as TableData;
    next.cells![0][0].value = 'renderer edit';
    f.client.changeTable(next, false);
    expect(parseTablePackageHead(f.client.content!).snapshot.data.cells![0][0].value).toBe(
      'renderer edit'
    );
    await f.client.flush();
    const draft = parseTablePackageHead(f.client.content!);
    expect(draft.optionalHeadExtension).toEqual(['retain']);
    expect(draft.snapshot.optionalSnapshotExtension).toEqual(['retain']);
    expect(draft.snapshot.data.cells![0][1]).toMatchObject({ value: '=2+3', computed: 5 });
    await f.client.save();
    expect(f.client.dirty).toBe(false);
    expect(
      (await readTablePackageInMain({ workspaceRoot: f.workspaceRoot, packageRoot: f.packageRoot }))
        .head
    ).toEqual(draft);
  });

  it('accepts optional cell fields produced by copying without dropping retained JSON metadata', async () => {
    const f = await fixture();
    await f.client.load();
    const data = structuredClone(f.client.snapshot!.tableData!);
    data.cells![0][1] = { ...data.cells![0][1], format: undefined };
    data.cells![0][1].value = 'copied cell';
    expect(() => f.client.changeTable(data, false)).not.toThrow();
    await f.client.flush();
    await f.client.save();
    const saved = await readTablePackageInMain({
      workspaceRoot: f.workspaceRoot,
      packageRoot: f.packageRoot,
    });
    expect(saved.head.snapshot.data.cells![0][1].value).toBe('copied cell');
    expect(saved.head.snapshot.data.cells![0][0]).toMatchObject({ extension: { keep: [42] } });
    expect(saved.head.optionalHeadExtension).toEqual(['retain']);
  });

  it('keeps a denied save retryable without advancing the saved-version digest', async () => {
    const f = await fixture();
    await f.client.load();
    const next = structuredClone(f.client.snapshot!.tableData!);
    next.cells![0][0].value = 'retained draft';
    f.client.changeTable(next, false);
    await f.client.flush();
    const error = Object.assign(new Error('EPERM: controlled locked rich table'), {
      code: 'EPERM',
    });
    f.deny(error);
    await expect(f.client.save()).rejects.toBe(error);
    expect(f.client.saving).toBe(false);
    expect(f.client.dirty).toBe(true);
    expect(f.client.snapshot!.tableDocument!.persistedSnapshotSha256).toBe(
      f.original.snapshotSha256
    );
    expect(parseTablePackageHead(f.client.content!).snapshot.data.cells![0][0].value).toBe(
      'retained draft'
    );
    f.deny();
    await f.client.save();
    expect(f.client.dirty).toBe(false);
  });

  it('undoes authored rich metadata while keeping sort and filter view changes out of saved content', async () => {
    const f = await fixture();
    const initial = await f.inspect();
    const renamed = await f.command(initial, {
      kind: 'table',
      command: { kind: 'rename', name: 'Renamed table' },
    });
    expect(renamed.tableData!.name).toBe('Renamed table');
    const undone = await f.command(renamed, { kind: 'undo' });
    expect(parseTablePackageHead(undone.content!)).toEqual(f.original);
    const formatted = await f.command(undone, {
      kind: 'table',
      command: {
        kind: 'format-cells',
        range: { startRow: 0, endRow: 0, startCol: 1, endCol: 1 },
        format: { italic: true },
      },
    });
    expect(formatted.tableData!.cells![0][1].format).toMatchObject({ italic: true });
    const originalAgain = await f.command(formatted, { kind: 'undo' });
    const view = await f.command(originalAgain, {
      kind: 'table-view',
      sort: { column: 0, direction: 'asc' },
      filters: {},
    });
    expect(view.dirty).toBe(false);
    expect(parseTablePackageHead(view.content!)).toEqual(f.original);
  });

  it('publishes same-revision native metadata to rich-table client subscribers', async () => {
    const f = await fixture();
    await f.client.load();
    const initial = f.client.viewRevision;
    const snapshot = f.client.snapshot!;
    f.client.observe({ ...snapshot, saving: true });
    const saving = f.client.viewRevision;
    expect(saving).not.toBe(initial);
    f.client.observe({ ...snapshot, readOnly: true });
    expect(f.client.viewRevision).not.toBe(saving);
  });

  it('keeps rich-table dispatch and Save running when a subscriber and its logger throw', async () => {
    const f = await fixture();
    await f.client.load();
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('Controlled logging failure');
    });
    f.client.subscribe(() => {
      throw new Error('Controlled observer failure');
    });
    const next = structuredClone(f.client.snapshot!.tableData!);
    next.cells![0][0].value = 'not stranded';
    expect(() => f.client.changeTable(next, false)).not.toThrow();
    await f.client.flush();
    await f.client.save();
    expect(f.client.dirty).toBe(false);
    expect(
      (await readTablePackageInMain({ workspaceRoot: f.workspaceRoot, packageRoot: f.packageRoot }))
        .head.snapshot.data.cells![0][0].value
    ).toBe('not stranded');
  });

  it('publishes a captured saved version while retaining newer edits as a distinct draft', async () => {
    const f = await fixture();
    const initial = await f.inspect();
    const a = await f.command(initial, {
      kind: 'table',
      command: { kind: 'set-cell', row: 0, column: 0, value: 'captured A' },
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.pause(async () => {
      entered();
      await gate;
    });
    const capture = await f.command(a, { kind: 'capture-save' });
    try {
      await started;
      const b = await f.command(capture, {
        kind: 'table',
        command: { kind: 'set-cell', row: 0, column: 0, value: 'newer B' },
      });
      expect(b.tableDocument!.persistedSnapshotSha256).toBe(f.original.snapshotSha256);
    } finally {
      release();
    }
    await f.owner.execute({
      target: { documentId: capture.documentId },
      operation: { kind: 'await-save', saveCaptureId: capture.saveCaptureId! },
    });
    const current = await f.inspect();
    const actual = await readTablePackageInMain({
      workspaceRoot: f.workspaceRoot,
      packageRoot: f.packageRoot,
    });
    expect(actual.head.snapshot.data.cells![0][0].value).toBe('captured A');
    expect(current.tableData!.cells![0][0].value).toBe('newer B');
    expect(current.tableDocument!.persistedSnapshotSha256).toBe(actual.head.snapshotSha256);
    expect(current.tableDocument!.snapshotSha256).not.toBe(actual.head.snapshotSha256);
    expect(current.dirty).toBe(true);
  });

  it('recovers a retained rich draft through a new owner and preserves its original metadata', async () => {
    const f = await fixture();
    const first = await f.inspect();
    await f.command(first, {
      kind: 'table',
      command: { kind: 'set-cell', row: 0, column: 0, value: 'restart draft' },
    });
    const restarted = new NativeFileDocumentOwner(f.options);
    const offered = await f.inspect(restarted);
    expect(offered.recoveryId).toBeTruthy();
    const recovered = await restarted.execute({
      target: { documentId: offered.documentId },
      expectedRevision: offered.revision,
      operation: { kind: 'restore-recovery', recoveryId: offered.recoveryId! },
      projection: 'document',
    });
    expect(recovered.tableData!.cells![0][0].value).toBe('restart draft');
    expect(parseTablePackageHead(recovered.content!).optionalHeadExtension).toEqual(['retain']);
    expect(recovered.tableDocument!.persistedSnapshotSha256).toBe(f.original.snapshotSha256);
    expect(
      (await readTablePackageInMain({ workspaceRoot: f.workspaceRoot, packageRoot: f.packageRoot }))
        .head
    ).toEqual(f.original);
  });

  it('refuses unverified or damaged rich tables without ordinary writable JSON fallback', async () => {
    const f = await fixture();
    const unverified = new NativeFileDocumentOwner({ ...f.options, verifyTablePackage: undefined });
    const first = await f.inspect(unverified);
    expect(first).toMatchObject({ ready: false, readOnly: true });
    expect(first.type).not.toBe('text');
    expect(first.capabilities).not.toContain('replace-text');
    await rm(tablePackageRevisionPath(f.packageRoot, f.original.snapshotSha256));
    const damaged = await f.inspect(new NativeFileDocumentOwner(f.options));
    expect(damaged).toMatchObject({ ready: false, readOnly: true });
    expect(damaged.type).not.toBe('text');
  });

  it('keeps a pending promotion destination noneditable through ordinary file commands', async () => {
    const f = await fixture();
    const pending = parseTablePackageHead(
      JSON.stringify({
        ...f.original,
        status: 'pending-promotion',
        promotionId: 'bedee0ae-ffde-4be5-b7c9-1ac345b63f10',
      })
    );
    const before = await readFile(f.paths.headPath, 'utf8');
    await publishTablePackageInMain(
      {
        workspaceRoot: f.workspaceRoot,
        packageRoot: f.packageRoot,
        head: pending,
        mode: 'replace',
        expectedContentHash: createHash('sha256').update(before).digest('hex'),
      },
      { assertCurrent() {} }
    );
    const state = await f.inspect(new NativeFileDocumentOwner(f.options));
    expect(state.readOnly).toBe(true);
    expect(state.capabilities).not.toContain('save');
    expect(state.capabilities).not.toContain('table');
  });

  it('retains rich rows beyond the existing CSV preview window', async () => {
    const f = await fixture();
    const rows = Array.from({ length: 1001 }, (_, index) => [
      { value: `row-${index}`, type: 'text' },
    ]);
    const snapshot = parseTableSnapshot(
      JSON.stringify({ ...f.original.snapshot, data: { rows: rows.length, cols: 1, cells: rows } })
    );
    const next = parseTablePackageHead(
      JSON.stringify({
        ...f.original,
        snapshot,
        snapshotSha256: createHash('sha256').update(serializeTableSnapshot(snapshot)).digest('hex'),
      })
    );
    await publishTablePackageInMain(
      {
        workspaceRoot: f.workspaceRoot,
        packageRoot: f.packageRoot,
        head: next,
        mode: 'replace',
        expectedContentHash: createHash('sha256')
          .update(await readFile(f.paths.headPath))
          .digest('hex'),
      },
      { assertCurrent() {} }
    );
    const inspected = await f.inspect();
    expect(inspected.tableData!.cells).toHaveLength(1001);
    expect(inspected.tableData!.cells![1000][0].value).toBe('row-1000');
    expect(parseTablePackageHead(inspected.content!).snapshot.data.cells).toHaveLength(1001);
  });

  it('refuses rich-only cell formatting for CSV without changing its draft or bytes', async () => {
    const f = await fixture();
    const path = join(f.workspaceRoot, 'plain.csv');
    const original = 'Sample,Value\r\nA,42\r\n';
    await writeFile(path, original);
    const owner = new NativeFileDocumentOwner(f.options);
    const inspect = () =>
      owner.execute({
        target: { path },
        projection: 'document',
        operation: {
          kind: 'inspect',
          offset: 0,
          limit: 2000,
          rowOffset: 0,
          rowLimit: 20,
          columnOffset: 0,
          columnLimit: 20,
        },
      });
    const before = await inspect();
    await expect(
      owner.execute({
        target: { documentId: before.documentId },
        expectedRevision: before.revision,
        operation: {
          kind: 'table',
          command: {
            kind: 'format-cells',
            range: { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
            format: { bold: true },
          },
        },
      })
    ).rejects.toThrow();
    expect(await inspect()).toMatchObject({
      revision: before.revision,
      content: before.content,
      dirty: false,
    });
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('retries pending identity retirement after activation instead of silently bypassing failed cleanup', async () => {
    const f = await activationFixture();
    await expect(f.inspect()).rejects.toThrow(/pending identity retirement failure/);
    expect(f.retirements).toBe(1);
    f.allowRetirement();
    const active = await f.inspect();
    expect(f.retirements).toBe(2);
    expect(active).toMatchObject({
      documentId: 'active-file-binding',
      readOnly: false,
      dirty: false,
    });
    expect((await readTablePackageInMain(f)).headText).toBe(f.active.headText);
    await expect(
      f.owner.execute({
        target: { documentId: f.pending.documentId },
        operation: { kind: 'inspect' },
      })
    ).rejects.toThrow();
  });

  it('refuses a retired routing identity while activation cleanup is still unavailable', async () => {
    const f = await activationFixture();
    await expect(f.inspect()).rejects.toThrow(/pending identity retirement failure/);
    await expect(
      f.owner.execute({
        target: { documentId: f.pending.documentId },
        operation: { kind: 'inspect' },
      })
    ).rejects.toThrow();
    expect((await readTablePackageInMain(f)).headText).toBe(f.active.headText);
  });
});
