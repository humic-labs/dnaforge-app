// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type {
  InventoryCommand,
  InventoryScientificTransferChoices,
} from '@waypoint/domain-services';
import type {
  InventoryApplyScientificTransferRequest,
  NativeInventoryReceipt,
} from '../shared/inventory-command';
import type {
  InventoryScientificContextsSnapshot,
  InventoryScientificSourceRead,
  InventoryScientificTransferPreviewSnapshot,
} from '../shared/inventory-client';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import { notebookPackagePaths } from '../db/notebook-package';

let db: Database.Database;
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test', exit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => db }));
vi.mock('./config', () => ({ getApiUrl: () => 'http://synthetic-grants.invalid' }));
import { openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { NativeDocumentWorkspaces } from './native-document-workspaces';
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { createNativeAgentGrantAuthorizer } from './agent-grant-authority';

it('records one notebook-observed physical transfer through real native HTTP and file SQLite', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-scientific-work-')));
  const projectPath = join(root, 'project'),
    otherPath = join(root, 'other');
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  const dbPath = join(root, 'inventory.sqlite');
  const scope = { project: 'scientific-project', inventoryId: 'scientific-inventory' };
  const writer = {
    identityId: 'scientific-writer',
    capabilities: ['read-workspace', 'write-workspace'],
  };
  const reader = { ...writer, capabilities: ['read-workspace'] };
  const projectScope = { kind: 'project-roots' as const, roots: [projectPath] };
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-scientific-native-acceptance.v1',
    status: 'running',
    root,
  };
  const trace: unknown[] = [],
    events: unknown[] = [];
  evidence.trace = trace;
  const evidenceDir = process.env.INVENTORY_SCIENTIFIC_EVIDENCE_DIR;
  let notebook!: ReturnType<typeof createNativeNotebookWorkingCopies>;
  let owner!: ReturnType<typeof createNativeInventoryOwner>;
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  let generation = 0,
    grantCalls = 0,
    revokedAfter = Infinity;
  let authority = { ownerInstanceId: '', token: '' };
  const raw = () => ({
    state: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
    journal: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
    events: [...events],
  });
  async function start() {
    authority = {
      ownerInstanceId: `scientific-native-${++generation}`,
      token: `synthetic-scientific-${generation}`,
    };
    const projectAuthority = createRegisteredProjectAuthority({
      db: () => db,
      managedRootDir: () => join(root, 'managed'),
    });
    const workspaces = new NativeDocumentWorkspaces({ authority: projectAuthority });
    notebook = createNativeNotebookWorkingCopies({
      db: () => db,
      registeredProjects: projectAuthority,
      workspaceRoots: () => workspaces.readableRoots(),
      writableWorkspaceRoots: () => workspaces.roots(),
      profileDirectory: () => join(root, 'profile'),
      captureWorkspace: (path, mutating) =>
        mutating ? workspaces.capture(path) : workspaces.captureReadable(path),
      relocateEntityFile: async () => {
        throw Error('Unrelated relocation');
      },
    });
    await notebook.completeLegacyMigration([]);
    owner = createNativeInventoryOwner({
      db: () => db,
      projectAuthority,
      notebookSources: notebook,
      actor: () => 'native:scientific',
      profileKey: 'a'.repeat(64),
      now: () => 1_700_000_000_000,
    });
    owner.initialize();
    owner.subscribe((event) => events.push(event));
    server = await startNativeDocumentCommandServer({
      owner: {
        inspect: async () => {
          throw Error('Unrelated annotation');
        },
        apply: async () => {
          throw Error('Unrelated annotation');
        },
        close: async () => {},
      },
      inventory: owner,
      notebookOwner: notebook,
      projectAuthority,
      authorizeInventoryAgent: createNativeAgentGrantAuthorizer(
        async () =>
          Response.json({
            ok: true,
            grants: [
              {
                id: writer.identityId,
                scopes: writer.capabilities,
                revokedAt: ++grantCalls > revokedAfter ? '2026-01-01T00:00:00Z' : null,
                expiresAt: null,
              },
            ],
            hasMore: false,
          }),
        'INVENTORY'
      ),
      getAuthority: () => authority,
    });
  }
  async function call(label: string, command: string, request: unknown, agent = writer) {
    const before = raw();
    const response = await fetch(`${server!.url}/internal/native-documents/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Native-Document-Authority': authority.token,
      },
      body: JSON.stringify({
        ownerInstanceId: authority.ownerInstanceId,
        projectScope,
        command,
        request,
        agent,
      }),
    });
    const body = (await response.json()) as { ok: boolean; result?: Record<string, unknown> };
    const after = raw();
    trace.push({
      label,
      command,
      request,
      agent,
      status: response.status,
      body,
      inventoryUnchanged:
        canonicalNativeMutationRequest(before) === canonicalNativeMutationRequest(after),
    });
    return { body, before, after, status: response.status };
  }
  async function result<T>(
    label: string,
    command: string,
    request: unknown,
    key: string,
    agent = writer
  ): Promise<T> {
    const value = await call(label, command, request, agent);
    expect(value.status, label).toBe(200);
    expect(value.body.ok, label).toBe(true);
    expect(value.body.result, label).toHaveProperty(key);
    return value.body.result![key] as T;
  }
  async function execute(id: string, commands: readonly InventoryCommand[]) {
    const receipt = await result<NativeInventoryReceipt>(
      id,
      'inventory.execute',
      {
        ...scope,
        operationId: id,
        expectedRevision: owner.inspect(scope)?.revision ?? 0,
        commands,
      },
      'execution'
    );
    expect(receipt.status).toBe('committed');
    return receipt;
  }
  async function preview(choices: InventoryScientificTransferChoices) {
    const before = raw();
    const value = await result<InventoryScientificTransferPreviewSnapshot>(
      'preview',
      'inventory.preview-scientific-transfer',
      { ...scope, expectedRevision: owner.inspect(scope)!.revision, choices },
      'preview'
    );
    expect(raw()).toEqual(before);
    return value;
  }
  function application(
    preview: InventoryScientificTransferPreviewSnapshot,
    operationId: string,
    choices: InventoryScientificTransferChoices
  ): InventoryApplyScientificTransferRequest {
    if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
    return {
      ...scope,
      kind: 'record-scientific-transfer',
      operationId,
      expectedRevision: preview.target.revision,
      choices,
      expectedPlanDigest: preview.planDigest,
    };
  }
  async function refused(
    label: string,
    request: InventoryApplyScientificTransferRequest,
    agent = writer
  ) {
    const value = await call(label, 'inventory.apply-scientific-transfer', request, agent);
    expect(value.after, label).toEqual(value.before);
    const execution = value.body.result?.execution as { status: string } | undefined;
    expect(
      execution?.status === 'rejected' || value.body.result?.ok === false || !value.body.ok,
      label
    ).toBe(true);
    return value;
  }
  async function lostAck(request: InventoryApplyScientificTransferRequest) {
    const address = new URL(server!.url),
      socket = createConnection({ host: address.hostname, port: Number(address.port) });
    socket.pause();
    socket.on('error', () => {});
    try {
      await new Promise<void>((accept, reject) => {
        socket.once('connect', accept);
        socket.once('error', reject);
      });
      const body = JSON.stringify({
        ownerInstanceId: authority.ownerInstanceId,
        projectScope,
        command: 'inventory.apply-scientific-transfer',
        request,
        agent: writer,
      });
      await new Promise<void>((accept, reject) =>
        socket.write(
          [
            'POST /internal/native-documents/call HTTP/1.1',
            `Host: ${address.host}`,
            'Content-Type: application/json',
            `X-DNAForge-Native-Document-Authority: ${authority.token}`,
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'),
          (error) => (error ? reject(error) : accept())
        )
      );
      let receipt: NativeInventoryReceipt | null = null;
      for (let attempt = 0; attempt < 300 && !receipt; attempt++) {
        receipt = owner.operation({ ...scope, operationId: request.operationId });
        if (!receipt) await new Promise((accept) => setTimeout(accept, 5));
      }
      expect(receipt).not.toBeNull();
      expect(socket.bytesRead).toBe(0);
      evidence.lostAcknowledgement = { request, responseBytesRead: socket.bytesRead, receipt };
      return receipt!;
    } finally {
      socket.destroy();
    }
  }
  db = openFileTestDb(dbPath);
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Scientific',?,'scientific-project','writable',1)"
    ).run(projectPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(42,'Other',?,'other-project','writable',1)"
    ).run(otherPath);
    rememberOriginalDefaultProject(db, 41);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('science-schema','entity','science','Science','{}','science-schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('science-schema-v1','science-schema',1,'{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('science-material','record','science-schema','science-schema-v1','Synthetic material','{}',41,'registered',1,1)"
    ).run();
    await start();
    const page = await notebook.create({
      title: 'Aliquot experiment',
      workspaceRoot: projectPath,
      requestId: 'science-page',
    });
    const other = await notebook.create({
      title: 'Aliquot experiment',
      workspaceRoot: otherPath,
      requestId: 'science-other-page',
    });
    const inspectedPage = await notebook.execute({
      documentId: page.pageId,
      operation: { kind: 'inspect-copy' },
    });
    const editedPage = await notebook.execute({
      documentId: page.pageId,
      expectedRevision: inspectedPage.revision,
      requestId: 'edit-original-scientific-notebook',
      operation: {
        kind: 'splice-blocks',
        index: 0,
        deleteCount: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'A completed manual aliquot into permanent well A1.' }],
          },
        ],
      },
    });
    const savedPage = await notebook.execute({
      documentId: page.pageId,
      expectedRevision: editedPage.revision,
      requestId: 'save-original-scientific-notebook',
      operation: { kind: 'save' },
    });
    expect(savedPage.dirty).toBe(false);
    expect(savedPage.saving).toBe(false);
    expect(savedPage.publication?.status).toBe('settled');
    expect(JSON.stringify(savedPage.copy.content)).toContain('A completed manual aliquot');
    evidence.sourceNotebookLifecycle = {
      created: page.pageId,
      inspected: inspectedPage.revision,
      edited: editedPage.revision,
      saved: savedPage.revision,
      publication: savedPage.publication,
    };
    await execute('seed-physical', [
      {
        kind: 'create-vessel',
        id: 'source-vessel',
        name: 'Source vial',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'receive-stock',
        id: 'source-stock',
        vesselId: 'source-vessel',
        materialId: 'science-material',
        quantity: { kind: 'known', value: '100', unit: 'uL' },
        quality: 'usable',
      },
      {
        kind: 'create-layout-storage',
        id: 'plate',
        name: 'Permanent reaction plate',
        layout: { kind: 'fixed-well', rows: 1, columns: 3 },
        placement: { kind: 'root' },
      },
    ]);
    const contexts = await result<InventoryScientificContextsSnapshot>(
      'same-project clean contexts',
      'inventory.scientific-contexts',
      scope,
      'contexts',
      reader
    );
    expect(contexts.pages).toHaveLength(1);
    expect(contexts.pages[0].pageId).toBe(page.pageId);
    const choices: InventoryScientificTransferChoices = {
      identity: { namespace: 'manual-observations', workId: 'work-001' },
      pageId: page.pageId,
      expectedSourceSha256: contexts.pages[0].sourceSha256,
      sourceStockId: 'source-stock',
      destinationVesselId: 'well:plate#A1',
      quantity: { value: '10', unit: 'uL' },
      reason: 'Operator reports completed manual aliquot into permanent A1',
    };
    expect((await preview({ ...choices, pageId: other.pageId })).kind).toBe('blocked');
    const ready = await preview(choices);
    expect(ready.kind).toBe('ready');
    const request = application(ready, 'lost-scientific-ack', choices);
    await refused('read-only cannot record', request, reader);
    const receipt = await lostAck(request);
    expect(receipt.context?.version).toBe(7);
    expect(
      receipt.context?.scientificSource?.schema === 'dnaforge.notebook-saved-source.v1'
        ? receipt.context.scientificSource.pageId
        : null
    ).toBe(page.pageId);
    expect(receipt.requestDigest).toBe(
      `sha256:${createHash('sha256').update(canonicalNativeMutationRequest(request)).digest('hex')}`
    );
    const work = Object.values(owner.inspect(scope)!.scientificWorks)[0];
    expect(work.effects.source.before.quantity).toEqual({
      kind: 'known',
      value: '100',
      unit: 'uL',
    });
    expect(work.effects.source.after.quantity).toEqual({ kind: 'known', value: '90', unit: 'uL' });
    expect(work.effects.destination.after.quantity).toEqual({
      kind: 'known',
      value: '10',
      unit: 'uL',
    });
    const retained = await result<InventoryScientificSourceRead>(
      'retained structured source',
      'inventory.scientific-source',
      { ...scope, workId: work.id },
      'result',
      reader
    );
    expect(retained.kind).toBe('available');
    await execute('later-source-use', [
      {
        kind: 'consume',
        stockId: 'source-stock',
        quantity: { value: '5', unit: 'uL' },
        reason: 'Later work independent of original aliquot',
      },
    ]);
    expect((await preview(choices)).kind).toBe('no-change');
    await refused('fresh-operation duplicate no debit', {
      ...request,
      operationId: 'fresh-duplicate',
      expectedRevision: owner.inspect(scope)!.revision,
    });
    const secondChoices = {
      ...choices,
      identity: { ...choices.identity, workId: 'work-002' },
      destinationVesselId: 'well:plate#A2',
    };
    const secondRequest = application(
      await preview(secondChoices),
      'second-scientific',
      secondChoices
    );
    const currentPage = await notebook.execute({
      documentId: page.pageId,
      operation: { kind: 'inspect-copy' },
    });
    const dirtyPage = await notebook.execute({
      documentId: page.pageId,
      expectedRevision: currentPage.revision,
      requestId: 'dirty-page-observation',
      operation: {
        kind: 'splice-blocks',
        index: 0,
        deleteCount: 0,
        blocks: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Unsaved experiment notes' }] },
        ],
      },
    });
    expect((await preview(secondChoices)).kind).toBe('blocked');
    await refused('dirty notebook refuses recording', secondRequest);
    await notebook.execute({
      documentId: page.pageId,
      expectedRevision: dirtyPage.revision,
      requestId: 'discard-dirty-test-page',
      operation: { kind: 'discard' },
    });
    const path = notebookPackagePaths(page.path).markdownPath,
      original = readFileSync(path, 'utf8');
    writeFileSync(path, original + '\nExternal source edit\n');
    await refused('edited source refuses old preview', secondRequest);
    writeFileSync(path, original);
    db.exec(
      "CREATE TRIGGER scientific_late_archive AFTER INSERT ON inventory_journal WHEN NEW.operation_id='late-page-archive' BEGIN UPDATE catalog_entities SET status='archived' WHERE id='" +
        page.pageId.replaceAll("'", "''") +
        "'; END"
    );
    await refused('late page archive rolls back all inventory and source identity SQL', {
      ...secondRequest,
      operationId: 'late-page-archive',
    });
    expect(db.prepare('SELECT status FROM catalog_entities WHERE id=?').get(page.pageId)).toEqual({
      status: 'active',
    });
    db.exec('DROP TRIGGER scientific_late_archive');
    db.function('change_scientific_source', () => {
      writeFileSync(path, original + '\nChanged after journal insert\n');
      return 1;
    });
    db.exec(
      "CREATE TRIGGER scientific_late_source AFTER INSERT ON inventory_journal WHEN NEW.operation_id='late-source-change' BEGIN SELECT change_scientific_source(); END"
    );
    await refused('late actual source edit rolls back inventory', {
      ...secondRequest,
      operationId: 'late-source-change',
    });
    expect(readFileSync(path, 'utf8')).toContain('Changed after journal insert');
    evidence.externalFileSideEffectRetainedThenRestored = true;
    db.exec('DROP TRIGGER scientific_late_source');
    writeFileSync(path, original);
    revokedAfter = grantCalls + 1;
    await refused('grant revoked during source capture refuses before commit', {
      ...secondRequest,
      operationId: 'late-grant-revocation',
    });
    revokedAfter = Infinity;
    db.prepare('UPDATE workspaces SET archived_at=1 WHERE id=41').run();
    await refused('archived inventory project cannot record', secondRequest);
    db.prepare('UPDATE workspaces SET archived_at=NULL WHERE id=41').run();
    const snapshot = owner.exportSnapshot({ ...scope, format: 'native-v1' });
    let sourceText = snapshot.sourceText;
    for (const inventoryId of ['adopted-1', 'adopted-2']) {
      const target = { project: scope.project, inventoryId };
      const preview = owner.previewImport({
        ...target,
        sourceText,
        options: {
          bindings: [
            { sourceMaterialId: 'science-material', destinationMaterialId: 'science-material' },
          ],
        },
      });
      expect(preview.kind).toBe('ready');
      if (preview.kind !== 'ready') throw Error('Adoption preview');
      expect(
        owner.applyImport({
          ...target,
          kind: 'adopt-archive',
          operationId: `adopt-${inventoryId}`,
          expectedRevision: 0,
          sourceText,
          options: preview.options,
          expectedPlanDigest: preview.planDigest,
        }).status
      ).toBe('committed');
      expect(owner.scientificSource({ ...target, workId: work.id })).toEqual(retained);
      sourceText = owner.exportSnapshot({ ...target, format: 'native-v1' }).sourceText;
    }
    const beforeRestart = raw();
    await server!.close();
    server = undefined;
    await notebook.close();
    db.close();
    db = openFileTestDb(dbPath);
    await start();
    expect(raw()).toEqual(beforeRestart);
    rmSync(page.path, { recursive: true, force: true });
    const beforeRetry = raw();
    expect(await owner.applyScientificTransfer(request)).toEqual(receipt);
    expect((await preview(choices)).kind).toBe('no-change');
    await refused('fresh duplicate after source removal', {
      ...request,
      operationId: 'duplicate-after-removal',
    });
    expect(
      await result<InventoryScientificSourceRead>(
        'source retained after notebook removal and restart',
        'inventory.scientific-source',
        { ...scope, workId: work.id },
        'result',
        reader
      )
    ).toEqual(retained);
    expect(raw()).toEqual(beforeRetry);
    evidence.finalState = owner.inspect(scope);
    evidence.originalReceipt = receipt;
    evidence.retainedSource = retained;
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure = error instanceof Error ? error.stack : String(error);
    throw error;
  } finally {
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'acceptance.json'), JSON.stringify(evidence, null, 2));
    }
    await server?.close();
    await notebook?.close();
    db?.close();
    if (!evidenceDir) rmSync(root, { recursive: true, force: true });
  }
});
