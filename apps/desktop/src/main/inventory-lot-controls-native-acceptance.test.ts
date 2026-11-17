// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  inventoryStockEligibility,
  type InventoryCommand,
  type InventoryQuantityInput,
  type InventoryAmountUnit,
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
  identityId: 'lot-controls-writer',
  capabilities: ['read-workspace', 'write-workspace'],
};
const adopter = {
  identityId: 'lot-controls-adopter',
  capabilities: ['read-workspace', 'write-workspace'],
};
const known = (value: string, unit: InventoryAmountUnit = 'uL'): InventoryQuantityInput => ({
  kind: 'known',
  value,
  unit,
});
const hash = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

it('guards managed lot ancestry and independent recalls through real HTTP, adoption and restart', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-inventory-lot-controls-')));
  const dbPath = join(root, 'inventory.sqlite');
  const projectPath = join(root, 'project');
  const otherPath = join(root, 'other-project');
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  const scope = { project: 'lot-controls-project', inventoryId: 'lot-controls-inventory' };
  const target = { ...scope, inventoryId: 'lot-controls-adopted' };
  const profileKey = 'a'.repeat(64);
  const projectScope = { kind: 'project-roots', roots: [projectPath] };
  const events: unknown[] = [];
  const trace: unknown[] = [];
  let db: Database.Database = openFileTestDb(dbPath);
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  let owner!: ReturnType<typeof createNativeInventoryOwner>;
  let authority = {
    ownerInstanceId: 'lot-controls-native-0',
    token: 'synthetic-lot-controls-token-0',
  };
  let instance = 0;
  let revokedAt: string | null = null;
  let clock = 1_700_000_000_000;
  const evidenceRoot = process.env.INVENTORY_LOT_CONTROLS_EVIDENCE_DIR;
  const evidencePath = evidenceRoot
    ? (() => {
        mkdirSync(resolve(evidenceRoot), { recursive: true });
        return join(mkdtempSync(join(resolve(evidenceRoot), 'native-')), 'acceptance.json');
      })()
    : null;
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-lot-controls-native-acceptance.v1',
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
      ownerInstanceId: `lot-controls-native-${++instance}`,
      token: `synthetic-lot-controls-token-${instance}`,
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
        throw new Error('The amount withdrawal did not commit before the response was dropped.');
      expect(socket.bytesRead).toBe(0);
      attempt.responseBytesRead = socket.bytesRead;
      attempt.originalReceipt = receipt;
      socket.destroy();
      return receipt;
    } finally {
      socket.destroy();
    }
  }
  const createLot = (id: string): InventoryCommand => ({
    kind: 'create-lot',
    id,
    materialId: 'lot-controls-material',
    name: id,
    origin: { kind: 'received', supplier: 'Synthetic supplier', lotNumber: id },
  });
  const manage = (lotId: string): InventoryCommand => ({
    kind: 'manage-lot',
    lotId,
    reason: 'Track local lot assessment',
  });
  const assess = (
    lotId: string,
    assessment: 'released' | 'quarantined' | 'rejected'
  ): InventoryCommand => ({
    kind: 'assess-lot',
    lotId,
    assessment,
    reason: 'Explicit local review of received material',
  });
  const consume = (
    stockId: string,
    value = '1',
    unit: InventoryAmountUnit = 'uL'
  ): Extract<InventoryCommand, { kind: 'consume' }> => ({
    kind: 'consume',
    stockId,
    quantity: { value, unit },
    reason: 'Measured use',
  });
  const recall = (id: string, lotId = 'lot-a'): InventoryCommand => ({
    kind: 'record-lot-recall',
    id,
    lotId,
    observedAt: null,
    source: {
      url: 'https://synthetic.invalid/supplier-recall',
      title: 'Synthetic supplier recall',
      locator: 'Lot notice',
      readAt: '2026-11-16',
      documentRevision: '1',
      sha256: null,
    },
    reason: 'Retain supplier recall notice as an independent restriction',
  });
  const withdrawRecall = (recallId: string): InventoryCommand => ({
    kind: 'withdraw-lot-recall',
    recallId,
    reason: 'Explicitly withdrew this recall after review',
  });
  const reserve = (id: string, stockId: string): InventoryCommand => ({
    kind: 'reserve-quantity',
    id,
    stockId,
    quantity: { value: '1', unit: 'uL' },
    purpose: 'Planned use before safety review changed',
    deadline: null,
  });
  const eligible = (stockId: string, targetScope = scope) =>
    inventoryStockEligibility(owner.inspect(targetScope)!, stockId, clock)!;
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Lot controls',?,'lot-controls-project','writable',1),(42,'Other',?,'lot-controls-other','writable',1)"
    ).run(projectPath, otherPath);
    rememberOriginalDefaultProject(db, 41);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('lot-controls-schema','entity','lot-controls','Lot controls','{}','lot-controls-schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('lot-controls-schema-v1','lot-controls-schema',1,'{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('lot-controls-material','record','lot-controls-schema','lot-controls-schema-v1','Synthetic material','{}',41,'registered',1,1)"
    ).run();
    await start();
    const receivedRequest = request('managed-receiving', [
      ...['lot-a', 'lot-b', 'lot-mass'].flatMap((id) => [createLot(id), manage(id)]),
      ...['source', 'other', 'mass', 'aliquot', 'sibling', 'preparation', 'probe'].map(
        (id): InventoryCommand => ({
          kind: 'create-vessel',
          id: `${id}-vessel`,
          name: id,
          placement: { kind: 'unplaced' },
        })
      ),
      ...[
        ['source', 'lot-a'],
        ['other', 'lot-b'],
      ].map(
        ([id, lotId]): InventoryCommand => ({
          kind: 'receive-lot-stock',
          id,
          vesselId: `${id}-vessel`,
          lotId,
          quantity: known('100'),
          quality: 'usable',
        })
      ),
      {
        kind: 'receive-lot-stock',
        id: 'mass',
        vesselId: 'mass-vessel',
        lotId: 'lot-mass',
        quantity: known('1', 'mg'),
        quality: 'usable',
      },
    ]);
    const receivedReceipt = await success<NativeInventoryExecution>(
      'managed-receive-one-native-operation',
      'inventory.execute',
      receivedRequest
    );
    expect(receivedReceipt).toMatchObject({
      status: 'committed',
      revision: 1,
      context: { version: 4 },
    });
    expect(owner.inspect(scope)!.lots['lot-a'].controls).toMatchObject({
      kind: 'managed',
      assessment: {
        value: 'unassessed',
        at: clock,
        by: { kind: 'agent', identityId: writer.identityId },
      },
    });
    expect(eligible('source')).toMatchObject({
      coverage: 'managed',
      lotConstraints: { knowledge: 'recorded', lotIds: ['lot-a'] },
      blockers: [{ code: 'LOT_NOT_RELEASED', lotId: 'lot-a', assessment: 'unassessed' }],
    });
    await refuse('unassessed-volume-use', [consume('source')], 'LOT_NOT_RELEASED');
    await refuse('unassessed-mass-use', [consume('mass', '1', 'ug')], 'LOT_NOT_RELEASED');
    await refuse(
      'unassessed-reservation',
      [reserve('premature-hold', 'source')],
      'LOT_NOT_RELEASED'
    );
    await execute('local-release-and-stock-specific-hold', [
      assess('lot-a', 'released'),
      assess('lot-b', 'released'),
      assess('lot-mass', 'released'),
      {
        kind: 'set-quality',
        stockId: 'source',
        quality: 'quarantined',
        reason: 'Independent container QC hold',
      },
      consume('mass', '10', 'ug'),
    ]);
    expect(owner.inspect(scope)!.stocks.mass.quantity).toEqual(known('990000', 'ng'));
    expect(eligible('source').blockers).toEqual([{ code: 'STOCK_QUARANTINED' }]);
    await refuse(
      'released-lot-does-not-clear-stock-hold',
      [consume('source')],
      'STOCK_QUARANTINED'
    );
    await execute('lot-hold-independent-of-stock-release', [
      {
        kind: 'set-quality',
        stockId: 'source',
        quality: 'usable',
        reason: 'Container QC resolved',
      },
      assess('lot-a', 'quarantined'),
    ]);
    await refuse(
      'stock-release-cannot-override-lot-hold',
      [
        {
          kind: 'set-quality',
          stockId: 'source',
          quality: 'usable',
          reason: 'Does not release the supplier lot',
        },
        consume('source'),
      ],
      'LOT_NOT_RELEASED'
    );
    await execute('release-and-derive-managed-output', [
      assess('lot-a', 'released'),
      {
        kind: 'transfer',
        sourceStockId: 'source',
        quantity: { value: '10', unit: 'uL' },
        destination: { kind: 'new-stock', stockId: 'aliquot', vesselId: 'aliquot-vessel' },
        reason: 'Aliquot before later source changes',
      },
      {
        kind: 'transfer',
        sourceStockId: 'source',
        quantity: { value: '5', unit: 'uL' },
        destination: { kind: 'new-stock', stockId: 'sibling', vesselId: 'sibling-vessel' },
        reason: 'Independent earlier sibling',
      },
      {
        kind: 'pool',
        lotId: 'prepared-lot',
        stockId: 'preparation',
        vesselId: 'preparation-vessel',
        materialId: 'lot-controls-material',
        name: 'Mixed preparation',
        inputs: [
          { stockId: 'aliquot', quantity: { value: '2', unit: 'uL' } },
          { stockId: 'other', quantity: { value: '2', unit: 'uL' } },
        ],
        reason: 'Actual preparation',
      },
      manage('prepared-lot'),
    ]);
    expect(eligible('preparation').lotConstraints).toEqual({
      knowledge: 'recorded',
      lotIds: ['lot-a', 'lot-b', 'prepared-lot'],
    });
    await refuse(
      'managed-derived-output-needs-its-own-release',
      [consume('preparation')],
      'LOT_NOT_RELEASED'
    );
    await execute('release-output-and-return-aliquot', [
      assess('prepared-lot', 'released'),
      {
        kind: 'transfer',
        sourceStockId: 'aliquot',
        quantity: { value: '1', unit: 'uL' },
        destination: { kind: 'existing-stock', stockId: 'source' },
        reason: 'Pour back unused same-source material',
      },
      {
        kind: 'associate-stock-lot',
        stockId: 'source',
        lotId: 'lot-b',
        reason: 'Later corrected supplier attribution',
      },
    ]);
    expect(eligible('source').lotConstraints.lotIds).toEqual(['lot-a', 'lot-b']);
    expect(eligible('sibling').lotConstraints.lotIds).toEqual(['lot-a']);
    await execute('later-recall-does-not-contaminate-earlier-sibling', [
      recall('recall-b', 'lot-b'),
    ]);
    await refuse('recall-follows-new-association', [consume('source')], 'LOT_RECALLED');
    await refuse('recall-follows-derived-input', [consume('preparation')], 'LOT_RECALLED');
    await execute('unaffected-sibling-use-and-hold', [
      consume('sibling'),
      reserve('sibling-hold', 'sibling'),
    ]);
    await execute('reattribution-cannot-launder-original-recall', [
      createLot('clean-lot'),
      manage('clean-lot'),
      assess('clean-lot', 'released'),
      {
        kind: 'associate-stock-lot',
        stockId: 'source',
        lotId: 'clean-lot',
        reason: 'Another supplier attribution must retain prior restrictions',
      },
    ]);
    await refuse('new-clean-source-does-not-erase-recall', [consume('source')], 'LOT_RECALLED');
    await execute('checkout-while-hold-remains', [
      {
        kind: 'checkout-item',
        item: { kind: 'vessel', id: 'sibling-vessel' },
        dueAt: null,
        reason: 'Physical custody is independent of lot safety',
      },
    ]);
    const safetyRequest = request('safety-action-by-another-current-writer', [
      recall('recall-a-first'),
      recall('recall-a-second'),
    ]);
    const safetyReceipt = await success<NativeInventoryExecution>(
      'record-safety-recall-despite-another-holders-custody-and-hold',
      'inventory.execute',
      safetyRequest,
      adopter
    );
    expect(safetyReceipt.status).toBe('committed');
    await execute('return-checked-out-stock-with-active-recall', [
      {
        kind: 'return-item',
        item: { kind: 'vessel', id: 'sibling-vessel' },
        destination: { kind: 'unplaced' },
        reason: 'Returning physical stock does not release recall',
      },
    ]);
    const heldBefore = owner.inspect(scope)!.reservations['sibling-hold'];
    await refuse(
      'recall-refuses-existing-reservation-fulfillment',
      [
        {
          kind: 'fulfill-reservations',
          claims: [{ reservationId: 'sibling-hold', quantity: { value: '1', unit: 'uL' } }],
          withdrawal: consume('sibling'),
        },
      ],
      'LOT_RECALLED'
    );
    expect(owner.inspect(scope)!.reservations['sibling-hold']).toEqual(heldBefore);
    await execute('withdraw-only-one-recall', [withdrawRecall('recall-a-first')]);
    expect(eligible('sibling').activeRecallIds).toEqual(['recall-a-second']);
    await refuse('other-active-recall-still-blocks', [consume('sibling')], 'LOT_RECALLED');
    await execute('withdraw-second-recall-and-fulfill', [
      withdrawRecall('recall-a-second'),
      {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'sibling-hold', quantity: { value: '1', unit: 'uL' } }],
        withdrawal: consume('sibling'),
      },
    ]);
    expect(owner.inspect(scope)!.stocks.sibling.quantity).toEqual(known('3'));
    expect(eligible('source').activeRecallIds).toEqual(['recall-b']);
    const lostRequest = request('lot-use-lost-acknowledgement', [consume('sibling')]);
    const originalReceipt = await loseAcknowledgement(lostRequest);
    await execute('later-use-then-new-recall', [consume('sibling'), recall('recall-a-later')]);
    expect(owner.inspect(scope)!.stocks.sibling.quantity).toEqual(known('1'));
    const retryBefore = raw();
    expect(
      await success(
        'recover-original-receipt-after-use-and-recall',
        'inventory.execute',
        lostRequest
      )
    ).toEqual(originalReceipt);
    expect(raw()).toEqual(retryBefore);
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
    const readOnly = await call(
      'reference-project-cannot-change-assessment',
      'inventory.execute',
      request('reference-assess', [assess('lot-a', 'quarantined')])
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
      'revoked-writer-cannot-withdraw-recall',
      'inventory.execute',
      request('revoked-withdraw', [withdrawRecall('recall-a-later')])
    );
    expect(denied.body.result).toMatchObject({
      ok: false,
      code: 'INVENTORY_CAPABILITY_DENIED',
      stateChanged: false,
    });
    expect(denied.after).toEqual(denied.before);
    revokedAt = null;
    const artifact = await success<InventoryExportSnapshot>(
      'export-managed-lot-evidence',
      'inventory.export-snapshot',
      { ...scope, format: 'native-v1' }
    );
    const preview = await success<InventoryImportPreviewSnapshot>(
      'preview-managed-lot-adoption',
      'inventory.preview-import',
      {
        ...target,
        sourceText: artifact.sourceText,
        options: {
          bindings: [
            {
              sourceMaterialId: 'lot-controls-material',
              destinationMaterialId: 'lot-controls-material',
            },
          ],
        },
      },
      adopter
    );
    if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
    const adoptionRequest = {
      ...target,
      kind: 'adopt-archive',
      operationId: 'adopt-lot-controls',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: preview.options,
      expectedPlanDigest: preview.planDigest,
    };
    const adoptionReceipt = await success<NativeInventoryExecution>(
      'adopt-managed-history-as-imported-evidence',
      'inventory.apply-import',
      adoptionRequest,
      adopter
    );
    expect(adoptionReceipt.status).toBe('committed');
    expect(eligible('sibling', target).blockers).toEqual(
      expect.arrayContaining([
        { code: 'LOT_ASSESSMENT_IMPORTED', lotId: 'lot-a' },
        { code: 'LOT_RECALLED', lotId: 'lot-a', recallIds: ['recall-a-later'] },
      ])
    );
    expect(owner.inspect(target)!.lotRecalls['recall-a-first'].lifecycle).toMatchObject({
      kind: 'withdrawn',
      by: { kind: 'imported' },
    });
    const localReassessment = {
      ...target,
      operationId: 'local-reassessment-of-imported-release',
      expectedRevision: owner.inspect(target)!.revision,
      commands: [assess('lot-a', 'released')],
    };
    expect(
      await success<NativeInventoryExecution>(
        'local-same-value-reassessment-establishes-local-release',
        'inventory.execute',
        localReassessment,
        adopter
      )
    ).toMatchObject({ status: 'committed' });
    expect(eligible('sibling', target).blockers).toEqual([
      { code: 'LOT_RECALLED', lotId: 'lot-a', recallIds: ['recall-a-later'] },
    ]);
    const explicitWithdrawal = {
      ...target,
      operationId: 'local-withdrawal-of-imported-active-recall',
      expectedRevision: owner.inspect(target)!.revision,
      commands: [withdrawRecall('recall-a-later')],
    };
    expect(
      await success<NativeInventoryExecution>(
        'explicit-local-withdrawal-of-imported-recall',
        'inventory.execute',
        explicitWithdrawal,
        adopter
      )
    ).toMatchObject({ status: 'committed' });
    expect(eligible('sibling', target).blockers).toEqual([]);
    const state = owner.inspect(scope)!;
    const adoptedState = owner.inspect(target)!;
    const history = owner.history({ ...scope, limit: 1000 });
    const adoptedHistory = owner.history({ ...target, limit: 1000 });
    expect(owner.replay(scope)).toEqual({ state, acceptedOperations: state.revision });
    expect(owner.replay(target)).toEqual({
      state: adoptedState,
      acceptedOperations: adoptedState.revision,
    });
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
    const reopenedBefore = raw();
    expect(
      await success('original-receive-receipt-after-reopen', 'inventory.execute', receivedRequest)
    ).toEqual(receivedReceipt);
    expect(
      await success('original-use-receipt-after-reopen', 'inventory.execute', lostRequest)
    ).toEqual(originalReceipt);
    expect(
      await success(
        'original-adoption-after-local-reassessment-and-reopen',
        'inventory.apply-import',
        adoptionRequest,
        adopter
      )
    ).toEqual(adoptionReceipt);
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
    Object.assign(evidence, {
      status: 'passed',
      state,
      adoptedState,
      history,
      adoptedHistory,
      originalReceipt,
      receivedRequest,
      receivedReceipt,
      adoptionRequest,
      adoptionReceipt,
      zeroPartialEffectsOnRefusals: true,
      reopenedExactStateHistoryAndExport: true,
      exportSourceText: artifact.sourceText,
    });
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
