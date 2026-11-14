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

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
}));

import { openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';

type InventoryNativeCommand =
  | 'inventory.execute'
  | 'inventory.inspect'
  | 'inventory.operation'
  | 'inventory.history';
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
  let authority: { ownerInstanceId: string; token: string };
  const scope = { project: 'Synthetic inventory project', inventoryId: 'inventory-synthetic' };
  const projectScope = { kind: 'project-roots' as const, roots: [projectPath] };

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
      now: () => 1_700_000_000_000 + instance,
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
    options: { invalidToken?: boolean; roots?: string[] } = {}
  ): Promise<{ status: number; body: NativeResponse<T> }> {
    if (!server) throw new Error('Fixture server is closed.');
    const entry: TraceEntry = {
      label,
      command,
      request,
      ownerInstanceId: authority.ownerInstanceId,
      projectScope: options.roots ? { kind: 'project-roots', roots: options.roots } : projectScope,
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
    request: unknown
  ): Promise<T> {
    const response = await call<T>(label, command, request);
    expect(response.status, label).toBe(200);
    expect(response.body.ok, label).toBe(true);
    return response.body.result as T;
  }

  async function loseAcknowledgement(
    request: InventoryExecuteRequest
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
    evidence.lostAcknowledgement = attempt;
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
        receipt = owner.operation({ ...scope, operationId: request.operationId });
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
      await success<NativeInventoryExecution>('receive 100 uL', 'inventory.execute', {
        ...scope,
        operationId: 'receive',
        expectedRevision: 0,
        commands: receive,
      })
    ).toMatchObject({ status: 'committed', revision: 1 });
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

    await server!.close();
    server = undefined;
    db.close();
    db = undefined;
    db = openFileTestDb(dbPath);
    await start();
    evidence.closedAndReopened = true;
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
