// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  inventoryTableBindingKey,
  inventoryVesselContents,
  inventoryWellId,
  type InventoryCommand,
} from '@waypoint/domain-services';
import { benchlingCaptureChoices } from '../../../../packages/core/domain-services/src/__tests__/benchling-capture-fixture';
import type {
  InventoryExecuteRequest,
  InventoryApplyBenchlingCaptureRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../shared/inventory-command';
import type {
  InventoryBenchlingCapturePreviewSnapshot,
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
} from '../shared/inventory-client';
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
}));
vi.mock('./config', () => ({ getApiUrl: () => 'http://synthetic-grants.invalid' }));
import { openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { createNativeInventoryOwner } from './inventory-owner';
import { findNativeInventorySourcePreimages } from './inventory-source-preimages';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { createNativeAgentGrantAuthorizer } from './agent-grant-authority';
type Command =
  | 'inventory.execute'
  | 'inventory.preview-benchling-capture'
  | 'inventory.apply-benchling-capture'
  | 'inventory.export-snapshot'
  | 'inventory.preview-import'
  | 'inventory.apply-import';
type Agent = { identityId: string; capabilities: string[] };
interface WireResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  accepted?: boolean;
}
const writer = {
  identityId: 'capture-writer',
  capabilities: ['read-workspace', 'write-workspace'],
};
const adopter = {
  identityId: 'capture-adopter',
  capabilities: ['read-workspace', 'write-workspace'],
};
const hash = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const sourceText = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../../test-fixtures/lims-import/benchling-physical/representative-capture.json'
  ),
  'utf8'
);
const namespace = 'benchling:synthetic-physical-example';
it('imports physical capture atomically through native HTTP, preserves local work and replays exact retained source', async () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'dnaforge-inventory-benchling-application-'))
  );
  const dbPath = join(root, 'inventory.sqlite');
  const projectPath = join(root, 'project');
  const otherPath = join(root, 'other-project');
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  const scope = { project: 'capture-project', inventoryId: 'capture-inventory' };
  const target = { ...scope, inventoryId: 'capture-adopted' };
  const profileKey = 'a'.repeat(64);
  const projectScope = { kind: 'project-roots', roots: [projectPath] };
  const events: unknown[] = [];
  const trace: unknown[] = [];
  let db: Database.Database = openFileTestDb(dbPath);
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  let owner!: ReturnType<typeof createNativeInventoryOwner>;
  let authority = { ownerInstanceId: 'capture-native-0', token: 'synthetic-contents-token-0' };
  let instance = 0;
  let revokedAt: string | null = null;
  let clock = 1_700_000_000_000;
  const evidenceRoot = process.env.INVENTORY_BENCHLING_APPLICATION_EVIDENCE_DIR;
  const evidencePath = evidenceRoot
    ? (() => {
        mkdirSync(resolve(evidenceRoot), { recursive: true });
        return join(mkdtempSync(join(resolve(evidenceRoot), 'native-')), 'acceptance.json');
      })()
    : null;
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-benchling-application-native-acceptance.v1',
    runtime:
      'Real loopback HTTP, native inventory owner and file-backed SQLite; synthetic project/scientific fixtures',
    status: 'running',
    trace,
  };
  const raw = () => ({
    states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
    journal: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
    totalChanges: db.prepare('SELECT total_changes() AS count').get(),
    events: [...events],
  });
  const summary = (value: ReturnType<typeof raw>) => ({
    stateSha256: hash(value.states),
    journalSha256: hash(value.journal),
    totalChanges: value.totalChanges,
    events: value.events.length,
  });
  async function start() {
    authority = {
      ownerInstanceId: `capture-native-${++instance}`,
      token: `synthetic-contents-token-${instance}`,
    };
    const projectAuthority = createRegisteredProjectAuthority({
      db: () => db,
      managedRootDir: () => join(root, 'managed'),
    });
    owner = createNativeInventoryOwner({
      db: () => db,
      projectAuthority,
      actor: () => `native:${authority.ownerInstanceId}`,
      profileKey,
      now: () => clock,
    });
    owner.initialize();
    owner.subscribe((event) => events.push(event));
    server = await startNativeDocumentCommandServer({
      owner: {
        inspect: async () => {
          throw new Error('Unrelated annotation route invoked.');
        },
        apply: async () => {
          throw new Error('Unrelated annotation route invoked.');
        },
        close: async () => {},
      },
      inventory: owner,
      projectAuthority,
      authorizeInventoryAgent: createNativeAgentGrantAuthorizer(
        async () =>
          Response.json({
            ok: true,
            grants: [writer, adopter].map((agent) => ({
              id: agent.identityId,
              scopes: ['read-workspace', 'write-workspace'],
              revokedAt,
              expiresAt: null,
            })),
            hasMore: false,
          }),
        'INVENTORY'
      ),
      getAuthority: () => authority,
    });
  }
  async function call(
    label: string,
    command: Command,
    request: unknown,
    agent: Agent = writer,
    roots = projectScope.roots
  ) {
    const before = raw();
    const response = await fetch(`${server!.url}/internal/native-documents/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Native-Document-Authority': authority.token,
      },
      body: JSON.stringify({
        ownerInstanceId: authority.ownerInstanceId,
        projectScope: { kind: 'project-roots', roots },
        command,
        request,
        agent,
      }),
    });
    const body = (await response.json()) as WireResponse;
    const after = raw();
    trace.push({
      label,
      command,
      request,
      agent,
      status: response.status,
      body,
      before: summary(before),
      after: summary(after),
    });
    return { status: response.status, body, before, after };
  }
  async function success<T>(
    label: string,
    command: Command,
    request: unknown,
    agent = writer
  ): Promise<T> {
    const response = await call(label, command, request, agent);
    expect(response.status, label).toBe(200);
    expect(response.body.ok, label).toBe(true);
    const key = {
      'inventory.execute': 'execution',
      'inventory.preview-benchling-capture': 'preview',
      'inventory.apply-benchling-capture': 'execution',
      'inventory.export-snapshot': 'artifact',
      'inventory.preview-import': 'preview',
      'inventory.apply-import': 'execution',
    }[command];
    expect(response.body.result, label).toHaveProperty(key);
    return response.body.result![key] as T;
  }
  function request(
    operationId: string,
    commands: readonly InventoryCommand[]
  ): InventoryExecuteRequest {
    return {
      ...scope,
      operationId,
      expectedRevision: owner.inspect(scope)?.revision ?? 0,
      commands,
    };
  }
  async function execute(operationId: string, commands: readonly InventoryCommand[]) {
    clock += 1;
    const result = await success<NativeInventoryExecution>(
      operationId,
      'inventory.execute',
      request(operationId, commands)
    );
    expect(result.status, operationId).toBe('committed');
    return result as NativeInventoryReceipt;
  }
  async function refuse(operationId: string, commands: readonly InventoryCommand[], code: string) {
    const response = await call(operationId, 'inventory.execute', request(operationId, commands));
    expect(response.body.result?.execution, operationId).toMatchObject({
      status: 'rejected',
      code,
    });
    expect(response.after, operationId).toEqual(response.before);
    return response;
  }
  async function loseAcknowledgement(input: InventoryApplyBenchlingCaptureRequest) {
    const address = new URL(server!.url);
    const socket = createConnection({ host: address.hostname, port: Number(address.port) });
    socket.pause();
    const attempt: Record<string, unknown> = { request: input, responseBodyConsumed: false };
    evidence.lostAcknowledgement = attempt;
    socket.on('error', (error) => {
      attempt.socketError = error.message;
    });
    try {
      await new Promise<void>((accept, reject) => {
        socket.once('connect', accept);
        socket.once('error', reject);
      });
      const body = JSON.stringify({
        ownerInstanceId: authority.ownerInstanceId,
        projectScope,
        command: 'inventory.apply-benchling-capture',
        request: input,
        agent: writer,
      });
      await new Promise<void>((accept, reject) => {
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
        );
      });
      const deadline = Date.now() + 2000;
      let receipt: NativeInventoryReceipt | null = null;
      while (!receipt && Date.now() < deadline) {
        await new Promise<void>((accept) => setImmediate(accept));
        receipt = owner.operation({ ...scope, operationId: input.operationId });
      }
      if (!receipt)
        throw new Error('The identification did not commit before the response was dropped.');
      expect(socket.bytesRead).toBe(0);
      attempt.responseBytesRead = socket.bytesRead;
      attempt.originalReceipt = receipt;
      socket.destroy();
      return receipt;
    } finally {
      socket.destroy();
    }
  }
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Capture',?,'capture-project','writable',1),(42,'Other',?,'contents-other','writable',1)"
    ).run(projectPath, otherPath);
    rememberOriginalDefaultProject(db, 41);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('capture-schema','entity','contents','Capture','{}','capture-schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('capture-schema-v1','capture-schema',1,'{}',1)"
    ).run();
    for (const id of ['material-a', 'material-b']) {
      const fields =
        id === 'material-b' ? JSON.stringify({ artifact: { schema: 'dnaforge.primer' } }) : '{}';
      db.prepare(
        "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES(?,'record','capture-schema','capture-schema-v1',?,?,41,'registered',1,1)"
      ).run(id, id, fields);
    }
    const materialPath = join(projectPath, 'synthetic-primer.forge.json');
    writeFileSync(materialPath, JSON.stringify({ schema: 'dnaforge.primer', sequence: 'ACGT' }));
    db.prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at) VALUES('material-b','record','Synthetic primer','entity://lims/material-b','database','active',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES('capture-file','material-b',41,?,'record','current',1,1)"
    ).run(materialPath);
    db.prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at) VALUES('material-a','record','Synthetic primer A','entity://lims/material-a','database','active',1,1)"
    ).run();
    const materialAPath = join(projectPath, 'synthetic-primer-a.forge.json');
    writeFileSync(materialAPath, JSON.stringify({ schema: 'dnaforge.primer', sequence: 'AGCT' }));
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES('capture-file-a','material-a',41,?,'record','current',1,1)"
    ).run(materialAPath);
    for (const id of ['adopted-a', 'adopted-b']) {
      db.prepare(
        "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES(?,'record','capture-schema','capture-schema-v1',?,'{}',41,'registered',1,1)"
      ).run(id, id);
    }
    await start();
    const choices = benchlingCaptureChoices(sourceText);
    const previewCall = async (text = sourceText, options = choices, destination = scope) => {
      const before = raw();
      const result = await success<InventoryBenchlingCapturePreviewSnapshot>(
        'preview-capture',
        'inventory.preview-benchling-capture',
        { ...destination, sourceText: text, options }
      );
      expect(raw()).toEqual(before);
      return result;
    };
    const preview = await previewCall();
    if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
    const importRequest: InventoryApplyBenchlingCaptureRequest = {
      ...scope,
      kind: 'import-benchling-capture',
      operationId: 'capture-import-1',
      expectedRevision: 0,
      sourceText,
      options: preview.options,
      expectedPlanDigest: preview.planDigest,
    };
    const invalid = { ...structuredClone(importRequest), operationId: 'late-collision' };
    const tube = invalid.options.records.find((item) => item.record.sourceId === 'con_multiple');
    if (
      tube?.disposition !== 'vessel' ||
      tube.target.kind !== 'movable' ||
      tube.target.placement.kind !== 'source'
    )
      throw new Error('Expected movable source tube');
    (tube.target.placement as any).position = {
      value: 'A1',
      basis: 'declared-mapping',
      reason: 'Adversarial occupied target',
    };
    const collision = await call(
      'late-collision-rolls-back-everything',
      'inventory.apply-benchling-capture',
      invalid
    );
    expect(collision.body.result?.execution).toMatchObject({ status: 'rejected' });
    expect(collision.after).toEqual(collision.before);
    expect(owner.inspect(scope)).toBeNull();
    const originalBytes = readFileSync(materialPath, 'utf8');
    db.prepare("UPDATE lims_entity SET updated_at=2 WHERE id='material-b'").run();
    const changedFile = await call(
      'changed-scientific-admission-refuses-saved-plan',
      'inventory.apply-benchling-capture',
      importRequest
    );
    expect(changedFile.body.result?.execution).toMatchObject({
      status: 'rejected',
      code: 'INVENTORY_BENCHLING_CAPTURE_PLAN_CHANGED',
    });
    expect(changedFile.after).toEqual(changedFile.before);
    db.prepare("UPDATE lims_entity SET updated_at=1 WHERE id='material-b'").run();
    db.prepare("UPDATE catalog_entity_files SET status='deleted' WHERE id='capture-file'").run();
    const missingBinding = await call(
      'missing-current-file-binding-refuses-capture',
      'inventory.apply-benchling-capture',
      importRequest
    );
    expect(missingBinding.body.result?.execution).toMatchObject({
      status: 'rejected',
      code: 'BENCHLING_MATERIAL_UNAVAILABLE',
    });
    expect(missingBinding.after).toEqual(missingBinding.before);
    db.prepare("UPDATE catalog_entity_files SET status='current' WHERE id='capture-file'").run();
    const readOnly = await call(
      'read-grant-can-preview-but-not-apply',
      'inventory.apply-benchling-capture',
      importRequest,
      { identityId: writer.identityId, capabilities: ['read-workspace'] }
    );
    expect(readOnly.body.result).toMatchObject({ ok: false, stateChanged: false });
    expect(readOnly.after).toEqual(readOnly.before);
    const excluded = await call(
      'excluded-root-cannot-import',
      'inventory.apply-benchling-capture',
      importRequest,
      writer,
      [otherPath]
    );
    expect(excluded.body.result).toMatchObject({
      ok: false,
      code: 'PROJECT_ACCESS_DENIED',
      stateChanged: false,
    });
    expect(excluded.after).toEqual(excluded.before);
    revokedAt = '2026-11-16T12:00:00.000Z';
    const revoked = await call(
      'revoked-grant-cannot-import',
      'inventory.apply-benchling-capture',
      importRequest
    );
    expect(revoked.body.result).toMatchObject({
      ok: false,
      code: 'INVENTORY_CAPABILITY_DENIED',
      stateChanged: false,
    });
    expect(revoked.after).toEqual(revoked.before);
    revokedAt = null;
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
    expect((await previewCall()).kind).toBe('ready');
    const reference = await call(
      'reference-project-cannot-import',
      'inventory.apply-benchling-capture',
      importRequest
    );
    expect(reference.body.result).toMatchObject({
      ok: false,
      code: 'PROJECT_ACCESS_DENIED',
      stateChanged: false,
    });
    expect(reference.after).toEqual(reference.before);
    db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=41").run();
    clock += 1;
    const originalReceipt = await loseAcknowledgement(importRequest);
    const state = owner.inspect(scope)!;
    expect(state.revision).toBe(1);
    expect(owner.history({ ...scope, limit: 1000 })).toHaveLength(1);
    expect(Object.keys(state.hierarchyBindings)).toHaveLength(5);
    expect(Object.keys(state.vesselBindings)).toHaveLength(8);
    expect(Object.keys(state.tableBindings)).toHaveLength(3);
    const vessel = (id: string) =>
      state.vesselBindings[inventoryTableBindingKey(namespace, id)].vesselId;
    expect(inventoryVesselContents(state, vessel('con_multiple'))?.kind).toBe('unidentified');
    expect(inventoryVesselContents(state, vessel('con_missing'))?.kind).toBe('unobserved');
    const fixed =
      state.hierarchyBindings[inventoryTableBindingKey(namespace, 'plt_fixed')].storageId;
    expect(inventoryVesselContents(state, inventoryWellId(fixed, 'B1'))?.kind).toBe('unobserved');
    const zero = Object.values(state.stocks).find(
      (item) => item.vesselId === vessel('con_well_zero')
    )!;
    expect(zero.quantity).toEqual({ kind: 'known', value: '0', unit: 'uL' });
    const filled = Object.values(state.stocks).find(
      (item) => item.vesselId === vessel('con_filled')
    )!;
    expect(filled.quantity).toEqual({ kind: 'known', value: '10.25', unit: 'uL' });
    const laterCapture = JSON.parse(sourceText);
    const fixedResponse = laterCapture.responses.find((item: any) => item.id === 'fixed-plate');
    const fixedBody = JSON.parse(fixedResponse.bodyText);
    fixedBody.wells.B1 = {
      id: 'con_well_later',
      name: 'Later captured well',
      parentStorageId: 'plt_fixed',
      contents: [],
      quantity: { value: 0, units: 'uL' },
    };
    fixedResponse.bodyText = JSON.stringify(fixedBody);
    const laterText = JSON.stringify(laterCapture);
    const laterChoices = benchlingCaptureChoices(laterText);
    const laterDecision = laterChoices.records.find(
      (item) => item.record.sourceId === 'con_well_later'
    );
    if (
      laterDecision?.disposition !== 'vessel' ||
      laterDecision.contents.kind !== 'identify' ||
      laterDecision.contents.quantity.kind !== 'source-volume'
    )
      throw new Error('Expected later well fixture');
    (laterDecision as any).contents = {
      kind: 'empty',
      selection: laterDecision.contents.selection,
      quantity: laterDecision.contents.quantity,
      reason: 'Explicit captured zero and empty contents array',
    };
    const laterPreview = await previewCall(laterText, laterChoices);
    if (laterPreview.kind !== 'ready') throw new Error(JSON.stringify(laterPreview));
    expect(laterPreview.commands).toEqual([]);
    const metadataReceipt = await success<NativeInventoryExecution>(
      'metadata-only-new-foreign-well-identity',
      'inventory.apply-benchling-capture',
      {
        ...scope,
        kind: 'import-benchling-capture',
        operationId: 'capture-new-well-binding',
        expectedRevision: state.revision,
        sourceText: laterText,
        options: laterPreview.options,
        expectedPlanDigest: laterPreview.planDigest,
      }
    );
    expect(metadataReceipt.status).toBe('committed');
    expect(owner.inspect(scope)!.revision).toBe(state.revision + 1);
    expect(
      owner.inspect(scope)!.vesselBindings[inventoryTableBindingKey(namespace, 'con_well_later')]
        .vesselId
    ).toBe(inventoryWellId(fixed, 'B1'));
    expect(inventoryVesselContents(owner.inspect(scope)!, inventoryWellId(fixed, 'B1'))?.kind).toBe(
      'unobserved'
    );
    evidence.metadataOnlyReceipt = metadataReceipt;
    await refuse(
      'unresolved-tube-cannot-receive',
      [
        {
          kind: 'receive-stock',
          id: 'bad-receive',
          vesselId: vessel('con_multiple'),
          materialId: 'material-a',
          quantity: { kind: 'unknown' },
          quality: 'usable',
        },
      ],
      'VESSEL_CONTENTS_UNRESOLVED'
    );
    await execute('move-unidentified-and-use-stock', [
      { kind: 'move-vessel', id: vessel('con_multiple'), placement: { kind: 'unplaced' } },
      { kind: 'move-vessel', id: vessel('con_empty'), placement: { kind: 'unplaced' } },
      {
        kind: 'set-quality',
        stockId: filled.id,
        quality: 'usable',
        reason: 'Explicit local quality release',
      },
      {
        kind: 'consume',
        stockId: filled.id,
        quantity: { value: '2', unit: 'uL' },
        reason: 'Local use after source import',
      },
    ]);
    const laterContents = JSON.parse(sourceText);
    const emptyPage = laterContents.responses.find((item: any) => item.id === 'box-page-1');
    const emptyBody = JSON.parse(emptyPage.bodyText);
    emptyBody.containers[0].contents = [{ entity: { id: 'seq_A', entityType: 'dna_sequence' } }];
    emptyBody.containers[0].quantity = { value: 5, units: 'uL' };
    emptyPage.bodyText = JSON.stringify(emptyBody);
    const laterContentsText = JSON.stringify(laterContents);
    const laterContentsChoices = benchlingCaptureChoices(laterContentsText);
    const emptyDecision = laterContentsChoices.records.find(
      (item) => item.record.sourceId === 'con_empty'
    );
    if (emptyDecision?.disposition !== 'vessel' || emptyDecision.contents.kind !== 'empty')
      throw new Error('Expected empty vessel baseline fixture');
    (emptyDecision as any).contents = {
      kind: 'identify',
      selection: emptyDecision.contents.selection,
      quantity: emptyDecision.contents.quantity,
      materialId: 'material-a',
      quality: { value: 'usable', reason: 'Explicit quality for newly captured contents' },
      reason: 'Later capture identifies the same physical container',
    };
    const laterContentsPreview = await previewCall(laterContentsText, laterContentsChoices);
    if (laterContentsPreview.kind !== 'ready')
      throw new Error(JSON.stringify(laterContentsPreview));
    const vesselCount = Object.keys(owner.inspect(scope)!.vessels).length;
    const laterContentsReceipt = await success<NativeInventoryExecution>(
      'later-contents-use-original-moved-container',
      'inventory.apply-benchling-capture',
      {
        ...scope,
        kind: 'import-benchling-capture',
        operationId: 'capture-later-contents',
        expectedRevision: owner.inspect(scope)!.revision,
        sourceText: laterContentsText,
        options: laterContentsPreview.options,
        expectedPlanDigest: laterContentsPreview.planDigest,
      }
    );
    expect(laterContentsReceipt.status).toBe('committed');
    expect(Object.keys(owner.inspect(scope)!.vessels)).toHaveLength(vesselCount);
    expect(owner.inspect(scope)!.vessels[vessel('con_empty')].placement).toEqual({
      kind: 'unplaced',
    });
    expect(
      Object.values(owner.inspect(scope)!.stocks).find(
        (item) => item.vesselId === vessel('con_empty')
      )!.quantity
    ).toEqual({ kind: 'known', value: '5', unit: 'uL' });
    evidence.laterContentsReceipt = laterContentsReceipt;
    const reordered = JSON.parse(sourceText);
    reordered.responses.reverse();
    const reorderedText = JSON.stringify(reordered);
    expect((await previewCall(reorderedText, benchlingCaptureChoices(reorderedText))).kind).toBe(
      'no-change'
    );
    expect(owner.inspect(scope)!.stocks[filled.id].quantity).toEqual({
      kind: 'known',
      value: '8.25',
      unit: 'uL',
    });
    expect(owner.inspect(scope)!.vessels[vessel('con_multiple')].placement).toEqual({
      kind: 'unplaced',
    });
    const changed = JSON.parse(sourceText);
    const page = changed.responses.find((item: any) => item.id === 'box-page-1');
    const body = JSON.parse(page.bodyText);
    body.containers[1].quantity.value = 12;
    page.bodyText = JSON.stringify(body);
    const changedText = JSON.stringify(changed);
    const changedPreview = await previewCall(changedText, benchlingCaptureChoices(changedText));
    expect(changedPreview.kind).toBe('blocked');
    expect(
      changedPreview.rows.some(
        (item) => item.kind === 'needs-reconciliation' && item.targetId === vessel('con_filled')
      )
    ).toBe(true);
    db.prepare("UPDATE lims_entity SET tombstone=1 WHERE id='material-a'").run();
    writeFileSync(materialPath, originalBytes.replace('ACGT', 'TGCA'));
    const beforeRetry = raw();
    expect(
      await success(
        'original-receipt-before-current-material-checks',
        'inventory.apply-benchling-capture',
        importRequest
      )
    ).toEqual(originalReceipt);
    expect(raw()).toEqual(beforeRetry);
    db.prepare("UPDATE lims_entity SET tombstone=0 WHERE id='material-a'").run();
    writeFileSync(materialPath, originalBytes);
    const artifact = await success<InventoryExportSnapshot>(
      'export-bound-physical-capture',
      'inventory.export-snapshot',
      { ...scope, format: 'native-v1' }
    );
    const adoptionPreview = await success<InventoryImportPreviewSnapshot>(
      'preview-bound-capture-adoption',
      'inventory.preview-import',
      {
        ...target,
        sourceText: artifact.sourceText,
        options: {
          bindings: ['material-a', 'material-b'].map((id) => ({
            sourceMaterialId: id,
            destinationMaterialId: id === 'material-a' ? 'adopted-a' : 'adopted-b',
          })),
        },
      },
      adopter
    );
    if (adoptionPreview.kind !== 'ready') throw new Error(JSON.stringify(adoptionPreview));
    const adoptionRequest = {
      ...target,
      kind: 'adopt-archive',
      operationId: 'adopt-capture',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: adoptionPreview.options,
      expectedPlanDigest: adoptionPreview.planDigest,
    };
    const adoptionReceipt = await success<NativeInventoryExecution>(
      'adopt-physical-source-identities',
      'inventory.apply-import',
      adoptionRequest,
      adopter
    );
    expect(adoptionReceipt.status).toBe('committed');
    const adopted = owner.inspect(target)!;
    expect(adopted.vesselBindings).toEqual(owner.inspect(scope)!.vesselBindings);
    expect(inventoryVesselContents(adopted, vessel('con_multiple'))).toMatchObject({
      kind: 'unidentified',
      by: { kind: 'imported' },
    });
    const adoptedChoices = structuredClone(laterContentsChoices);
    for (const item of adoptedChoices.records)
      if (item.disposition === 'vessel' && item.contents.kind === 'identify')
        (item.contents as any).materialId =
          item.contents.materialId === 'material-a' ? 'adopted-a' : 'adopted-b';
    expect((await previewCall(laterContentsText, adoptedChoices, target)).kind).toBe('no-change');
    expect(new Set(Object.values(adopted.stocks).map((item) => item.materialId))).toEqual(
      new Set(['adopted-a', 'adopted-b'])
    );
    const final = owner.inspect(scope)!;
    const history = owner.history({ ...scope, limit: 1000 });
    const adoptedHistory = owner.history({ ...target, limit: 1000 });
    const sourceIds = new Set(['con_empty', 'con_filled', 'con_well_zero', 'con_matrix_tube']);
    const preimages = findNativeInventorySourcePreimages(final, history, namespace, sourceIds);
    const adoptedPreimages = findNativeInventorySourcePreimages(
      adopted,
      adoptedHistory,
      namespace,
      sourceIds
    );
    expect(preimages).toHaveLength(4);
    expect(adoptedPreimages).toEqual(preimages);
    expect(preimages.find((item) => item.sourceId === 'con_filled')!.fields.quantity).toBe('10.25');
    evidence.sourcePreimages = preimages;
    evidence.adoptedSourcePreimages = adoptedPreimages;
    expect(owner.replay(scope)).toEqual({ state: final, acceptedOperations: final.revision });
    expect(owner.replay(target)).toEqual({ state: adopted, acceptedOperations: 1 });
    await server!.close();
    server = undefined;
    db.close();
    db = openFileTestDb(dbPath);
    await start();
    expect(owner.inspect(scope)).toEqual(final);
    expect(owner.inspect(target)).toEqual(adopted);
    expect(owner.history({ ...scope, limit: 1000 })).toEqual(history);
    expect(owner.history({ ...target, limit: 1000 })).toEqual(adoptedHistory);
    expect(owner.replay(scope)).toEqual({ state: final, acceptedOperations: final.revision });
    expect(owner.replay(target)).toEqual({ state: adopted, acceptedOperations: 1 });
    const reopenedBefore = raw();
    expect(
      await success(
        'original-capture-receipt-after-reopen',
        'inventory.apply-benchling-capture',
        importRequest
      )
    ).toEqual(originalReceipt);
    expect(
      await success(
        'original-adoption-receipt-after-reopen',
        'inventory.apply-import',
        adoptionRequest,
        adopter
      )
    ).toEqual(adoptionReceipt);
    expect(raw()).toEqual(reopenedBefore);
    expect(
      (
        await success<InventoryExportSnapshot>(
          'exact-export-after-reopen',
          'inventory.export-snapshot',
          { ...scope, format: 'native-v1' }
        )
      ).sourceText
    ).toBe(artifact.sourceText);
    evidence.status = 'passed';
    evidence.originalReceipt = originalReceipt;
    evidence.state = final;
    evidence.history = history;
    evidence.adoptedState = adopted;
    evidence.adoptedHistory = adoptedHistory;
    evidence.exportSourceText = artifact.sourceText;
    evidence.reopenedExactStateHistoryAndExport = true;
  } catch (error) {
    evidence.status = 'failed';
    evidence.error =
      error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    if (server) await server.close();
    if (db.open) db.close();
    if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
