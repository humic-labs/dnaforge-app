// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
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
  InventoryAvailabilitySnapshot,
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
  | 'inventory.apply-import'
  | 'inventory.availability';
type Agent = { identityId: string; capabilities: string[] };
interface WireResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  accepted?: boolean;
}
const writer = {
  identityId: 'validity-writer',
  capabilities: ['read-workspace', 'write-workspace'],
};
const adopter = {
  identityId: 'validity-adopter',
  capabilities: ['read-workspace', 'write-workspace'],
};
const known = (value: string, unit: InventoryAmountUnit = 'uL'): InventoryQuantityInput => ({
  kind: 'known',
  value,
  unit,
});
const hash = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

it('enforces opening and exact expiry through native HTTP, trusted clocks, receipt recovery and nested adoption', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-inventory-validity-')));
  const dbPath = join(root, 'inventory.sqlite');
  const projectPath = join(root, 'project');
  const otherPath = join(root, 'other-project');
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  const scope = { project: 'validity-project', inventoryId: 'validity-inventory' };
  const target = { ...scope, inventoryId: 'validity-adopted' };
  const profileKey = 'a'.repeat(64);
  const projectScope = { kind: 'project-roots', roots: [projectPath] };
  const events: unknown[] = [];
  const trace: unknown[] = [];
  let db: Database.Database = openFileTestDb(dbPath);
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  let owner!: ReturnType<typeof createNativeInventoryOwner>;
  let authority = {
    ownerInstanceId: 'validity-native-0',
    token: 'synthetic-validity-token-0',
  };
  let instance = 0;
  let revokedAt: string | null = null;
  let clock = 1_700_000_000_000;
  const evidenceRoot = process.env.INVENTORY_VALIDITY_EVIDENCE_DIR;
  const evidencePath = evidenceRoot
    ? (() => {
        mkdirSync(resolve(evidenceRoot), { recursive: true });
        return join(mkdtempSync(join(resolve(evidenceRoot), 'native-')), 'acceptance.json');
      })()
    : null;
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-validity-native-acceptance.v1',
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
      ownerInstanceId: `validity-native-${++instance}`,
      token: `synthetic-validity-token-${instance}`,
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
      'inventory.availability': 'availability',
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
  const startedAt = clock;
  const consume = (
    stockId: string,
    value = '1'
  ): Extract<InventoryCommand, { kind: 'consume' }> => ({
    kind: 'consume',
    stockId,
    quantity: { value, unit: 'uL' },
    reason: 'Measured use',
  });
  const reserve = (id: string, stockId: string): InventoryCommand => ({
    kind: 'reserve-quantity',
    id,
    stockId,
    quantity: { value: '1', unit: 'uL' },
    deadline: null,
    purpose: 'Planned use before expiry',
  });
  const opening = (
    id: string,
    stockId: string,
    value: 'sealed' | 'opened',
    observedAt: number | null
  ): InventoryCommand => ({
    kind: 'record-stock-opening',
    id,
    stockId,
    value,
    observedAt,
    source: null,
    reason: 'Explicit physical opening observation',
  });
  const validity = (
    id: string,
    stockId: string,
    rule: Extract<InventoryCommand, { kind: 'record-validity-decision' }>['rule']
  ): InventoryCommand => ({
    kind: 'record-validity-decision',
    id,
    owner: { kind: 'stock', stockId },
    rule,
    sourceText: 'Synthetic container stability statement',
    sourcePrecision: 'elapsed-duration',
    source: null,
    reason: 'Explicit local interpretation of this container policy',
  });
  async function availability(label: string, input = scope) {
    const before = raw();
    const value = await success<InventoryAvailabilitySnapshot>(
      label,
      'inventory.availability',
      input
    );
    expect(value, label).toMatchObject({
      projectId: scope.project,
      inventoryId: input.inventoryId,
    });
    expect(raw(), label).toEqual(before);
    return value;
  }
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Validity',?,'validity-project','writable',1),(42,'Other',?,'validity-other','writable',1)"
    ).run(projectPath, otherPath);
    rememberOriginalDefaultProject(db, 41);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('validity-schema','entity','validity','Validity','{}','validity-schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('validity-schema-v1','validity-schema',1,'{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('validity-material','record','validity-schema','validity-schema-v1','Synthetic standard','{}',41,'registered',1,1)"
    ).run();
    await start();
    const receiveRequest = request('receive-validity-episodes', [
      ...['source', 'child', 'sibling', 'late-child', 'unknown', 'positive', 'legacy', 'probe'].map(
        (id): InventoryCommand => ({
          kind: 'create-vessel',
          id: `${id}-vessel`,
          name: id,
          placement: { kind: 'unplaced' },
        })
      ),
      {
        kind: 'create-lot',
        id: 'supplier-lot',
        materialId: 'validity-material',
        name: 'Supplier lot',
        origin: { kind: 'received', supplier: 'Synthetic supplier', lotNumber: '0001' },
      },
      { kind: 'manage-lot', lotId: 'supplier-lot', reason: 'Manage local lot release' },
      {
        kind: 'assess-lot',
        lotId: 'supplier-lot',
        assessment: 'released',
        reason: 'Local quality release does not establish validity',
      },
      {
        kind: 'receive-lot-stock',
        id: 'source',
        vesselId: 'source-vessel',
        lotId: 'supplier-lot',
        quantity: known('100'),
        quality: 'usable',
      },
      ...['unknown', 'positive', 'legacy'].map(
        (id): InventoryCommand => ({
          kind: 'receive-stock',
          id,
          vesselId: `${id}-vessel`,
          materialId: 'validity-material',
          quantity: known('10'),
          quality: 'usable',
        })
      ),
    ]);
    const receiveReceipt = await success<NativeInventoryExecution>(
      'receive-material-episodes',
      'inventory.execute',
      receiveRequest
    );
    expect(receiveReceipt).toMatchObject({ status: 'committed', context: { version: 5 } });
    await execute('unobserved-alone-does-not-block-untracked-use', [consume('legacy')]);
    await execute('retain-printed-month-as-unresolved-evidence', [
      {
        kind: 'record-validity-decision',
        id: 'lot-validity',
        owner: { kind: 'lot', lotId: 'supplier-lot' },
        rule: { kind: 'unresolved' },
        sourceText: 'Printed expiration: 2023-11',
        sourcePrecision: 'month',
        source: null,
        reason: 'Printed month has no chosen cutoff or timezone',
      },
    ]);
    await refuse(
      'quality-release-cannot-override-unresolved-validity',
      [consume('source')],
      'VALIDITY_UNRESOLVED'
    );
    await execute('interpret-explicit-cutoff-and-relative-container-rule', [
      {
        kind: 'correct-validity-decision',
        id: 'lot-absolute',
        supersedesId: 'lot-validity',
        rule: { kind: 'absolute', deadlineAt: startedAt + 1000 },
        sourceText: 'Printed expiration: 2023-11',
        sourcePrecision: 'month',
        source: null,
        reason: 'Explicit synthetic cutoff instant; no automatic month conversion',
      },
      validity('relative-policy', 'source', {
        kind: 'after-opening',
        openingStockId: 'source',
        elapsedMs: 500,
      }),
    ]);
    await refuse(
      'unobserved-relative-opening-cannot-reserve',
      [reserve('unknown-opening-hold', 'source')],
      'VALIDITY_UNRESOLVED'
    );
    await execute('observe-sealed-source', [
      opening('source-sealed', 'source', 'sealed', startedAt),
    ]);
    const sealed = await availability('sealed-native-actions', { ...scope, project: 'Validity' });
    expect(sealed.stocks.source.actions.reserve).toEqual({ kind: 'allowed' });
    expect(sealed.stocks.source.actions.withdraw).toMatchObject({
      kind: 'blocked',
      blockers: [expect.objectContaining({ code: 'OPENING_REQUIRED' })],
    });
    await execute('sealed-source-can-be-reserved', [reserve('source-hold', 'source')]);
    await refuse(
      'sealed-use-still-needs-explicit-opening',
      [consume('source')],
      'OPENING_REQUIRED'
    );
    clock = startedAt + 10;
    await execute('open-and-use-in-one-native-transaction', [
      opening('source-open', 'source', 'opened', startedAt + 10),
      consume('source'),
    ]);
    clock = startedAt + 100;
    await execute('derive-two-physical-aliquots', [
      {
        kind: 'transfer',
        sourceStockId: 'source',
        quantity: { value: '10', unit: 'uL' },
        destination: { kind: 'new-stock', stockId: 'child', vesselId: 'child-vessel' },
        reason: 'Actual aliquot before later corrections',
      },
      {
        kind: 'transfer',
        sourceStockId: 'source',
        quantity: { value: '5', unit: 'uL' },
        destination: { kind: 'new-stock', stockId: 'sibling', vesselId: 'sibling-vessel' },
        reason: 'Independent earlier sibling',
      },
    ]);
    const derivationAt = clock;
    expect(owner.inspect(scope)!.stocks.child.inheritedValidity).toEqual([
      { rootId: 'relative-policy', openingNoLaterThan: derivationAt },
    ]);
    clock = startedAt + 200;
    await execute('destination-opening-does-not-reset-inherited-deadline', [
      opening('child-own-opening', 'child', 'opened', startedAt + 200),
      validity('later-source-policy', 'source', { kind: 'absolute', deadlineAt: startedAt + 900 }),
      {
        kind: 'transfer',
        sourceStockId: 'source',
        quantity: { value: '3', unit: 'uL' },
        destination: { kind: 'new-stock', stockId: 'late-child', vesselId: 'late-child-vessel' },
        reason: 'Later aliquot includes the new source family',
      },
      opening('positive-open', 'positive', 'opened', startedAt + 200),
      validity('positive-policy', 'positive', {
        kind: 'after-opening',
        openingStockId: 'positive',
        elapsedMs: 10000,
      }),
    ]);
    expect(owner.inspect(scope)!.stocks.sibling.inheritedValidity.map((x) => x.rootId)).toEqual([
      'relative-policy',
    ]);
    expect(
      owner.inspect(scope)!.stocks['late-child'].inheritedValidity.map((x) => x.rootId)
    ).toEqual(['later-source-policy', 'relative-policy']);
    expect(
      (await availability('inherited-deadline-is-original-source')).stocks.child.validity
        .effectiveDeadlineAt
    ).toBe(startedAt + 510);
    await execute('corrected-source-opening-conflicts-with-earlier-derivation', [
      {
        kind: 'correct-stock-opening',
        id: 'source-opening-late',
        stockId: 'source',
        supersedesId: 'source-open',
        value: 'opened',
        observedAt: startedAt + 150,
        source: null,
        reason: 'Corrected report conflicts with already recorded aliquot',
      },
    ]);
    await refuse(
      'contradictory-correction-cannot-extend-child-life',
      [consume('child')],
      'VALIDITY_CHRONOLOGY_CONFLICT'
    );
    await execute('correct-unreliable-opening-status-to-unobserved', [
      {
        kind: 'correct-stock-opening',
        id: 'source-opening-unobserved',
        stockId: 'source',
        supersedesId: 'source-opening-late',
        value: 'unobserved',
        observedAt: null,
        source: null,
        reason: 'The prior opening report was unreliable',
      },
    ]);
    expect(owner.inspect(scope)!.stocks.source.opening).toEqual({
      kind: 'unobserved',
      observationId: 'source-opening-unobserved',
    });
    await refuse(
      'corrected-unobserved-keeps-inherited-policy-unresolved',
      [consume('child')],
      'VALIDITY_UNRESOLVED'
    );
    await execute('record-earlier-supported-opening-without-erasing-chain', [
      opening('source-opening-supported', 'source', 'opened', startedAt + 5),
    ]);
    await execute('opened-with-unknown-time-is-a-different-state', [
      opening('unknown-open-time', 'unknown', 'opened', null),
      validity('unknown-policy', 'unknown', {
        kind: 'after-opening',
        openingStockId: 'unknown',
        elapsedMs: 10000,
      }),
    ]);
    await refuse(
      'opened-at-unknown-is-not-an-observation-of-now',
      [consume('unknown')],
      'OPENING_TIME_UNKNOWN'
    );
    clock = startedAt + 300;
    const lostRequest = request('use-before-expiry-lost-response', [consume('source')]);
    const originalReceipt = await loseAcknowledgement(lostRequest);
    clock = startedAt + 503;
    await execute('hold-aliquot-immediately-before-cutoff', [reserve('child-hold', 'child')]);
    const beforeCutoff = await availability('native-cutoff-minus-one');
    expect(beforeCutoff.asOf).toBe(startedAt + 504);
    expect(beforeCutoff.stocks.child.validity).toMatchObject({
      state: 'current',
      effectiveDeadlineAt: startedAt + 505,
      nextBoundaryAt: startedAt + 505,
    });
    expect(beforeCutoff.stocks.child.actions.withdraw).toEqual({ kind: 'allowed' });
    clock = startedAt + 505;
    const atCutoff = await availability('native-exact-cutoff');
    expect(atCutoff.asOf).toBe(startedAt + 505);
    expect(atCutoff.stocks.child.validity.state).toBe('expired');
    expect(atCutoff.stocks.child.actions.reserve).toMatchObject({
      kind: 'blocked',
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'MATERIAL_EXPIRED' })]),
    });
    await refuse('exact-cutoff-use-refusal', [consume('child')], 'MATERIAL_EXPIRED');
    await refuse(
      'exact-cutoff-transfer-refusal',
      [
        {
          kind: 'transfer',
          sourceStockId: 'child',
          quantity: { value: '1', unit: 'uL' },
          destination: { kind: 'new-stock', stockId: 'must-not-exist', vesselId: 'probe-vessel' },
          reason: 'Expired material cannot be aliquoted',
        },
      ],
      'MATERIAL_EXPIRED'
    );
    await refuse(
      'exact-cutoff-reservation-refusal',
      [reserve('late-hold', 'child')],
      'MATERIAL_EXPIRED'
    );
    await refuse(
      'late-expiry-refusal-rolls-back-an-earlier-opening-fact',
      [opening('rolled-back-opening', 'legacy', 'opened', clock), consume('child')],
      'MATERIAL_EXPIRED'
    );
    expect(owner.inspect(scope)!.openingObservations['rolled-back-opening']).toBeUndefined();
    const heldBefore = owner.inspect(scope)!.reservations['child-hold'];
    await refuse(
      'exact-cutoff-fulfillment-refusal',
      [
        {
          kind: 'fulfill-reservations',
          claims: [{ reservationId: 'child-hold', quantity: { value: '1', unit: 'uL' } }],
          withdrawal: consume('child'),
        },
      ],
      'MATERIAL_EXPIRED'
    );
    expect(owner.inspect(scope)!.reservations['child-hold']).toEqual(heldBefore);
    const retryBefore = raw();
    expect(
      await success('original-receipt-after-expiry', 'inventory.execute', lostRequest)
    ).toEqual(originalReceipt);
    expect(raw()).toEqual(retryBefore);
    expect(owner.inspect(scope)!.stocks.source.quantity).toEqual(known('80'));
    await execute('late-lot-expiry-and-clean-association-retain-original-owner', [
      {
        kind: 'correct-validity-decision',
        id: 'lot-expiry-correction',
        supersedesId: 'lot-absolute',
        rule: { kind: 'absolute', deadlineAt: startedAt + 500 },
        sourceText: 'Corrected supplier cutoff',
        sourcePrecision: 'instant',
        source: null,
        reason: 'Late learned stricter original-lot deadline',
      },
      {
        kind: 'create-lot',
        id: 'clean-lot',
        materialId: 'validity-material',
        name: 'Clean label',
        origin: { kind: 'received', supplier: 'Synthetic supplier', lotNumber: '0002' },
      },
      { kind: 'manage-lot', lotId: 'clean-lot', reason: 'Local management' },
      {
        kind: 'assess-lot',
        lotId: 'clean-lot',
        assessment: 'released',
        reason: 'Local quality release',
      },
      {
        kind: 'associate-stock-lot',
        stockId: 'child',
        lotId: 'clean-lot',
        reason: 'A new label cannot erase earlier material restrictions',
      },
    ]);
    expect(
      (await availability('late-lot-deadline-reaches-retained-descendants')).stocks.child.validity
        .effectiveDeadlineAt
    ).toBe(startedAt + 500);
    const artifact = await success<InventoryExportSnapshot>(
      'export-opening-validity-families',
      'inventory.export-snapshot',
      { ...scope, format: 'native-v1' }
    );
    const importOptions = {
      bindings: [
        { sourceMaterialId: 'validity-material', destinationMaterialId: 'validity-material' },
      ],
    };
    clock = owner.inspect(scope)!.lastRecordedAt - 1;
    const futureBefore = raw();
    const futurePreview = await success<InventoryImportPreviewSnapshot>(
      'future-source-clock-refuses-adoption',
      'inventory.preview-import',
      {
        ...scope,
        inventoryId: 'future-target',
        sourceText: artifact.sourceText,
        options: importOptions,
      },
      adopter
    );
    expect(futurePreview.kind).toBe('blocked');
    expect(futurePreview.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_CLOCK_IN_FUTURE' })])
    );
    expect(raw()).toEqual(futureBefore);
    clock = owner.inspect(scope)!.lastRecordedAt + 10;
    const preview = await success<InventoryImportPreviewSnapshot>(
      'preview-validity-adoption',
      'inventory.preview-import',
      { ...target, sourceText: artifact.sourceText, options: importOptions },
      adopter
    );
    if (preview.kind !== 'ready') throw new Error(JSON.stringify(preview));
    const adoptionRequest = {
      ...target,
      kind: 'adopt-archive',
      operationId: 'adopt-opening-validity',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: preview.options,
      expectedPlanDigest: preview.planDigest,
    };
    clock = owner.inspect(scope)!.lastRecordedAt - 1;
    const futureApplyBefore = raw();
    const futureApply = await success<NativeInventoryExecution>(
      'accepting-transaction-rechecks-source-clock-after-ready-preview',
      'inventory.apply-import',
      { ...adoptionRequest, operationId: 'future-clock-apply-refusal' },
      adopter
    );
    expect(futureApply).toMatchObject({ status: 'rejected', code: 'SOURCE_CLOCK_IN_FUTURE' });
    expect(raw()).toEqual(futureApplyBefore);
    clock = owner.inspect(scope)!.lastRecordedAt + 10;
    const adoptionReceipt = await success<NativeInventoryExecution>(
      'adopt-retained-interpretations-and-opening-evidence',
      'inventory.apply-import',
      adoptionRequest,
      adopter
    );
    expect(adoptionReceipt.status).toBe('committed');
    const adoptedOpeningBefore = owner.inspect(target)!.openingObservations;
    const adoptedPositive = await availability(
      'imported-positive-interpretation-needs-local-authority',
      target
    );
    expect(adoptedPositive.stocks.positive.actions.withdraw).toMatchObject({
      kind: 'blocked',
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'VALIDITY_ASSESSMENT_IMPORTED' }),
      ]),
    });
    expect(adoptedPositive.stocks.child.validity.state).toBe('expired');
    const reassessRequest = {
      ...target,
      operationId: 'reassess-imported-validity',
      expectedRevision: owner.inspect(target)!.revision,
      commands: [
        {
          kind: 'correct-validity-decision',
          id: 'positive-local-reassessment',
          supersedesId: 'positive-policy',
          rule: { kind: 'after-opening', openingStockId: 'positive', elapsedMs: 10000 },
          sourceText: 'Synthetic container stability statement',
          sourcePrecision: 'elapsed-duration',
          source: null,
          reason: 'Explicit local reassessment retains the original observed opening',
        },
      ],
    };
    expect(
      await success<NativeInventoryExecution>(
        'local-reassessment-does-not-manufacture-opening',
        'inventory.execute',
        reassessRequest,
        adopter
      )
    ).toMatchObject({ status: 'committed' });
    expect(owner.inspect(target)!.openingObservations).toEqual(adoptedOpeningBefore);
    expect(
      (await availability('locally-reassessed-positive-policy-can-use-original-opening', target))
        .stocks.positive.actions.withdraw
    ).toEqual({ kind: 'allowed' });
    const adoptedArtifact = await success<InventoryExportSnapshot>(
      'export-already-adopted-validity',
      'inventory.export-snapshot',
      { ...target, format: 'native-v1' },
      adopter
    );
    const nestedTarget = { ...scope, inventoryId: 'nested-validity-target' };
    const nestedPreview = await success<InventoryImportPreviewSnapshot>(
      'preview-nested-validity-archive',
      'inventory.preview-import',
      { ...nestedTarget, sourceText: adoptedArtifact.sourceText, options: importOptions },
      adopter
    );
    if (nestedPreview.kind !== 'ready') throw new Error(JSON.stringify(nestedPreview));
    const nestedRequest = {
      ...nestedTarget,
      kind: 'adopt-archive',
      operationId: 'nested-validity-adoption',
      expectedRevision: 0,
      sourceText: adoptedArtifact.sourceText,
      options: nestedPreview.options,
      expectedPlanDigest: nestedPreview.planDigest,
    };
    expect(
      await success<NativeInventoryExecution>(
        'nested-adoption-retains-foreign-interpretation-boundary',
        'inventory.apply-import',
        nestedRequest,
        adopter
      )
    ).toMatchObject({ status: 'committed' });
    expect(
      (await availability('nested-import-requires-its-own-local-reassessment', nestedTarget)).stocks
        .positive.actions.withdraw
    ).toMatchObject({
      kind: 'blocked',
      blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'VALIDITY_ASSESSMENT_IMPORTED' }),
      ]),
    });
    const state = owner.inspect(scope)!;
    const adoptedState = owner.inspect(target)!;
    const nestedState = owner.inspect(nestedTarget)!;
    const history = owner.history({ ...scope, limit: 1000 });
    const adoptedHistory = owner.history({ ...target, limit: 1000 });
    const nestedHistory = owner.history({ ...nestedTarget, limit: 1000 });
    expect(owner.replay(scope)).toEqual({ state, acceptedOperations: state.revision });
    expect(owner.replay(target)).toEqual({
      state: adoptedState,
      acceptedOperations: adoptedState.revision,
    });
    expect(owner.replay(nestedTarget)).toEqual({ state: nestedState, acceptedOperations: 1 });
    await server!.close();
    server = undefined;
    db.close();
    db = openFileTestDb(dbPath);
    await start();
    expect(owner.inspect(scope)).toEqual(state);
    expect(owner.inspect(target)).toEqual(adoptedState);
    expect(owner.inspect(nestedTarget)).toEqual(nestedState);
    expect(owner.history({ ...scope, limit: 1000 })).toEqual(history);
    expect(owner.history({ ...target, limit: 1000 })).toEqual(adoptedHistory);
    expect(owner.history({ ...nestedTarget, limit: 1000 })).toEqual(nestedHistory);
    expect(owner.replay(scope)).toEqual({ state, acceptedOperations: state.revision });
    expect(owner.replay(target)).toEqual({
      state: adoptedState,
      acceptedOperations: adoptedState.revision,
    });
    expect(owner.replay(nestedTarget)).toEqual({ state: nestedState, acceptedOperations: 1 });
    const reopenedBefore = raw();
    expect(
      await success(
        'original-use-receipt-after-reopen-and-expiry',
        'inventory.execute',
        lostRequest
      )
    ).toEqual(originalReceipt);
    expect(
      await success('original-receive-receipt-after-reopen', 'inventory.execute', receiveRequest)
    ).toEqual(receiveReceipt);
    expect(
      await success(
        'original-adoption-receipt-after-local-reassessment',
        'inventory.apply-import',
        adoptionRequest,
        adopter
      )
    ).toEqual(adoptionReceipt);
    expect(raw()).toEqual(reopenedBefore);
    expect(
      (
        await success<InventoryExportSnapshot>(
          'exact-expiry-export-after-reopen',
          'inventory.export-snapshot',
          { ...scope, format: 'native-v1' }
        )
      ).sourceText
    ).toBe(artifact.sourceText);
    Object.assign(evidence, {
      status: 'passed',
      state,
      adoptedState,
      nestedState,
      history,
      adoptedHistory,
      nestedHistory,
      originalReceipt,
      receiveReceipt,
      receiveRequest,
      adoptionReceipt,
      adoptionRequest,
      beforeCutoff,
      atCutoff,
      derivationAt,
      reopenedExactStateHistoryAndExport: true,
      zeroPartialEffectsOnRefusals: true,
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
