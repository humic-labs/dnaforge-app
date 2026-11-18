// @vitest-environment node
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  parseInventoryState,
  type InventoryPlatePlanObservationChoices,
  type InventoryPlatePlanVersionChoices,
} from '@waypoint/domain-services';
import {
  inventoryPlatePlanObservationPreviewSnapshotSchema,
  inventoryPlatePlanObservationsReadSchema,
  inventoryPlatePlanObservationReadSchema,
  inventoryPlatePlanObservationSourceReadSchema,
  type InventoryApplyPlatePlanObservationRequest,
} from '../shared/inventory-plate-plan-observations';
import type { InventoryAcceptedRequest, NativeInventoryReceipt } from '../shared/inventory-command';
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
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import { createNativeProtocolPackages } from './native-protocol-packages';
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { replayNativeInventoryJournal, applyNativeInventoryAdoption } from './inventory-archive';
import { parseNativeInventoryJournalEntry } from './inventory-journal';

it('records one full manual occurrence atomically with real saved sources, zero-byte acknowledgement recovery and immutable grouped lineage', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-plan-observation-'))),
    projectPath = join(root, 'project'),
    dbPath = join(root, 'catalog.sqlite');
  mkdirSync(projectPath);
  db = openFileTestDb(dbPath);
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  const scope = { project: 'observation-project', inventoryId: 'inventory' };
  let now = 1000;
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(61,'Observations',?,'observation-project','writable',1)"
    ).run(projectPath);
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
    const projectAuthority = createRegisteredProjectAuthority({
        db: () => db,
        managedRootDir: () => join(root, 'managed'),
      }),
      workspaces = new NativeDocumentWorkspaces({ authority: projectAuthority });
    const notebook = createNativeNotebookWorkingCopies({
      db: () => db,
      registeredProjects: projectAuthority,
      workspaceRoots: () => workspaces.readableRoots(),
      writableWorkspaceRoots: () => workspaces.roots(),
      profileDirectory: () => join(root, 'profile'),
      captureWorkspace: (path, mutating) =>
        mutating ? workspaces.capture(path) : workspaces.captureReadable(path),
      relocateEntityFile: async () => {
        throw Error('Unrelated relocation');
      },
    });
    await notebook.completeLegacyMigration([]);
    const page = await notebook.create({
      title: 'Manual preparation Notebook',
      workspaceRoot: projectPath,
      requestId: 'notebook-once',
    });
    const protocols = createNativeProtocolPackages({
      db: () => db,
      projectAuthority,
      workspaces,
      profileDirectory: () => join(root, 'profile'),
      actor: () => 'native:observation-proof',
    });
    const template = await protocols.createProtocol({
      project: scope.project,
      requestId: 'protocol-once',
      title: 'Preparation protocol',
    });
    if (template.kind !== 'ready') throw Error(JSON.stringify(template));
    const run = await protocols.startRun({
      project: scope.project,
      requestId: 'run-once',
      title: 'Manual preparation Run',
      protocolId: template.package.entityId,
      expectedSourceSha256: template.package.sourceSha256,
    });
    if (run.kind !== 'ready') throw Error(JSON.stringify(run));
    const makeOwner = () =>
      createNativeInventoryOwner({
        db: () => db,
        projectAuthority,
        notebookSources: notebook,
        protocolSources: protocols,
        profileKey: 'a'.repeat(64),
        actor: () => 'native:observation-proof',
        now: () => now,
      });
    let owner = makeOwner();
    owner.initialize();
    const events: string[] = [];
    owner.subscribe((event) => events.push(event.operationId));
    expect(
      owner.execute({
        ...scope,
        operationId: 'physical-fixture',
        expectedRevision: 0,
        commands: [
          ...['plate', 'second-plate'].map((id) => ({
            kind: 'create-layout-storage',
            id,
            name: id,
            layout: { kind: 'fixed-well', rows: 2, columns: 3 },
            placement: { kind: 'root' },
          })),
          ...['source', 'held'].flatMap((id) => [
            { kind: 'create-vessel', id: 'vial-' + id, name: id, placement: { kind: 'unplaced' } },
            {
              kind: 'receive-stock',
              id,
              vesselId: 'vial-' + id,
              materialId: 'material',
              quantity: { kind: 'known', value: id === 'source' ? '16' : '62', unit: 'uL' },
              quality: 'usable',
            },
          ]),
          {
            kind: 'reserve-quantity',
            id: 'hold-sixty',
            stockId: 'held',
            quantity: { value: '60', unit: 'uL' },
            deadline: null,
            purpose: 'Reserved material',
          },
        ],
      }).status
    ).toBe('committed');
    const planChoices: InventoryPlatePlanVersionChoices = {
      identity: { namespace: 'manual-plans', planId: 'aliquots' },
      reason: 'Reusable instructions',
      definition: {
        schema: 'dnaforge.inventory-plate-plan-definition.v1',
        title: 'Ordered aliquots',
        layout: { kind: 'fixed-well', rows: 2, columns: 3 },
        sourceSlots: [
          { key: 'sample', label: 'Sample' },
          { key: 'control', label: 'Control' },
        ],
        transfers: [
          {
            actionId: 'z-first',
            sourceSlotKey: 'sample',
            destinationPosition: 'A3',
            quantity: { value: '4', unit: 'uL' },
            label: 'First aliquot',
          },
          {
            actionId: 'a-second',
            sourceSlotKey: 'control',
            destinationPosition: 'B1',
            quantity: { value: '4', unit: 'uL' },
            label: 'Second aliquot',
          },
        ],
      },
    };
    const planPreview = owner.previewPlatePlanVersion({
      ...scope,
      expectedRevision: 1,
      choices: planChoices,
    });
    if (planPreview.kind !== 'ready') throw Error(JSON.stringify(planPreview));
    expect(
      owner.applyPlatePlanVersion({
        ...scope,
        kind: 'save-plate-plan-version',
        operationId: 'plan-once',
        expectedRevision: 1,
        choices: planChoices,
        expectedPlanDigest: planPreview.planDigest,
      }).status
    ).toBe('committed');
    const version = Object.values(owner.inspect(scope)!.platePlanVersions)[0];
    const choices: InventoryPlatePlanObservationChoices = {
      identity: { namespace: 'manual-occurrences', observationId: 'occurrence-once' },
      binding: {
        versionId: version.id,
        definitionSha256: version.definitionSha256,
        destinationPlateId: 'plate',
        sources: [
          { sourceSlotKey: 'control', stockId: 'source' },
          { sourceSlotKey: 'sample', stockId: 'source' },
        ],
      },
      context: {
        kind: 'protocol-run',
        entityId: run.package.entityId,
        sourceSha256: run.package.sourceSha256,
      },
      reason: 'Reported exactly completed full manual plan',
    };
    const authority = {
        ownerInstanceId: 'observation-owner',
        token: 'synthetic-observation-token',
      },
      agent = { identityId: 'observer', capabilities: ['read-workspace', 'write-workspace'] },
      projectScope = { kind: 'project-roots' as const, roots: [projectPath] };
    let allowed = true,
      onGrant: (() => void) | undefined;
    server = await startNativeDocumentCommandServer({
      owner: { inspect: vi.fn(), apply: vi.fn(), close: vi.fn() },
      inventory: owner,
      projectAuthority,
      getAuthority: () => authority,
      authorizeInventoryAgent: async () => {
        onGrant?.();
        if (!allowed) throw Error('INVENTORY_CAPABILITY_DENIED: Revoked');
      },
    });
    const call = async (
      command: string,
      request: unknown,
      key: string,
      capabilities = agent.capabilities
    ) => {
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
          agent: { ...agent, capabilities },
        }),
      });
      const body = await response.json();
      return { status: response.status, value: body.result?.[key], result: body.result };
    };
    const raw = () =>
      JSON.stringify({
        state: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
        history: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
      });
    const before = raw(),
      originalState = owner.inspect(scope)!,
      originalRunBytes = readFileSync(run.package.path),
      originalProtocolBytes = readFileSync(template.package.path),
      eventCount = events.length;
    const previewRequest = { ...scope, expectedRevision: 2, choices };
    const preview = inventoryPlatePlanObservationPreviewSnapshotSchema.parse(
      (await call('preview-plate-plan-observation', previewRequest, 'preview', ['read-workspace']))
        .value
    );
    if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
    expect(preview.observation.effects.sources).toHaveLength(1);
    expect(preview.observation.effects.sources[0]).toMatchObject({
      sourceSlotKeys: ['sample', 'control'],
      before: { quantity: { value: '16' } },
      after: { quantity: { value: '8' } },
    });
    const held = inventoryPlatePlanObservationPreviewSnapshotSchema.parse(
      (
        await call(
          'preview-plate-plan-observation',
          {
            ...previewRequest,
            choices: {
              ...choices,
              identity: { ...choices.identity, observationId: 'held-preview' },
              binding: {
                ...choices.binding,
                sources: choices.binding.sources.map((row) => ({ ...row, stockId: 'held' })),
              },
            },
          },
          'preview',
          ['read-workspace']
        )
      ).value
    );
    expect(held).toMatchObject({ kind: 'blocked', issues: [{ code: 'QUANTITY_RESERVED' }] });
    expect(raw() === before).toBe(true);
    expect(events).toHaveLength(eventCount);
    const request: InventoryApplyPlatePlanObservationRequest = {
      ...previewRequest,
      kind: 'record-plate-plan-observation',
      operationId: 'record-once',
      expectedPlanDigest: preview.planDigest,
    };
    expect(
      (await call('apply-plate-plan-observation', request, 'execution', ['read-workspace'])).result
    ).toMatchObject({ ok: false, stateChanged: false });
    expect(
      (
        await call(
          'apply-plate-plan-observation',
          { ...request, scientificSource: {} },
          'execution'
        )
      ).status
    ).toBe(400);
    const address = new URL(server.url),
      socket = createConnection({ host: address.hostname, port: Number(address.port) });
    socket.pause();
    socket.on('error', () => {});
    let receipt: NativeInventoryReceipt | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const body = JSON.stringify({
        ownerInstanceId: authority.ownerInstanceId,
        projectScope,
        command: 'inventory.apply-plate-plan-observation',
        request,
        agent,
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
        receipt = owner.operation({ ...scope, operationId: request.operationId });
        if (!receipt) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(receipt?.revision).toBe(3);
      expect(receipt?.context?.version).toBe(10);
      expect(receipt?.context?.scientificSource?.schema).toBe(
        'dnaforge.protocol-run-saved-source.v1'
      );
      expect(socket.bytesRead).toBe(0);
    } finally {
      socket.destroy();
    }
    expect((await call('apply-plate-plan-observation', request, 'execution')).value).toEqual(
      receipt
    );
    const after = owner.inspect(scope)!,
      observation = Object.values(after.platePlanObservations)[0],
      detailRequest = {
        ...scope,
        observationId: observation.id,
        intentSha256: observation.intentSha256,
      };
    expect(after.revision).toBe(3);
    expect(Object.keys(after.platePlanObservations)).toHaveLength(1);
    expect(after.stocks.source.quantity).toEqual({ kind: 'known', value: '8', unit: 'uL' });
    expect(
      observation.actions.map((row) => [
        row.actionId,
        row.ordinal,
        row.transfer.destination.vesselId,
      ])
    ).toEqual([
      ['z-first', 1, 'well:plate#A3'],
      ['a-second', 2, 'well:plate#B1'],
    ]);
    expect(observation.effects.destinations.map((row) => row.after.quantity)).toEqual([
      { kind: 'known', value: '4', unit: 'uL' },
      { kind: 'known', value: '4', unit: 'uL' },
    ]);
    for (const key of [
      'scientificWorks',
      'scientificCitations',
      'scientificCitationWithdrawals',
      'platePlanVersions',
      'storage',
      'vessels',
      'lots',
      'reservations',
    ] as const)
      expect(after[key]).toEqual(originalState[key]);
    expect(readFileSync(run.package.path).equals(originalRunBytes)).toBe(true);
    expect(readFileSync(template.package.path).equals(originalProtocolBytes)).toBe(true);
    const detail = inventoryPlatePlanObservationReadSchema.parse(
      (await call('plate-plan-observation', detailRequest, 'result', ['read-workspace'])).value
    );
    expect(detail).toMatchObject({ kind: 'available', observation });
    const retained = inventoryPlatePlanObservationSourceReadSchema.parse(
      (await call('plate-plan-observation-source', detailRequest, 'result', ['read-workspace']))
        .value
    );
    expect(retained).toMatchObject({
      kind: 'available',
      sourceSha256: choices.context.sourceSha256,
    });
    const list = inventoryPlatePlanObservationsReadSchema.parse(
      (
        await call(
          'plate-plan-observations',
          {
            ...scope,
            version: { versionId: version.id, definitionSha256: version.definitionSha256 },
            context: { kind: 'protocol-run', entityId: run.package.entityId },
            limit: 1,
          },
          'result',
          ['read-workspace']
        )
      ).value
    );
    expect(list).toMatchObject({
      kind: 'ready',
      observations: [{ id: observation.id, actionCount: 2, sourceStockCount: 1 }],
      filters: { version: { versionId: version.id }, context: { entityId: run.package.entityId } },
    });
    expect(
      owner.scientificWorksForContext({
        ...scope,
        context: { kind: 'protocol-run', entityId: run.package.entityId },
      })
    ).toMatchObject({ kind: 'ready', works: [] });
    const noMore = raw(),
      missingPath = run.package.path + '.temporarily-unavailable';
    renameSync(run.package.path, missingPath);
    try {
      expect(await owner.applyPlatePlanObservation(request)).toEqual(receipt);
      expect(
        await owner.applyPlatePlanObservation({
          ...request,
          operationId: 'same-occurrence-fresh-operation',
          expectedRevision: 3,
        })
      ).toMatchObject({ status: 'rejected', code: 'INVENTORY_PLATE_PLAN_OBSERVATION_NO_CHANGES' });
      expect(
        await owner.applyPlatePlanObservation({
          ...request,
          choices: { ...choices, reason: 'Changed committed request' },
        })
      ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
      const conflict = await owner.previewPlatePlanObservation({
        ...previewRequest,
        expectedRevision: 3,
        choices: { ...choices, reason: 'Changed occurrence intent' },
      });
      expect(conflict.kind).toBe('blocked');
      expect(owner.platePlanObservationSource(detailRequest)).toEqual(retained);
    } finally {
      renameSync(missingPath, run.package.path);
    }
    expect(raw() === noMore).toBe(true);
    const savedPages = await notebook.savedSources(scope.project, '', 20),
      savedPage = savedPages.find((row) => row.pageId === page.pageId)!;
    const secondChoices: InventoryPlatePlanObservationChoices = {
      ...choices,
      identity: { namespace: 'manual-occurrences', observationId: 'second-notebook-occurrence' },
      context: {
        kind: 'notebook-page',
        entityId: page.pageId,
        sourceSha256: savedPage.sourceSha256,
      },
      binding: { ...choices.binding, destinationPlateId: 'second-plate' },
    };
    const secondPreview = inventoryPlatePlanObservationPreviewSnapshotSchema.parse(
      await owner.previewPlatePlanObservation({
        ...scope,
        expectedRevision: 3,
        choices: secondChoices,
      })
    );
    if (secondPreview.kind !== 'ready') throw Error(JSON.stringify(secondPreview));
    expect(secondPreview.observation.effects.sources[0].after.quantity).toMatchObject({
      value: '0',
      unit: 'uL',
    });
    const secondRequest: InventoryApplyPlatePlanObservationRequest = {
      ...scope,
      kind: 'record-plate-plan-observation',
      operationId: 'second-occurrence-once',
      expectedRevision: 3,
      choices: secondChoices,
      expectedPlanDigest: secondPreview.planDigest,
    };
    const guardedBefore = raw();
    await expect(
      owner.applyPlatePlanObservation(secondRequest, () => {}, {
        beforeScientificCommit: async () => {
          throw new Error('Late current write grant refused');
        },
      })
    ).rejects.toThrow('Late current write grant refused');
    expect(raw() === guardedBefore).toBe(true);
    const copiedRun = await protocols.readPackage({
        project: scope.project,
        entityId: run.package.entityId,
      }),
      edited = JSON.parse(copiedRun.originalText);
    edited.title = 'Later saved Run title';
    expect(
      (
        await protocols.savePackage({
          project: scope.project,
          entityId: run.package.entityId,
          requestId: 'later-title-once',
          expectedSourceSha256: copiedRun.sourceSha256,
          originalText: JSON.stringify(edited),
        })
      ).kind
    ).toBe('ready');
    expect(owner.platePlanObservationSource(detailRequest)).toEqual(retained);
    expect(
      (await owner.previewPlatePlanObservation({ ...previewRequest, expectedRevision: 3 })).kind
    ).toBe('no-change');
    expect(await owner.applyPlatePlanObservation(secondRequest)).toMatchObject({
      status: 'committed',
      revision: 4,
    });
    const secondObservation = Object.values(owner.inspect(scope)!.platePlanObservations).find(
      (row) => row.id !== observation.id
    )!;
    expect(
      owner.platePlanObservationSource({
        ...scope,
        observationId: secondObservation.id,
        intentSha256: secondObservation.intentSha256,
      })
    ).toMatchObject({ kind: 'available', source: { schema: 'dnaforge.notebook-saved-source.v1' } });
    const page1 = inventoryPlatePlanObservationsReadSchema.parse(
      owner.platePlanObservations({ ...scope, limit: 1 })
    );
    if (page1.kind !== 'ready' || !page1.nextCursor) throw Error(JSON.stringify(page1));
    expect(
      owner.platePlanObservations({
        ...scope,
        context: { kind: 'protocol-run', entityId: run.package.entityId },
        cursor: page1.nextCursor,
      })
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_QUERY_CURSOR_INVALID' });
    expect(
      owner.platePlanObservations({ ...scope, limit: 1, cursor: page1.nextCursor })
    ).toMatchObject({ kind: 'ready', observations: [expect.anything()], nextCursor: null });
    expect(
      owner.platePlanObservations({
        ...scope,
        version: { versionId: version.id, definitionSha256: 'sha256:' + '0'.repeat(64) },
      })
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_PLATE_PLAN_PIN_MISMATCH' });
    expect(
      owner.platePlanObservation({ ...detailRequest, intentSha256: 'sha256:' + '0'.repeat(64) })
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_PLATE_PLAN_OBSERVATION_PIN_MISMATCH' });
    const immutable = owner.platePlanObservation(detailRequest);
    expect(
      owner.execute({
        ...scope,
        operationId: 'later-consumption',
        expectedRevision: 4,
        commands: [
          {
            kind: 'consume',
            stockId: observation.effects.destinations[0].after.id,
            quantity: { value: '1', unit: 'uL' },
            reason: 'Later independent use',
          },
        ],
      }).status
    ).toBe('committed');
    owner = makeOwner();
    expect(owner.platePlanObservation(detailRequest)).toEqual({ ...immutable, revision: 5 });
    expect(owner.platePlanObservationSource(detailRequest)).toEqual(retained);
    const history = owner.history({ ...scope, limit: 1000 });
    expect(replayNativeInventoryJournal(history)).toEqual(owner.inspect(scope));
    const recorded = history.find(
      (row) => 'kind' in row.request && row.request.kind === 'record-plate-plan-observation'
    )!;
    for (const context of [
      { ...recorded.receipt.context, version: 9 },
      { ...recorded.receipt.context, scientificSource: undefined },
    ])
      expect(() =>
        parseNativeInventoryJournalEntry(
          {
            inventory_id: scope.inventoryId,
            operation_id: recorded.request.operationId,
            revision: recorded.receipt.revision,
          },
          scope.project,
          { request: recorded.request, receipt: { ...recorded.receipt, context } }
        )
      ).toThrow('matching native source witness');
    const archive = owner.exportSnapshot({ ...scope, format: 'native-v1' });
    expect(() =>
      applyNativeInventoryAdoption(
        null,
        {
          ...scope,
          kind: 'adopt-archive',
          operationId: 'old-context',
          expectedRevision: 0,
          sourceText: archive.sourceText,
          options: { bindings: [] },
          expectedPlanDigest: 'sha256:' + '0'.repeat(64),
        },
        {
          at: now,
          principal: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
          authority: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
        },
        0,
        { receiptContextVersion: 9 }
      )
    ).toThrow('pre-V10');
    const adoptedScope = { ...scope, inventoryId: 'adopted' },
      importPreview = owner.previewImport({
        ...adoptedScope,
        sourceText: archive.sourceText,
        options: {
          bindings: [{ sourceMaterialId: 'material', destinationMaterialId: 'material' }],
        },
      });
    if (importPreview.kind !== 'ready') throw Error(JSON.stringify(importPreview));
    expect(
      owner.applyImport({
        ...adoptedScope,
        kind: 'adopt-archive',
        operationId: 'adopt-occurrences',
        expectedRevision: 0,
        sourceText: archive.sourceText,
        options: importPreview.options,
        expectedPlanDigest: importPreview.planDigest,
      }).status
    ).toBe('committed');
    expect(
      owner.platePlanObservationSource({
        ...adoptedScope,
        observationId: observation.id,
        intentSha256: observation.intentSha256,
      })
    ).toEqual(retained);
    expect(owner.inspect(adoptedScope)!.platePlanObservations[observation.id].by.kind).toBe(
      'imported'
    );
    allowed = false;
    expect(
      (await call('plate-plan-observation-source', detailRequest, 'result', ['read-workspace']))
        .result
    ).toMatchObject({ ok: false, stateChanged: false });
    allowed = true;
    let readGrants = 0;
    onGrant = () => {
      if (++readGrants === 2) allowed = false;
    };
    expect(
      (await call('preview-plate-plan-observation', previewRequest, 'preview', ['read-workspace']))
        .result
    ).toMatchObject({ ok: false, stateChanged: false });
  } finally {
    await server?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.runIf(Boolean(process.env.INVENTORY_PLAN_OBSERVATION_ACTUAL_DB))(
  'retries and replays all copied actual 215 receipts with zero SQL and raw-byte changes',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-observation-actual-'))),
      path = join(root, 'catalog.sqlite');
    copyFileSync(process.env.INVENTORY_PLAN_OBSERVATION_ACTUAL_DB!, path);
    db = openFileTestDb(path);
    try {
      const raw = () =>
          JSON.stringify({
            states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
            history: db
              .prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision')
              .all(),
          }),
        before = raw(),
        bytes = readFileSync(path),
        changes = db.prepare('SELECT total_changes() AS count').get();
      for (const row of db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all() as {
        inventory_id: string;
        project_id: string;
        state_json: string;
      }[]) {
        const project = db
            .prepare('SELECT path FROM workspaces WHERE repo_uuid=?')
            .get(row.project_id) as { path: string },
          owner = createNativeInventoryOwner({
            db: () => db,
            projectAuthority: createRegisteredProjectAuthority({
              db: () => db,
              managedRootDir: () => dirname(dirname(project.path)),
            }),
            actor: () => 'native:actual-occurrence-oracle',
            profileKey: 'a'.repeat(64),
          }),
          scope = { project: row.project_id, inventoryId: row.inventory_id };
        const expected = parseInventoryState(JSON.parse(row.state_json)),
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
        expect(replayNativeInventoryJournal(history)).toEqual(expected);
        expect(Object.keys(expected.platePlanObservations)).toHaveLength(0);
        expect(owner.platePlanObservations(scope)).toMatchObject({
          kind: 'ready',
          observations: [],
          filters: { version: null, context: null },
        });
        if (JSON.parse(row.state_json).schema === 'dnaforge.inventory.v26') {
          expect(expected.revision).toBe(98);
          expect(Object.keys(expected.platePlanVersions)).toHaveLength(2);
          expect(Object.keys(expected.scientificCitations)).toHaveLength(2);
          expect(Object.keys(expected.scientificCitationWithdrawals)).toHaveLength(1);
        }
        const retry = (request: InventoryAcceptedRequest) => {
          if (!('kind' in request)) return owner.execute(request);
          switch (request.kind) {
            case 'record-plate-plan-observation':
              return owner.applyPlatePlanObservation(request);
            case 'save-plate-plan-version':
              return owner.applyPlatePlanVersion(request);
            case 'record-scientific-citation':
              return owner.applyScientificCitation(request);
            case 'withdraw-scientific-citation':
              return owner.applyScientificCitationWithdrawal(request);
            case 'record-scientific-transfer':
              return owner.applyScientificTransfer(request);
            case 'record-scientific-transfer-v2':
              return owner.applyScientificTransferV2(request);
            case 'receive-arrival':
              return owner.applyArrival(request);
            case 'adopt-archive':
              return owner.applyImport(request);
            case 'receive-table':
              return owner.applyTable(request);
            case 'apply-stocktake':
              return owner.applyStocktake(request);
            case 'import-hierarchy':
              return owner.applyHierarchy(request);
            case 'receive-mapped-table':
              return owner.applyMappedTable(request);
            case 'import-benchling-capture':
              return owner.applyBenchlingCapture(request);
            case 'acknowledge-table-source':
              return owner.acknowledgeSource(request);
          }
        };
        for (const entry of history) {
          expect(owner.operation({ ...scope, operationId: entry.request.operationId })).toEqual(
            entry.receipt
          );
          expect(await retry(entry.request)).toEqual(entry.receipt);
        }
      }
      const receipts = (
        db.prepare('SELECT receipt_json FROM inventory_journal').all() as { receipt_json: string }[]
      ).map((row) => JSON.parse(row.receipt_json));
      expect(receipts).toHaveLength(215);
      expect(receipts.filter((receipt) => receipt.context?.version === 9)).toHaveLength(2);
      expect(
        receipts
          .filter((receipt) => receipt.context?.version === 9)
          .every((receipt) => !receipt.context.scientificSource)
      ).toBe(true);
      expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
      expect(raw() === before).toBe(true);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
