// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  InventoryCommand,
  InventoryGeometry,
  InventoryState,
} from '@waypoint/domain-services';
import { expect, it, vi } from 'vitest';
import type {
  InventoryExecuteRequest,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from '../shared/inventory-command';
import type { InventoryAvailabilitySnapshot } from '../shared/inventory-client';

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
import { nativeDocumentProfileKey } from './native-document-owner-identity';

type InventoryNativeCommand =
  | 'inventory.execute'
  | 'inventory.inspect'
  | 'inventory.availability'
  | 'inventory.operation'
  | 'inventory.history'
  | 'inventory.projects'
  | 'inventory.catalog'
  | 'inventory.materials';
type Server = Awaited<ReturnType<typeof startNativeDocumentCommandServer>>;
interface NativeResponse<T> {
  ok: boolean;
  result?: T;
  accepted?: boolean;
  error?: { code: string };
}
interface TraceEntry {
  label: string;
  command: InventoryNativeCommand;
  request: unknown;
  ownerInstanceId: string;
  projectScope: unknown;
  agent?: { identityId: string; capabilities: string[] };
  authentication: 'valid' | 'invalid';
  response?: { status: number; body: unknown };
  failure?: string;
}

it('preserves inventory through real native HTTP, lost acknowledgements, restart and refusals', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-inventory-native-')));
  const dbPath = join(root, 'inventory.sqlite');
  const projectPath = join(root, 'project');
  const otherPath = join(root, 'other-project');
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  mkdirSync(join(root, 'managed'));
  const evidenceRoot = process.env.INVENTORY_CORE_EVIDENCE_DIR;
  const evidencePath = evidenceRoot
    ? (() => {
        mkdirSync(resolve(evidenceRoot), { recursive: true });
        return join(mkdtempSync(join(resolve(evidenceRoot), 'native-')), 'acceptance.json');
      })()
    : undefined;
  const trace: TraceEntry[] = [];
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-native-acceptance.v1',
    runtime: 'Node loopback HTTP and file-backed SQLite; synthetic fixture',
    startedAt: new Date().toISOString(),
    status: 'running',
    trace,
  };
  let db: Database.Database | undefined;
  let server: Server | undefined;
  let owner: ReturnType<typeof createNativeInventoryOwner>;
  let instance = 0;
  let clock = 1_700_000_000_001;
  let authority: { ownerInstanceId: string; token: string };
  const scope = { project: 'Synthetic inventory project', inventoryId: 'inventory-synthetic' };
  const projectScope = { kind: 'project-roots' as const, roots: [projectPath] };
  const profileKey = nativeDocumentProfileKey(root);
  const grantSnapshot = [
    {
      id: 'synthetic-inventory-writer',
      scopes: ['read-workspace', 'write-workspace'],
      revokedAt: null,
      expiresAt: null,
    },
    {
      id: 'synthetic-other-writer',
      scopes: ['read-workspace', 'write-workspace'],
      revokedAt: null,
      expiresAt: null,
    },
    {
      id: 'synthetic-read-only',
      scopes: ['read-workspace'],
      revokedAt: null,
      expiresAt: null,
    },
    {
      id: 'synthetic-revoked',
      scopes: ['read-workspace', 'write-workspace'],
      revokedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    },
    {
      id: 'synthetic-expired',
      scopes: ['read-workspace', 'write-workspace'],
      revokedAt: null,
      expiresAt: '2000-01-01T00:00:00.000Z',
    },
  ];
  const grantReads: string[] = [];
  const grantFetch: typeof fetch = async (input) => {
    const url = String(input);
    expect(new URL(url).pathname).toBe('/agent-grants');
    grantReads.push(url);
    return Response.json({ ok: true, grants: grantSnapshot, hasMore: false });
  };
  evidence.grantSnapshot = grantSnapshot;
  evidence.grantReads = grantReads;

  async function start() {
    if (!db) throw new Error('Fixture database is closed.');
    db.pragma('foreign_keys = ON');
    const projectAuthority = createRegisteredProjectAuthority({
      db: () => db!,
      managedRootDir: () => join(root, 'managed'),
    });
    authority = {
      ownerInstanceId: `synthetic-native-${++instance}`,
      token: `synthetic-secret-${instance}`,
    };
    owner = createNativeInventoryOwner({
      db: () => db!,
      projectAuthority,
      actor: () => `native:${authority.ownerInstanceId}`,
      profileKey,
      now: () => clock,
    });
    owner.initialize();
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
      authorizeInventoryAgent: createNativeAgentGrantAuthorizer(grantFetch, 'INVENTORY'),
      projectAuthority,
      getAuthority: () => authority,
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(projectAuthority.resolve(scope.project)).toMatchObject({
      id: 41,
      path: projectPath,
      pinned: false,
    });
  }

  async function call<T>(
    label: string,
    command: InventoryNativeCommand,
    request: unknown,
    options: {
      invalidToken?: boolean;
      roots?: string[];
      agent?: { identityId: string; capabilities: string[] };
    } = {}
  ): Promise<{ status: number; body: NativeResponse<T> }> {
    if (!server) throw new Error('Fixture server is closed.');
    const entry: TraceEntry = {
      label,
      command,
      request,
      ownerInstanceId: authority.ownerInstanceId,
      projectScope: options.roots ? { kind: 'project-roots', roots: options.roots } : projectScope,
      ...(options.agent ? { agent: options.agent } : {}),
      authentication: options.invalidToken ? 'invalid' : 'valid',
    };
    trace.push(entry);
    try {
      const response = await fetch(`${server.url}/internal/native-documents/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DNAForge-Native-Document-Authority': options.invalidToken
            ? 'synthetic-invalid'
            : authority.token,
        },
        body: JSON.stringify({
          ownerInstanceId: entry.ownerInstanceId,
          projectScope: entry.projectScope,
          command,
          request,
          ...(options.agent ? { agent: options.agent } : {}),
        }),
      });
      const body = (await response.json()) as NativeResponse<T>;
      entry.response = { status: response.status, body };
      return { status: response.status, body };
    } catch (error) {
      entry.failure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async function success<T>(
    label: string,
    command: InventoryNativeCommand,
    request: unknown,
    options: { agent?: { identityId: string; capabilities: string[] } } = {}
  ): Promise<T> {
    const response = await call<T>(label, command, request, options);
    expect(response.status, label).toBe(200);
    expect(response.body.ok, label).toBe(true);
    const wrapped = response.body.result as Record<string, unknown>;
    expect(wrapped).toBeTypeOf('object');
    const keys: Record<InventoryNativeCommand, string> = {
      'inventory.execute': 'execution',
      'inventory.inspect': 'state',
      'inventory.availability': 'availability',
      'inventory.operation': 'receipt',
      'inventory.history': 'entries',
      'inventory.projects': 'projects',
      'inventory.catalog': 'entries',
      'inventory.materials': 'page',
    };
    expect(wrapped).toHaveProperty(keys[command]);
    return wrapped[keys[command]] as T;
  }

  async function loseAcknowledgement(
    request: InventoryExecuteRequest,
    evidenceKey = 'lostAcknowledgement'
  ): Promise<NativeInventoryReceipt> {
    if (!server) throw new Error('Fixture server is closed.');
    const attempt: Record<string, unknown> = {
      command: 'inventory.execute',
      request,
      ownerInstanceId: authority.ownerInstanceId,
      projectScope,
      phase: 'connecting',
      responseBodyConsumed: false,
    };
    evidence[evidenceKey] = attempt;
    const address = new URL(server.url);
    const socket = createConnection({ host: address.hostname, port: Number(address.port) });
    socket.pause();
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
        request,
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
      attempt.phase = 'request-sent-reading-paused';
      const deadline = Date.now() + 2_000;
      let receipt: NativeInventoryReceipt | null = null;
      while (!receipt && Date.now() < deadline) {
        await new Promise<void>((accept) => setImmediate(accept));
        receipt = owner.operation({
          project: request.project,
          inventoryId: request.inventoryId,
          operationId: request.operationId,
        });
      }
      if (!receipt)
        throw new Error('Lost-acknowledgement command did not commit within two seconds.');
      attempt.durableReceiptObservedBeforeDisconnect = receipt;
      attempt.responseBytesRead = socket.bytesRead;
      expect(socket.bytesRead).toBe(0);
      await new Promise<void>((accept) => {
        socket.once('close', () => accept());
        socket.destroy();
      });
      attempt.phase = 'disconnected-before-reading-acknowledgement';
      return receipt;
    } catch (error) {
      attempt.failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      socket.destroy();
    }
  }

  try {
    db = openFileTestDb(dbPath);
    ensureSchema(db, dbPath);
    const register = db.prepare(
      `INSERT INTO workspaces (id,name,path,repo_uuid,access_mode,created_at) VALUES(?,?,?,?, 'writable',1)`
    );
    register.run(41, scope.project, projectPath, 'synthetic-inventory-project');
    register.run(42, 'Other synthetic project', otherPath, 'synthetic-other-project');
    rememberOriginalDefaultProject(db, 41);
    db.prepare(
      `INSERT INTO lims_schema (id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('synthetic-schema','entity','synthetic-material','Synthetic material','{}','synthetic-schema-v1',1,1)`
    ).run();
    db.prepare(
      `INSERT INTO lims_schema_revision (id,schema_id,version,fields,created_at) VALUES('synthetic-schema-v1','synthetic-schema',1,'{}',1)`
    ).run();
    db.prepare(
      `INSERT INTO lims_entity (id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('synthetic-material','record','synthetic-schema','synthetic-schema-v1','Synthetic material','{}',41,'registered',1,1)`
    ).run();
    await start();

    const projects = await success<Array<{ projectId: string; defaultInventoryId: string }>>(
      'discover scoped projects',
      'inventory.projects',
      {}
    );
    expect(projects).toHaveLength(1);
    expect(projects[0].defaultInventoryId).toBe(`inventory:${projects[0].projectId}`);
    const catalog = await success<readonly { id: string; recipeVersionId: string }[]>(
      'discover built-in equipment recipes without installing inventory',
      'inventory.catalog',
      { project: scope.project }
    );
    expect(catalog.length).toBeGreaterThan(0);
    expect(new Set(catalog.map((entry) => entry.id)).size).toBe(catalog.length);
    expect(catalog.every((entry) => typeof entry.recipeVersionId === 'string')).toBe(true);
    expect(owner.inspect(scope)).toBeNull();
    expect(owner.history(scope)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM inventory_state').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM inventory_journal').get()).toEqual({
      count: 0,
    });
    expect(
      await call(
        'refuse catalog discovery outside captured project roots',
        'inventory.catalog',
        { project: scope.project },
        { roots: [otherPath] }
      )
    ).toMatchObject({
      status: 200,
      body: { ok: true, result: { ok: false, code: 'PROJECT_ACCESS_DENIED', stateChanged: false } },
    });
    evidence.catalogRead = catalog;
    expect(
      await success('inspect absent inventory dictionary', 'inventory.inspect', {
        ...scope,
        inventoryId: 'absent',
      })
    ).toBeNull();
    expect(
      await success('availability absent inventory dictionary', 'inventory.availability', {
        ...scope,
        inventoryId: 'absent',
      })
    ).toBeNull();
    expect(
      await success('history absent inventory dictionary', 'inventory.history', {
        ...scope,
        inventoryId: 'absent',
      })
    ).toEqual([]);
    expect(
      await success('operation absent inventory dictionary', 'inventory.operation', {
        ...scope,
        operationId: 'absent',
      })
    ).toBeNull();
    expect(
      await success('find scoped material by exact identity', 'inventory.materials', {
        project: scope.project,
        query: 'synthetic-material',
      })
    ).toMatchObject({
      items: [{ id: 'synthetic-material', name: 'Synthetic material', registryId: null }],
      nextCursor: null,
    });

    const receive: InventoryCommand[] = [
      {
        kind: 'create-storage',
        id: 'freezer',
        name: 'Synthetic freezer',
        slots: ['top', 'bottom'],
        placement: { kind: 'root' },
      },
      {
        kind: 'create-storage',
        id: 'box',
        name: 'Synthetic box',
        slots: ['A1', 'A2'],
        placement: { kind: 'located', storageId: 'freezer', slotId: 'top' },
      },
      {
        kind: 'create-vessel',
        id: 'tube',
        name: 'Synthetic tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
      },
      {
        kind: 'receive-stock',
        id: 'stock',
        vesselId: 'tube',
        materialId: 'synthetic-material',
        quantity: { kind: 'known', value: '100', unit: 'uL' },
        quality: 'usable',
      },
    ];
    expect(
      await success<NativeInventoryExecution>(
        'receive 100 uL',
        'inventory.execute',
        {
          ...scope,
          operationId: 'receive',
          expectedRevision: 0,
          commands: receive,
        },
        {
          agent: {
            identityId: 'synthetic-inventory-writer',
            capabilities: ['read-workspace', 'write-workspace'],
          },
        }
      )
    ).toMatchObject({
      status: 'committed',
      revision: 1,
      actor: 'agent:synthetic-inventory-writer',
      context: {
        version: 1,
        principal: { kind: 'agent', identityId: 'synthetic-inventory-writer' },
        authority: { kind: 'local-profile', profileKey },
      },
    });
    expect(
      await success<NativeInventoryExecution>('move tube', 'inventory.execute', {
        ...scope,
        operationId: 'move',
        expectedRevision: 1,
        commands: [
          {
            kind: 'move-vessel',
            id: 'tube',
            placement: { kind: 'located', storageId: 'box', slotId: 'A2' },
          },
        ],
      })
    ).toMatchObject({ status: 'committed', revision: 2 });
    const consume: InventoryExecuteRequest = {
      ...scope,
      operationId: 'consume',
      expectedRevision: 2,
      commands: [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '20', unit: 'uL' },
          reason: 'Synthetic experiment',
        },
      ],
    };
    const deniedAgent = await call(
      'reject read-only agent mutation',
      'inventory.execute',
      consume,
      {
        agent: { identityId: 'synthetic-read-only', capabilities: ['read-workspace'] },
      }
    );
    expect(deniedAgent).toMatchObject({
      status: 200,
      body: { ok: true, result: { ok: false, code: 'INSUFFICIENT_SCOPE', stateChanged: false } },
    });
    expect(owner.inspect(scope)?.revision).toBe(2);
    expect(owner.operation({ ...scope, operationId: 'consume' })).toBeNull();
    expect(
      await success('read-only current grant can inspect inventory', 'inventory.inspect', scope, {
        agent: { identityId: 'synthetic-read-only', capabilities: ['read-workspace'] },
      })
    ).toEqual(owner.inspect(scope));
    const stateBeforeGrantRefusals = owner.inspect(scope);
    const historyBeforeGrantRefusals = owner.history(scope);
    for (const identityId of [
      'synthetic-read-only',
      'synthetic-revoked',
      'synthetic-expired',
      'synthetic-missing',
    ]) {
      const operationId = `refused-grant:${identityId}`;
      const denied = await call(
        `reject current grant ${identityId} claiming write access`,
        'inventory.execute',
        { ...consume, operationId },
        { agent: { identityId, capabilities: ['read-workspace', 'write-workspace'] } }
      );
      expect(denied).toMatchObject({
        status: 200,
        body: {
          ok: true,
          result: { ok: false, code: 'INVENTORY_CAPABILITY_DENIED', stateChanged: false },
        },
      });
      expect(owner.operation({ ...scope, operationId })).toBeNull();
      expect(owner.inspect(scope)).toEqual(stateBeforeGrantRefusals);
      expect(owner.history(scope)).toEqual(historyBeforeGrantRefusals);
    }
    expect(grantReads).toHaveLength(6);
    expect(
      await success(
        'current read-only grant discovers the same equipment catalog',
        'inventory.catalog',
        { project: scope.project },
        {
          agent: { identityId: 'synthetic-read-only', capabilities: ['read-workspace'] },
        }
      )
    ).toEqual(catalog);
    expect(owner.inspect(scope)).toEqual(stateBeforeGrantRefusals);
    expect(owner.history(scope)).toEqual(historyBeforeGrantRefusals);
    const receipt = await loseAcknowledgement(consume);
    expect(receipt).toMatchObject({
      status: 'committed',
      operationId: 'consume',
      revision: 3,
      actor: 'native:synthetic-native-1',
    });
    expect(
      await success<NativeInventoryReceipt>('resolve lost acknowledgement', 'inventory.operation', {
        ...scope,
        operationId: 'consume',
      })
    ).toEqual(receipt);
    expect(
      await success<NativeInventoryExecution>(
        'retry lost acknowledgement',
        'inventory.execute',
        consume
      )
    ).toEqual(receipt);
    const beforeRestart = await success<InventoryState>(
      'inspect 80 uL before restart',
      'inventory.inspect',
      scope
    );
    expect(beforeRestart.stocks.stock.quantity).toEqual({ kind: 'known', value: '80', unit: 'uL' });
    expect(beforeRestart.vessels.tube.placement).toEqual({
      kind: 'located',
      storageId: 'box',
      slotId: 'A2',
    });
    expect(
      await success<NativeInventoryHistoryEntry[]>(
        'history before restart',
        'inventory.history',
        scope
      )
    ).toHaveLength(3);

    const reservationScope = { ...scope, inventoryId: 'inventory-reservations' };
    expect(
      await success<NativeInventoryExecution>('receive reservation stock', 'inventory.execute', {
        ...reservationScope,
        operationId: 'reservation-receive',
        expectedRevision: 0,
        commands: receive,
      })
    ).toMatchObject({ status: 'committed', revision: 1 });
    const identities = ['synthetic-inventory-writer', 'synthetic-other-writer'];
    const agents = identities.map((identityId) => ({
      agent: { identityId, capabilities: ['read-workspace', 'write-workspace'] },
    }));
    const deadline = clock + 1_000;
    const holdRequests: InventoryExecuteRequest[] = ['70', '40'].map((value, index) => ({
      ...reservationScope,
      operationId: `competing-hold-${index}`,
      expectedRevision: 1,
      commands: [
        {
          kind: 'reserve-quantity',
          id: `hold-${index}`,
          stockId: 'stock',
          quantity: { value, unit: 'uL' },
          deadline,
          purpose: 'Synthetic competing experiment',
        },
      ],
    }));
    const competition = await Promise.all(
      holdRequests.map((request, index) =>
        success<NativeInventoryExecution>(
          `competing granted holder ${index}`,
          'inventory.execute',
          request,
          agents[index]
        )
      )
    );
    expect(competition.filter((result) => result.status === 'committed')).toHaveLength(1);
    expect(competition.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ code: 'REVISION_CONFLICT', currentRevision: 2 }),
    ]);
    const winnerIndex = competition.findIndex((result) => result.status === 'committed');
    const loserIndex = 1 - winnerIndex;
    const winnerHold = `hold-${winnerIndex}`;
    const winnerVolume = winnerIndex === 0 ? '70' : '40';
    const afterCompetition = await success<InventoryState>(
      'inspect latest inventory after competing hold conflict',
      'inventory.inspect',
      reservationScope,
      agents[loserIndex]
    );
    expect(afterCompetition.revision).toBe(2);
    expect(afterCompetition.stocks.stock.quantity).toEqual({
      kind: 'known',
      value: '100',
      unit: 'uL',
    });
    expect(Object.keys(afterCompetition.reservations)).toHaveLength(1);
    const loserRequest = {
      ...holdRequests[loserIndex],
      operationId: `competing-hold-${loserIndex}-fresh`,
      expectedRevision: afterCompetition.revision,
    };
    expect(
      await success<NativeInventoryExecution>(
        'refuse over-allocation after fresh inspection',
        'inventory.execute',
        loserRequest,
        agents[loserIndex]
      )
    ).toMatchObject({ status: 'rejected', currentRevision: 2 });
    expect(
      owner.operation({ ...reservationScope, operationId: loserRequest.operationId })
    ).toBeNull();
    const heldState = owner.inspect(reservationScope);
    const grantedAvailability = await Promise.all(
      agents.map((agent, index) =>
        success<InventoryAvailabilitySnapshot>(
          `read availability as granted holder ${index}`,
          'inventory.availability',
          reservationScope,
          agent
        )
      )
    );
    for (const [index, available] of grantedAvailability.entries()) {
      expect(available).toMatchObject({
        revision: 2,
        asOf: clock,
        principal: { kind: 'agent', identityId: identities[index] },
        stocks: {
          stock: {
            onHand: { kind: 'known', value: '100', unit: 'uL' },
            held: { value: winnerVolume, unit: 'uL' },
            mine: { value: index === winnerIndex ? winnerVolume : '0', unit: 'uL' },
          },
        },
      });
    }
    clock = deadline;
    const expiryPending = await success<InventoryAvailabilitySnapshot>(
      'observe exact deadline without silently expiring',
      'inventory.availability',
      reservationScope,
      agents[winnerIndex]
    );
    expect(expiryPending.reservations[winnerHold]).toMatchObject({
      overdue: true,
      actions: { fulfill: false, expire: true },
    });
    expect(expiryPending.stocks.stock.held).toEqual({ value: winnerVolume, unit: 'uL' });
    expect(owner.inspect(reservationScope)).toEqual(heldState);
    expect(
      await success<NativeInventoryExecution>(
        'refuse fulfillment at exact deadline',
        'inventory.execute',
        {
          ...reservationScope,
          operationId: 'deadline-fulfill',
          expectedRevision: 2,
          commands: [
            {
              kind: 'fulfill-reservations',
              claims: [{ reservationId: winnerHold, quantity: { value: '1', unit: 'uL' } }],
              withdrawal: {
                kind: 'consume',
                stockId: 'stock',
                quantity: { value: '1', unit: 'uL' },
                reason: 'Synthetic deadline refusal',
              },
            },
          ],
        },
        agents[winnerIndex]
      )
    ).toMatchObject({ status: 'rejected', currentRevision: 2 });
    expect(owner.operation({ ...reservationScope, operationId: 'deadline-fulfill' })).toBeNull();
    expect(owner.inspect(reservationScope)).toEqual(heldState);
    expect(
      await success<NativeInventoryExecution>(
        'record expiry at exact trusted deadline',
        'inventory.execute',
        {
          ...reservationScope,
          operationId: 'record-expiry',
          expectedRevision: 2,
          commands: [{ kind: 'expire-reservations', ids: [winnerHold] }],
        },
        agents[loserIndex]
      )
    ).toMatchObject({ status: 'committed', revision: 3, recordedAt: deadline });
    clock -= 5_000;
    const profileHoldRequest: InventoryExecuteRequest = {
      ...reservationScope,
      operationId: 'profile-hold',
      expectedRevision: 3,
      commands: [
        {
          kind: 'reserve-quantity',
          id: 'profile-hold',
          stockId: 'stock',
          quantity: { value: '30', unit: 'uL' },
          deadline: null,
          purpose: 'Synthetic local profile experiment',
        },
      ],
    };
    const profileHoldReceipt = await loseAcknowledgement(
      profileHoldRequest,
      'reservationLostAcknowledgement'
    );
    expect(profileHoldReceipt).toMatchObject({
      status: 'committed',
      revision: 4,
      recordedAt: deadline,
      context: {
        version: 1,
        principal: { kind: 'local-profile', profileKey },
        authority: { kind: 'local-profile', profileKey },
      },
    });
    expect(
      await success<NativeInventoryExecution>(
        'recover exact lost reservation acknowledgement',
        'inventory.execute',
        profileHoldRequest
      )
    ).toEqual(profileHoldReceipt);
    expect(
      await success<NativeInventoryExecution>('fulfill profile hold once', 'inventory.execute', {
        ...reservationScope,
        operationId: 'profile-fulfill',
        expectedRevision: 4,
        commands: [
          {
            kind: 'fulfill-reservations',
            claims: [{ reservationId: 'profile-hold', quantity: { value: '20', unit: 'uL' } }],
            withdrawal: {
              kind: 'consume',
              stockId: 'stock',
              quantity: { value: '20', unit: 'uL' },
              reason: 'Synthetic reservation fulfillment',
            },
          },
        ],
      })
    ).toMatchObject({ status: 'committed', revision: 5, recordedAt: deadline });
    const reservationBeforeRestart = owner.inspect(reservationScope);
    const reservationHistoryBeforeRestart = owner.history(reservationScope);
    const profileAvailability = await success<InventoryAvailabilitySnapshot>(
      'inspect remaining profile allocation before restart',
      'inventory.availability',
      reservationScope
    );
    expect(profileAvailability).toMatchObject({
      revision: 5,
      asOf: deadline,
      principal: { kind: 'local-profile', profileKey },
      stocks: {
        stock: {
          onHand: { kind: 'known', value: '80', unit: 'uL' },
          held: { value: '10', unit: 'uL' },
          mine: { value: '10', unit: 'uL' },
          unreserved: { kind: 'known', value: '70', unit: 'uL' },
        },
      },
    });
    evidence.reservationBeforeRestart = {
      competition,
      heldState,
      grantedAvailability,
      expiryPending,
      state: reservationBeforeRestart,
      history: reservationHistoryBeforeRestart,
      profileHoldReceipt,
      availability: profileAvailability,
    };
    for (const request of [
      { ...profileHoldRequest, at: 0 },
      {
        ...profileHoldRequest,
        context: {
          principal: { kind: 'agent', identityId: identities[winnerIndex] },
          at: 0,
        },
      },
      {
        ...profileHoldRequest,
        commands: [
          {
            ...profileHoldRequest.commands[0],
            holder: { kind: 'agent', identityId: identities[winnerIndex] },
          },
        ],
      },
    ]) {
      const forged = await call(
        'reject caller-supplied holder or execution time',
        'inventory.execute',
        request
      );
      expect(forged).toMatchObject({
        status: 400,
        body: { ok: false, accepted: false, error: { code: 'INVALID_NATIVE_DOCUMENT_REQUEST' } },
      });
      expect(owner.inspect(reservationScope)).toEqual(reservationBeforeRestart);
      expect(owner.history(reservationScope)).toEqual(reservationHistoryBeforeRestart);
    }

    const custodyScope = { ...scope, inventoryId: 'inventory-custody' };
    async function custodyAttempt(
      label: string,
      commands: readonly InventoryCommand[],
      options: { agent?: { identityId: string; capabilities: string[] } } = {}
    ) {
      const before = await success<InventoryState | null>(
        `${label}: inspect current custody`,
        'inventory.inspect',
        custodyScope,
        options
      );
      const request: InventoryExecuteRequest = {
        ...custodyScope,
        operationId: `custody:${label}`,
        expectedRevision: before?.revision ?? 0,
        commands,
      };
      const result = await success<NativeInventoryExecution>(
        label,
        'inventory.execute',
        request,
        options
      );
      return { before, request, result };
    }
    async function custodyCommit(
      label: string,
      commands: readonly InventoryCommand[],
      options: { agent?: { identityId: string; capabilities: string[] } } = {}
    ) {
      const attempt = await custodyAttempt(label, commands, options);
      expect(attempt.result, label).toMatchObject({ status: 'committed' });
      return attempt;
    }
    async function custodyRefusal(
      label: string,
      commands: readonly InventoryCommand[],
      options: { agent?: { identityId: string; capabilities: string[] } } = {},
      code?: string
    ) {
      const attempt = await custodyAttempt(label, commands, options);
      expect(attempt.result, label).toMatchObject({
        status: 'rejected',
        ...(code ? { code } : {}),
      });
      expect(owner.inspect(custodyScope), label).toEqual(attempt.before);
      expect(owner.history(custodyScope), label).toHaveLength(attempt.before?.revision ?? 0);
      expect(
        owner.operation({ ...custodyScope, operationId: attempt.request.operationId }),
        label
      ).toBeNull();
      return attempt;
    }
    const tubeItem = { kind: 'vessel' as const, id: 'tube' };
    const nativeHolder = { kind: 'local-profile' as const, profileKey };
    await custodyCommit('receive custody stock and empty container', [
      ...receive,
      {
        kind: 'create-vessel',
        id: 'empty-transit',
        name: 'Empty transit container',
        placement: { kind: 'unplaced' },
      },
    ]);
    await custodyCommit(
      'reserve foreign quantity before departure',
      [
        {
          kind: 'reserve-quantity',
          id: 'foreign-custody-hold',
          stockId: 'stock',
          quantity: { value: '10', unit: 'uL' },
          deadline: null,
          purpose: 'Other operator experiment',
        },
      ],
      agents[1]
    );
    await custodyRefusal('refuse checkout over foreign allocation', [
      { kind: 'checkout-item', item: tubeItem, dueAt: null, reason: 'Retrieve for bench work' },
    ]);
    await custodyCommit(
      'release foreign allocation before departure',
      [
        {
          kind: 'release-reservation',
          reservationId: 'foreign-custody-hold',
          reason: 'Experiment rescheduled',
        },
      ],
      agents[1]
    );
    const checkoutDue = clock + 1_000;
    const custodyCheckoutRequest: InventoryExecuteRequest = {
      ...custodyScope,
      operationId: 'custody:lost-checkout',
      expectedRevision: owner.inspect(custodyScope)!.revision,
      commands: [
        {
          kind: 'checkout-item',
          item: tubeItem,
          dueAt: checkoutDue,
          reason: 'Retrieve for bench work',
        },
      ],
    };
    const custodyCheckoutReceipt = await loseAcknowledgement(
      custodyCheckoutRequest,
      'custodyLostAcknowledgement'
    );
    expect(custodyCheckoutReceipt.context?.principal).toEqual(nativeHolder);
    const checkedOut = owner.inspect(custodyScope)!;
    expect(checkedOut.vessels.tube).toMatchObject({
      placement: { kind: 'unplaced' },
      custody: { kind: 'checked-out', holder: nativeHolder, dueAt: checkoutDue },
    });
    const checkedOutTube = checkedOut.vessels.tube;
    if (checkedOutTube.kind !== 'movable') throw new Error('The fixture tube must be movable.');
    const originalCustody = checkedOutTube.custody;
    if (originalCustody.kind !== 'checked-out') throw new Error('Checkout did not persist.');
    clock = checkoutDue + 1;
    const overdueCustody = await success<InventoryAvailabilitySnapshot>(
      'observe overdue checkout without automatic return',
      'inventory.availability',
      custodyScope
    );
    expect(overdueCustody.items.tube).toMatchObject({
      overdue: true,
      state: { kind: 'checked-out', holder: nativeHolder },
    });
    expect(owner.inspect(custodyScope)).toEqual(checkedOut);
    await custodyRefusal(
      'refuse foreign use of checked-out stock',
      [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '1', unit: 'uL' },
          reason: 'Foreign use attempt',
        },
      ],
      agents[1]
    );
    await custodyRefusal(
      'refuse foreign ordinary return',
      [
        {
          kind: 'return-item',
          item: tubeItem,
          destination: { kind: 'located', storageId: 'box', slotId: 'A2' },
          reason: 'Foreign return attempt',
        },
      ],
      agents[1]
    );
    await custodyCommit('use owned checked-out stock', [
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '20', unit: 'uL' },
        reason: 'Bench experiment',
      },
    ]);
    await custodyCommit('reuse vacated original position', [
      {
        kind: 'create-vessel',
        id: 'blocker',
        name: 'Other physical container',
        placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
      },
    ]);
    await custodyRefusal(
      'refuse occupied return without changing custody',
      [
        {
          kind: 'return-item',
          item: tubeItem,
          destination: { kind: 'located', storageId: 'box', slotId: 'A1' },
          reason: 'Return after experiment',
        },
      ],
      {},
      'SLOT_OCCUPIED'
    );
    await custodyCommit('move former ancestor while container is checked out', [
      {
        kind: 'move-storage',
        id: 'box',
        placement: { kind: 'located', storageId: 'freezer', slotId: 'bottom' },
      },
    ]);
    const movedAncestorTube = owner.inspect(custodyScope)!.vessels.tube;
    if (movedAncestorTube.kind !== 'movable') throw new Error('The fixture tube must be movable.');
    expect(movedAncestorTube.custody).toMatchObject({
      kind: 'checked-out',
      lastKnown: originalCustody.lastKnown,
    });
    await custodyCommit('return to explicit alternate position', [
      {
        kind: 'return-item',
        item: tubeItem,
        destination: { kind: 'located', storageId: 'box', slotId: 'A2' },
        reason: 'Return after experiment',
      },
    ]);
    expect(owner.inspect(custodyScope)!.vessels.tube).toMatchObject({
      placement: { kind: 'located', storageId: 'box', slotId: 'A2' },
      custody: { kind: 'available' },
    });
    await custodyCommit('retain owned allocation across absence', [
      {
        kind: 'reserve-quantity',
        id: 'custody-retained-hold',
        stockId: 'stock',
        quantity: { value: '15', unit: 'uL' },
        deadline: null,
        purpose: 'Next bench experiment',
      },
      { kind: 'checkout-item', item: tubeItem, dueAt: null, reason: 'Prepare transport' },
    ]);
    await custodyCommit('begin explicit container transit', [
      {
        kind: 'start-item-transit',
        item: tubeItem,
        destination: { kind: 'located', storageId: 'box', slotId: 'A2' },
        reason: 'Transport between work areas',
      },
    ]);
    const inTransit = owner.inspect(custodyScope)!;
    const transitTube = inTransit.vessels.tube;
    if (transitTube.kind !== 'movable' || transitTube.custody.kind !== 'in-transit')
      throw new Error('The fixture tube must retain its explicit transit state.');
    expect(inTransit.vessels.tube).toMatchObject({
      placement: { kind: 'unplaced' },
      custody: {
        kind: 'in-transit',
        holder: nativeHolder,
        destination: { kind: 'located', storageId: 'box', slotId: 'A2' },
      },
    });
    await custodyRefusal('refuse physical withdrawal during transit', [
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '1', unit: 'uL' },
        reason: 'Transit use attempt',
      },
    ]);
    await custodyRefusal('refuse legacy movement as transit arrival', [
      {
        kind: 'move-vessel',
        id: 'tube',
        placement: { kind: 'located', storageId: 'box', slotId: 'A2' },
      },
    ]);
    await custodyCommit('record truthful quality and quantity observations during transit', [
      { kind: 'set-quality', stockId: 'stock', quality: 'quarantined', reason: 'Receiving review' },
      {
        kind: 'reconcile',
        stockId: 'stock',
        quantity: { kind: 'known', value: '80', unit: 'uL' },
        reason: 'Reported balance',
      },
      { kind: 'set-quality', stockId: 'stock', quality: 'usable', reason: 'Review complete' },
    ]);
    await custodyCommit('check out and dispatch an empty container', [
      {
        kind: 'checkout-item',
        item: { kind: 'vessel', id: 'empty-transit' },
        dueAt: null,
        reason: 'Transport empty vessel',
      },
      {
        kind: 'start-item-transit',
        item: { kind: 'vessel', id: 'empty-transit' },
        destination: { kind: 'unplaced' },
        reason: 'Transport empty vessel',
      },
    ]);
    await custodyRefusal('refuse physical receipt into an in-transit empty vessel', [
      {
        kind: 'receive-stock',
        id: 'unreceived-stock',
        vesselId: 'empty-transit',
        materialId: 'synthetic-material',
        quantity: { kind: 'known', value: '1', unit: 'uL' },
        quality: 'usable',
      },
    ]);
    await custodyCommit(
      'report missing without erasing another holder',
      [{ kind: 'report-item-missing', item: tubeItem, reason: 'Not found at transport handoff' }],
      agents[1]
    );
    const missingCustodyState = owner.inspect(custodyScope)!;
    expect(missingCustodyState.vessels.tube).toMatchObject({
      placement: { kind: 'unplaced' },
      custody: {
        kind: 'missing',
        holder: nativeHolder,
        reportedBy: { kind: 'agent', identityId: identities[1] },
        lastKnown: transitTube.custody.lastKnown,
      },
    });
    expect(missingCustodyState.reservations['custody-retained-hold']).toMatchObject({
      lifecycle: { kind: 'active' },
      remaining: { value: '15', unit: 'uL' },
    });
    await custodyRefusal('refuse missing stock withdrawal', [
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '1', unit: 'uL' },
        reason: 'Missing stock use attempt',
      },
    ]);
    await custodyRefusal(
      'refuse occupied locate without losing missing responsibility',
      [
        {
          kind: 'locate-item',
          item: tubeItem,
          destination: { kind: 'located', storageId: 'box', slotId: 'A1' },
          reason: 'Found at handoff',
        },
      ],
      agents[1],
      'SLOT_OCCUPIED'
    );
    await custodyCommit(
      'record observed return by current granted operator',
      [
        {
          kind: 'locate-item',
          item: tubeItem,
          destination: { kind: 'located', storageId: 'box', slotId: 'A2' },
          reason: 'Found and physically returned at handoff',
        },
      ],
      agents[1]
    );
    expect(owner.inspect(custodyScope)!.vessels.tube).toMatchObject({
      placement: { kind: 'located', storageId: 'box', slotId: 'A2' },
      custody: { kind: 'available' },
    });
    await custodyCommit('release retained quantity before another custodian checkout', [
      {
        kind: 'release-reservation',
        reservationId: 'custody-retained-hold',
        reason: 'Handoff complete',
      },
    ]);
    await custodyCommit(
      'grant operator checks out available stock',
      [
        {
          kind: 'checkout-item',
          item: tubeItem,
          dueAt: null,
          reason: 'Granted operator bench work',
        },
      ],
      agents[0]
    );
    await custodyRefusal('profile authority cannot silently debit foreign custody', [
      {
        kind: 'consume',
        stockId: 'stock',
        quantity: { value: '1', unit: 'uL' },
        reason: 'Profile use attempt',
      },
    ]);
    await custodyCommit('record reason-bearing local profile recovery return', [
      {
        kind: 'return-item',
        item: tubeItem,
        destination: { kind: 'located', storageId: 'box', slotId: 'A2' },
        reason: 'Local operator physically recovered and returned this container',
      },
    ]);
    await custodyCommit('leave container checked out for native restart', [
      {
        kind: 'checkout-item',
        item: tubeItem,
        dueAt: null,
        reason: 'Continue bench work after restart',
      },
    ]);
    await custodyCommit('receive material in a container before aggregate checkout', [
      {
        kind: 'receive-stock',
        id: 'nested-stock',
        vesselId: 'blocker',
        materialId: 'synthetic-material',
        quantity: { kind: 'known', value: '30', unit: 'uL' },
        quality: 'usable',
      },
      {
        kind: 'checkout-item',
        item: { kind: 'storage', id: 'box' },
        dueAt: null,
        reason: 'Retrieve complete box',
      },
    ]);
    const aggregateAvailability = await success<InventoryAvailabilitySnapshot>(
      'read inherited box custody',
      'inventory.availability',
      custodyScope
    );
    expect(aggregateAvailability.items.blocker).toMatchObject({
      root: { kind: 'storage', id: 'box' },
      inherited: true,
      state: { kind: 'checked-out', holder: nativeHolder },
    });
    await custodyRefusal(
      'refuse foreign withdrawal from checked-out box',
      [
        {
          kind: 'consume',
          stockId: 'nested-stock',
          quantity: { value: '1', unit: 'uL' },
          reason: 'Foreign nested use attempt',
        },
      ],
      agents[1]
    );
    await custodyCommit('use stock through owned ancestor custody', [
      {
        kind: 'consume',
        stockId: 'nested-stock',
        quantity: { value: '5', unit: 'uL' },
        reason: 'Owned box experiment',
      },
    ]);
    await custodyRefusal('refuse child movement escaping inherited custody', [
      { kind: 'move-vessel', id: 'blocker', placement: { kind: 'unplaced' } },
    ]);
    await custodyCommit('explicitly split a child checkout from owned aggregate', [
      {
        kind: 'checkout-item',
        item: { kind: 'vessel', id: 'blocker' },
        dueAt: null,
        reason: 'Extract one container from the box',
      },
      {
        kind: 'return-item',
        item: { kind: 'vessel', id: 'blocker' },
        destination: { kind: 'located', storageId: 'freezer', slotId: 'top' },
        reason: 'Return extracted container to a distinct position',
      },
    ]);
    expect(owner.inspect(custodyScope)!.stocks['nested-stock'].quantity).toEqual({
      kind: 'known',
      value: '25',
      unit: 'uL',
    });
    await custodyCommit('create a three-plate stack with stable permanent wells', [
      {
        kind: 'create-layout-storage',
        id: 'custody-stack',
        name: 'Custody stack',
        layout: { kind: 'stack', capacity: 3, removal: 'top-only' },
        placement: { kind: 'root' },
      },
      ...['plate-a', 'plate-b', 'plate-c'].map(
        (id): InventoryCommand => ({
          kind: 'create-layout-storage',
          id,
          name: id,
          layout: { kind: 'fixed-well', rows: 1, columns: 1 },
          placement: { kind: 'root' },
        })
      ),
      {
        kind: 'receive-stock',
        id: 'plate-stock',
        vesselId: 'well:plate-b#A1',
        materialId: 'synthetic-material',
        quantity: { kind: 'known', value: '5', unit: 'uL' },
        quality: 'usable',
      },
      ...['plate-a', 'plate-b', 'plate-c'].map(
        (id): InventoryCommand => ({
          kind: 'push-stack',
          stackId: 'custody-stack',
          item: { kind: 'storage', id },
        })
      ),
    ]);
    await custodyRefusal(
      'refuse physical retrieval of middle plate',
      [
        {
          kind: 'checkout-item',
          item: { kind: 'storage', id: 'plate-b' },
          dueAt: null,
          reason: 'Middle plate retrieval attempt',
        },
      ],
      {},
      'STACK_TOP_REQUIRED'
    );
    await custodyCommit(
      'record truthful middle-stack absence',
      [
        {
          kind: 'report-item-missing',
          item: { kind: 'storage', id: 'plate-b' },
          reason: 'Observed plate absent during stack count',
        },
      ],
      agents[1]
    );
    const missingMiddle = owner.inspect(custodyScope)!;
    expect(missingMiddle.storage['plate-b']).toMatchObject({
      placement: { kind: 'root' },
      custody: {
        kind: 'missing',
        holder: null,
        lastKnown: { placement: { kind: 'located', storageId: 'custody-stack', slotId: '2' } },
      },
    });
    expect(missingMiddle.storage['plate-a'].placement).toEqual({
      kind: 'located',
      storageId: 'custody-stack',
      slotId: '1',
    });
    expect(missingMiddle.storage['plate-c'].placement).toEqual({
      kind: 'located',
      storageId: 'custody-stack',
      slotId: '2',
    });
    expect(missingMiddle.vessels['well:plate-b#A1']).toMatchObject({
      kind: 'fixed-well',
      placement: { kind: 'located', storageId: 'plate-b', slotId: 'A1' },
    });
    await custodyCommit(
      'locate missing plate explicitly at stack top',
      [
        {
          kind: 'locate-item',
          item: { kind: 'storage', id: 'plate-b' },
          destination: { kind: 'stack-top', stackId: 'custody-stack' },
          reason: 'Found and placed above counted stack',
        },
      ],
      agents[1]
    );
    await custodyCommit('check out top plate with fixed wells attached', [
      {
        kind: 'checkout-item',
        item: { kind: 'storage', id: 'plate-b' },
        dueAt: null,
        reason: 'Plate experiment',
      },
    ]);
    const plateAvailability = await success<InventoryAvailabilitySnapshot>(
      'read permanent well inherited custody',
      'inventory.availability',
      custodyScope
    );
    expect(plateAvailability.items['well:plate-b#A1']).toMatchObject({
      root: { kind: 'storage', id: 'plate-b' },
      inherited: true,
      state: { kind: 'checked-out', holder: nativeHolder },
    });
    await custodyRefusal(
      'refuse independent permanent-well checkout',
      [
        {
          kind: 'checkout-item',
          item: { kind: 'vessel', id: 'well:plate-b#A1' },
          dueAt: null,
          reason: 'Independent well retrieval attempt',
        },
      ],
      {},
      'FIXED_WELL_IMMUTABLE'
    );
    await custodyRefusal(
      'refuse arbitrary stack ordinal on return',
      [
        {
          kind: 'return-item',
          item: { kind: 'storage', id: 'plate-b' },
          destination: { kind: 'located', storageId: 'custody-stack', slotId: '3' },
          reason: 'Ordinal return attempt',
        },
      ],
      {},
      'STACK_OPERATION_REQUIRED'
    );
    await custodyCommit('retrieve next top after earlier plate checkout', [
      {
        kind: 'checkout-item',
        item: { kind: 'storage', id: 'plate-c' },
        dueAt: null,
        reason: 'Second plate experiment',
      },
    ]);
    await custodyCommit('return checked-out plates with explicit stack pushes', [
      {
        kind: 'return-item',
        item: { kind: 'storage', id: 'plate-c' },
        destination: { kind: 'stack-top', stackId: 'custody-stack' },
        reason: 'Return second plate',
      },
      {
        kind: 'return-item',
        item: { kind: 'storage', id: 'plate-b' },
        destination: { kind: 'stack-top', stackId: 'custody-stack' },
        reason: 'Return first plate',
      },
    ]);
    const custodyBeforeRestart = owner.inspect(custodyScope)!;
    const custodyHistoryBeforeRestart = owner.history(custodyScope);
    const custodyAvailabilityBeforeRestart = await success<InventoryAvailabilitySnapshot>(
      'inspect custody before native restart',
      'inventory.availability',
      custodyScope
    );
    expect(custodyBeforeRestart.stocks.stock.quantity).toEqual({
      kind: 'known',
      value: '80',
      unit: 'uL',
    });
    expect(custodyBeforeRestart.stocks['plate-stock'].quantity).toEqual({
      kind: 'known',
      value: '5',
      unit: 'uL',
    });
    evidence.custodyBeforeRestart = {
      state: custodyBeforeRestart,
      history: custodyHistoryBeforeRestart,
      availability: custodyAvailabilityBeforeRestart,
      checkoutReceipt: custodyCheckoutReceipt,
      originalLocation: originalCustody.lastKnown,
      missingState: missingCustodyState,
      missingMiddle,
      aggregateAvailability,
      plateAvailability,
    };

    const physicalScope = { ...scope, inventoryId: 'inventory-physical-configuration' };
    async function physicalAttempt(label: string, commands: readonly InventoryCommand[]) {
      const before = await success<InventoryState | null>(
        `${label}: inspect current physical configuration`,
        'inventory.inspect',
        physicalScope
      );
      const request: InventoryExecuteRequest = {
        ...physicalScope,
        operationId: `physical:${label}`,
        expectedRevision: before?.revision ?? 0,
        commands,
      };
      const result = await success<NativeInventoryExecution>(label, 'inventory.execute', request);
      return { before, request, result };
    }
    async function physicalCommit(label: string, commands: readonly InventoryCommand[]) {
      const attempt = await physicalAttempt(label, commands);
      expect(attempt.result, label).toMatchObject({ status: 'committed' });
      return attempt;
    }
    async function physicalRefusal(label: string, commands: readonly InventoryCommand[]) {
      const attempt = await physicalAttempt(label, commands);
      expect(attempt.result, label).toMatchObject({ status: 'rejected' });
      expect(owner.inspect(physicalScope), label).toEqual(attempt.before);
      expect(owner.history(physicalScope), label).toHaveLength(attempt.before?.revision ?? 0);
      expect(
        owner.operation({ ...physicalScope, operationId: attempt.request.operationId })
      ).toBeNull();
      return attempt;
    }
    const unknownGeometry: InventoryGeometry = {
      external: {
        width: { kind: 'unknown' },
        height: { kind: 'unknown' },
        depth: { kind: 'unknown' },
      },
      usable: {
        width: { kind: 'unknown' },
        height: { kind: 'unknown' },
        depth: { kind: 'unknown' },
      },
    };
    const tubeDefinition = {
      kind: 'vessel' as const,
      mobility: 'movable' as const,
      limits: {
        capacity: { kind: 'known' as const, value: '200', unit: 'uL' as const },
        deadVolume: { kind: 'known' as const, value: '0', unit: 'uL' as const },
      },
      geometry: unknownGeometry,
    };
    await physicalCommit('publish immutable physical types and a pinned recipe', [
      {
        kind: 'define-physical-type',
        id: 'physical-tube-v1',
        typeId: 'physical-tube',
        name: 'Synthetic tube',
        description: 'Synthetic movable tube type',
        sources: [],
        fields: [
          { key: 'assetTag', label: 'Asset tag', type: 'text', required: true, maxLength: 30 },
        ],
        definition: tubeDefinition,
      },
      {
        kind: 'define-physical-type',
        id: 'physical-rack-v1',
        typeId: 'physical-rack',
        name: 'Synthetic rack',
        description: 'Synthetic rack with explicit allowed child type',
        sources: [],
        fields: [
          { key: 'assetTag', label: 'Asset tag', type: 'text', required: true },
          { key: 'notes', label: 'Notes', type: 'long_text' },
          { key: 'active', label: 'Active', type: 'boolean', required: true },
          { key: 'color', label: 'Color', type: 'enum', enumOptions: ['red', 'blue'] },
          { key: 'collected', label: 'Collected', type: 'date' },
          { key: 'score', label: 'Score', type: 'number', minValue: 0, maxValue: 10 },
          { key: 'tags', label: 'Tags', type: 'string_array' },
        ],
        definition: {
          kind: 'storage',
          layout: { kind: 'named', slots: ['A1', 'A2'] },
          childPolicy: { kind: 'types', typeIds: ['physical-tube'] },
          positionRules: {},
          geometry: unknownGeometry,
        },
      },
      {
        kind: 'define-equipment-recipe',
        id: 'physical-recipe-v1',
        recipeId: 'physical-recipe',
        name: 'Synthetic rack and tube',
        description: 'Synthetic recipe pins explicit physical type versions',
        model: {
          manufacturer: 'Synthetic fixture',
          model: 'R2',
          partNumber: null,
          region: null,
          revision: 'A',
        },
        components: [
          {
            key: 'rack',
            parentKey: null,
            positionId: null,
            name: 'Rack',
            typeVersionId: 'physical-rack-v1',
          },
          {
            key: 'tube',
            parentKey: 'rack',
            positionId: 'A1',
            name: 'Tube',
            typeVersionId: 'physical-tube-v1',
          },
        ],
        sources: [
          {
            url: 'https://example.invalid/synthetic-rack-specification',
            title: 'Synthetic acceptance fixture; no manufacturer claim',
            locator: 'Fixture rack and tube arrangement',
            readAt: '2026-11-14',
            documentRevision: 'synthetic-A',
            sha256: null,
          },
        ],
      },
    ]);
    const instantiateRequest: InventoryExecuteRequest = {
      ...physicalScope,
      operationId: 'physical:lost-recipe-installation',
      expectedRevision: owner.inspect(physicalScope)!.revision,
      commands: [
        {
          kind: 'instantiate-equipment-recipe',
          recipeVersionId: 'physical-recipe-v1',
          name: 'Installed synthetic rack',
          components: [
            {
              key: 'rack',
              id: 'installed-rack',
              metadata: {
                assetTag: 'rack-01',
                notes: 'Keep dry',
                active: false,
                color: 'blue',
                collected: '15/01/2024',
                score: 0,
                tags: [],
              },
            },
            { key: 'tube', id: 'installed-tube', metadata: { assetTag: 'tube-01' } },
          ],
          destination: { kind: 'root' },
          reason: 'Record actual synthetic installation',
        },
      ],
    };
    await physicalRefusal('refuse incomplete recipe atomically before creating any component', [
      {
        kind: 'instantiate-equipment-recipe',
        recipeVersionId: 'physical-recipe-v1',
        name: 'Incomplete installation',
        components: [
          {
            key: 'rack',
            id: 'incomplete-rack',
            metadata: { assetTag: 'not-created', active: false },
          },
          { key: 'tube', id: 'incomplete-tube', metadata: {} },
        ],
        destination: { kind: 'root' },
        reason: 'Missing child metadata must refuse the whole installation',
      },
    ]);
    const installationReceipt = await loseAcknowledgement(
      instantiateRequest,
      'physicalLostAcknowledgement'
    );
    expect(installationReceipt.context?.principal).toEqual(nativeHolder);
    const installed = owner.inspect(physicalScope)!;
    expect(installed.storage['installed-rack'].configuration).toMatchObject({
      typeVersionId: 'physical-rack-v1',
      metadata: { assetTag: 'rack-01', active: false, score: 0, tags: [] },
      recipe: { recipeVersionId: 'physical-recipe-v1', componentKey: 'rack' },
    });
    expect(installed.vessels['installed-tube']).toMatchObject({
      placement: { kind: 'located', storageId: 'installed-rack', slotId: 'A1' },
      limits: tubeDefinition.limits,
      configuration: {
        typeVersionId: 'physical-tube-v1',
        recipe: { recipeVersionId: 'physical-recipe-v1', componentKey: 'tube' },
      },
    });
    const installedAvailability = await success<InventoryAvailabilitySnapshot>(
      'read physical projection with honest unknown fit',
      'inventory.availability',
      physicalScope
    );
    expect(installedAvailability.physical.items['installed-tube']).toMatchObject({
      metadataIssues: { malformed: [], incomplete: [] },
      placementCompatibility: { logical: 'allowed', fit: 'unknown' },
    });
    await physicalRefusal('refuse missing required physical metadata without a receipt', [
      {
        kind: 'configure-item',
        item: { kind: 'vessel', id: 'installed-tube' },
        typeVersionId: 'physical-tube-v1',
        metadata: {},
        orientation: { kind: 'unknown' },
        unavailablePositions: {},
        reason: 'Incomplete metadata must not replace current installation',
      },
    ]);
    await physicalRefusal('refuse undeclared physical metadata without a receipt', [
      {
        kind: 'configure-item',
        item: { kind: 'vessel', id: 'installed-tube' },
        typeVersionId: 'physical-tube-v1',
        metadata: { assetTag: 'tube-01', undeclared: 'not permitted' },
        orientation: { kind: 'unknown' },
        unavailablePositions: {},
        reason: 'Unknown fields must not enter installed metadata',
      },
    ]);
    await physicalCommit('publish next tube version without rewriting installed pins', [
      {
        kind: 'define-physical-type',
        id: 'physical-tube-v2',
        typeId: 'physical-tube',
        name: 'Synthetic larger tube',
        description: 'A new version, separate from installed v1',
        sources: [],
        fields: [{ key: 'assetTag', label: 'Asset tag', type: 'text', required: true }],
        definition: {
          ...tubeDefinition,
          limits: {
            ...tubeDefinition.limits,
            capacity: { kind: 'known', value: '500', unit: 'uL' },
          },
        },
      },
    ]);
    expect(owner.inspect(physicalScope)!.vessels['installed-tube']).toEqual(
      installed.vessels['installed-tube']
    );
    await physicalCommit('instantiate a newer allowed child type version and scientific stock', [
      {
        kind: 'instantiate-physical-type',
        typeVersionId: 'physical-tube-v2',
        id: 'second-installed-tube',
        name: 'Second tube',
        destination: { kind: 'located', storageId: 'installed-rack', slotId: 'A2' },
        metadata: { assetTag: 'tube-02' },
        reason: 'Stable allowed child identity accepts the explicit newer version',
      },
      {
        kind: 'create-vessel',
        id: 'untyped-tube',
        name: 'Untyped tube',
        placement: { kind: 'unplaced' },
      },
      {
        kind: 'receive-stock',
        id: 'physical-stock',
        vesselId: 'installed-tube',
        materialId: 'synthetic-material',
        quantity: { kind: 'known', value: '100', unit: 'uL' },
        quality: 'usable',
      },
    ]);
    await physicalRefusal('refuse removing an occupied configured position', [
      {
        kind: 'reconfigure-storage',
        storageId: 'installed-rack',
        layout: { kind: 'named', slots: ['A1'] },
        reason: 'Occupied A2 cannot disappear',
      },
    ]);
    await physicalCommit('move newer tube aside before checking child policy', [
      {
        kind: 'move-vessel',
        id: 'second-installed-tube',
        placement: { kind: 'unplaced' },
      },
    ]);
    await physicalRefusal('refuse logically disallowed untyped child despite an empty position', [
      {
        kind: 'move-vessel',
        id: 'untyped-tube',
        placement: { kind: 'located', storageId: 'installed-rack', slotId: 'A2' },
      },
    ]);
    await physicalCommit('record installed geometry separately from immutable type versions', [
      {
        kind: 'record-item-geometry',
        item: { kind: 'storage', id: 'installed-rack' },
        geometry: {
          ...unknownGeometry,
          usable: {
            width: { kind: 'known', value: '1', unit: 'cm' },
            height: { kind: 'known', value: '1', unit: 'cm' },
            depth: { kind: 'known', value: '1', unit: 'cm' },
          },
        },
        source: null,
        reason: 'Synthetic observed usable dimensions',
      },
      {
        kind: 'record-item-geometry',
        item: { kind: 'vessel', id: 'second-installed-tube' },
        geometry: {
          ...unknownGeometry,
          external: {
            width: { kind: 'known', value: '20', unit: 'mm' },
            height: { kind: 'known', value: '20', unit: 'mm' },
            depth: { kind: 'known', value: '20', unit: 'mm' },
          },
        },
        source: null,
        reason: 'Synthetic observed external dimensions',
      },
    ]);
    await physicalRefusal('refuse a known geometry contradiction despite an allowed type', [
      {
        kind: 'move-vessel',
        id: 'second-installed-tube',
        placement: { kind: 'located', storageId: 'installed-rack', slotId: 'A2' },
      },
    ]);
    expect(
      owner.inspect(physicalScope)!.storage['installed-rack'].configuration.geometryOverride
    ).toMatchObject({
      geometry: { usable: { width: { kind: 'known', value: '10', unit: 'mm' } } },
    });
    expect(
      owner.inspect(physicalScope)!.typeVersions['physical-rack-v1'].definition.geometry
    ).toEqual(unknownGeometry);
    await physicalCommit('consume scientific material from explicitly configured physical vessel', [
      {
        kind: 'consume',
        stockId: 'physical-stock',
        quantity: { value: '10', unit: 'uL' },
        reason: 'Synthetic configured-vessel use',
      },
    ]);
    expect(
      await success<NativeInventoryExecution>(
        'retry exact lost recipe installation after later commands',
        'inventory.execute',
        instantiateRequest
      )
    ).toEqual(installationReceipt);
    const physicalBeforeRestart = owner.inspect(physicalScope)!;
    const physicalHistoryBeforeRestart = owner.history(physicalScope);
    const physicalAvailabilityBeforeRestart = await success<InventoryAvailabilitySnapshot>(
      'inspect physical configuration before native restart',
      'inventory.availability',
      physicalScope
    );
    expect(physicalBeforeRestart.stocks['physical-stock'].quantity).toEqual({
      kind: 'known',
      value: '90',
      unit: 'uL',
    });
    evidence.physicalBeforeRestart = {
      state: physicalBeforeRestart,
      history: physicalHistoryBeforeRestart,
      availability: physicalAvailabilityBeforeRestart,
      installationReceipt,
    };

    await server!.close();
    server = undefined;
    db.close();
    db = undefined;
    db = openFileTestDb(dbPath);
    await start();
    evidence.closedAndReopened = true;
    expect(owner.inspect(physicalScope)).toEqual(physicalBeforeRestart);
    expect(owner.history(physicalScope)).toEqual(physicalHistoryBeforeRestart);
    expect(
      await success<InventoryAvailabilitySnapshot>(
        'read exact physical projection after native reopen',
        'inventory.availability',
        physicalScope
      )
    ).toEqual(physicalAvailabilityBeforeRestart);
    expect(
      await success<NativeInventoryExecution>(
        'retry lost recipe installation after native reopen',
        'inventory.execute',
        instantiateRequest
      )
    ).toEqual(installationReceipt);
    const physicalReplay = owner.replay(physicalScope);
    expect(physicalReplay).toEqual({
      state: physicalBeforeRestart,
      acceptedOperations: physicalHistoryBeforeRestart.length,
    });
    evidence.physicalReopenedReadback = {
      state: owner.inspect(physicalScope),
      history: owner.history(physicalScope),
      availability: owner.availability(physicalScope),
      receipt: owner.operation({ ...physicalScope, operationId: instantiateRequest.operationId }),
      replay: physicalReplay,
    };
    expect(owner.inspect(custodyScope)).toEqual(custodyBeforeRestart);
    expect(owner.history(custodyScope)).toEqual(custodyHistoryBeforeRestart);
    expect(
      await success<InventoryAvailabilitySnapshot>(
        'read exact custody after native reopen',
        'inventory.availability',
        custodyScope
      )
    ).toEqual(custodyAvailabilityBeforeRestart);
    expect(
      await success<NativeInventoryExecution>(
        'retry lost checkout after later returns and native reopen',
        'inventory.execute',
        custodyCheckoutRequest
      )
    ).toEqual(custodyCheckoutReceipt);
    const custodyReplay = owner.replay(custodyScope);
    expect(custodyReplay).toEqual({
      state: custodyBeforeRestart,
      acceptedOperations: custodyHistoryBeforeRestart.length,
    });
    evidence.custodyReopenedReadback = {
      state: owner.inspect(custodyScope),
      history: owner.history(custodyScope),
      availability: owner.availability(custodyScope),
      receipt: owner.operation({
        ...custodyScope,
        operationId: custodyCheckoutRequest.operationId,
      }),
      replay: custodyReplay,
    };
    expect(owner.inspect(reservationScope)).toEqual(reservationBeforeRestart);
    expect(owner.history(reservationScope)).toEqual(reservationHistoryBeforeRestart);
    expect(
      await success<InventoryAvailabilitySnapshot>(
        'read exact profile availability after native reopen',
        'inventory.availability',
        reservationScope
      )
    ).toEqual(profileAvailability);
    expect(
      await success<NativeInventoryExecution>(
        'retry original reservation after later fulfillment and native reopen',
        'inventory.execute',
        profileHoldRequest
      )
    ).toEqual(profileHoldReceipt);
    const reservationReplay = owner.replay(reservationScope);
    expect(reservationReplay).toEqual({
      state: reservationBeforeRestart,
      acceptedOperations: 5,
    });
    evidence.reservationReopenedReadback = {
      state: owner.inspect(reservationScope),
      history: owner.history(reservationScope),
      availability: owner.availability(reservationScope),
      receipt: owner.operation({
        ...reservationScope,
        operationId: profileHoldRequest.operationId,
      }),
      replay: reservationReplay,
    };
    expect(
      await success<NativeInventoryExecution>(
        'retry original consume after restart',
        'inventory.execute',
        consume
      )
    ).toEqual(receipt);
    expect(
      await success<NativeInventoryExecution>(
        'reject changed operation payload',
        'inventory.execute',
        {
          ...consume,
          commands: [
            {
              kind: 'consume',
              stockId: 'stock',
              quantity: { value: '21', unit: 'uL' },
              reason: 'Synthetic experiment',
            },
          ],
        }
      )
    ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
    expect(
      await success<NativeInventoryExecution>('reject stale competing move', 'inventory.execute', {
        ...scope,
        operationId: 'stale-move',
        expectedRevision: 1,
        commands: [
          {
            kind: 'move-vessel',
            id: 'tube',
            placement: { kind: 'located', storageId: 'box', slotId: 'A1' },
          },
        ],
      })
    ).toMatchObject({ status: 'rejected', code: 'REVISION_CONFLICT', currentRevision: 3 });
    const badToken = await call(
      'reject bad token without consuming stock',
      'inventory.execute',
      { ...consume, operationId: 'bad-token', expectedRevision: 3 },
      { invalidToken: true }
    );
    expect(badToken).toMatchObject({
      status: 403,
      body: { ok: false, accepted: false, error: { code: 'NATIVE_DOCUMENT_AUTHORITY_REQUIRED' } },
    });
    const wrongProject = await call(
      'reject inventory in another registered project',
      'inventory.inspect',
      { ...scope, project: 'Other synthetic project' },
      { roots: [otherPath] }
    );
    expect(wrongProject).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          ok: false,
          code: 'PROJECT_ACCESS_DENIED',
          stateChanged: false,
          partialEffects: [],
        },
      },
    });
    const outsideScope = await call(
      'reject project outside request roots',
      'inventory.inspect',
      scope,
      { roots: [otherPath] }
    );
    expect(outsideScope).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          ok: false,
          code: 'PROJECT_ACCESS_DENIED',
          stateChanged: false,
          partialEffects: [],
        },
      },
    });
    const wrongProjectWrite = await call(
      'reject stock consumption from another registered project',
      'inventory.execute',
      {
        ...consume,
        project: 'Other synthetic project',
        operationId: 'wrong-project',
        expectedRevision: 3,
      },
      { roots: [otherPath] }
    );
    expect(wrongProjectWrite).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          ok: false,
          code: 'PROJECT_ACCESS_DENIED',
          stateChanged: false,
          partialEffects: [],
        },
      },
    });
    const outsideScopeWrite = await call(
      'reject stock consumption outside request roots',
      'inventory.execute',
      { ...consume, operationId: 'outside-scope', expectedRevision: 3 },
      { roots: [otherPath] }
    );
    expect(outsideScopeWrite).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          ok: false,
          code: 'PROJECT_ACCESS_DENIED',
          stateChanged: false,
          partialEffects: [],
        },
      },
    });

    const finalState = await success<InventoryState>(
      'final state after restart and refusals',
      'inventory.inspect',
      scope
    );
    const history = await success<NativeInventoryHistoryEntry[]>(
      'final history after restart and refusals',
      'inventory.history',
      scope
    );
    const finalReceipt = await success<NativeInventoryReceipt>(
      'final receipt after restart',
      'inventory.operation',
      { ...scope, operationId: 'consume' }
    );
    const rejectedReceipt = await success<NativeInventoryReceipt | null>(
      'stale rejection has no durable receipt',
      'inventory.operation',
      { ...scope, operationId: 'stale-move' }
    );
    const replay = owner.replay(scope);
    evidence.reopenedReadback = {
      state: finalState,
      history,
      receipt: finalReceipt,
      rejectedReceipt,
      replay,
    };
    expect(finalState).toEqual(beforeRestart);
    expect(finalState.revision).toBe(3);
    expect(finalReceipt).toEqual(receipt);
    expect(rejectedReceipt).toBeNull();
    expect(history.map((entry) => entry.receipt.operationId)).toEqual([
      'receive',
      'move',
      'consume',
    ]);
    expect(history[2].receipt).toEqual(receipt);
    expect(replay).toEqual({ state: finalState, acceptedOperations: 3 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.failure =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error);
    throw error;
  } finally {
    try {
      try {
        await server?.close();
      } finally {
        if (db?.open) db.close();
      }
    } catch (error) {
      evidence.status = 'failed';
      evidence.cleanupFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      evidence.finishedAt = new Date().toISOString();
      if (evidencePath) {
        writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
        console.info(`INVENTORY_CORE_EVIDENCE=${evidencePath}`);
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
});
