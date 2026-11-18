// @vitest-environment node
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  existsSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { it, expect, vi } from 'vitest';
import { canonicalProtocolJson, parseProtocolPackage } from '@waypoint/domain-services';
let db: Database.Database;
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => db }));
import { openFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { NativeDocumentWorkspaces } from './native-document-workspaces';
import { createNativeProtocolPackages } from './native-protocol-packages';
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import type { InventoryScientificTransferV2PreviewSnapshot } from '../shared/inventory-client';
import type {
  NativeProtocolCreationResult,
  NativeProtocolPackageSnapshot,
} from '../shared/protocol-packages';
it('recovers Protocol and Run publication with actual workspace authority and preserves later amendments', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-protocol-owner-'))),
    project = join(root, 'project'),
    dbPath = join(root, 'catalog.sqlite');
  mkdirSync(project);
  db = openFileTestDb(dbPath);
  ensureSchema(db, dbPath);
  db.prepare(
    "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Protocol project',?,'protocol-project','writable',1)"
  ).run(project);
  rememberOriginalDefaultProject(db, 41);
  const projectAuthority = createRegisteredProjectAuthority({
      db: () => db,
      managedRootDir: () => join(root, 'managed'),
    }),
    workspaces = new NativeDocumentWorkspaces({ authority: projectAuthority });
  let interrupt = false;
  const notifications: Array<{
    projectId: string;
    entityId: string;
    workspaceRoot: string;
    path: string;
    operation: 'create' | 'save';
  }> = [];
  const make = () =>
    createNativeProtocolPackages({
      db: () => db,
      projectAuthority,
      workspaces,
      profileDirectory: () => join(root, 'profile'),
      actor: () => 'native:protocol-proof',
      onCommitted: (change: (typeof notifications)[number]) => notifications.push(change),
      afterFilePublished: () => {
        if (interrupt) {
          interrupt = false;
          throw Error('Synthetic file/catalog interruption');
        }
      },
    });
  let owner = make();
  const evidence: unknown[] = [];
  const ready = (value: NativeProtocolCreationResult): NativeProtocolPackageSnapshot => {
    evidence.push(value);
    expect(value.kind, JSON.stringify(value)).toBe('ready');
    if (value.kind !== 'ready') throw Error(JSON.stringify(value));
    return value.package;
  };
  try {
    const create = {
      project: 'protocol-project',
      requestId: 'create-protocol-once',
      title: 'Observed protocol',
    };
    interrupt = true;
    const pending = await owner.createProtocol(create);
    evidence.push(pending);
    expect(pending.kind).toBe('pending');
    if (pending.kind !== 'pending') throw Error(JSON.stringify(pending));
    expect(existsSync(pending.path)).toBe(true);
    expect(
      db.prepare("SELECT count(*) AS count FROM catalog_entities WHERE type='protocol'").get()
    ).toEqual({ count: 0 });
    expect(notifications).toEqual([]);
    owner = make();
    let protocol = ready(
      await owner.recoverCreation({ project: create.project, requestId: create.requestId })
    );
    const initialProtocolText = protocol.originalText,
      fileUuid = protocol.fileObjectUuid,
      protocolId = protocol.entityId;
    expect(notifications).toEqual([
      {
        projectId: create.project,
        entityId: protocolId,
        workspaceRoot: project,
        path: protocol.path,
        operation: 'create',
      },
    ]);
    expect(ready(await owner.createProtocol(create)).entityId).toBe(protocolId);
    expect(notifications).toHaveLength(1);
    const raw = parseProtocolPackage(protocol.originalText).raw;
    (raw.steps as Array<Record<string, unknown>>)[0].title = 'Actual saved execution step';
    protocol = ready(
      await owner.savePackage({
        project: create.project,
        requestId: 'save-step',
        entityId: protocolId,
        expectedSourceSha256: protocol.sourceSha256,
        originalText: canonicalProtocolJson(raw) + '\n',
      })
    );
    expect(protocol.fileObjectUuid).toBe(fileUuid);
    expect(notifications.at(-1)).toMatchObject({ entityId: protocolId, operation: 'save' });
    expect(ready(await owner.createProtocol(create)).originalText).toBe(initialProtocolText);
    expect(readFileSync(protocol.path, 'utf8')).toBe(protocol.originalText);
    const start = {
      project: create.project,
      requestId: 'start-run-once',
      protocolId,
      expectedSourceSha256: protocol.sourceSha256,
      title: 'Observed run',
    };
    interrupt = true;
    const runPending = await owner.startRun(start);
    evidence.push(runPending);
    expect(runPending.kind).toBe('pending');
    const oldProtocolText = protocol.originalText,
      changed = parseProtocolPackage(oldProtocolText).raw;
    (changed.steps as Array<Record<string, unknown>>)[0].title = 'Later protocol edit';
    protocol = ready(
      await owner.savePackage({
        project: create.project,
        requestId: 'save-later-step',
        entityId: protocolId,
        expectedSourceSha256: protocol.sourceSha256,
        originalText: canonicalProtocolJson(changed) + '\n',
      })
    );
    owner = make();
    let run = ready(
      await owner.recoverCreation({ project: create.project, requestId: start.requestId })
    );
    const initialRunText = run.originalText,
      runRaw = parseProtocolPackage(run.originalText).raw,
      frozen = runRaw.frozenProtocol as Record<string, unknown>;
    expect((frozen.source as Record<string, unknown>).originalText).toBe(oldProtocolText);
    runRaw.amendments = [
      {
        id: 'observed-note',
        sequence: 1,
        at: '2026-11-17T12:00:00.000Z',
        actor: null,
        reason: 'Recorded observation',
        path: '/measurements/observation',
        value: { type: 'text', value: 'Observed manually' },
      },
    ];
    run = ready(
      await owner.savePackage({
        project: create.project,
        requestId: 'save-run-amendment',
        entityId: run.entityId,
        expectedSourceSha256: run.sourceSha256,
        originalText: canonicalProtocolJson(runRaw) + '\n',
      })
    );
    expect(ready(await owner.startRun(start)).originalText).toBe(initialRunText);
    expect(readFileSync(run.path, 'utf8')).toBe(run.originalText);
    renameSync(run.path, run.path + '.retained');
    const missingRetry = await owner.startRun(start);
    expect(ready(missingRetry).originalText).toBe(initialRunText);
    expect(missingRetry).toMatchObject({
      kind: 'ready',
      currentAvailability: { kind: 'unavailable' },
    });
    expect(existsSync(run.path)).toBe(false);
    renameSync(run.path + '.retained', run.path);
    expect(
      db.prepare("SELECT count(*) AS count FROM catalog_entities WHERE type='protocol_run'").get()
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT count(*) AS count FROM catalog_entity_events WHERE event_type='created'")
        .get()
    ).toEqual({ count: 2 });
    const altered = parseProtocolPackage(run.originalText).raw;
    altered.startedAt = '2026-11-18T12:00:00.000Z';
    await expect(
      owner.savePackage({
        project: create.project,
        requestId: 'forbidden-start-edit',
        entityId: run.entityId,
        expectedSourceSha256: run.sourceSha256,
        originalText: canonicalProtocolJson(altered),
      })
    ).rejects.toThrow('PROTOCOL_IMMUTABLE_FIELD_CHANGED');
    await expect(owner.startRun({ ...start, title: 'Changed intent' })).rejects.toThrow(
      'PROTOCOL_REQUEST_CONFLICT'
    );
    await expect(
      owner.withSavedRunSource(create.project, run.entityId, (capture) => {
        db.transaction(() => capture.assertCurrent())();
      })
    ).resolves.toBeUndefined();
    db.prepare('UPDATE workspaces SET archived_at=1 WHERE id=41').run();
    await expect(
      owner.readPackage({ project: create.project, entityId: run.entityId })
    ).rejects.toThrow('PROJECT_ACCESS_DENIED');
    db.prepare('UPDATE workspaces SET archived_at=NULL WHERE id=41').run();
    expect(
      (await owner.readPackage({ project: create.project, entityId: run.entityId })).fileObjectUuid
    ).toBe(run.fileObjectUuid);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('science-schema','entity','science','Science','{}','science-schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('science-schema-v1','science-schema',1,'{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('science-material','record','science-schema','science-schema-v1','Synthetic material','{}',41,'registered',1,1)"
    ).run();
    const inventory = createNativeInventoryOwner({
      db: () => db,
      projectAuthority,
      protocolSources: owner,
      profileKey: 'a'.repeat(64),
      actor: () => 'native:protocol-proof',
    });
    inventory.initialize();
    const authority = {
        ownerInstanceId: 'protocol-proof-owner',
        token: 'synthetic-protocol-proof-token',
      },
      agent = {
        identityId: 'protocol-proof-agent',
        capabilities: ['read-workspace', 'write-workspace', 'create-entity'],
      },
      scope = { project: create.project, inventoryId: 'protocol-inventory' },
      projectScope = { kind: 'project-roots' as const, roots: [project] };
    let grants = 0,
      tamperOnGrant = Infinity;
    const server = await startNativeDocumentCommandServer({
      owner: {
        inspect: async () => {
          throw Error('Unrelated annotation');
        },
        apply: async () => {
          throw Error('Unrelated annotation');
        },
        close: async () => {},
      },
      protocols: owner,
      inventory,
      projectAuthority,
      getAuthority: () => authority,
      authorizeProtocolsAgent: async () => {},
      authorizeInventoryAgent: async () => {
        if (++grants === tamperOnGrant)
          writeFileSync(run.path, run.originalText.replace('Observed run', 'Late changed Run'));
      },
    });
    const call = async (command: string, request: unknown) => {
      const response = await fetch(server.url + '/internal/native-documents/call', {
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
      evidence.push({ command, request, status: response.status, body });
      return body;
    };
    const rawInventory = () =>
      JSON.stringify({
        state: db.prepare('SELECT * FROM inventory_state').all(),
        history: db.prepare('SELECT * FROM inventory_journal').all(),
      });
    try {
      const generic = await call('protocols.execute', {
        operation: {
          kind: 'create-protocol',
          project: create.project,
          requestId: 'generic-http-protocol',
          title: 'HTTP protocol',
        },
      });
      expect(generic.ok).toBe(true);
      expect(generic.result?.kind).toBe('ready');
      const seed = await call('inventory.execute', {
        ...scope,
        operationId: 'seed-physical',
        expectedRevision: 0,
        commands: [
          {
            kind: 'create-vessel',
            id: 'source-vessel',
            name: 'Source vial',
            placement: { kind: 'unplaced' },
          },
          {
            kind: 'receive-stock',
            id: 'source-stock',
            vesselId: 'source-vessel',
            materialId: 'science-material',
            quantity: { kind: 'known', value: '100', unit: 'uL' },
            quality: 'usable',
          },
          {
            kind: 'create-layout-storage',
            id: 'plate',
            name: 'Permanent plate',
            layout: { kind: 'fixed-well', rows: 1, columns: 2 },
            placement: { kind: 'root' },
          },
        ],
      });
      expect(seed.result?.execution).toMatchObject({ status: 'committed', revision: 1 });
      const contexts = await call('inventory.scientific-contexts-v2', {
        ...scope,
        kind: 'protocol-run',
      });
      expect((contexts.result?.contexts as { contexts: unknown[] }).contexts).toHaveLength(1);
      const choices = {
        identity: { namespace: 'manual-run-observation', workId: 'run-work-1' },
        context: {
          kind: 'protocol-run' as const,
          entityId: run.entityId,
          sourceSha256: run.sourceSha256,
        },
        sourceStockId: 'source-stock',
        destinationVesselId: 'well:plate#A1',
        quantity: { value: '10', unit: 'uL' as const },
        reason: 'Operator reports completed manual transfer for saved Run',
      };
      const before = rawInventory(),
        previewBody = await call('inventory.preview-scientific-transfer-v2', {
          ...scope,
          expectedRevision: 1,
          choices,
        }),
        preview = previewBody.result?.preview as InventoryScientificTransferV2PreviewSnapshot;
      expect(preview.kind).toBe('ready');
      expect(rawInventory()).toBe(before);
      if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
      const request = {
        ...scope,
        kind: 'record-scientific-transfer-v2' as const,
        operationId: 'run-lost-ack',
        expectedRevision: 1,
        choices,
        expectedPlanDigest: preview.planDigest,
      };
      tamperOnGrant = grants + 2;
      const failed = await call('inventory.apply-scientific-transfer-v2', request);
      expect(failed.result).toMatchObject({
        ok: false,
        code: 'INVENTORY_SCIENTIFIC_SOURCE_CHANGED',
        stateChanged: false,
      });
      expect(rawInventory()).toBe(before);
      writeFileSync(run.path, run.originalText);
      tamperOnGrant = Infinity;
      const address = new URL(server.url),
        socket = createConnection({ host: address.hostname, port: Number(address.port) });
      socket.pause();
      socket.on('error', () => {});
      try {
        await new Promise<void>((accept, reject) => {
          socket.once('connect', accept);
          socket.once('error', reject);
        });
        const body = JSON.stringify({
          ownerInstanceId: authority.ownerInstanceId,
          projectScope,
          command: 'inventory.apply-scientific-transfer-v2',
          request,
          agent,
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
        let receipt = null;
        for (let attempt = 0; attempt < 300 && !receipt; attempt++) {
          receipt = inventory.operation({ ...scope, operationId: request.operationId });
          if (!receipt) await new Promise((accept) => setTimeout(accept, 5));
        }
        expect(receipt).toMatchObject({
          status: 'committed',
          revision: 2,
          context: {
            version: 7,
            scientificSource: {
              schema: 'dnaforge.protocol-run-saved-source.v1',
              originalText: run.originalText,
            },
          },
        });
        expect(socket.bytesRead).toBe(0);
        evidence.push({ lostAcknowledgement: { responseBytesRead: socket.bytesRead, receipt } });
      } finally {
        socket.destroy();
      }
      const state = inventory.inspect(scope)!;
      expect(state.stocks['source-stock'].quantity).toEqual({
        kind: 'known',
        value: '90',
        unit: 'uL',
      });
      expect(Object.values(state.scientificWorks)[0].context.kind).toBe('protocol-run');
      const recorded = rawInventory();
      expect(
        (await call('inventory.apply-scientific-transfer-v2', request)).result?.execution
      ).toMatchObject({ status: 'committed', revision: 2 });
      expect(
        (
          await call('inventory.apply-scientific-transfer-v2', {
            ...request,
            operationId: 'fresh-work-duplicate',
            expectedRevision: 2,
          })
        ).result?.execution
      ).toMatchObject({ status: 'rejected', code: 'INVENTORY_SCIENTIFIC_NO_CHANGES' });
      expect(rawInventory()).toBe(recorded);
      expect(inventory.replay(scope)?.state).toEqual(state);
      const source = inventory.scientificSource({
        ...scope,
        workId: Object.keys(state.scientificWorks)[0],
      });
      expect(source).toMatchObject({
        kind: 'available',
        source: { schema: 'dnaforge.protocol-run-saved-source.v1', originalText: run.originalText },
      });
    } finally {
      await server.close();
    }
    if (process.env.PROTOCOL_NATIVE_EVIDENCE_DIR) {
      mkdirSync(process.env.PROTOCOL_NATIVE_EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        join(process.env.PROTOCOL_NATIVE_EVIDENCE_DIR, 'acceptance.json'),
        JSON.stringify({ status: 'passed', root, protocol, run, evidence }, null, 2)
      );
    }
  } catch (error) {
    if (process.env.PROTOCOL_NATIVE_EVIDENCE_DIR) {
      mkdirSync(process.env.PROTOCOL_NATIVE_EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        join(process.env.PROTOCOL_NATIVE_EVIDENCE_DIR, 'failure.json'),
        JSON.stringify({ root, error: String(error), evidence }, null, 2)
      );
    }
    throw error;
  } finally {
    db.close();
  }
});
