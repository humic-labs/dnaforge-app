// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import type { InventoryBenchlingCaptureSnapshot } from '../shared/inventory-client';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => '1.0.0', exit: vi.fn() },
}));
vi.mock('./config', () => ({ getApiUrl: () => 'http://synthetic-grants.invalid' }));

import { openFileTestDb, openReadonlyFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { createNativeAgentGrantAuthorizer } from './agent-grant-authority';

const bodyText =
  '{"id":"con_synthetic","name":"Synthetic tube","parentStorageId":null,"contents":[],"quantity":{"value":9007199254740993,"units":"uL"},"fields":{"precise":{"value":0.10000000000000001},"exponent":{"value":1e400},"negativeZero":{"value":-0}}}';
const capture = {
  format: 'dnaforge.benchling-physical-capture.v1',
  apiVersion: 'v2',
  namespace: 'synthetic:benchling:native-inspection',
  capturedAt: '2026-11-16T12:00:00.000Z',
  scope: {
    kind: 'selected-records',
    description: 'Synthetic V2 container shape with adversarial exact JSON numeric source evidence',
  },
  responses: [
    {
      id: 'container-response',
      request: { method: 'GET', path: '/api/v2/containers/con_synthetic', query: {} },
      bodyText,
    },
  ],
};
const sourceText = JSON.stringify(capture, null, 2) + '\r\n';

it('inspects exact foreign capture facts over native HTTP and file SQLite without writes or imported authority', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-benchling-inspection-')));
  const dbPath = join(root, 'inventory.sqlite');
  const projectPath = join(root, 'project');
  const otherPath = join(root, 'other-project');
  mkdirSync(projectPath);
  mkdirSync(otherPath);
  const scope = { project: 'capture-project', inventoryId: 'capture-inventory' };
  const profileKey = 'a'.repeat(64);
  const nativeAuthority = { ownerInstanceId: 'synthetic-capture-owner', token: 'synthetic-token' };
  let db: Database.Database = openFileTestDb(dbPath);
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  let revokedAt: string | null = null;
  const events: unknown[] = [];
  const trace: unknown[] = [];
  const evidence: Record<string, unknown> = {
    schema: 'dnaforge.inventory-benchling-native-inspection.v1',
    runtime:
      'Real loopback HTTP, registered project authority and file SQLite; synthetic capture with adversarial exact JSON numeric tokens, not Benchling-produced quantity evidence',
    status: 'running',
    sourceText,
    trace,
  };
  const evidenceRoot = process.env.INVENTORY_BENCHLING_EVIDENCE_DIR;
  const evidencePath = evidenceRoot
    ? (() => {
        mkdirSync(resolve(evidenceRoot), { recursive: true });
        return join(mkdtempSync(join(resolve(evidenceRoot), 'native-')), 'acceptance.json');
      })()
    : null;
  const snapshot = () => ({
    states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
    journal: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
    totalChanges: db.prepare('SELECT total_changes() AS count').get(),
    events: [...events],
  });
  const createOwner = () =>
    createNativeInventoryOwner({
      db: () => db,
      projectAuthority: createRegisteredProjectAuthority({
        db: () => db,
        managedRootDir: () => join(root, 'managed'),
      }),
      actor: () => 'native:synthetic-capture',
      profileKey,
      now: () => 1_700_000_000_000,
    });
  const call = async (
    label: string,
    request: Record<string, unknown> = { ...scope, sourceText },
    options: { roots?: string[]; capabilities?: string[]; token?: string } = {}
  ) => {
    const before = snapshot();
    const response = await fetch(`${server!.url}/internal/native-documents/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DNAForge-Native-Document-Authority': options.token ?? nativeAuthority.token,
      },
      body: JSON.stringify({
        ownerInstanceId: nativeAuthority.ownerInstanceId,
        projectScope: { kind: 'project-roots', roots: options.roots ?? [projectPath, otherPath] },
        command: 'inventory.inspect-benchling-capture',
        request,
        agent: {
          identityId: 'synthetic-read-only',
          capabilities: options.capabilities ?? ['read-workspace'],
        },
      }),
    });
    const body = await response.json();
    const after = snapshot();
    trace.push({ label, request, status: response.status, body, before, after });
    expect(after, label).toEqual(before);
    return { status: response.status, body };
  };
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'capture-project',?,'capture-project-id','writable',1),(42,'other-project',?,'other-project-id','writable',1)"
    ).run(projectPath, otherPath);
    rememberOriginalDefaultProject(db, 41);
    const owner = createOwner();
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
      authorizeInventoryAgent: createNativeAgentGrantAuthorizer(
        async () =>
          Response.json({
            ok: true,
            grants: [
              {
                id: 'synthetic-read-only',
                scopes: ['read-workspace'],
                revokedAt,
                expiresAt: null,
              },
            ],
            hasMore: false,
          }),
        'INVENTORY'
      ),
      getAuthority: () => nativeAuthority,
    });
    const inspected = await call('inspect absent inventory without creating it');
    expect(inspected.status).toBe(200);
    const result = inspected.body.result.result as InventoryBenchlingCaptureSnapshot;
    expect(inspected.body.result.kind).toBe('benchling-capture-inspection');
    expect(result.kind).toBe('inspected');
    expect(result.target).toEqual({
      projectId: 'capture-project-id',
      inventoryId: scope.inventoryId,
      present: false,
      revision: 0,
    });
    expect(result.principal).toEqual({ kind: 'agent', identityId: 'synthetic-read-only' });
    expect(result.asOf).toBe(1_700_000_000_000);
    expect(result.capture!.sourceText).toBe(sourceText);
    expect(result.capture!.responses[0].bodyText).toBe(bodyText);
    expect(result.capture!.responses[0].numberLexemes).toEqual(
      expect.arrayContaining([
        { pointer: '/quantity/value', lexeme: '9007199254740993' },
        { pointer: '/fields/precise/value', lexeme: '0.10000000000000001' },
        { pointer: '/fields/exponent/value', lexeme: '1e400' },
        { pointer: '/fields/negativeZero/value', lexeme: '-0' },
      ])
    );
    expect(snapshot().states).toEqual([]);
    expect(snapshot().journal).toEqual([]);
    for (const [label, text] of [
      ['empty source', ''],
      ['malformed source', '{'],
      ['unsupported capture version', JSON.stringify({ ...capture, apiVersion: 'v3' })],
      [
        'duplicate response body keys',
        JSON.stringify({
          ...capture,
          responses: [{ ...capture.responses[0], bodyText: '{"id":"a","id":"b"}' }],
        }),
      ],
    ]) {
      const refusal = await call(label, { ...scope, sourceText: text });
      expect(refusal.status).toBe(200);
      expect(refusal.body.result.result.kind).toBe('blocked');
    }
    expect(
      owner.execute({
        ...scope,
        operationId: 'prepare-existing-inventory',
        expectedRevision: 0,
        commands: [
          {
            kind: 'create-vessel',
            id: 'local-tube',
            name: 'Local tube',
            placement: { kind: 'unplaced' },
          },
        ],
      }).status
    ).toBe('committed');
    const existing = await call('inspect present inventory without importing physical facts');
    expect(existing.body.result.result.target).toMatchObject({ present: true, revision: 1 });
    const beforeLimit = snapshot();
    expect(
      owner.inspectBenchlingCapture({
        ...scope,
        sourceText: ' '.repeat(NATIVE_DOCUMENT_MAX_BODY_BYTES + 1),
      }).kind
    ).toBe('blocked');
    expect(snapshot()).toEqual(beforeLimit);
    evidence.oversizedSource = {
      byteLength: NATIVE_DOCUMENT_MAX_BODY_BYTES + 1,
      before: beforeLimit,
      after: snapshot(),
    };
    db.prepare("UPDATE workspaces SET access_mode='reference' WHERE id=41").run();
    expect((await call('inspect reference project')).body.result.result.kind).toBe('inspected');
    expect(
      (
        await call(
          'refuse excluded project roots',
          { ...scope, sourceText },
          { roots: [otherPath] }
        )
      ).body.result
    ).toMatchObject({ ok: false, code: 'PROJECT_ACCESS_DENIED', stateChanged: false });
    expect(
      (await call('refuse foreign inventory', { ...scope, project: 'other-project', sourceText }))
        .body.result
    ).toMatchObject({ ok: false, code: 'PROJECT_ACCESS_DENIED', stateChanged: false });
    revokedAt = '2026-11-16T12:00:00.000Z';
    expect((await call('refuse revoked current read grant')).body.result).toMatchObject({
      ok: false,
      code: 'INVENTORY_CAPABILITY_DENIED',
      stateChanged: false,
    });
    revokedAt = null;
    expect(
      (await call('refuse missing read capability', { ...scope, sourceText }, { capabilities: [] }))
        .body.result
    ).toMatchObject({ ok: false, code: 'INSUFFICIENT_SCOPE', stateChanged: false });
    expect(
      (
        await call('refuse authored native authority', {
          ...scope,
          sourceText,
          principal: { kind: 'local-profile', profileKey },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await call(
          'refuse missing transport authentication',
          { ...scope, sourceText },
          { token: 'invalid' }
        )
      ).status
    ).toBe(403);
    await server.close();
    server = undefined;
    db.close();
    db = openReadonlyFileTestDb(dbPath);
    const readOnlyOwner = createOwner();
    const reopenedBefore = snapshot();
    const reopened = readOnlyOwner.inspectBenchlingCapture({ ...scope, sourceText });
    expect(reopened.kind).toBe('inspected');
    expect(reopened.target).toMatchObject({ present: true, revision: 1 });
    expect(reopened.capture!.responses[0].bodyText).toBe(bodyText);
    expect(snapshot()).toEqual(reopenedBefore);
    expect(reopenedBefore.totalChanges).toEqual({ count: 0 });
    evidence.reopened = { before: reopenedBefore, result: reopened, after: snapshot() };
    evidence.status = 'passed';
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
