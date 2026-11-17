// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  INVENTORY_RECEIVE_TABLE_COLUMNS,
  INVENTORY_STOCKTAKE_COLUMNS,
  inventoryObservationKey,
  type InventoryCommand,
  type InventoryQuantityInput,
  type InventoryAmountUnit,
  type InventoryReceiveTableFields,
  type InventoryStocktakeFields,
} from '@waypoint/domain-services';
import type {
  InventoryExecuteRequest,
  NativeInventoryExecution,
  NativeInventoryReceipt,
} from '../shared/inventory-command';
import type {
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
  InventoryTablePreviewSnapshot,
  InventoryStocktakePreviewSnapshot,
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
  | 'inventory.preview-table'
  | 'inventory.apply-table'
  | 'inventory.preview-stocktake'
  | 'inventory.apply-stocktake';
type Agent = { identityId: string; capabilities: string[] };
interface WireResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  accepted?: boolean;
}
const writer = {
  identityId: 'amounts-writer',
  capabilities: ['read-workspace', 'write-workspace'],
};
const adopter = {
  identityId: 'amounts-adopter',
  capabilities: ['read-workspace', 'write-workspace'],
};
const known = (value: string, unit: InventoryAmountUnit = 'uL'): InventoryQuantityInput => ({
  kind: 'known',
  value,
  unit,
});
const hash = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

it('preserves declared amount bases through native HTTP, atomic refusals, source imports, adoption and restart', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-inventory-amounts-')));
  const dbPath = join(root, 'inventory.sqlite');
  const projectPath = join(root, 'project');
  const otherPath = join(root, 'other-project');
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  const scope = { project: 'amounts-project', inventoryId: 'amounts-inventory' };
  const target = { ...scope, inventoryId: 'amounts-adopted' };
  const profileKey = 'a'.repeat(64);
  const projectScope = { kind: 'project-roots', roots: [projectPath] };
  const events: unknown[] = [];
  const trace: unknown[] = [];
  let db: Database.Database = openFileTestDb(dbPath);
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  let owner!: ReturnType<typeof createNativeInventoryOwner>;
  let authority = { ownerInstanceId: 'amounts-native-0', token: 'synthetic-amounts-token-0' };
  let instance = 0;
  let revokedAt: string | null = null;
  let clock = 1_700_000_000_000;
  const evidenceRoot = process.env.INVENTORY_AMOUNTS_EVIDENCE_DIR;
  const evidencePath = evidenceRoot
    ? (() => {
        mkdirSync(resolve(evidenceRoot), { recursive: true });
        return join(mkdtempSync(join(resolve(evidenceRoot), 'native-')), 'acceptance.json');
      })()
    : null;
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-amounts-native-acceptance.v1',
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
      ownerInstanceId: `amounts-native-${++instance}`,
      token: `synthetic-amounts-token-${instance}`,
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
      'inventory.preview-table': 'preview',
      'inventory.apply-table': 'execution',
      'inventory.preview-stocktake': 'preview',
      'inventory.apply-stocktake': 'execution',
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
  const receive = (id: string, quantity: InventoryQuantityInput): InventoryCommand => ({
    kind: 'receive-stock',
    id,
    vesselId: `${id}-vessel`,
    materialId: 'amounts-material',
    quantity,
    quality: 'usable',
  });
  const consume = (
    stockId: string,
    value: string,
    unit: InventoryAmountUnit
  ): InventoryCommand => ({
    kind: 'consume',
    stockId,
    quantity: { value, unit },
    reason: 'Measured laboratory use',
  });
  const reserve = (
    id: string,
    stockId: string,
    value: string,
    unit: InventoryAmountUnit
  ): InventoryCommand => ({
    kind: 'reserve-quantity',
    id,
    stockId,
    quantity: { value, unit },
    purpose: 'Planned experiment',
    deadline: null,
  });
  const transfer = (
    stockId: string,
    value: string,
    unit: InventoryAmountUnit,
    destination: Extract<InventoryCommand, { kind: 'transfer' }>['destination']
  ): InventoryCommand => ({
    kind: 'transfer',
    sourceStockId: stockId,
    quantity: { value, unit },
    destination,
    reason: 'Measured aliquot',
  });
  const csv = <K extends string>(columns: readonly K[], fields: Record<K, string>) =>
    [
      columns.join(','),
      columns.map((key) => '"' + fields[key].replaceAll('"', '""') + '"').join(','),
    ].join('\r\n');
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Amounts',?,'amounts-project','writable',1),(42,'Other',?,'amounts-other','writable',1)"
    ).run(projectPath, otherPath);
    rememberOriginalDefaultProject(db, 41);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('amounts-schema','entity','amounts','Amounts','{}','amounts-schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('amounts-schema-v1','amounts-schema',1,'{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('amounts-material','record','amounts-schema','amounts-schema-v1','Synthetic standard','{}',41,'registered',1,1)"
    ).run();
    await start();
    const ids = [
      'mass',
      'count',
      'molar',
      'unknown-mass',
      'unknown-count',
      'legacy-unknown',
      'mass-aliquot',
      'count-aliquot',
      'mix-target',
    ];
    const received = [
      receive('mass', known('2.5', 'mg')),
      receive('count', known('10', 'item')),
      receive('molar', known('1.5', 'umol')),
      receive('unknown-mass', { kind: 'unknown', unit: 'ug' }),
      receive('unknown-count', { kind: 'unknown', unit: 'item' }),
      receive('legacy-unknown', { kind: 'unknown' }),
    ];
    const receivedRequest = request('receive-declared-bases', [
      ...ids.map(
        (id): InventoryCommand => ({
          kind: 'create-vessel',
          id: `${id}-vessel`,
          name: id,
          placement: { kind: 'unplaced' },
        })
      ),
      {
        kind: 'set-vessel-limits',
        vesselId: 'mass-vessel',
        limits: {
          capacity: { kind: 'known', value: '1', unit: 'uL' },
          deadVolume: { kind: 'known', value: '1', unit: 'uL' },
        },
        reason: 'Independent physical volume limits',
      },
      ...received,
    ]);
    const first = await success<NativeInventoryExecution>(
      'receive-mass-count-molar-and-unknown-bases',
      'inventory.execute',
      receivedRequest
    );
    expect(first.status).toBe('committed');
    const stocks = owner.inspect(scope)!.stocks;
    expect(stocks.mass.quantity).toEqual(known('2500000', 'ng'));
    expect(stocks.count.quantity).toEqual(known('10', 'item'));
    expect(stocks.molar.quantity).toEqual(known('1500', 'nmol'));
    expect(stocks['unknown-mass'].quantity).toEqual({ kind: 'unknown', unit: 'ng' });
    expect(stocks['unknown-count'].quantity).toEqual({ kind: 'unknown', unit: 'item' });
    expect(stocks['legacy-unknown'].quantity).toEqual({ kind: 'unknown', unit: 'uL' });
    expect(owner.history({ ...scope, limit: 1000 })[0].request).toEqual(receivedRequest);
    await execute('mass-use-transfer-and-hold', [
      reserve('mass-hold', 'mass', '500', 'ug'),
      consume('mass', '100', 'ug'),
      transfer('mass', '0.4', 'mg', {
        kind: 'new-stock',
        stockId: 'mass-child',
        vesselId: 'mass-aliquot-vessel',
      }),
    ]);
    expect(owner.inspect(scope)!.stocks.mass.quantity).toEqual(known('2000000', 'ng'));
    expect(owner.inspect(scope)!.stocks['mass-child'].quantity).toEqual(known('400000', 'ng'));
    await execute('mass-partial-fulfillment', [
      {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'mass-hold', quantity: { value: '0.25', unit: 'mg' } }],
        withdrawal: consume('mass', '250', 'ug') as Extract<InventoryCommand, { kind: 'consume' }>,
      },
    ]);
    expect(owner.inspect(scope)!.reservations['mass-hold']).toMatchObject({
      remaining: { value: '250000', unit: 'ng' },
      lifecycle: { kind: 'active' },
    });
    await execute('mass-final-fulfillment', [
      {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'mass-hold', quantity: { value: '250', unit: 'ug' } }],
        withdrawal: consume('mass', '0.25', 'mg') as Extract<InventoryCommand, { kind: 'consume' }>,
      },
    ]);
    expect(owner.inspect(scope)!.stocks.mass.quantity).toEqual(known('1500000', 'ng'));
    expect(owner.inspect(scope)!.reservations['mass-hold']).toMatchObject({
      remaining: { value: '0', unit: 'ng' },
      lifecycle: { kind: 'fulfilled' },
    });
    await execute('count-use-split-recombine-and-hold', [
      consume('count', '1', 'item'),
      transfer('count', '3', 'item', {
        kind: 'new-stock',
        stockId: 'count-child',
        vesselId: 'count-aliquot-vessel',
      }),
      transfer('count', '2', 'item', { kind: 'existing-stock', stockId: 'count-child' }),
      reserve('count-hold', 'count', '2', 'item'),
      {
        kind: 'fulfill-reservations',
        claims: [{ reservationId: 'count-hold', quantity: { value: '2', unit: 'item' } }],
        withdrawal: consume('count', '2', 'item') as Extract<InventoryCommand, { kind: 'consume' }>,
      },
      consume('molar', '500', 'pmol'),
    ]);
    expect(owner.inspect(scope)!.stocks.count.quantity).toEqual(known('2', 'item'));
    expect(owner.inspect(scope)!.stocks['count-child'].quantity).toEqual(known('5', 'item'));
    expect(owner.inspect(scope)!.stocks.molar.quantity).toEqual(known('1499.5', 'nmol'));
    expect(owner.inspect(scope)!.reservations['count-hold']).toMatchObject({
      remaining: { value: '0', unit: 'item' },
      lifecycle: { kind: 'fulfilled' },
    });
    await refuse(
      'unknown-mass-cannot-use',
      [consume('unknown-mass', '1', 'ng')],
      'QUANTITY_UNKNOWN'
    );
    await refuse(
      'unknown-count-cannot-hold',
      [reserve('unknown-hold', 'unknown-count', '1', 'item')],
      'QUANTITY_UNKNOWN'
    );
    await execute('same-basis-measurement-resolves-amount', [
      {
        kind: 'reconcile',
        stockId: 'unknown-mass',
        quantity: known('0.002', 'mg'),
        reason: 'Measured remaining mass',
      },
      consume('unknown-mass', '2', 'ug'),
    ]);
    expect(owner.inspect(scope)!.stocks['unknown-mass'].quantity).toEqual(known('0', 'ng'));
    await refuse(
      'mass-basis-cannot-be-replaced-with-volume',
      [
        {
          kind: 'reconcile',
          stockId: 'mass',
          quantity: known('1'),
          reason: 'Incompatible observation',
        },
      ],
      'QUANTITY_DIMENSION_MISMATCH'
    );
    await refuse(
      'legacy-unknown-still-declares-volume',
      [
        {
          kind: 'reconcile',
          stockId: 'mass',
          quantity: { kind: 'unknown' },
          reason: 'Legacy unknown is volume',
        },
      ],
      'QUANTITY_DIMENSION_MISMATCH'
    );
    await refuse(
      'mixed-use-rolls-back-earlier-transfer',
      [
        transfer('mass-child', '1', 'ug', { kind: 'existing-stock', stockId: 'mass' }),
        consume('mass', '1', 'uL'),
      ],
      'QUANTITY_DIMENSION_MISMATCH'
    );
    await refuse(
      'count-volume-transfer',
      [transfer('count', '1', 'uL', { kind: 'existing-stock', stockId: 'count-child' })],
      'QUANTITY_DIMENSION_MISMATCH'
    );
    await refuse(
      'molar-mass-reservation',
      [reserve('invalid-molar-hold', 'molar', '1', 'ng')],
      'QUANTITY_DIMENSION_MISMATCH'
    );
    await execute('hold-before-invalid-claim', [reserve('claim-hold', 'mass', '1', 'ug')]);
    await refuse(
      'incompatible-claim-does-not-consume-hold',
      [
        {
          kind: 'fulfill-reservations',
          claims: [{ reservationId: 'claim-hold', quantity: { value: '1', unit: 'uL' } }],
          withdrawal: consume('mass', '1', 'ug') as Extract<InventoryCommand, { kind: 'consume' }>,
        },
      ],
      'QUANTITY_DIMENSION_MISMATCH'
    );
    for (const [label, command] of [
      ['fractional-item-use', consume('count', '0.5', 'item')],
      ['fractional-item-reservation', reserve('fraction-hold', 'count', '0.5', 'item')],
      ['fractional-item-receipt', receive('mix-target', known('0.5', 'item'))],
    ] as const) {
      const rejected = await call(label, 'inventory.execute', request(label, [command]));
      expect(rejected.status, label).toBe(400);
      expect(rejected.body).toMatchObject({
        ok: false,
        error: { code: 'INVALID_NATIVE_DOCUMENT_REQUEST' },
        accepted: false,
      });
      expect(rejected.after, label).toEqual(rejected.before);
    }
    for (const kind of ['pool', 'dilute'] as const) {
      const common = {
        lotId: `${kind}-lot`,
        stockId: `${kind}-stock`,
        vesselId: 'mix-target-vessel',
        materialId: 'amounts-material',
        name: 'Requested preparation',
        reason: 'Independent amounts do not establish volume',
      };
      const input = { stockId: 'mass', quantity: { value: '1', unit: 'uL' as const } };
      const other = { stockId: 'count', quantity: { value: '1', unit: 'uL' as const } };
      const command: InventoryCommand =
        kind === 'pool'
          ? { kind, ...common, inputs: [input, other] }
          : { kind, ...common, sample: input, diluent: other };
      await refuse(`${kind}-requires-volume`, [command], 'MIXING_REQUIRES_VOLUME');
    }
    await refuse(
      'homogeneous-mass-mixing-requires-volume',
      [
        {
          ...transfer('mass-child', '1', 'ug', { kind: 'existing-stock', stockId: 'mass' }),
          mixing: 'homogeneous',
        } as InventoryCommand,
      ],
      'MIXING_REQUIRES_VOLUME'
    );
    const lostRequest = request('mass-use-lost-acknowledgement', [consume('mass', '100', 'ug')]);
    const originalReceipt = await loseAcknowledgement(lostRequest);
    await execute('mass-use-after-lost-acknowledgement', [consume('mass', '50', 'ug')]);
    const retryBefore = raw();
    expect(
      await success('original-mass-receipt-after-later-use', 'inventory.execute', lostRequest)
    ).toEqual(originalReceipt);
    expect(raw()).toEqual(retryBefore);
    expect(owner.inspect(scope)!.stocks.mass.quantity).toEqual(known('1350000', 'ng'));
    const receiveFields: InventoryReceiveTableFields = {
      source_id: 'legacy-volume-source',
      name: 'Source tube',
      material_key: 'material',
      quantity_kind: 'unknown',
      quantity: '',
      unit: '',
      quality: 'usable',
      vessel_kind: 'new',
      vessel_key: '',
      location_key: 'unplaced',
      slot: '',
    };
    const tableOptions = {
      namespace: 'legacy-volume-format',
      delimiter: ',' as const,
      materials: [{ key: 'material', materialId: 'amounts-material' }],
      locations: [{ key: 'unplaced', target: { kind: 'unplaced' as const } }],
      vessels: [],
      skips: [],
    };
    const tableInput = {
      ...scope,
      format: 'receive-v1' as const,
      sourceText: csv(INVENTORY_RECEIVE_TABLE_COLUMNS, receiveFields),
      options: tableOptions,
    };
    const previewBefore = raw();
    const tablePreview = await success<InventoryTablePreviewSnapshot>(
      'legacy-volume-source-preview',
      'inventory.preview-table',
      tableInput
    );
    expect(raw()).toEqual(previewBefore);
    if (tablePreview.kind !== 'ready') throw new Error(JSON.stringify(tablePreview));
    expect(tablePreview.commands.find((command) => command.kind === 'receive-stock')).toMatchObject(
      { quantity: { kind: 'unknown' } }
    );
    expect(
      tablePreview.commands.find((command) => command.kind === 'receive-stock')
    ).not.toMatchObject({ quantity: { unit: 'uL' } });
    const tableRequest = {
      ...scope,
      sourceText: tableInput.sourceText,
      kind: 'receive-table',
      operationId: 'receive-legacy-volume-source',
      expectedRevision: owner.inspect(scope)!.revision,
      options: tablePreview.options,
      expectedPlanDigest: tablePreview.planDigest,
    };
    const tableReceipt = await success<NativeInventoryExecution>(
      'legacy-volume-source-apply',
      'inventory.apply-table',
      tableRequest
    );
    expect(tableReceipt.status).toBe('committed');
    const sourceBinding = Object.values(owner.inspect(scope)!.tableBindings)[0];
    expect(owner.inspect(scope)!.stocks[sourceBinding.stockId].quantity).toEqual({
      kind: 'unknown',
      unit: 'uL',
    });
    expect(
      (
        await success<InventoryTablePreviewSnapshot>(
          'unchanged-volume-source',
          'inventory.preview-table',
          tableInput
        )
      ).kind
    ).toBe('no-change');
    expect(
      (
        await success<InventoryTablePreviewSnapshot>(
          'receive-v1-does-not-accept-mass',
          'inventory.preview-table',
          {
            ...tableInput,
            sourceText: csv(INVENTORY_RECEIVE_TABLE_COLUMNS, {
              ...receiveFields,
              quantity_kind: 'known',
              quantity: '1',
              unit: 'mg',
            }),
          }
        )
      ).kind
    ).toBe('blocked');
    const stocktakeFields: InventoryStocktakeFields = {
      observation_id: 'unknown-volume-observation',
      subject_key: 'source',
      observed_at: 'unknown',
      quantity_kind: 'unknown',
      quantity: '',
      unit: '',
      presence: 'not-observed',
      location_key: '',
      slot: '',
      reason: 'Unmeasured volume',
    };
    const stocktakeOptions = {
      namespace: 'legacy-stocktake-format',
      delimiter: ',' as const,
      subjects: [
        { key: 'source', subject: { kind: 'stock' as const, stockId: sourceBinding.stockId } },
      ],
      locations: [],
      decisions: [
        { observationId: stocktakeFields.observation_id, choice: { kind: 'record-only' as const } },
      ],
    };
    const stocktakeInput = {
      ...scope,
      format: 'stocktake-v1' as const,
      sourceText: csv(INVENTORY_STOCKTAKE_COLUMNS, stocktakeFields),
      options: stocktakeOptions,
    };
    const stocktakePreview = await success<InventoryStocktakePreviewSnapshot>(
      'legacy-stocktake-preview',
      'inventory.preview-stocktake',
      stocktakeInput
    );
    if (stocktakePreview.kind !== 'ready') throw new Error(JSON.stringify(stocktakePreview));
    expect(stocktakePreview.commands[0]).toMatchObject({
      kind: 'record-inventory-observation',
      fact: { kind: 'quantity', quantity: { kind: 'unknown' } },
    });
    const stocktakeRequest = {
      ...scope,
      sourceText: stocktakeInput.sourceText,
      options: stocktakeInput.options,
      kind: 'apply-stocktake',
      operationId: 'record-legacy-stocktake-source',
      expectedRevision: owner.inspect(scope)!.revision,
      expectedPlanDigest: stocktakePreview.planDigest,
    };
    const stocktakeReceipt = await success<NativeInventoryExecution>(
      'legacy-stocktake-apply',
      'inventory.apply-stocktake',
      stocktakeRequest
    );
    expect(stocktakeReceipt.status).toBe('committed');
    const observationKey = inventoryObservationKey(
      stocktakeOptions.namespace,
      stocktakeFields.observation_id
    );
    expect(owner.inspect(scope)!.observations[observationKey].fact).toEqual({
      kind: 'quantity',
      quantity: { kind: 'unknown', unit: 'uL' },
    });
    expect(
      (
        await success<InventoryStocktakePreviewSnapshot>(
          'unchanged-upcast-stocktake-source',
          'inventory.preview-stocktake',
          stocktakeInput
        )
      ).kind
    ).toBe('no-change');
    const measuredVolume = {
      ...stocktakeFields,
      observation_id: 'mass-volume-observation',
      quantity_kind: 'known',
      quantity: '1',
      unit: 'uL',
    };
    const massObservation = {
      ...scope,
      format: 'stocktake-v1' as const,
      sourceText: csv(INVENTORY_STOCKTAKE_COLUMNS, measuredVolume),
      options: {
        ...stocktakeOptions,
        subjects: [{ key: 'source', subject: { kind: 'stock' as const, stockId: 'mass' } }],
        decisions: [
          {
            observationId: measuredVolume.observation_id,
            choice: { kind: 'apply' as const, reason: 'Incompatible measurement' },
          },
        ],
      },
    };
    expect(
      (
        await success<InventoryStocktakePreviewSnapshot>(
          'volume-observation-cannot-replace-mass',
          'inventory.preview-stocktake',
          massObservation
        )
      ).kind
    ).toBe('blocked');
    expect(
      (
        await success<InventoryStocktakePreviewSnapshot>(
          'stocktake-v1-does-not-accept-count',
          'inventory.preview-stocktake',
          {
            ...stocktakeInput,
            sourceText: csv(INVENTORY_STOCKTAKE_COLUMNS, {
              ...stocktakeFields,
              quantity_kind: 'known',
              quantity: '1',
              unit: 'item',
            }),
          }
        )
      ).kind
    ).toBe('blocked');
    const artifact = await success<InventoryExportSnapshot>(
      'export-generic-bases',
      'inventory.export-snapshot',
      { ...scope, format: 'native-v1' }
    );
    const adoption = await success<InventoryImportPreviewSnapshot>(
      'preview-generic-balance-adoption',
      'inventory.preview-import',
      {
        ...target,
        sourceText: artifact.sourceText,
        options: {
          bindings: [
            { sourceMaterialId: 'amounts-material', destinationMaterialId: 'amounts-material' },
          ],
        },
      },
      adopter
    );
    if (adoption.kind !== 'ready') throw new Error(JSON.stringify(adoption));
    const adoptionRequest = {
      ...target,
      kind: 'adopt-archive',
      operationId: 'adopt-generic-balances',
      expectedRevision: 0,
      sourceText: artifact.sourceText,
      options: adoption.options,
      expectedPlanDigest: adoption.planDigest,
    };
    const adoptionReceipt = await success<NativeInventoryExecution>(
      'adopt-generic-balances',
      'inventory.apply-import',
      adoptionRequest,
      adopter
    );
    expect(adoptionReceipt.status).toBe('committed');
    for (const [id, stock] of Object.entries(owner.inspect(scope)!.stocks))
      expect(owner.inspect(target)!.stocks[id].quantity).toEqual(stock.quantity);
    expect(owner.inspect(target)!.reservations['mass-hold']).toMatchObject({
      kind: 'quantity',
      remaining: { value: '0', unit: 'ng' },
    });
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
    const reopenedBefore = raw();
    expect(
      await success('original-amount-receipt-after-reopen', 'inventory.execute', lostRequest)
    ).toEqual(originalReceipt);
    expect(
      await success(
        'original-raw-receive-source-after-reopen',
        'inventory.apply-table',
        tableRequest
      )
    ).toEqual(tableReceipt);
    expect(
      await success(
        'original-raw-stocktake-source-after-reopen',
        'inventory.apply-stocktake',
        stocktakeRequest
      )
    ).toEqual(stocktakeReceipt);
    expect(
      await success(
        'original-adoption-after-reopen',
        'inventory.apply-import',
        adoptionRequest,
        adopter
      )
    ).toEqual(adoptionReceipt);
    expect(raw()).toEqual(reopenedBefore);
    expect(
      (
        await success<InventoryExportSnapshot>(
          'exact-generic-export-after-reopen',
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
      sourceRequests: { tableRequest, stocktakeRequest },
      exportSourceText: artifact.sourceText,
      zeroPartialEffectsOnRefusals: true,
      reopenedExactStateHistoryAndExport: true,
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
