// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  inventoryVesselContents,
  inventoryWellId,
  type InventoryCommand,
  type InventoryQuantity,
  type InventoryState,
} from '@waypoint/domain-services';
import type {
  InventoryExecuteRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../shared/inventory-command';
import type {
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
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { createNativeAgentGrantAuthorizer } from './agent-grant-authority';

type Command =
  | 'inventory.execute'
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
  identityId: 'contents-writer',
  capabilities: ['read-workspace', 'write-workspace'],
};
const adopter = {
  identityId: 'contents-adopter',
  capabilities: ['read-workspace', 'write-workspace'],
};
const known = (value: string): InventoryQuantity => ({ kind: 'known', value, unit: 'uL' });
const hash = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

it('keeps contents knowledge distinct through real HTTP, atomic refusals, identification, adoption and restart', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-inventory-contents-')));
  const dbPath = join(root, 'inventory.sqlite');
  const projectPath = join(root, 'project');
  const otherPath = join(root, 'other-project');
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  const scope = { project: 'contents-project', inventoryId: 'contents-inventory' };
  const target = { ...scope, inventoryId: 'contents-adopted' };
  const profileKey = 'a'.repeat(64);
  const projectScope = { kind: 'project-roots', roots: [projectPath] };
  const events: unknown[] = [];
  const trace: unknown[] = [];
  let db: Database.Database = openFileTestDb(dbPath);
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  let owner: ReturnType<typeof createNativeInventoryOwner>;
  let authority = { ownerInstanceId: 'contents-native-0', token: 'synthetic-contents-token-0' };
  let instance = 0;
  let revokedAt: string | null = null;
  let clock = 1_700_000_000_000;
  const evidenceRoot = process.env.INVENTORY_CONTENTS_EVIDENCE_DIR;
  const evidencePath = evidenceRoot
    ? (() => {
        mkdirSync(resolve(evidenceRoot), { recursive: true });
        return join(mkdtempSync(join(resolve(evidenceRoot), 'native-')), 'acceptance.json');
      })()
    : null;
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-contents-native-acceptance.v1',
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
      ownerInstanceId: `contents-native-${++instance}`,
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
  async function loseAcknowledgement(input: InventoryExecuteRequest) {
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
        command: 'inventory.execute',
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
  const receive = (id: string, vesselId: string, quantity = known('100')): InventoryCommand => ({
    kind: 'receive-stock',
    id,
    vesselId,
    materialId: 'contents-material',
    quantity,
    quality: 'usable',
  });
  const identify = (
    id: string,
    vesselId: string,
    quantity = known('10'),
    materialId = 'contents-material'
  ): InventoryCommand => ({
    kind: 'identify-vessel-stock',
    id,
    vesselId,
    materialId,
    quantity,
    quality: 'usable',
    reason: 'Identified synthetic material already present',
  });
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Contents',?,'contents-project','writable',1),(42,'Other',?,'contents-other','writable',1)"
    ).run(projectPath, otherPath);
    rememberOriginalDefaultProject(db, 41);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('contents-schema','entity','contents','Contents','{}','contents-schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('contents-schema-v1','contents-schema',1,'{}',1)"
    ).run();
    for (const id of ['contents-material', 'contents-file-material']) {
      const fields =
        id === 'contents-file-material'
          ? JSON.stringify({ artifact: { schema: 'dnaforge.primer' } })
          : '{}';
      db.prepare(
        "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES(?,'record','contents-schema','contents-schema-v1',?,?,41,'registered',1,1)"
      ).run(id, id, fields);
    }
    const materialPath = join(projectPath, 'synthetic-primer.forge.json');
    writeFileSync(materialPath, JSON.stringify({ schema: 'dnaforge.primer', sequence: 'ACGT' }));
    db.prepare(
      "INSERT INTO catalog_entities(id,type,name,locator,storage_type,status,created_at,updated_at) VALUES('contents-file-material','record','Synthetic primer','entity://lims/contents-file-material','database','active',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO catalog_entity_files(id,entity_id,workspace_id,path,file_kind,status,created_at,updated_at) VALUES('contents-file','contents-file-material',41,?,'record','current',1,1)"
    ).run(materialPath);
    await start();
    await execute('create-unobserved-physical-fixture', [
      {
        kind: 'create-storage',
        id: 'shelf',
        name: 'Synthetic shelf',
        slots: ['A', 'B', 'C'],
        placement: { kind: 'root' },
      },
      ...[
        'unknown',
        'unknown-quantity',
        'declare',
        'source-a',
        'source-b',
        'probe',
        'lost',
        'compatible',
      ].map(
        (id): InventoryCommand => ({
          kind: 'create-vessel',
          id,
          name: `Synthetic ${id}`,
          placement: { kind: 'unplaced' },
        })
      ),
      {
        kind: 'record-vessels-contents',
        vesselIds: ['unknown', 'unknown-quantity', 'declare', 'probe', 'lost'],
        knowledge: 'unobserved',
        reason: 'Physical contents have not been identified',
      },
      receive('source-stock-a', 'source-a'),
      receive('source-stock-b', 'source-b'),
      {
        kind: 'create-lot',
        id: 'lot',
        materialId: 'contents-material',
        name: 'Synthetic lot',
        origin: { kind: 'received', supplier: 'Synthetic', lotNumber: '1' },
      },
    ]);
    expect(inventoryVesselContents(owner.inspect(scope)!, 'unknown')).toMatchObject({
      kind: 'unobserved',
      by: { kind: 'agent', identityId: writer.identityId },
    });
    expect(inventoryVesselContents(owner.inspect(scope)!, 'compatible')).toEqual({
      kind: 'declared-empty',
    });
    const blocked: InventoryCommand[] = [
      receive('ordinary-receipt', 'unknown'),
      {
        kind: 'receive-lot-stock',
        id: 'lot-receipt',
        vesselId: 'unknown',
        lotId: 'lot',
        quantity: known('1'),
        quality: 'usable',
      },
      {
        kind: 'transfer',
        sourceStockId: 'source-stock-a',
        quantity: { value: '1', unit: 'uL' },
        destination: { kind: 'new-stock', stockId: 'transfer-output', vesselId: 'unknown' },
        reason: 'Must not add to unresolved contents',
      },
      {
        kind: 'pool',
        lotId: 'pooled',
        stockId: 'pool-output',
        vesselId: 'unknown',
        materialId: 'contents-material',
        name: 'Synthetic pool',
        inputs: [
          { stockId: 'source-stock-a', quantity: { value: '1', unit: 'uL' } },
          { stockId: 'source-stock-b', quantity: { value: '1', unit: 'uL' } },
        ],
        reason: 'Must not pool into unresolved contents',
      },
      {
        kind: 'dilute',
        lotId: 'diluted',
        stockId: 'dilute-output',
        vesselId: 'unknown',
        materialId: 'contents-material',
        name: 'Synthetic dilution',
        sample: { stockId: 'source-stock-a', quantity: { value: '1', unit: 'uL' } },
        diluent: { stockId: 'source-stock-b', quantity: { value: '1', unit: 'uL' } },
        reason: 'Must not dilute into unresolved contents',
      },
    ];
    for (const command of blocked)
      await refuse(`refuse-${command.kind}`, [command], 'VESSEL_CONTENTS_UNRESOLVED');
    await execute('observe-unidentified-and-move', [
      {
        kind: 'record-vessel-contents',
        vesselId: 'unknown',
        knowledge: 'unidentified',
        reason: 'Material visible; identity not established',
      },
      {
        kind: 'move-vessel',
        id: 'unknown',
        placement: { kind: 'located', storageId: 'shelf', slotId: 'A' },
      },
      {
        kind: 'checkout-item',
        item: { kind: 'vessel', id: 'unknown' },
        dueAt: null,
        reason: 'Inspect synthetic tube',
      },
      {
        kind: 'return-item',
        item: { kind: 'vessel', id: 'unknown' },
        destination: { kind: 'located', storageId: 'shelf', slotId: 'B' },
        reason: 'Return synthetic tube',
      },
    ]);
    expect(inventoryVesselContents(owner.inspect(scope)!, 'unknown')).toMatchObject({
      kind: 'unidentified',
      by: { kind: 'agent', identityId: writer.identityId },
    });
    expect(owner.inspect(scope)!.vessels.unknown.placement).toEqual({
      kind: 'located',
      storageId: 'shelf',
      slotId: 'B',
    });
    await execute('declare-then-receive', [
      {
        kind: 'declare-vessel-empty',
        vesselId: 'declare',
        reason: 'Actual empty observation in synthetic task',
      },
      receive('declared-stock', 'declare', known('5')),
    ]);
    await execute('identify-unknown-amount', [
      identify(
        'unknown-amount-stock',
        'unknown-quantity',
        { kind: 'unknown' },
        'contents-file-material'
      ),
    ]);
    expect(inventoryVesselContents(owner.inspect(scope)!, 'unknown-quantity')).toEqual({
      kind: 'identified',
      stockId: 'unknown-amount-stock',
    });
    expect(owner.inspect(scope)!.stocks['unknown-amount-stock'].quantity).toEqual({
      kind: 'unknown',
    });
    await execute('initialize-384-unobserved-wells', [
      {
        kind: 'create-layout-storage',
        id: 'plate-384',
        name: 'Explicit sixteen by twenty-four plate',
        layout: { kind: 'fixed-well', rows: 16, columns: 24 },
        placement: { kind: 'root' },
      },
      {
        kind: 'record-vessels-contents',
        vesselIds: Array.from({ length: 16 }, (_, r) =>
          Array.from({ length: 24 }, (_, c) =>
            inventoryWellId('plate-384', `${String.fromCharCode(65 + r)}${c + 1}`)
          )
        ).flat(),
        knowledge: 'unobserved',
        reason: 'All positions uncaptured until explicitly identified',
      },
    ]);
    const wellIds = Object.values(owner.inspect(scope)!.vessels)
      .filter((vessel) => vessel.kind === 'fixed-well')
      .map((vessel) => vessel.id);
    expect(wellIds).toHaveLength(384);
    expect(
      wellIds.every(
        (id) => inventoryVesselContents(owner.inspect(scope)!, id)?.kind === 'unobserved'
      )
    ).toBe(true);
    const zeroWell = inventoryWellId('plate-384', 'A1');
    await execute('identify-known-zero-well', [identify('zero-stock', zeroWell, known('0'))]);
    expect(inventoryVesselContents(owner.inspect(scope)!, zeroWell)).toEqual({
      kind: 'identified',
      stockId: 'zero-stock',
    });
    await refuse(
      'no-zero-to-empty',
      [
        {
          kind: 'declare-vessel-empty',
          vesselId: zeroWell,
          reason: 'Zero quantity is not a physical empty observation',
        },
      ],
      'STOCK_ALREADY_PRESENT'
    );
    await refuse(
      'no-zero-to-unobserved',
      [
        {
          kind: 'record-vessel-contents',
          vesselId: zeroWell,
          knowledge: 'unobserved',
          reason: 'Cannot erase identified material',
        },
      ],
      'STOCK_ALREADY_PRESENT'
    );
    await refuse(
      'bulk-late-identified-target-refuses-all',
      [
        {
          kind: 'record-vessels-contents',
          vesselIds: [...wellIds.filter((id) => id !== zeroWell), zeroWell],
          knowledge: 'unidentified',
          reason: 'Last target is already identified',
        },
      ],
      'STOCK_ALREADY_PRESENT'
    );
    await refuse(
      'late-missing-material-rolls-back-create',
      [
        {
          kind: 'create-vessel',
          id: 'must-not-exist',
          name: 'Rolled back candidate',
          placement: { kind: 'unplaced' },
        },
        identify('missing-material-stock', 'probe', known('1'), 'not-admitted'),
      ],
      'INVENTORY_MATERIAL_UNAVAILABLE'
    );
    expect(owner.inspect(scope)!.vessels['must-not-exist']).toBeUndefined();
    const lostRequest = request('identify-lost-response', [identify('lost-stock', 'lost')]);
    const originalReceipt = await loseAcknowledgement(lostRequest);
    await execute('use-after-identification', [
      {
        kind: 'consume',
        stockId: 'lost-stock',
        quantity: { value: '2', unit: 'uL' },
        reason: 'Later actual use',
      },
    ]);
    db.prepare("UPDATE lims_entity SET tombstone=1 WHERE id='contents-material'").run();
    const retryBefore = raw();
    expect(
      await success(
        'original-identification-retry-after-use-and-material-change',
        'inventory.execute',
        lostRequest
      )
    ).toEqual(originalReceipt);
    expect(raw()).toEqual(retryBefore);
    await refuse(
      'new-identification-refuses-deleted-material',
      [identify('deleted-material-stock', 'probe')],
      'INVENTORY_MATERIAL_UNAVAILABLE'
    );
    db.prepare("UPDATE lims_entity SET tombstone=0 WHERE id='contents-material'").run();
    db.prepare("UPDATE catalog_entity_files SET status='deleted' WHERE id='contents-file'").run();
    await refuse(
      'new-identification-refuses-missing-current-file-owner',
      [identify('missing-file-stock', 'probe', known('1'), 'contents-file-material')],
      'INVENTORY_MATERIAL_UNAVAILABLE'
    );
    db.prepare("UPDATE catalog_entity_files SET status='current' WHERE id='contents-file'").run();
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
    const readOnly = await call(
      'reference-project-cannot-identify',
      'inventory.execute',
      request('reference-write', [identify('reference-stock', 'probe')])
    );
    expect(readOnly.body.result).toMatchObject({
      ok: false,
      code: 'PROJECT_ACCESS_DENIED',
      stateChanged: false,
    });
    expect(readOnly.after).toEqual(readOnly.before);
    db.prepare("UPDATE workspaces SET access_mode='writable' WHERE id=41").run();
    revokedAt = '2026-11-16T12:00:00.000Z';
    const denied = await call(
      'current-revoked-grant-cannot-identify',
      'inventory.execute',
      request('revoked-write', [identify('revoked-stock', 'probe')])
    );
    expect(denied.body.result).toMatchObject({
      ok: false,
      code: 'INVENTORY_CAPABILITY_DENIED',
      stateChanged: false,
    });
    expect(denied.after).toEqual(denied.before);
    revokedAt = null;
    const readOnlyAgent = await call(
      'read-capability-cannot-identify',
      'inventory.execute',
      request('read-only-agent', [identify('read-stock', 'probe')]),
      { identityId: writer.identityId, capabilities: ['read-workspace'] }
    );
    expect(readOnlyAgent.body.result).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_SCOPE',
      stateChanged: false,
    });
    expect(readOnlyAgent.after).toEqual(readOnlyAgent.before);
    const excluded = await call(
      'excluded-project-roots-cannot-identify',
      'inventory.execute',
      request('excluded-root', [identify('excluded-stock', 'probe')]),
      writer,
      [otherPath]
    );
    expect(excluded.body.result).toMatchObject({
      ok: false,
      code: 'PROJECT_ACCESS_DENIED',
      stateChanged: false,
    });
    expect(excluded.after).toEqual(excluded.before);
    const artifact = await success<InventoryExportSnapshot>(
      'export-contents-and-original-knowledge-actors',
      'inventory.export-snapshot',
      { ...scope, format: 'native-v1' }
    );
    const preview = await success<InventoryImportPreviewSnapshot>(
      'preview-contents-adoption',
      'inventory.preview-import',
      {
        ...target,
        sourceText: artifact.sourceText,
        options: {
          bindings: ['contents-material', 'contents-file-material'].map((id) => ({
            sourceMaterialId: id,
            destinationMaterialId: id,
          })),
        },
      },
      adopter
    );
    if (preview.kind !== 'ready')
      throw new Error(`Contents archive preview: ${JSON.stringify(preview)}`);
    const adoptionRequest = {
      ...target,
      kind: 'adopt-archive',
      operationId: 'adopt-contents',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: preview.options,
      expectedPlanDigest: preview.planDigest,
    };
    const adoptedReceipt = await success<NativeInventoryExecution>(
      'adopt-existing-knowledge-without-foreign-authority',
      'inventory.apply-import',
      adoptionRequest,
      adopter
    );
    expect(adoptedReceipt.status).toBe('committed');
    const adopted = owner.inspect(target)!;
    const foreign = adopted.vessels.unknown.contentsKnowledge;
    expect(foreign).toMatchObject({
      kind: 'unidentified',
      by: {
        kind: 'imported',
        principal: { kind: 'agent', identityId: writer.identityId },
        source: { inventoryId: scope.inventoryId },
      },
    });
    expect(inventoryVesselContents(adopted, zeroWell)).toEqual({
      kind: 'identified',
      stockId: 'zero-stock',
    });
    expect(adopted.stocks['lost-stock'].quantity).toEqual(known('8'));
    const state = owner.inspect(scope)!;
    const adoptedState = owner.inspect(target)!;
    const history = owner.history({ ...scope, limit: 1000 });
    const adoptedHistory = owner.history({ ...target, limit: 1000 });
    expect(owner.replay(scope)).toEqual({ state, acceptedOperations: state.revision });
    expect(owner.replay(target)).toEqual({ state: adoptedState, acceptedOperations: 1 });
    await server!.close();
    server = undefined;
    db.close();
    db = openFileTestDb(dbPath);
    await start();
    expect(owner.inspect(scope)).toEqual(state);
    expect(owner.inspect(target)).toEqual(adoptedState);
    expect(owner.history({ ...scope, limit: 1000 })).toEqual(history);
    expect(owner.history({ ...target, limit: 1000 })).toEqual(adoptedHistory);
    expect(owner.replay(scope)).toEqual({ state, acceptedOperations: state.revision });
    expect(owner.replay(target)).toEqual({ state: adoptedState, acceptedOperations: 1 });
    const reopenedBefore = raw();
    expect(
      await success('original-receipt-after-native-reopen', 'inventory.execute', lostRequest)
    ).toEqual(originalReceipt);
    expect(
      await success(
        'original-adoption-receipt-after-native-reopen',
        'inventory.apply-import',
        adoptionRequest,
        adopter
      )
    ).toEqual(adoptedReceipt);
    expect(raw()).toEqual(reopenedBefore);
    expect(
      (
        await success<InventoryExportSnapshot>(
          'exact-export-after-native-reopen',
          'inventory.export-snapshot',
          { ...scope, format: 'native-v1' }
        )
      ).sourceText
    ).toBe(artifact.sourceText);
    evidence.status = 'passed';
    evidence.originalReceipt = originalReceipt;
    evidence.state = state;
    evidence.history = history;
    evidence.adoptedState = adoptedState;
    evidence.adoptedHistory = adoptedHistory;
    evidence.exportSourceText = artifact.sourceText;
    evidence.reopenedExactStateHistoryAndExport = true;
    evidence.zeroPartialEffectsOnRefusals = true;
    evidence.bulkInitializedWells = wellIds.length;
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
}, 15_000);
