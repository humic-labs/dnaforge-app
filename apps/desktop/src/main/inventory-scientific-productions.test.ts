// @vitest-environment node
import { mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { defineBlob, parseOperationId } from '@waypoint/workspace-revisions';
import { compileScientificWorkspace } from '@waypoint/scientific-objects';
import { serializeGenBank } from '@waypoint/sequence-utils';
import {
  verifyAcceptedDnaProductionWitness,
  scientificNativeCodecs,
} from '@waypoint/scientific-artifacts';
import {
  inventoryScientificProductionChoices,
  parseInventoryState,
} from '@waypoint/domain-services';
import * as wire from '../shared/inventory-scientific-productions';
let db: Database.Database;
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  ipcMain: { handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => db }));
vi.mock('./scientific-migration-recovery', () => ({
  ensureScientificEnrollmentCheckpoint: vi.fn(),
}));
import { createFileTestDb, openFileTestDb, openReadonlyFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import {
  createRegisteredProjectAuthority,
  withAgentProjectScope,
} from './registered-project-authority';
import { NativeDocumentWorkspaces } from './native-document-workspaces';
import {
  createNativeProtocolPackages,
  type ProtocolSavedSourceCapture,
} from './native-protocol-packages';
import { buildSequencePackageDocument } from '../db/sequence-package';
import { ScientificObjectStore } from './scientific-object-store';
import { submitScientificWorkspace } from './scientific-workspace-service';
import { createNativeInventoryOwner } from './inventory-owner';
import type { NativeInventoryReceipt } from '../shared/inventory-command';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { parseNativeInventoryJournalEntry } from './inventory-journal';
import {
  replayNativeInventoryJournal,
  nativeInventoryArchiveRuntime,
  applyNativeInventoryAdoption,
} from './inventory-archive';
import { parseInventoryArchive } from '@waypoint/domain-services';

it('records one atomic manual production with retained native DNA proof, semantic-time stability and exact duplicate recovery', async () => {
  const file = createFileTestDb('inventory-production');
  db = file.db;
  let now = 1000;
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  try {
    ensureSchema(db, file.dbPath);
    const path = join(realpathSync(file.tmpDir), 'project');
    mkdirSync(path);
    const scope = { project: 'production-project', inventoryId: 'inventory' };
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(61,'Production',?,'production-project','writable',1)"
    ).run(path);
    rememberOriginalDefaultProject(db, 61);
    const store = new ScientificObjectStore(db, 61);
    await submitScientificWorkspace({
      db,
      workspaceId: 61,
      request: {
        operationId: 'initial',
        expectedHead: null,
        source: { kind: 'documents', entries: [] },
      },
    });
    const text = serializeGenBank({
      id: 'design',
      name: 'Accepted design',
      sequence: 'ACGTACGT',
      length: 8,
      circular: false,
      annotations: [],
    });
    const metadata = buildSequencePackageDocument({
      id: 'design',
      name: 'Accepted design',
      product: {
        file: 'product.gb',
        genBankChecksum: defineBlob(new TextEncoder().encode(text)).hash,
      },
    });
    await submitScientificWorkspace({
      db,
      workspaceId: 61,
      request: {
        operationId: 'design',
        expectedHead: store.read().head,
        source: {
          kind: 'native-artifact',
          expectedRevisionId: null,
          entry: {
            resourceId: 'design',
            path: 'Accepted design/product.gb',
            representation: { format: 'genbank-v1', text },
            sequencePackageText: JSON.stringify(metadata),
          },
        },
      },
    });
    const projectAuthority = createRegisteredProjectAuthority({
        db: () => db,
        managedRootDir: () => join(file.tmpDir, 'managed'),
      }),
      workspaces = new NativeDocumentWorkspaces({ authority: projectAuthority });
    const protocols = createNativeProtocolPackages({
      db: () => db,
      projectAuthority,
      workspaces,
      profileDirectory: () => join(file.tmpDir, 'profile'),
      actor: () => 'native:production',
    });
    const template = await protocols.createProtocol({
      project: scope.project,
      requestId: 'template',
      title: 'Production protocol',
    });
    if (template.kind !== 'ready') throw Error(JSON.stringify(template));
    const run = await protocols.startRun({
      project: scope.project,
      requestId: 'run',
      title: 'Completed production',
      protocolId: template.package.entityId,
      expectedSourceSha256: template.package.sourceSha256,
    });
    if (run.kind !== 'ready') throw Error(JSON.stringify(run));
    const makeOwner = () =>
      createNativeInventoryOwner({
        db: () => db,
        projectAuthority,
        protocolSources: protocols,
        profileKey: 'a'.repeat(64),
        actor: () => 'native:production',
        now: () => now,
      });
    let owner = makeOwner();
    owner.initialize();
    const events: string[] = [];
    owner.subscribe((event) => events.push(event.operationId));
    expect(
      owner.execute({
        ...scope,
        operationId: 'physical',
        expectedRevision: 0,
        commands: [
          ...['source', 'output', 'blocked'].map((id) => ({
            kind: 'create-vessel',
            id: 'vial-' + id,
            name: id,
            placement: { kind: 'unplaced' },
          })),
          {
            kind: 'receive-stock',
            id: 'input',
            vesselId: 'vial-source',
            materialId: 'design',
            quantity: { kind: 'known', value: '8', unit: 'uL' },
            quality: 'usable',
          },
          {
            kind: 'receive-stock',
            id: 'occupied',
            vesselId: 'vial-blocked',
            materialId: 'design',
            quantity: { kind: 'known', value: '1', unit: 'uL' },
            quality: 'usable',
          },
        ],
      }).status
    ).toBe('committed');
    const authority = { ownerInstanceId: 'production-owner', token: 'production-token' },
      projectScope = { kind: 'project-roots' as const, roots: [path] };
    let grants = 0,
      allow = true,
      onGrant: (() => Promise<void>) | undefined;
    server = await startNativeDocumentCommandServer({
      owner: { inspect: vi.fn(), apply: vi.fn(), close: vi.fn() },
      inventory: owner,
      projectAuthority,
      getAuthority: () => authority,
      authorizeInventoryAgent: async (agent, required) => {
        grants++;
        if (!allow || required.some((capability) => !agent.capabilities.includes(capability)))
          throw Error('INVENTORY_CAPABILITY_DENIED: Revoked');
        await onGrant?.();
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
          projectScope,
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
    const designCall = await call('scientific-production-designs', scope);
    expect(designCall.status, JSON.stringify(designCall.body)).toBe(200);
    expect(grants).toBeGreaterThanOrEqual(2);
    const designs = wire.inventoryScientificProductionDesignsReadSchema.parse(
      designCall.body.result.result
    );
    expect(designs.kind).toBe('ready');
    if (designs.kind !== 'ready') throw Error(JSON.stringify(designs));
    expect(designs.designs).toHaveLength(1);
    expect(designs.designs[0].materialAdmission.kind).toBe('admitted');
    const candidates = await owner.runValueCandidates({
      ...scope,
      runId: run.package.entityId,
      limit: 1,
    });
    if (candidates.kind !== 'ready') throw Error(JSON.stringify(candidates));
    const choices = {
      identity: { namespace: 'manual', productionId: 'once' },
      context: {
        kind: 'protocol-run' as const,
        entityId: run.package.entityId,
        sourceSha256: candidates.run.sourceSha256,
      },
      design: designs.designs[0].selection,
      inputs: [{ stockId: 'input', quantity: { value: '8', unit: 'uL' as const } }],
      output: {
        vesselId: 'vial-output',
        quantity: { value: '3', unit: 'uL' as const },
        lotName: 'Measured product',
      },
      method: 'Manual preparation',
      reason: 'Reported completed production',
    };
    const previewRequest = { ...scope, expectedRevision: 1, choices };
    const preview = wire.inventoryScientificProductionPreviewSnapshotSchema.parse(
      await owner.previewScientificProduction(previewRequest)
    );
    expect(preview.kind, JSON.stringify(preview)).toBe('ready');
    if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
    now = 2000;
    const later = await owner.previewScientificProduction(previewRequest);
    expect(later.kind).toBe('ready');
    if (later.kind === 'ready') expect(later.planDigest).toBe(preview.planDigest);
    const before = owner.inspect(scope);
    const occupied = await owner.previewScientificProduction({
      ...previewRequest,
      choices: {
        ...choices,
        identity: { namespace: 'manual', productionId: 'occupied' },
        output: { ...choices.output, vesselId: 'vial-blocked' },
      },
    });
    expect(occupied.kind).toBe('blocked');
    expect(owner.inspect(scope)).toEqual(before);
    const request = {
      ...previewRequest,
      kind: 'record-scientific-production' as const,
      operationId: 'accepted-once',
      expectedPlanDigest: preview.planDigest,
    };
    const denied = await call('apply-scientific-production', request);
    expect(denied.body.result).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_SCOPE',
      stateChanged: false,
    });
    let oldCapture: ProtocolSavedSourceCapture | undefined;
    await protocols.withSavedRunSource(scope.project, run.package.entityId, (capture) => {
      oldCapture = capture;
    });
    const originalHead = store.read().head;
    let writeChecks = 0;
    onGrant = async () => {
      if (++writeChecks !== 2) return;
      const otherText = serializeGenBank({
        id: 'other',
        name: 'Other design',
        sequence: 'GGCC',
        length: 4,
        circular: false,
        annotations: [],
      });
      const otherMetadata = buildSequencePackageDocument({
        id: 'other',
        name: 'Other design',
        product: {
          file: 'product.gb',
          genBankChecksum: defineBlob(new TextEncoder().encode(otherText)).hash,
        },
      });
      await submitScientificWorkspace({
        db,
        workspaceId: 61,
        request: {
          operationId: 'unrelated-design',
          expectedHead: store.read().head,
          source: {
            kind: 'native-artifact',
            expectedRevisionId: null,
            entry: {
              resourceId: 'other',
              path: 'Other design/product.gb',
              representation: { format: 'genbank-v1', text: otherText },
              sequencePackageText: JSON.stringify(otherMetadata),
            },
          },
        },
      });
    };
    const address = new URL(server.url),
      socket = createConnection({ host: address.hostname, port: Number(address.port) });
    let receipt: NativeInventoryReceipt | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const body = JSON.stringify({
        ownerInstanceId: authority.ownerInstanceId,
        projectScope,
        command: 'inventory.apply-scientific-production',
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
          (error) => (error ? reject(error) : resolve())
        )
      );
      for (let index = 0; index < 300 && !receipt; index++) {
        try {
          receipt = owner.operation({ ...scope, operationId: request.operationId });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.startsWith('WORKSPACE_SYNC_DATABASE_BUSY:')
          )
            throw error;
        }

        if (!receipt) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(socket.bytesRead).toBe(0);
    } finally {
      socket.destroy();
      onGrant = undefined;
    }
    if (!receipt) throw Error('The submitted report was not retained.');
    expect(store.read().head).not.toBe(originalHead);
    expect(() => oldCapture!.assertCurrent()).toThrow('PROTOCOL_SOURCE_CHANGED');
    const refreshed = oldCapture!.refreshCurrentLocal!();
    expect(refreshed.source).toEqual(oldCapture!.source);
    expect(() => refreshed.assertCurrent()).not.toThrow();
    expect(receipt.status, JSON.stringify(receipt)).toBe('committed');
    if (receipt.status !== 'committed') throw Error(JSON.stringify(receipt));
    expect(receipt.context?.version).toBe(12);
    expect(events).toEqual(['physical', 'accepted-once']);
    const verified = verifyAcceptedDnaProductionWitness(receipt.context!.acceptedDesign);
    expect(verified.binding.document.length).toBe(8);
    expect(verified.representation.text).toBe(text);
    for (const change of [
      (w: any) => {
        w.blobs.pop();
      },
      (w: any) => {
        w.blobs[0].body.value = 'AAAA';
      },
      (w: any) => {
        w.selection.revision.contentSha256 = '0'.repeat(64);
      },
      (w: any) => {
        w.unexpected = true;
      },
    ]) {
      const bad = JSON.parse(JSON.stringify(receipt.context!.acceptedDesign));
      change(bad);
      expect(() => verifyAcceptedDnaProductionWitness(bad)).toThrow();
    }
    expect(await owner.applyScientificProduction(request)).toEqual(receipt);
    const state = owner.inspect(scope)!;
    const production = Object.values(state.scientificProductions)[0];
    expect(state.stocks.input.quantity).toEqual({ kind: 'known', value: '0', unit: 'uL' });
    expect(state.stocks[production.output.stockId].quality).toBe('quarantined');
    expect(state.lots[production.output.lotId].controls).toMatchObject({
      kind: 'managed',
      assessment: { value: 'unassessed' },
    });
    expect(inventoryScientificProductionChoices(production)).toEqual(choices);
    renameSync(run.package.path, run.package.path + '.gone');
    const fresh = { ...request, operationId: 'second-view' };
    const duplicate = await owner.applyScientificProduction(fresh);
    expect(duplicate).toMatchObject({
      status: 'rejected',
      operationId: 'second-view',
      code: 'INVENTORY_SCIENTIFIC_PRODUCTION_NO_CHANGES',
    });
    expect(owner.operation({ ...scope, operationId: 'second-view' })).toBeNull();
    const detail = wire.inventoryScientificProductionReadSchema.parse(
      owner.scientificProduction({
        ...scope,
        productionId: production.id,
        intentSha256: production.intentSha256,
      })
    );
    expect(detail.kind).toBe('available');
    if (detail.kind === 'available')
      expect(inventoryScientificProductionChoices(detail.production)).toEqual(fresh.choices);
    expect((await owner.previewScientificProduction(previewRequest)).kind).toBe('no-change');
    expect(
      await owner.applyScientificProduction({
        ...fresh,
        operationId: 'conflict',
        choices: { ...choices, method: 'Different' },
      })
    ).toMatchObject({ status: 'rejected', code: 'SCIENTIFIC_PRODUCTION_CONFLICT' });
    const source = wire.inventoryScientificProductionSourceReadSchema.parse(
      owner.scientificProductionSource({
        ...scope,
        productionId: production.id,
        intentSha256: production.intentSha256,
      })
    );
    expect(source.kind).toBe('available');
    if (source.kind === 'available') expect(source.design.representation.text).toBe(text);
    const entries = owner.history({ ...scope, limit: 20 });
    expect(replayNativeInventoryJournal(entries)).toEqual(state);
    expect(() =>
      replayNativeInventoryJournal(entries, 0, { allowScientificProductions: false })
    ).toThrow(/V12/);
    const raw = entries.map((entry) => ({ entry, receipt: JSON.stringify(entry.receipt) }));
    const bad = {
      ...entries.at(-1)!,
      receipt: { ...receipt, context: { ...receipt.context!, version: 11 as const } },
    };
    expect(() =>
      parseNativeInventoryJournalEntry(
        { inventory_id: scope.inventoryId, operation_id: request.operationId, revision: 2 },
        scope.project,
        bad
      )
    ).toThrow();
    expect(raw).toHaveLength(2);
    const archive = owner.exportSnapshot({ ...scope, format: 'native-v1' });
    const parsed = parseInventoryArchive(archive.sourceText, nativeInventoryArchiveRuntime);
    expect(parsed.state!.scientificProductions[production.id]).toEqual(production);
    expect(() =>
      parseInventoryArchive(archive.sourceText, nativeInventoryArchiveRuntime, {
        allowScientificProductions: false,
      })
    ).toThrow();
    renameSync(run.package.path + '.gone', run.package.path);
    writeFileSync(run.package.path, oldCapture!.source.originalText + ' ');
    expect(() => oldCapture!.refreshCurrentLocal!()).toThrow('PROTOCOL_SOURCE_CHANGED');
    writeFileSync(run.package.path, oldCapture!.source.originalText);
    const entriesBeforeClaim = store
      .read()
      .reader.listCurrent()
      .map((snapshot) => ({
        resourceId: snapshot.resourceId,
        path: store.catalog().entries.find((slot) => slot.resourceId === snapshot.resourceId)!
          .path!,
        representation: snapshot.representation!,
      }));
    const claimedPath = relative(path, run.package.path).replace(/\\/g, '/');
    await submitScientificWorkspace({
      db,
      workspaceId: 61,
      request: {
        operationId: 'claim-local-path',
        expectedHead: store.read().head,
        source: {
          kind: 'documents',
          entries: [
            ...entriesBeforeClaim,
            {
              resourceId: 'claim',
              path: claimedPath,
              document: {
                formatVersion: 1,
                kind: 'primer',
                name: 'Claim',
                molecule: 'DNA',
                bases: 'ACGT',
                modifications: [],
                fields: {},
              },
            },
          ],
        },
      },
    });
    expect(() => oldCapture!.refreshCurrentLocal!()).toThrow('PROTOCOL_SOURCE_CHANGED');
    const currentScientific = store.read(),
      removal = compileScientificWorkspace({
        graph: currentScientific.graph,
        head: currentScientific.head,
        entries: entriesBeforeClaim,
        codecs: scientificNativeCodecs,
      }),
      removalId = parseOperationId('remove-claimed-path');
    if (!removalId.ok) throw Error('Invalid operation fixture');
    expect(
      store.submit({
        operationId: removalId.value,
        expectedHead: currentScientific.head,
        mutations: removal.mutations,
        blobs: removal.blobs,
      }).kind
    ).toBe('changed');
    expect(() => oldCapture!.refreshCurrentLocal!()).toThrow(/tombstone/);
    const reopened = openFileTestDb(file.dbPath);
    db = reopened;
    try {
      owner = makeOwner();
      expect(owner.inspect(scope)).toEqual(parseInventoryState(state));
      expect(
        owner.scientificProductionSource({
          ...scope,
          productionId: production.id,
          intentSha256: production.intentSha256,
        }).kind
      ).toBe('available');
    } finally {
      reopened.close();
      db = file.db;
    }
  } finally {
    await server?.close();
    file.cleanup();
  }
});

it.runIf(Boolean(process.env.INVENTORY_SCIENTIFIC_PRODUCTION_ACTUAL_DB))(
  'reads and replays historical native journals without changing raw bytes or executing writes',
  async () =>
    withAgentProjectScope({ kind: 'app-following' }, async () => {
      const path = process.env.INVENTORY_SCIENTIFIC_PRODUCTION_ACTUAL_DB!,
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
          expect(Object.keys(state.scientificProductions)).toHaveLength(0);
          count += history.length;
          if (admitted) {
            expect(owner.scientificProductions(scope)).toMatchObject({
              kind: 'ready',
              productions: [],
              filters: { context: null },
            });
            for (const entry of history) {
              expect(owner.operation({ ...scope, operationId: entry.request.operationId })).toEqual(
                entry.receipt
              );
            }
            admittedRows += history.length;
          } else {
            expect(() => owner.scientificProductions(scope)).toThrow('PROJECT_ACCESS_DENIED');
            unavailableRows += history.length;
          }
        }
        expect(count).toBe(Number(process.env.INVENTORY_SCIENTIFIC_PRODUCTION_ACTUAL_ROWS));
        expect(admittedRows).toBe(
          Number(process.env.INVENTORY_SCIENTIFIC_PRODUCTION_ACTUAL_ADMITTED_ROWS)
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
