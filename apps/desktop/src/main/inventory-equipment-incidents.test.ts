// @vitest-environment node
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  parseInventoryState,
  type InventoryEquipmentIncidentActionChoices,
} from '@waypoint/domain-services';
import * as wire from '../shared/inventory-equipment-incidents';
import type { NativeInventoryReceipt } from '../shared/inventory-command';
let db: Database.Database;
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => db }));
import { createFileTestDb, openFileTestDb, openReadonlyFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import {
  createRegisteredProjectAuthority,
  withAgentProjectScope,
} from './registered-project-authority';
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { parseNativeInventoryJournalEntry } from './inventory-journal';
import {
  replayNativeInventoryJournal,
  nativeInventoryArchiveRuntime,
  applyNativeInventoryAdoption,
} from './inventory-archive';
import { parseInventoryArchive } from '@waypoint/domain-services';
it('records incident actions once through native filesystem SQLite HTTP and keeps review separate from equipment resolution', async () => {
  const file = createFileTestDb('equipment-incidents');
  db = file.db;
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  try {
    ensureSchema(db, file.dbPath);
    const path = join(realpathSync(file.tmpDir), 'project');
    mkdirSync(path);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(61,'Incident project',?,'incident-project','writable',1)"
    ).run(path);
    rememberOriginalDefaultProject(db, 61);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema','entity','science','Science','{}','schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-v1','schema',1,'{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('material','record','schema','schema-v1','Material','{}',61,'registered',1,1)"
    ).run();
    const scope = { project: 'incident-project', inventoryId: 'inventory' };
    const projectAuthority = createRegisteredProjectAuthority({
      db: () => db,
      managedRootDir: () => join(file.tmpDir, 'managed'),
    });
    let now = 1000;
    const makeOwner = () =>
      createNativeInventoryOwner({
        db: () => db,
        projectAuthority,
        profileKey: 'a'.repeat(64),
        actor: () => 'native:incident',
        now: () => now,
      });
    let owner = makeOwner();
    owner.initialize();
    const events: string[] = [];
    owner.subscribe((e) => events.push(e.operationId));
    expect(
      owner.execute({
        ...scope,
        operationId: 'physical',
        expectedRevision: 0,
        commands: [
          {
            kind: 'create-storage',
            id: 'freezer',
            name: 'Untyped freezer',
            slots: ['box'],
            placement: { kind: 'root' },
          },
          {
            kind: 'create-storage',
            id: 'rescue',
            name: 'Rescue',
            slots: ['box'],
            placement: { kind: 'root' },
          },
          {
            kind: 'create-storage',
            id: 'box',
            name: 'Box',
            slots: ['known', 'unknown', 'possible'],
            placement: { kind: 'located', storageId: 'freezer', slotId: 'box' },
          },
          ...['known', 'unknown', 'possible'].map((id) => ({
            kind: 'create-vessel',
            id,
            name: id,
            placement: { kind: 'located', storageId: 'box', slotId: id },
          })),
          {
            kind: 'receive-stock',
            id: 'stock',
            vesselId: 'known',
            materialId: 'material',
            quantity: { kind: 'known', value: '8', unit: 'uL' },
            quality: 'usable',
          },
          {
            kind: 'record-vessel-contents',
            vesselId: 'unknown',
            knowledge: 'unidentified',
            reason: 'Confirmed present',
          },
        ],
      }).status
    ).toBe('committed');
    const authority = { ownerInstanceId: 'incident-owner', token: 'incident-token' };
    let allow = true;
    server = await startNativeDocumentCommandServer({
      owner: { inspect: vi.fn(), apply: vi.fn(), close: vi.fn() },
      inventory: owner,
      projectAuthority,
      getAuthority: () => authority,
      authorizeInventoryAgent: async (agent, required) => {
        if (!allow || required.some((c) => !agent.capabilities.includes(c)))
          throw Error('INVENTORY_CAPABILITY_DENIED: Revoked');
      },
    });
    const call = async (command: string, request: unknown, write = false) => {
      const response = await fetch(server!.url + '/internal/native-documents/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DNAForge-Native-Document-Authority': authority.token,
        },
        body: JSON.stringify({
          ownerInstanceId: authority.ownerInstanceId,
          projectScope: { kind: 'project-roots', roots: [path] },
          command: 'inventory.' + command,
          request,
          agent: {
            identityId: 'agent',
            capabilities: write ? ['read-workspace', 'write-workspace'] : ['read-workspace'],
          },
        }),
      });
      return { status: response.status, body: await response.json() };
    };
    const choices: InventoryEquipmentIncidentActionChoices = {
      identity: { namespace: 'manual', actionId: 'outage' },
      action: {
        kind: 'report',
        equipment: { storageId: 'freezer', configurationRevision: 0 },
        noticedAt: 900,
        description: 'Operator reported outage',
        reason: 'Check affected contents',
      },
    };
    const before = owner.inspect(scope),
      changes = db.prepare('SELECT total_changes() AS n').get();
    const previewResponse = await call('preview-equipment-incident-action', {
      ...scope,
      expectedRevision: 1,
      choices,
    });
    const preview = wire.inventoryEquipmentIncidentActionPreviewSnapshotSchema.parse(
      previewResponse.body.result.preview
    );
    expect(preview.kind, JSON.stringify(preview)).toBe('ready');
    if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
    expect(preview.record.kind).toBe('report');
    expect(preview.commands).toEqual([]);
    expect(owner.inspect(scope)).toEqual(before);
    expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    now = 1100;
    const request = {
      ...scope,
      kind: 'record-equipment-incident-action' as const,
      operationId: 'open-once',
      expectedRevision: 1,
      choices,
      expectedPlanDigest: preview.planDigest,
    };
    expect((await call('apply-equipment-incident-action', request)).body.result).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_SCOPE',
      stateChanged: false,
    });
    const address = new URL(server.url),
      socket = createConnection({ host: address.hostname, port: Number(address.port) });
    socket.pause();
    let receipt: NativeInventoryReceipt | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const body = JSON.stringify({
        ownerInstanceId: authority.ownerInstanceId,
        projectScope: { kind: 'project-roots', roots: [path] },
        command: 'inventory.apply-equipment-incident-action',
        request,
        agent: { identityId: 'agent', capabilities: ['read-workspace', 'write-workspace'] },
      });
      await new Promise<void>((resolve, reject) =>
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
          (e) => (e ? reject(e) : resolve())
        )
      );
      for (let i = 0; i < 100 && !receipt; i++) {
        receipt = owner.operation({ ...scope, operationId: request.operationId });
        if (!receipt) await new Promise((r) => setTimeout(r, 5));
      }
      expect(socket.bytesRead).toBe(0);
    } finally {
      socket.destroy();
    }
    expect(receipt?.context?.version).toBe(13);
    expect(owner.applyEquipmentIncidentAction(request)).toEqual(receipt);
    expect(events).toEqual(['physical', 'open-once']);
    const duplicate = owner.applyEquipmentIncidentAction({
      ...request,
      operationId: 'fresh-duplicate',
    });
    expect(duplicate).toMatchObject({
      status: 'rejected',
      operationId: 'fresh-duplicate',
      code: 'INVENTORY_EQUIPMENT_INCIDENT_NO_CHANGES',
    });
    expect(owner.operation({ ...scope, operationId: 'fresh-duplicate' })).toBeNull();
    const pin = {
      incidentId: preview.record.incident.incidentId,
      intentSha256: preview.record.incident.intentSha256,
    };
    const detail = wire.inventoryEquipmentIncidentReadSchema.parse(
      owner.equipmentIncident({ ...scope, ...pin })
    );
    expect(detail.kind).toBe('available');
    if (detail.kind !== 'available') throw Error('Missing report');
    expect(detail.incident.actionProof.choices).toEqual(choices);
    expect(detail.current.lifecycle).toBe('open');
    const initial = wire.inventoryEquipmentIncidentSubjectsReadSchema.parse(
      owner.equipmentIncidentSubjects({ ...scope, ...pin, view: 'initial', limit: 1 })
    );
    expect(initial.kind).toBe('ready');
    if (initial.kind !== 'ready' || !initial.nextCursor) throw Error('Expected bounded cohort');
    expect(
      owner.equipmentIncidentSubjects({
        ...scope,
        ...pin,
        view: 'review',
        cursor: initial.nextCursor,
      })
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_QUERY_CURSOR_INVALID' });
    const blocked = owner.execute({
      ...scope,
      operationId: 'blocked-withdraw',
      expectedRevision: 2,
      commands: [
        {
          kind: 'consume',
          stockId: 'stock',
          quantity: { value: '1', unit: 'uL' },
          reason: 'Attempted withdrawal',
        },
      ],
    });
    expect(blocked.status).toBe('rejected');
    expect(owner.inspect(scope)?.revision).toBe(2);
    const blockedBefore = owner.inspect(scope);
    expect(
      owner.execute({
        ...scope,
        operationId: 'blocked-inbound',
        expectedRevision: 2,
        commands: [
          {
            kind: 'receive-stock',
            id: 'incoming',
            vesselId: 'possible',
            materialId: 'material',
            quantity: { kind: 'known', value: '1', unit: 'uL' },
            quality: 'usable',
          },
        ],
      }).status
    ).toBe('rejected');
    expect(owner.inspect(scope)).toEqual(blockedBefore);
    expect(
      owner.execute({
        ...scope,
        operationId: 'identify-existing',
        expectedRevision: 2,
        commands: [
          {
            kind: 'identify-vessel-stock',
            id: 'identified',
            vesselId: 'unknown',
            materialId: 'material',
            quantity: { kind: 'known', value: '1', unit: 'uL' },
            quality: 'usable',
            reason: 'Identified initial confirmed episode',
          },
        ],
      }).status
    ).toBe('committed');
    expect(owner.inspect(scope)!.stocks.identified.incidentReviewRootIds).toHaveLength(1);
    expect(
      Object.values(owner.inspect(scope)!.equipmentIncidentFacts).filter(
        (f) => f.kind === 'contents-identified'
      )
    ).toHaveLength(1);
    const accept = (id: string, action: InventoryEquipmentIncidentActionChoices['action']) => {
      const choices = { identity: { namespace: 'manual', actionId: id }, action };
      const expectedRevision = owner.inspect(scope)!.revision;
      const preview = owner.previewEquipmentIncidentAction({ ...scope, expectedRevision, choices });
      expect(preview.kind, JSON.stringify(preview)).toBe('ready');
      if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
      const request = {
        ...scope,
        kind: 'record-equipment-incident-action' as const,
        operationId: id,
        expectedRevision,
        choices,
        expectedPlanDigest: preview.planDigest,
      };
      const receipt = owner.applyEquipmentIncidentAction(request);
      expect(receipt.status, JSON.stringify(receipt)).toBe('committed');
      return { request, preview, receipt };
    };
    now = 2000;
    const measured = accept('manual-temperature', {
      kind: 'manual-temperature',
      incident: pin,
      reading: {
        kind: 'measured',
        temperature: { value: '-70', unit: 'C' },
        observedAt: 1900,
        pointLabel: 'Chamber',
      },
      supersedes: null,
      reason: 'Manual reported reading',
    });
    const factPin = {
      factId: measured.preview.actionId!,
      intentSha256: measured.preview.intentSha256!,
    };
    const fact = wire.inventoryEquipmentIncidentFactsReadSchema.parse(
      owner.equipmentIncidentFacts({
        ...scope,
        ...pin,
        query: { kind: 'fact', fact: factPin, freshnessMaxAgeMs: 200 },
      })
    );
    expect(fact.kind).toBe('available');
    if (fact.kind === 'available') {
      expect(fact.manual?.freshness.state).toBe('fresh');
      expect(fact.nextBoundaryAt).toBe(2101);
    }
    expect(
      owner.equipmentIncidentSubjects({
        ...scope,
        ...pin,
        view: 'initial',
        cursor: initial.nextCursor,
      })
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_QUERY_STALE' });
    accept('rescue', {
      kind: 'completed-relocation',
      incident: pin,
      moves: [
        {
          item: { kind: 'storage', id: 'box' },
          destination: { kind: 'located', storageId: 'rescue', slotId: 'box' },
        },
      ],
      corrects: null,
      reason: 'Reported completed whole box rescue',
    });
    expect(owner.inspect(scope)?.storage.box.placement).toEqual({
      kind: 'located',
      storageId: 'rescue',
      slotId: 'box',
    });
    const reviews = owner.equipmentIncidentSubjects({ ...scope, ...pin, view: 'review' });
    if (reviews.kind !== 'ready') throw Error(JSON.stringify(reviews));
    const stockRoot = reviews.subjects.find(
      (row) => row.kind === 'root' && row.root.originSubject.kind === 'stock'
    );
    if (!stockRoot || stockRoot.kind !== 'root') throw Error('Missing stock root');
    accept('review-remove', {
      kind: 'impact-review',
      incident: pin,
      subjects: [
        {
          root: { rootId: stockRoot.root.id, intentSha256: stockRoot.root.intentSha256 },
          supersedes: null,
        },
      ],
      disposition: 'remove-incident-restriction',
      basis: 'Operator disposition for this root only',
      reason: 'Review',
    });
    accept('resolve', {
      kind: 'resolve',
      incident: pin,
      resolution: 'reported-resolved',
      reason: 'Operator reported equipment resolved',
    });
    const resolved = owner.equipmentIncident({ ...scope, ...pin });
    expect(resolved.kind === 'available' && resolved.current.lifecycle).toBe('resolved');
    expect(owner.inspect(scope)!.stocks.stock.quality).toBe('usable');
    const exported = owner.exportSnapshot({ ...scope, format: 'native-v1' });
    const archive = parseInventoryArchive(exported.sourceText, nativeInventoryArchiveRuntime);
    expect(archive.state).toEqual(owner.inspect(scope));
    const rows = db.prepare('SELECT * FROM inventory_journal ORDER BY revision').all() as {
      inventory_id: string;
      operation_id: string;
      revision: number;
      request_json: string;
      receipt_json: string;
    }[];
    const entries = rows.map((row) =>
      parseNativeInventoryJournalEntry(row, scope.project, {
        request: JSON.parse(row.request_json),
        receipt: JSON.parse(row.receipt_json),
      })
    );
    expect(replayNativeInventoryJournal(entries)).toEqual(owner.inspect(scope));
    expect(() =>
      replayNativeInventoryJournal(entries, 0, { allowEquipmentIncidents: false })
    ).toThrow(/V13|incident/);
    expect(() =>
      parseInventoryArchive(exported.sourceText, nativeInventoryArchiveRuntime, {
        allowEquipmentIncidents: false,
      })
    ).toThrow();
    const copyScope = { ...scope, inventoryId: 'copy' };
    const importPreview = owner.previewImport({
      ...copyScope,
      sourceText: exported.sourceText,
      options: { bindings: [{ sourceMaterialId: 'material', destinationMaterialId: 'material' }] },
    });
    expect(importPreview.kind, JSON.stringify(importPreview)).toBe('ready');
    if (importPreview.kind !== 'ready') throw Error(JSON.stringify(importPreview));
    const importRequest = {
      ...copyScope,
      kind: 'adopt-archive' as const,
      operationId: 'adopt',
      expectedRevision: 0,
      sourceText: exported.sourceText,
      options: importPreview.options,
      expectedPlanDigest: importPreview.planDigest,
    };
    expect(() =>
      applyNativeInventoryAdoption(
        null,
        importRequest,
        {
          at: now,
          principal: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
          authority: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
        },
        0,
        { receiptContextVersion: 12 }
      )
    ).toThrow();
    expect(owner.applyImport(importRequest).status).toBe('committed');
    const copyReviews = owner.equipmentIncidentSubjects({ ...copyScope, ...pin, view: 'review' });
    if (copyReviews.kind !== 'ready') throw Error(JSON.stringify(copyReviews));
    expect(
      copyReviews.subjects.some(
        (row) => row.kind === 'root' && row.review.restriction === 'imported-removal-unconfirmed'
      )
    ).toBe(true);
    allow = false;
    expect((await call('equipment-incident', { ...scope, ...pin })).body.result).toMatchObject({
      ok: false,
    });
    await server.close();
    server = undefined;
    const state = owner.inspect(scope);
    const reopened = openFileTestDb(file.dbPath);
    db = reopened;
    try {
      owner = makeOwner();
      expect(owner.inspect(scope)).toEqual(state);
      expect(owner.applyEquipmentIncidentAction(request)).toEqual(receipt);
    } finally {
      reopened.close();
      db = file.db;
    }
  } finally {
    await server?.close();
    file.cleanup();
  }
});

it.runIf(Boolean(process.env.INVENTORY_EQUIPMENT_INCIDENT_ACTUAL_DB))(
  'reads and replays historical native journals without changing raw bytes or executing writes',
  async () =>
    withAgentProjectScope({ kind: 'app-following' }, async () => {
      const path = process.env.INVENTORY_EQUIPMENT_INCIDENT_ACTUAL_DB!,
        hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
      const beforeFile = hash(readFileSync(path));
      db = openReadonlyFileTestDb(path);
      try {
        db.pragma('query_only=ON');
        expect(db.readonly).toBe(true);
        const raw = () =>
            JSON.stringify({
              states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
              history: db
                .prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision')
                .all(),
            }),
          before = raw(),
          changes = db.prepare('SELECT total_changes() AS n').get();
        let count = 0,
          admittedRows = 0,
          unavailableRows = 0;
        for (const row of db
          .prepare('SELECT * FROM inventory_state ORDER BY inventory_id')
          .all() as {
          inventory_id: string;
          project_id: string;
          state_json: string;
        }[]) {
          const project = db
            .prepare('SELECT path FROM workspaces WHERE repo_uuid=?')
            .get(row.project_id) as { path: string };
          const projectAuthority = createRegisteredProjectAuthority({
            db: () => db,
            managedRootDir: () => dirname(dirname(project.path)),
          });
          const admitted = projectAuthority.resolve(row.project_id) !== null;
          const owner = createNativeInventoryOwner({
              db: () => db,
              projectAuthority,
              profileKey: 'a'.repeat(64),
              actor: () => 'native:historical-replay',
            }),
            scope = { project: row.project_id, inventoryId: row.inventory_id };
          const state = parseInventoryState(JSON.parse(row.state_json)),
            history = (
              db
                .prepare('SELECT * FROM inventory_journal WHERE inventory_id=? ORDER BY revision')
                .all(row.inventory_id) as {
                inventory_id: string;
                operation_id: string;
                revision: number;
                request_json: string;
                receipt_json: string;
              }[]
            ).map((entry) =>
              parseNativeInventoryJournalEntry(entry, row.project_id, {
                request: JSON.parse(entry.request_json),
                receipt: JSON.parse(entry.receipt_json),
              })
            );
          expect(replayNativeInventoryJournal(history)).toEqual(state);
          expect(Object.keys(state.equipmentIncidents)).toHaveLength(0);
          count += history.length;
          if (admitted) {
            expect(owner.equipmentIncidents(scope)).toMatchObject({
              kind: 'ready',
              incidents: [],
              filters: { equipmentId: null, status: null },
            });
            for (const entry of history) {
              expect(owner.operation({ ...scope, operationId: entry.request.operationId })).toEqual(
                entry.receipt
              );
            }
            admittedRows += history.length;
          } else {
            expect(() => owner.equipmentIncidents(scope)).toThrow('PROJECT_ACCESS_DENIED');
            unavailableRows += history.length;
          }
        }
        expect(count).toBe(Number(process.env.INVENTORY_EQUIPMENT_INCIDENT_ACTUAL_ROWS));
        expect(admittedRows).toBe(
          Number(process.env.INVENTORY_EQUIPMENT_INCIDENT_ACTUAL_ADMITTED_ROWS)
        );
        expect(admittedRows + unavailableRows).toBe(count);
        console.log(
          JSON.stringify({
            replayedRows: count,
            currentOwnerLookups: admittedRows,
            unavailableProjectHistory: unavailableRows,
            totalChanges: db.prepare('SELECT total_changes() AS n').get(),
          })
        );
        expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
        expect(raw()).toBe(before);
      } finally {
        db.close();
        expect(hash(readFileSync(path))).toBe(beforeFile);
      }
    })
);
