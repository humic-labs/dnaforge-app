// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  type InventoryArrivalChoices,
  type InventoryArrivalSource,
  type InventoryCommand,
} from '@waypoint/domain-services';
import type {
  InventoryApplyArrivalRequest,
  InventoryExecuteRequest,
  NativeInventoryReceipt,
} from '../shared/inventory-command';
import type {
  InventoryArrivalPreviewSnapshot,
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
  InventoryStockroomSnapshot,
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

it('projects stockroom receipts independently from balances through native HTTP and trusted snapshot time', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-inventory-stockroom-')));
  const dbPath = join(root, 'inventory.sqlite'),
    projectPath = join(root, 'project');
  mkdirSync(projectPath);
  const scope = { project: 'arrival-project', inventoryId: 'arrival-inventory' };
  const writer = {
    identityId: 'arrival-writer',
    capabilities: ['read-workspace', 'write-workspace'],
  };
  const reader = { ...writer, capabilities: ['read-workspace'] };
  const projectScope = { kind: 'project-roots' as const, roots: [projectPath] };
  let db: Database.Database = openFileTestDb(dbPath);
  let owner!: ReturnType<typeof createNativeInventoryOwner>;
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  let generation = 0,
    clock = 1_700_000_000_000,
    clockReads = 0,
    revokedAt: string | null = null;
  let authority = { ownerInstanceId: '', token: '' };
  const events: unknown[] = [],
    trace: unknown[] = [];
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-stockroom-native-acceptance.v1',
    status: 'running',
    trace,
  };
  const evidenceDir = process.env.INVENTORY_STOCKROOM_EVIDENCE_DIR;
  const raw = () => ({
    states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
    journal: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
    changes: db.prepare('SELECT total_changes() AS count').get(),
    events: [...events],
  });
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const summary = (value: ReturnType<typeof raw>) => ({
    states: hash(value.states),
    journal: hash(value.journal),
    changes: value.changes,
    events: value.events.length,
  });
  async function start() {
    authority = {
      ownerInstanceId: `arrival-native-${++generation}`,
      token: `synthetic-arrival-token-${generation}`,
    };
    const projectAuthority = createRegisteredProjectAuthority({
      db: () => db,
      managedRootDir: () => join(root, 'managed'),
    });
    owner = createNativeInventoryOwner({
      db: () => db,
      projectAuthority,
      actor: () => `native:${authority.ownerInstanceId}`,
      profileKey: 'a'.repeat(64),
      now: () => {
        clockReads += 1;
        return clock;
      },
    });
    owner.initialize();
    owner.subscribe((event) => events.push(event));
    server = await startNativeDocumentCommandServer({
      owner: {
        inspect: async () => {
          throw new Error('Unrelated owner');
        },
        apply: async () => {
          throw new Error('Unrelated owner');
        },
        close: async () => {},
      },
      inventory: owner,
      projectAuthority,
      authorizeInventoryAgent: createNativeAgentGrantAuthorizer(
        async () =>
          Response.json({
            ok: true,
            grants: [
              { id: writer.identityId, scopes: writer.capabilities, revokedAt, expiresAt: null },
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
      before: summary(before),
      after: summary(after),
    });
    return { status: response.status, body, before, after };
  }
  async function result<T>(
    label: string,
    command: string,
    request: unknown,
    key: string,
    agent = writer
  ) {
    const response = await call(label, command, request, agent);
    expect(response.status, label).toBe(200);
    expect(response.body.ok, label).toBe(true);
    expect(response.body.result, label).toHaveProperty(key);
    return response.body.result![key] as T;
  }
  async function execute(id: string, commands: readonly InventoryCommand[]) {
    clock += 1;
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
  const source: InventoryArrivalSource = {
    schema: 'dnaforge.inventory-arrival-source.v1',
    identity: { namespace: 'receiving-ledger', arrivalId: 'delivery-0007' },
    supplier: 'Synthetic supplier',
    observedAt: clock - 1,
    observationReason: 'Package physically received',
    scope: {
      kind: 'complete-listed-manifest',
      reason: 'Every component on this supplied manifest was checked',
    },
    documents: [
      {
        key: 'packing',
        mediaType: 'text/plain',
        body: {
          encoding: 'utf8',
          value: 'Material X: 1.25 mg\nQC: supplier passed\nPackage batch PK-007\n',
        },
        reference: null,
        coverage: { kind: 'full' },
      },
    ],
    packages: [{ key: 'kit', label: 'Kit', productCode: 'KIT-007', packagingBatch: 'PK-007' }],
    components: [
      {
        key: 'standard',
        packageKey: 'kit',
        label: 'Material X',
        productCode: 'X-1',
        componentBatch: 'X-LOT-9',
      },
      {
        key: 'unknown',
        packageKey: 'kit',
        label: 'Unlabeled insert',
        productCode: null,
        componentBatch: null,
      },
    ],
    claims: [],
  };
  const options: InventoryArrivalChoices = {
    components: [
      {
        componentKey: 'standard',
        kind: 'identified',
        materialId: 'arrival-material',
        lot: {
          kind: 'new',
          lotKey: 'standard-lot',
          name: 'Received standard',
          supplier: 'Synthetic supplier',
          lotNumber: 'X-LOT-9',
          managementReason: 'Assess this supplier lot locally',
        },
        quantity: { kind: 'known', value: '1.25', unit: 'mg' },
        quantityBasis: { kind: 'measurement', reason: 'Measured mass from a calibrated balance' },
        stockQuality: { value: 'usable', reason: 'No independent stock hold was observed' },
        vessel: { name: 'Standard vial', placement: { kind: 'unplaced' } },
      },
      {
        componentKey: 'unknown',
        kind: 'unidentified-physical',
        reason: 'The insert label does not establish material identity',
        vessel: { name: 'Unidentified insert', placement: { kind: 'unplaced' } },
      },
    ],
  };
  const sourceText = JSON.stringify(source);
  async function preview(text = sourceText, choices = options, selectedScope = scope) {
    const before = raw();
    const value = await result<InventoryArrivalPreviewSnapshot>(
      'preview',
      'inventory.preview-arrival',
      { ...selectedScope, sourceText: text, options: choices },
      'preview',
      reader
    );
    expect(raw()).toEqual(before);
    return value;
  }
  function application(
    value: InventoryArrivalPreviewSnapshot,
    operationId: string,
    text = sourceText,
    selectedScope = scope
  ): InventoryApplyArrivalRequest {
    if (value.kind !== 'ready') throw new Error(`Expected ready: ${JSON.stringify(value)}`);
    return {
      ...selectedScope,
      kind: 'receive-arrival',
      operationId,
      expectedRevision: value.target.revision,
      sourceText: text,
      options: value.options,
      expectedPlanDigest: value.planDigest,
    };
  }
  async function loseAcknowledgement(input: InventoryExecuteRequest) {
    const address = new URL(server!.url),
      socket = createConnection({ host: address.hostname, port: Number(address.port) });
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
      const deadline = Date.now() + 2000;
      while (!receipt && Date.now() < deadline) {
        await new Promise<void>((accept) => setImmediate(accept));
        receipt = owner.operation({ ...scope, operationId: input.operationId });
      }
      if (!receipt) throw new Error('Arrival did not commit before dropping its acknowledgement');
      expect(socket.bytesRead).toBe(0);
      attempt.responseBytesRead = socket.bytesRead;
      attempt.originalReceipt = receipt;
      return receipt;
    } finally {
      socket.destroy();
    }
  }
  async function stockroom(label: string, selectedScope = scope) {
    const before = raw(),
      beforeClockReads = clockReads;
    const value = await result<InventoryStockroomSnapshot>(
      label,
      'inventory.stockroom',
      selectedScope,
      'stockroom',
      reader
    );
    expect(raw(), label).toEqual(before);
    expect(clockReads - beforeClockReads, label).toBe(1);
    expect(value, label).toMatchObject({
      projectId: scope.project,
      inventoryId: selectedScope.inventoryId,
      revision: owner.inspect(selectedScope)!.revision,
      asOf: clock,
      principal: { kind: 'agent', identityId: reader.identityId },
    });
    return value;
  }
  const expected = (
    id: string,
    value = '2.5',
    materialId = 'arrival-material'
  ): InventoryCommand => ({
    kind: 'record-expected-delivery',
    id,
    name: id,
    supplier: null,
    externalReference: null,
    materialId,
    quantity: { value, unit: 'mg' },
    reason: 'Operator records an expected amount without placing an order',
  });
  const rule = (
    id: string,
    value: string,
    validityBasis:
      | 'current-recorded-rules'
      | 'confirmed-current-validity' = 'current-recorded-rules'
  ): InventoryCommand => ({
    kind: 'record-reorder-rule',
    id,
    name: id,
    materialId: 'arrival-material',
    threshold: { value, unit: 'ng' },
    validityBasis,
    actionBasis: 'withdraw',
    reason: 'Track free stock under this explicit policy',
  });
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
  async function refuse(label: string, commands: readonly InventoryCommand[], code?: string) {
    const response = await call(label, 'inventory.execute', request(label, commands));
    expect(response.body.result?.execution, label).toMatchObject({
      status: 'rejected',
      ...(code ? { code } : {}),
    });
    expect(response.after, label).toEqual(response.before);
    return response;
  }
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Arrivals',?,'arrival-project','writable',1)"
    ).run(projectPath);
    rememberOriginalDefaultProject(db, 41);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('arrival-schema','entity','arrival','Arrival','{}','arrival-schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('arrival-schema-v1','arrival-schema',1,'{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('arrival-material','record','arrival-schema','arrival-schema-v1','Synthetic standard','{}',41,'registered',1,1)"
    ).run();
    await start();
    const absentBefore = raw();
    expect(
      await result('absent-stockroom', 'inventory.stockroom', scope, 'stockroom', reader)
    ).toBeNull();
    expect(raw()).toEqual(absentBefore);
    const first = await preview();
    if (first.kind !== 'ready') throw new Error(JSON.stringify(first));
    const receiving = await result<NativeInventoryReceipt>(
      'receive-original-components',
      'inventory.apply-arrival',
      application(first, 'receive-components'),
      'execution'
    );
    expect(receiving).toMatchObject({ status: 'committed', context: { version: 5 } });
    const target = first.options.targets.find((row) => row.componentKey === 'standard')!;
    const consume = (value: string): InventoryCommand => ({
      kind: 'consume',
      stockId: target.stockId!,
      quantity: { value, unit: 'mg' },
      reason: 'Actual measured use independent from receiving progress',
    });
    await execute('release-and-use-before-matching', [
      {
        kind: 'assess-lot',
        lotId: target.lotId!,
        assessment: 'released',
        reason: 'Independent local release',
      },
      consume('0.25'),
    ]);
    const stocksBeforeExpectation = owner.inspect(scope)!.stocks;
    const configured = await execute('expect-and-configure', [
      expected('expected-main'),
      rule('reorder-high', '600000'),
    ]);
    expect(configured.context?.version).toBe(5);
    expect(owner.inspect(scope)!.stocks).toEqual(stocksBeforeExpectation);
    const initial = await stockroom('one-native-snapshot-before-matching', {
      ...scope,
      project: 'Arrivals',
    });
    expect(initial.expectedDeliveries['expected-main']).toMatchObject({
      allocated: { value: '0', unit: 'ng' },
      remaining: { value: '2500000', unit: 'ng' },
      progress: 'none-received',
    });
    expect(initial.reorderRules['reorder-high']).toMatchObject({
      kind: 'ready',
      assessment: { knownUnreserved: { value: '1000000', unit: 'ng' }, conclusion: 'adequate' },
    });
    const allocation: InventoryCommand = {
      kind: 'allocate-arrival',
      id: 'allocation-original',
      lineId: 'expected-main',
      arrivalId: first.arrival.id,
      componentKey: 'standard',
      quantity: { value: '1.25', unit: 'mg' },
      reason: 'Match the original received amount after some stock was already used',
    };
    await execute('match-original-not-remaining', [allocation]);
    const matched = await stockroom('original-receipt-progress');
    expect(matched.expectedDeliveries['expected-main']).toMatchObject({
      allocated: { value: '1250000', unit: 'ng' },
      remaining: { value: '1250000', unit: 'ng' },
      progress: 'partly-received',
    });
    expect(matched.arrivalComponents).toContainEqual(
      expect.objectContaining({
        arrivalId: first.arrival.id,
        componentKey: 'standard',
        received: { value: '1250000', unit: 'ng' },
        unmatched: { value: '0', unit: 'ng' },
      })
    );
    await execute('later-use-never-unfulfills', [consume('0.5')]);
    const used = await stockroom('low-after-use');
    expect(used.expectedDeliveries['expected-main']).toEqual(
      matched.expectedDeliveries['expected-main']
    );
    expect(used.reorderRules['reorder-high']).toMatchObject({
      kind: 'ready',
      assessment: { knownUnreserved: { value: '500000', unit: 'ng' }, conclusion: 'low' },
    });
    await execute('another-expectation-is-not-stock', [expected('expected-other')]);
    const stillLow = await stockroom('expectation-did-not-raise-stock');
    expect(stillLow.reorderRules['reorder-high']).toEqual(used.reorderRules['reorder-high']);
    await execute('relevant-unknown-and-lower-bound', [
      {
        kind: 'create-vessel',
        id: 'unknown-tube',
        name: 'Unknown mass',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'receive-stock',
        id: 'unknown-mass',
        vesselId: 'unknown-tube',
        materialId: 'arrival-material',
        quantity: { kind: 'unknown', unit: 'ng' },
        quality: 'usable',
      },
      rule('reorder-lower', '400000'),
      rule('reorder-strict', '400000', 'confirmed-current-validity'),
    ]);
    const unknown = await stockroom('unknown-eligible-balance');
    expect(unknown.reorderRules['reorder-high']).toMatchObject({
      kind: 'ready',
      assessment: {
        knownUnreserved: { value: '500000', unit: 'ng' },
        conclusion: 'needs-measurement',
        unknownIncludedStockIds: ['unknown-mass'],
      },
    });
    expect(unknown.reorderRules['reorder-lower']).toMatchObject({
      kind: 'ready',
      assessment: { conclusion: 'adequate', unknownIncludedStockIds: ['unknown-mass'] },
    });
    expect(unknown.reorderRules['reorder-strict']).toMatchObject({
      kind: 'ready',
      assessment: { conclusion: 'low', knownUnreserved: { value: '0', unit: 'ng' } },
    });
    const cutoff = clock + 500;
    await execute('explicit-known-validity', [
      {
        kind: 'record-validity-decision',
        id: 'known-lot-validity',
        owner: { kind: 'lot', lotId: target.lotId! },
        rule: { kind: 'not-required' },
        sourceText: 'Synthetic explicit lot validity assessment',
        sourcePrecision: 'unknown',
        source: null,
        reason:
          'Explicitly assessed this retained lot family; container deadline remains independent',
      },
      {
        kind: 'record-validity-decision',
        id: 'known-validity',
        owner: { kind: 'stock', stockId: target.stockId! },
        rule: { kind: 'absolute', deadlineAt: cutoff },
        sourceText: 'Synthetic exact expiry policy',
        sourcePrecision: 'instant',
        source: null,
        reason: 'Explicit local cutoff for this physical stock',
      },
    ]);
    const beforeDeadline = await stockroom('same-clock-before-cutoff');
    expect(beforeDeadline.reorderRules['reorder-strict']).toMatchObject({
      kind: 'ready',
      assessment: { conclusion: 'adequate', nextBoundaryAt: cutoff },
    });
    const beforeTick = raw();
    clock = cutoff;
    const atDeadline = await stockroom('native-exact-cutoff-read-only');
    expect(atDeadline.reorderRules['reorder-strict']).toMatchObject({
      kind: 'ready',
      assessment: { conclusion: 'low', knownUnreserved: { value: '0', unit: 'ng' } },
    });
    expect(raw()).toEqual(beforeTick);
    await refuse('component-cap-across-lines', [
      {
        ...allocation,
        id: 'too-much',
        lineId: 'expected-other',
        quantity: { value: '1', unit: 'ng' },
      },
    ]);
    await refuse('late-batch-rolls-back-new-expectation', [
      expected('rolled-back-expectation'),
      {
        ...allocation,
        id: 'late-invalid',
        lineId: 'rolled-back-expectation',
        quantity: { value: '1', unit: 'ng' },
      },
    ]);
    await refuse('unresolved-is-not-known-receipt', [
      {
        ...allocation,
        id: 'unresolved-allocation',
        componentKey: 'unknown',
        quantity: { value: '1', unit: 'ng' },
      },
    ]);
    await refuse('basis-mismatch', [
      { ...allocation, id: 'wrong-basis', quantity: { value: '1', unit: 'uL' } },
    ]);
    await execute('close-unmatched-remainder', [
      {
        kind: 'close-expected-delivery-remainder',
        lineId: 'expected-main',
        reason: 'No further supplier delivery expected',
      },
    ]);
    await refuse('closed-matching-correction-requires-reopen', [
      {
        kind: 'withdraw-arrival-allocation',
        allocationId: 'allocation-original',
        reason: 'Correction requires an explicit reopen first',
      },
    ]);
    const correction = request('lost-ack-correction', [
      {
        kind: 'reopen-expected-delivery',
        lineId: 'expected-main',
        reason: 'Reopen before correcting matching',
      },
      {
        kind: 'withdraw-arrival-allocation',
        allocationId: 'allocation-original',
        reason: 'Correct the matched amount with a new fact',
      },
      { ...allocation, id: 'allocation-corrected', quantity: { value: '1', unit: 'mg' } },
    ]);
    const originalReceipt = await loseAcknowledgement(correction);
    const corrected = await stockroom('corrected-allocation-after-lost-ack');
    expect(corrected.expectedDeliveries['expected-main']).toMatchObject({
      allocated: { value: '1000000', unit: 'ng' },
      remaining: { value: '1500000', unit: 'ng' },
    });
    expect(owner.inspect(scope)!.stocks[target.stockId!].quantity).toEqual({
      kind: 'known',
      value: '500000',
      unit: 'ng',
    });
    const retryBefore = raw();
    expect(
      await result('identical-original-retry', 'inventory.execute', correction, 'execution')
    ).toEqual(originalReceipt);
    expect(raw()).toEqual(retryBefore);
    await refuse(
      'missing-scientific-material',
      [expected('unadmitted', '1', 'missing-material')],
      'INVENTORY_MATERIAL_UNAVAILABLE'
    );
    const beforeTrigger = raw();
    db.exec(
      "CREATE TRIGGER archive_stockroom_material AFTER INSERT ON inventory_journal WHEN NEW.operation_id='late-material-archive' BEGIN UPDATE lims_entity SET archived_at=1 WHERE id='arrival-material'; END"
    );
    const late = await call(
      'late-material-archive',
      'inventory.execute',
      request('late-material-archive', [
        expected('late-material-line'),
        rule('late-material-rule', '1'),
      ])
    );
    expect(late.body.result).toMatchObject({
      ok: false,
      code: 'INVENTORY_MATERIAL_CHANGED',
      stateChanged: false,
    });
    const afterTrigger = raw();
    expect({
      states: afterTrigger.states,
      journal: afterTrigger.journal,
      events: afterTrigger.events,
    }).toEqual({
      states: beforeTrigger.states,
      journal: beforeTrigger.journal,
      events: beforeTrigger.events,
    });
    expect((afterTrigger.changes as { count: number }).count).toBeGreaterThan(
      (beforeTrigger.changes as { count: number }).count
    );
    expect(
      db.prepare("SELECT archived_at FROM lims_entity WHERE id='arrival-material'").get()
    ).toEqual({ archived_at: null });
    db.exec('DROP TRIGGER archive_stockroom_material');
    const artifact = await result<InventoryExportSnapshot>(
      'export-stockroom',
      'inventory.export-snapshot',
      { ...scope, format: 'native-v1' },
      'artifact'
    );
    const adoptedScope = { ...scope, inventoryId: 'stockroom-adopted' };
    const adoption = await result<InventoryImportPreviewSnapshot>(
      'preview-adoption',
      'inventory.preview-import',
      {
        ...adoptedScope,
        sourceText: artifact.sourceText,
        options: {
          bindings: [
            { sourceMaterialId: 'arrival-material', destinationMaterialId: 'arrival-material' },
          ],
        },
      },
      'preview'
    );
    if (adoption.kind !== 'ready') throw new Error(JSON.stringify(adoption));
    expect(
      await result(
        'adopt-stockroom',
        'inventory.apply-import',
        {
          ...adoptedScope,
          kind: 'adopt-archive',
          operationId: 'adopt-stockroom',
          expectedRevision: 0,
          sourceText: artifact.sourceText,
          options: adoption.options,
          expectedPlanDigest: adoption.planDigest,
        },
        'execution'
      )
    ).toMatchObject({ status: 'committed', context: { version: 5 } });
    const adopted = await stockroom('adopted-progress', adoptedScope);
    expect(adopted.expectedDeliveries['expected-main'].allocated).toEqual(
      corrected.expectedDeliveries['expected-main'].allocated
    );
    expect(
      owner
        .inspect(adoptedScope)!
        .arrivals[first.arrival.id].components.find((component) => component.key === 'standard')!
        .receivedQuantity
    ).toEqual({ kind: 'known', value: '1250000', unit: 'ng' });
    const savedState = owner.inspect(scope),
      savedHistory = owner.history({ ...scope, limit: 1000 });
    await server!.close();
    server = undefined;
    db.close();
    db = openFileTestDb(dbPath);
    await start();
    expect(owner.inspect(scope)).toEqual(savedState);
    expect(owner.history({ ...scope, limit: 1000 })).toEqual(savedHistory);
    const reopened = raw();
    expect(
      await result('recover-original-after-reopen', 'inventory.execute', correction, 'execution')
    ).toEqual(originalReceipt);
    expect(raw()).toEqual(reopened);
    expect(owner.replay(scope)).toEqual({
      state: savedState,
      acceptedOperations: savedHistory.length,
    });
    await stockroom('reopened-stockroom');
    revokedAt = '2026-01-01T00:00:00.000Z';
    const denied = await call('current-grant-revoked', 'inventory.stockroom', scope);
    expect(denied.body.result).toMatchObject({
      ok: false,
      code: 'INVENTORY_CAPABILITY_DENIED',
      stateChanged: false,
    });
    expect(denied.after).toEqual(denied.before);
    Object.assign(evidence, {
      status: 'passed',
      initial,
      matched,
      used,
      unknown,
      beforeDeadline,
      atDeadline,
      corrected,
      adopted,
      originalReceipt,
      state: savedState,
      history: savedHistory,
      singleNativeClockPerRead: true,
      currentMaterialLateRollback: true,
    });
  } catch (error) {
    evidence.status = 'failed';
    evidence.error =
      error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    if (server) await server.close();
    if (db.open) db.close();
    if (evidenceDir) {
      mkdirSync(resolve(evidenceDir), { recursive: true });
      writeFileSync(
        join(mkdtempSync(join(resolve(evidenceDir), 'native-')), 'acceptance.json'),
        JSON.stringify(evidence, null, 2) + '\n'
      );
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
