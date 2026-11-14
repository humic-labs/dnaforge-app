// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { InventoryCommand, InventoryState } from '@waypoint/domain-services';
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

    await server!.close();
    server = undefined;
    db.close();
    db = undefined;
    db = openFileTestDb(dbPath);
    await start();
    evidence.closedAndReopened = true;
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
