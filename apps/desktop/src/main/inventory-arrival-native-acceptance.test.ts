// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  inventoryArrivalPhysicalIds,
  type InventoryArrivalChoices,
  type InventoryArrivalDocumentRead,
  type InventoryArrivalSource,
  type InventoryCommand,
} from '@waypoint/domain-services';
import type {
  InventoryApplyArrivalRequest,
  NativeInventoryReceipt,
} from '../shared/inventory-command';
import type {
  InventoryArrivalPreviewSnapshot,
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

it('receives actual components atomically through native HTTP, retains supplier bytes and never refills a recorded delivery', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-inventory-arrival-')));
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
    revokedAt: string | null = null;
  let authority = { ownerInstanceId: '', token: '' };
  const events: unknown[] = [],
    trace: unknown[] = [];
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-arrival-native-acceptance.v1',
    status: 'running',
    trace,
  };
  const evidenceDir = process.env.INVENTORY_ARRIVAL_EVIDENCE_DIR;
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
      now: () => clock,
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
  async function document(
    arrival: Extract<InventoryArrivalPreviewSnapshot, { kind: 'ready' }>['arrival'],
    selectedScope = scope
  ) {
    const before = raw();
    const value = await result<InventoryArrivalDocumentRead>(
      'document',
      'inventory.arrival-document',
      {
        ...selectedScope,
        arrivalId: arrival.id,
        documentKey: 'packing',
        expectedSha256: arrival.documents[0].sha256,
      },
      'result',
      reader
    );
    expect(value).toMatchObject({ kind: 'available', body: source.documents[0].body });
    expect(raw()).toEqual(before);
    return value;
  }
  async function loseAcknowledgement(input: InventoryApplyArrivalRequest) {
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
        command: 'inventory.apply-arrival',
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
    const first = await preview();
    expect(first.kind).toBe('ready');
    if (first.kind !== 'ready') throw new Error(JSON.stringify(first));
    const firstRequest = application(first, 'receive-original');
    const denied = await call(
      'reader-cannot-receive',
      'inventory.apply-arrival',
      firstRequest,
      reader
    );
    expect(denied.status).toBe(200);
    expect(denied.body.result).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_SCOPE',
      stateChanged: false,
    });
    expect(denied.after).toEqual(denied.before);
    const receipt = await loseAcknowledgement(firstRequest);
    expect(receipt).toMatchObject({ status: 'committed', revision: 1, context: { version: 6 } });
    const state = owner.inspect(scope)!;
    expect(Object.keys(state.arrivals)).toEqual([first.arrival.id]);
    expect(state.revision).toBe(1);
    const target = first.options.targets.find((row) => row.componentKey === 'standard')!;
    const unresolved = first.options.targets.find((row) => row.componentKey === 'unknown')!;
    expect(state.stocks[target.stockId!].quantity).toEqual({
      kind: 'known',
      value: '1250000',
      unit: 'ng',
    });
    expect(state.lots[target.lotId!].controls).toMatchObject({
      kind: 'managed',
      assessment: { value: 'unassessed' },
    });
    expect(state.vessels[unresolved.vesselId!].contentsKnowledge.kind).toBe('unidentified');
    expect(unresolved.stockId).toBeNull();
    expect(Object.keys(state.stocks)).toHaveLength(1);
    await document(first.arrival);
    await execute('release-use-move', [
      {
        kind: 'assess-lot',
        lotId: target.lotId!,
        assessment: 'released',
        reason: 'Independent local assessment complete',
      },
      {
        kind: 'consume',
        stockId: target.stockId!,
        quantity: { value: '0.25', unit: 'mg' },
        reason: 'Measured experiment use',
      },
      {
        kind: 'create-storage',
        id: 'drawer',
        name: 'Actual drawer',
        slots: ['A1'],
        placement: { kind: 'root' },
      },
      {
        kind: 'move-vessel',
        id: target.vesselId!,
        placement: { kind: 'located', storageId: 'drawer', slotId: 'A1' },
      },
    ]);
    const unchanged = await preview();
    expect(unchanged.kind).toBe('no-change');
    if (unchanged.kind !== 'no-change') throw new Error(JSON.stringify(unchanged));
    expect(unchanged.options.targets).toEqual(first.options.targets);
    const repeated = await call('fresh-duplicate-no-write', 'inventory.apply-arrival', {
      ...firstRequest,
      operationId: 'duplicate-fresh',
      expectedRevision: owner.inspect(scope)!.revision,
    });
    expect(repeated.body.result?.execution).toMatchObject({
      status: 'rejected',
      code: 'INVENTORY_ARRIVAL_NO_CHANGES',
    });
    expect(repeated.after).toEqual(repeated.before);
    expect(owner.inspect(scope)!.stocks[target.stockId!].quantity).toEqual({
      kind: 'known',
      value: '1000000',
      unit: 'ng',
    });
    const changed = await preview(JSON.stringify({ ...source, supplier: 'Changed supplier' }));
    expect(changed.kind).toBe('blocked');
    const collisionSource = {
        ...source,
        identity: { ...source.identity, arrivalId: 'late-collision' },
      },
      collisionText = JSON.stringify(collisionSource);
    const collision = await preview(collisionText);
    expect(collision.kind).toBe('ready');
    const lateVessel = inventoryArrivalPhysicalIds(
      {
        projectId: scope.project,
        inventoryId: scope.inventoryId,
      },
      collisionSource.identity,
      'vessel',
      'unknown'
    );
    await execute('occupy-late-component-id', [
      {
        kind: 'create-vessel',
        id: lateVessel,
        name: 'Existing physical vessel',
        placement: { kind: 'unplaced' },
      },
    ]);
    const conflict = await call('late-component-collision', 'inventory.apply-arrival', {
      ...application(collision, 'collision-apply', collisionText),
      expectedRevision: owner.inspect(scope)!.revision,
    });
    expect(conflict.body.result?.execution).toMatchObject({ status: 'rejected' });
    expect(conflict.after).toEqual(conflict.before);
    const beforeRetry = raw();
    expect(
      await result(
        'original-operation-after-use',
        'inventory.apply-arrival',
        firstRequest,
        'execution'
      )
    ).toEqual(receipt);
    expect(raw()).toEqual(beforeRetry);
    const artifact = await result<InventoryExportSnapshot>(
      'export',
      'inventory.export-snapshot',
      { ...scope, format: 'native-v1' },
      'artifact'
    );
    const adoptedScope = { ...scope, inventoryId: 'arrival-adopted' };
    async function adopt(text: string, selectedScope: typeof scope) {
      const value = await result<InventoryImportPreviewSnapshot>(
        'adoption-preview',
        'inventory.preview-import',
        {
          ...selectedScope,
          sourceText: text,
          options: {
            bindings: [
              { sourceMaterialId: 'arrival-material', destinationMaterialId: 'arrival-material' },
            ],
          },
        },
        'preview'
      );
      if (value.kind !== 'ready') throw new Error(JSON.stringify(value));
      const adoption = await result<NativeInventoryReceipt>(
        'adoption',
        'inventory.apply-import',
        {
          ...selectedScope,
          kind: 'adopt-archive',
          operationId: `adopt-${selectedScope.inventoryId}`,
          expectedRevision: 0,
          sourceText: text,
          options: value.options,
          expectedPlanDigest: value.planDigest,
        },
        'execution'
      );
      expect(adoption.status).toBe('committed');
      return adoption;
    }
    await adopt(artifact.sourceText, adoptedScope);
    await document(first.arrival, adoptedScope);
    expect((await preview(sourceText, options, adoptedScope)).kind).toBe('no-change');
    const adoptedArtifact = await result<InventoryExportSnapshot>(
      'nested-export',
      'inventory.export-snapshot',
      { ...adoptedScope, format: 'native-v1' },
      'artifact'
    );
    const nestedScope = { ...scope, inventoryId: 'arrival-nested' };
    await adopt(adoptedArtifact.sourceText, nestedScope);
    await document(first.arrival, nestedScope);
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
      await result('original-after-reopen', 'inventory.apply-arrival', firstRequest, 'execution')
    ).toEqual(receipt);
    expect(raw()).toEqual(reopened);
    await document(first.arrival, nestedScope);
    expect(owner.replay(scope)).toEqual({
      state: savedState,
      acceptedOperations: savedHistory.length,
    });
    revokedAt = '2026-01-01T00:00:00.000Z';
    const revoked = await call('revoked-document-read', 'inventory.arrival-document', {
      ...scope,
      arrivalId: first.arrival.id,
      documentKey: 'packing',
      expectedSha256: first.arrival.documents[0].sha256,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.result).toMatchObject({
      ok: false,
      code: 'INVENTORY_CAPABILITY_DENIED',
      stateChanged: false,
    });
    expect(revoked.after).toEqual(revoked.before);
    Object.assign(evidence, {
      status: 'passed',
      firstRequest,
      originalReceipt: receipt,
      first,
      unchanged,
      changed,
      finalState: savedState,
      history: savedHistory,
      exactRetainedDocuments: true,
      noPartialEffects: true,
      zeroLostAckResponseBytes: true,
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
