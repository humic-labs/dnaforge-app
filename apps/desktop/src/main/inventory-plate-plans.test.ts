// @vitest-environment node
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  parseInventoryState,
  type InventoryPlatePlanVersionChoices,
} from '@waypoint/domain-services';
import type { InventoryAcceptedRequest, NativeInventoryReceipt } from '../shared/inventory-command';
import type { InventoryApplyPlatePlanVersionRequest } from '../shared/inventory-plate-plans';
import {
  inventoryPlatePlanVersionPreviewSnapshotSchema,
  inventoryPlatePlanVersionsReadSchema,
  inventoryPlatePlanVersionReadSchema,
  inventoryPlatePlanBindingPreviewSnapshotSchema,
} from '../shared/inventory-plate-plans';
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
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { parseNativeInventoryJournalEntry } from './inventory-journal';
import { replayNativeInventoryJournal, applyNativeInventoryAdoption } from './inventory-archive';
import { NativeDocumentCommandError } from '../shared/native-document-error';

it('saves immutable plan metadata through lost acknowledgement and A-B-A reuse, then previews one cumulative physical binding without effects', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-plan-native-'))),
    projectPath = join(root, 'project'),
    dbPath = join(root, 'catalog.sqlite');
  mkdirSync(projectPath);
  const sentinel = join(projectPath, 'existing-source.txt');
  writeFileSync(sentinel, 'Original project source β\r\n');
  const sourceBytes = readFileSync(sentinel);
  db = openFileTestDb(dbPath);
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  const scope = { project: 'plan-project', inventoryId: 'inventory' };
  let now = 1000,
    clockSequence: number[] = [];
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(51,'Plans',?,'plan-project','writable',1)"
    ).run(projectPath);
    rememberOriginalDefaultProject(db, 51);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema','entity','science','Science','{}','schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-v1','schema',1,'{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('material','record','schema','schema-v1','Material','{}',51,'registered',1,1)"
    ).run();
    const projectAuthority = createRegisteredProjectAuthority({
      db: () => db,
      managedRootDir: () => join(root, 'managed'),
    });
    const makeOwner = () =>
      createNativeInventoryOwner({
        db: () => db,
        projectAuthority,
        profileKey: 'a'.repeat(64),
        actor: () => 'native:plan-proof',
        now: () => clockSequence.shift() ?? now,
      });
    let owner = makeOwner();
    owner.initialize();
    const events: string[] = [];
    owner.subscribe((event) => events.push(event.operationId));
    const authority = { ownerInstanceId: 'plan-owner', token: 'synthetic-plan-token' },
      agent = { identityId: 'plan-writer', capabilities: ['read-workspace', 'write-workspace'] },
      projectScope = { kind: 'project-roots' as const, roots: [projectPath] };
    let grantAllowed = true;
    server = await startNativeDocumentCommandServer({
      owner: { inspect: vi.fn(), apply: vi.fn(), close: vi.fn() },
      inventory: owner,
      projectAuthority,
      getAuthority: () => authority,
      authorizeInventoryAgent: async () => {
        if (!grantAllowed) throw Error('INVENTORY_CAPABILITY_DENIED: Revoked');
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
        journal: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
      });
    const initial = raw();
    expect(owner.platePlanVersions(scope)).toEqual({
      kind: 'inventory-absent',
      projectId: scope.project,
      inventoryId: scope.inventoryId,
      identity: null,
    });
    const choices: InventoryPlatePlanVersionChoices = {
      identity: { namespace: 'aliquot-plans', planId: 'same-family' },
      reason: 'Original reusable plan',
      definition: {
        schema: 'dnaforge.inventory-plate-plan-definition.v1',
        title: 'Aliquot β <&>',
        layout: { kind: 'fixed-well', rows: 8, columns: 12 },
        sourceSlots: [
          { key: 'template', label: 'Template β' },
          { key: 'control', label: 'Control <&>' },
        ],
        transfers: [
          {
            actionId: 'second-lexically',
            sourceSlotKey: 'template',
            destinationPosition: 'A3',
            quantity: { value: '4', unit: 'uL' },
            label: 'First instruction',
          },
          {
            actionId: 'first-lexically',
            sourceSlotKey: 'control',
            destinationPosition: 'B1',
            quantity: { value: '4', unit: 'uL' },
            label: 'Second instruction',
          },
        ],
      },
    };
    const preview = inventoryPlatePlanVersionPreviewSnapshotSchema.parse(
      (
        await call(
          'preview-plate-plan-version',
          { ...scope, expectedRevision: 0, choices },
          'preview',
          ['read-workspace']
        )
      ).value
    );
    expect(raw() === initial).toBe(true);
    if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
    expect(preview.target).toMatchObject({ present: false, revision: 0 });
    const request: InventoryApplyPlatePlanVersionRequest = {
      ...scope,
      kind: 'save-plate-plan-version',
      operationId: 'save-a-once',
      expectedRevision: 0,
      choices,
      expectedPlanDigest: preview.planDigest,
    };
    expect(
      (await call('apply-plate-plan-version', request, 'execution', ['read-workspace'])).result
    ).toMatchObject({ ok: false, stateChanged: false });
    expect(raw() === initial).toBe(true);
    expect(
      (await call('apply-plate-plan-version', { ...request, scientificSource: {} }, 'execution'))
        .status
    ).toBe(400);
    expect(
      (
        await call(
          'apply-plate-plan-version',
          {
            ...request,
            choices: {
              ...choices,
              definition: {
                ...choices.definition,
                transfers: choices.definition.transfers.map((row, index) =>
                  index === 0 ? { ...row, quantity: { value: '4.0', unit: 'uL' } } : row
                ),
              },
            },
          },
          'execution'
        )
      ).status
    ).toBe(400);
    expect(raw() === initial).toBe(true);
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
        command: 'inventory.apply-plate-plan-version',
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
      expect(receipt?.context?.version).toBe(9);
      expect(receipt?.context?.scientificSource).toBeUndefined();
      expect(socket.bytesRead).toBe(0);
    } finally {
      socket.destroy();
    }
    expect((await call('apply-plate-plan-version', request, 'execution')).value).toEqual(receipt);
    const a = Object.values(owner.inspect(scope)!.platePlanVersions)[0];
    expect(Object.keys(owner.inspect(scope)!.stocks)).toEqual([]);
    const readA = inventoryPlatePlanVersionReadSchema.parse(
      (
        await call(
          'plate-plan-version',
          { ...scope, versionId: a.id, definitionSha256: a.definitionSha256 },
          'result',
          ['read-workspace']
        )
      ).value
    );
    if (readA.kind !== 'available' || readA.diagram.kind !== 'rendered')
      throw Error(JSON.stringify(readA));
    expect(readA.version).toEqual(a);
    expect(readA.diagram.artifact.svg).toContain('H12');
    expect(readA.diagram.artifact.svg).toContain('β');
    expect(readA.diagram.artifact.svg).toContain('&lt;&amp;&gt;');
    expect(readA.diagram.artifact.sha256).toBe(
      'sha256:' + createHash('sha256').update(readA.diagram.artifact.svg).digest('hex')
    );
    const beforeB = raw(),
      bChoices = {
        ...choices,
        definition: {
          ...choices.definition,
          layout: { kind: 'fixed-well' as const, rows: 2, columns: 3 },
        },
        reason: 'Smaller compatible version',
      };
    const bPreview = owner.previewPlatePlanVersion({
      ...scope,
      expectedRevision: 1,
      choices: bChoices,
    });
    if (bPreview.kind !== 'ready') throw Error(JSON.stringify(bPreview));
    expect(raw() === beforeB).toBe(true);
    expect(
      owner.applyPlatePlanVersion({
        ...scope,
        kind: 'save-plate-plan-version',
        operationId: 'save-b-once',
        expectedRevision: 1,
        choices: bChoices,
        expectedPlanDigest: bPreview.planDigest,
      }).status
    ).toBe('committed');
    const b = Object.values(owner.inspect(scope)!.platePlanVersions).find(
      (version) => version.id !== a.id
    )!;
    const beforeDuplicates = raw();
    expect(
      owner.previewPlatePlanVersion({
        ...scope,
        expectedRevision: 0,
        choices: { ...choices, reason: 'New reason is not saved' },
      })
    ).toMatchObject({ kind: 'no-change', version: a, target: { present: true, revision: 2 } });
    expect(
      owner.applyPlatePlanVersion({
        ...request,
        operationId: 'fresh-content-duplicate',
        choices: { ...choices, reason: 'New reason is not saved' },
      })
    ).toMatchObject({ status: 'rejected', code: 'INVENTORY_PLATE_PLAN_VERSION_NO_CHANGES' });
    expect(
      owner.applyPlatePlanVersion({
        ...request,
        choices: { ...choices, reason: 'Changed committed request' },
      })
    ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
    expect(raw() === beforeDuplicates).toBe(true);
    const list = inventoryPlatePlanVersionsReadSchema.parse(
      (
        await call(
          'plate-plan-versions',
          { ...scope, identity: choices.identity, limit: 1 },
          'result',
          ['read-workspace']
        )
      ).value
    );
    if (list.kind !== 'ready' || !list.nextCursor) throw Error(JSON.stringify(list));
    const second = inventoryPlatePlanVersionsReadSchema.parse(
      owner.platePlanVersions({
        ...scope,
        identity: choices.identity,
        limit: 1,
        cursor: list.nextCursor,
      })
    );
    if (second.kind !== 'ready') throw Error(JSON.stringify(second));
    expect(new Set([list.versions[0].id, second.versions[0].id])).toEqual(new Set([a.id, b.id]));
    expect(
      owner.platePlanVersions({
        ...scope,
        identity: { namespace: 'none', planId: 'empty' },
        cursor: list.nextCursor,
      })
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_QUERY_CURSOR_INVALID' });
    expect(
      owner.platePlanVersions({ ...scope, identity: { namespace: 'none', planId: 'empty' } })
    ).toMatchObject({
      kind: 'ready',
      identity: { namespace: 'none', planId: 'empty' },
      versions: [],
    });
    expect(
      owner.platePlanVersion({
        ...scope,
        versionId: a.id,
        definitionSha256: 'sha256:' + '0'.repeat(64),
      })
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_PLATE_PLAN_PIN_MISMATCH' });
    const seeded = owner.execute({
      ...scope,
      operationId: 'physical-fixture',
      expectedRevision: 2,
      commands: [
        {
          kind: 'create-layout-storage',
          id: 'plate',
          name: 'Existing plate',
          layout: { kind: 'fixed-well', rows: 2, columns: 3 },
          placement: { kind: 'root' },
        },
        ...['eight', 'six', 'held'].flatMap((id) => [
          { kind: 'create-vessel', id: 'vial-' + id, name: id, placement: { kind: 'unplaced' } },
          {
            kind: 'receive-stock',
            id,
            vesselId: 'vial-' + id,
            materialId: 'material',
            quantity: {
              kind: 'known',
              value: id === 'eight' ? '8' : id === 'six' ? '6' : '60',
              unit: 'uL',
            },
            quality: 'usable',
          },
        ]),
        {
          kind: 'reserve-quantity',
          id: 'hold-sixty',
          stockId: 'held',
          quantity: { value: '60', unit: 'uL' },
          deadline: null,
          purpose: 'Reserved source',
        },
      ],
    });
    expect(seeded.status).toBe('committed');
    expect(
      owner.platePlanVersions({ ...scope, identity: choices.identity, cursor: list.nextCursor })
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_QUERY_REVISION_CHANGED' });
    const binding = {
      versionId: b.id,
      definitionSha256: b.definitionSha256,
      destinationPlateId: 'plate',
      sources: [
        { sourceSlotKey: 'control', stockId: 'eight' },
        { sourceSlotKey: 'template', stockId: 'eight' },
      ],
    };
    const beforeBinding = raw(),
      eventsBeforeBinding = events.length;
    const ready = inventoryPlatePlanBindingPreviewSnapshotSchema.parse(
      (
        await call(
          'preview-plate-plan-binding',
          { ...scope, expectedRevision: 3, binding },
          'preview',
          ['read-workspace']
        )
      ).value
    );
    if (ready.kind !== 'ready') throw Error(JSON.stringify(ready));
    expect(ready.sources).toHaveLength(1);
    expect(ready.sources[0]).toMatchObject({
      sourceSlotKeys: ['template', 'control'],
      demand: { value: '8', unit: 'uL' },
      projectedRemaining: { value: '0', unit: 'uL' },
    });
    expect(ready.destinations.map((row) => [row.actionId, row.ordinal, row.vesselId])).toEqual([
      ['second-lexically', 1, 'well:plate#A3'],
      ['first-lexically', 2, 'well:plate#B1'],
    ]);
    for (const [stockId, code] of [
      ['six', 'INSUFFICIENT_QUANTITY'],
      ['held', 'QUANTITY_RESERVED'],
    ] as const) {
      const blocked = inventoryPlatePlanBindingPreviewSnapshotSchema.parse(
        owner.previewPlatePlanBinding({
          ...scope,
          expectedRevision: 3,
          binding: { ...binding, sources: binding.sources.map((row) => ({ ...row, stockId })) },
        })
      );
      expect(blocked).toMatchObject({ kind: 'blocked', issues: [{ code }] });
      if (blocked.kind !== 'blocked') throw Error(JSON.stringify(blocked));
      expect(blocked.sources.every((row) => !Object.hasOwn(row, 'projectedRemaining'))).toBe(true);
    }
    expect(
      owner.previewPlatePlanBinding({
        ...scope,
        expectedRevision: 3,
        binding: { ...binding, versionId: a.id, definitionSha256: a.definitionSha256 },
      })
    ).toMatchObject({ kind: 'blocked' });
    expect(raw() === beforeBinding).toBe(true);
    expect(events).toHaveLength(eventsBeforeBinding);
    grantAllowed = false;
    expect(
      (
        await call(
          'preview-plate-plan-binding',
          { ...scope, expectedRevision: 3, binding },
          'preview',
          ['read-workspace']
        )
      ).result
    ).toMatchObject({ ok: false, stateChanged: false });
    grantAllowed = true;
    const fenceChoices = {
        ...choices,
        definition: { ...choices.definition, title: 'Fenced metadata' },
      },
      fencePreview = owner.previewPlatePlanVersion({
        ...scope,
        expectedRevision: 3,
        choices: fenceChoices,
      });
    if (fencePreview.kind !== 'ready') throw Error(JSON.stringify(fencePreview));
    let guards = 0;
    expect(() =>
      owner.applyPlatePlanVersion(
        {
          ...scope,
          kind: 'save-plate-plan-version',
          operationId: 'late-authority-fence',
          expectedRevision: 3,
          choices: fenceChoices,
          expectedPlanDigest: fencePreview.planDigest,
        },
        () => {
          if (++guards === 4)
            throw new NativeDocumentCommandError(
              'INVENTORY_CAPABILITY_DENIED',
              'Current authority changed',
              false
            );
        }
      )
    ).toThrow('Current authority changed');
    expect(raw() === beforeBinding).toBe(true);
    expect(events).toHaveLength(eventsBeforeBinding);
    const validity = owner.execute({
      ...scope,
      operationId: 'validity-fixture',
      expectedRevision: 3,
      commands: [
        {
          kind: 'record-validity-decision',
          id: 'stock-cutoff',
          owner: { kind: 'stock', stockId: 'eight' },
          rule: { kind: 'absolute', deadlineAt: 1002 },
          sourceText: 'Absolute cutoff at native timestamp 1002',
          sourcePrecision: 'instant',
          source: null,
          reason: 'Absolute source cutoff',
        },
      ],
    });
    expect(validity.status).toBe('committed');
    const beforeDeadline = raw();
    clockSequence = [1001, 1002];
    expect(owner.previewPlatePlanBinding({ ...scope, expectedRevision: 4, binding })).toMatchObject(
      { kind: 'unavailable', code: 'INVENTORY_PLATE_PLAN_PREVIEW_STALE', retryable: true }
    );
    now = 1002;
    expect(owner.previewPlatePlanBinding({ ...scope, expectedRevision: 4, binding })).toMatchObject(
      { kind: 'blocked', issues: [{ code: 'MATERIAL_EXPIRED' }] }
    );
    expect(raw() === beforeDeadline).toBe(true);
    owner = makeOwner();
    expect(
      owner.platePlanVersion({ ...scope, versionId: a.id, definitionSha256: a.definitionSha256 })
    ).toEqual({ ...readA, revision: 4 });
    const history = owner.history({ ...scope, limit: 1000 });
    expect(replayNativeInventoryJournal(history)).toEqual(owner.inspect(scope));
    const saved = history[0];
    expect(() =>
      parseNativeInventoryJournalEntry(
        {
          inventory_id: scope.inventoryId,
          operation_id: saved.request.operationId,
          revision: saved.receipt.revision,
        },
        scope.project,
        {
          request: saved.request,
          receipt: { ...saved.receipt, context: { ...saved.receipt.context, version: 8 } },
        }
      )
    ).toThrow('V9');
    expect(() =>
      parseNativeInventoryJournalEntry(
        {
          inventory_id: scope.inventoryId,
          operation_id: saved.request.operationId,
          revision: saved.receipt.revision,
        },
        scope.project,
        {
          request: saved.request,
          receipt: {
            ...saved.receipt,
            context: {
              ...saved.receipt.context,
              scientificSource: {
                schema: 'dnaforge.notebook-saved-source.v1',
                projectId: scope.project,
                workspaceScope: scope.project,
                pageId: scope.project + '::page',
                fileObjectUuid: 'file',
                title: 'Forbidden witness',
                content: { type: 'doc', content: [] },
              },
            },
          },
        }
      )
    ).toThrow('Only scientific work');
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
        { receiptContextVersion: 8 }
      )
    ).toThrow('pre-V9');
    const adoptedScope = { ...scope, inventoryId: 'adopted' },
      imported = owner.previewImport({
        ...adoptedScope,
        sourceText: archive.sourceText,
        options: {
          bindings: [{ sourceMaterialId: 'material', destinationMaterialId: 'material' }],
        },
      });
    if (imported.kind !== 'ready') throw Error(JSON.stringify(imported));
    expect(
      owner.applyImport({
        ...adoptedScope,
        kind: 'adopt-archive',
        operationId: 'adopt-plan-archive',
        expectedRevision: 0,
        sourceText: archive.sourceText,
        options: imported.options,
        expectedPlanDigest: imported.planDigest,
      }).status
    ).toBe('committed');
    const adopted = owner.inspect(adoptedScope)!.platePlanVersions[a.id];
    expect(adopted.definition).toEqual(a.definition);
    expect(adopted.by.kind).toBe('imported');
    expect(readFileSync(sentinel).equals(sourceBytes)).toBe(true);
  } finally {
    await server?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.runIf(Boolean(process.env.INVENTORY_PLATE_PLAN_ACTUAL_DB))(
  'retries, replays and reads the copied actual 213 receipts without SQL or raw-byte changes',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-plan-actual-'))),
      path = join(root, 'catalog.sqlite');
    copyFileSync(process.env.INVENTORY_PLATE_PLAN_ACTUAL_DB!, path);
    db = openFileTestDb(path);
    try {
      const raw = () =>
        JSON.stringify({
          states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
          journal: db
            .prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision')
            .all(),
        });
      const before = raw(),
        bytes = readFileSync(path),
        changes = db.prepare('SELECT total_changes() AS count').get();
      const rows = db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all() as {
        inventory_id: string;
        project_id: string;
        state_json: string;
      }[];
      for (const row of rows) {
        const project = db
          .prepare('SELECT path FROM workspaces WHERE repo_uuid=?')
          .get(row.project_id) as { path: string };
        const owner = createNativeInventoryOwner({
          db: () => db,
          projectAuthority: createRegisteredProjectAuthority({
            db: () => db,
            managedRootDir: () => dirname(dirname(project.path)),
          }),
          actor: () => 'native:actual-plan-oracle',
          profileKey: 'a'.repeat(64),
        });
        const scope = { project: row.project_id, inventoryId: row.inventory_id },
          expected = parseInventoryState(JSON.parse(row.state_json));
        if (JSON.parse(row.state_json).schema === 'dnaforge.inventory.v25') {
          expect(Object.keys(expected.scientificCitations)).toHaveLength(2);
          expect(Object.keys(expected.scientificCitationWithdrawals)).toHaveLength(1);
          expect(Object.keys(expected.platePlanVersions)).toHaveLength(0);
        }
        const history = (
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
        expect(owner.platePlanVersions(scope)).toMatchObject({
          kind: 'ready',
          versions: [],
          identity: null,
        });
        expect(
          owner.platePlanVersion({
            ...scope,
            versionId: 'plate-plan-version:' + '0'.repeat(64),
            definitionSha256: 'sha256:' + '0'.repeat(64),
          })
        ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_PLATE_PLAN_VERSION_NOT_FOUND' });
        const retry = async (request: InventoryAcceptedRequest) => {
          if (!('kind' in request)) return owner.execute(request);
          switch (request.kind) {
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
      expect(
        (db.prepare('SELECT count(*) AS count FROM inventory_journal').get() as { count: number })
          .count
      ).toBe(213);
      const v8 = (
        db.prepare('SELECT receipt_json FROM inventory_journal').all() as { receipt_json: string }[]
      )
        .map((row) => JSON.parse(row.receipt_json))
        .filter((receipt) => receipt.context?.version === 8);
      expect(v8).toHaveLength(3);
      expect(v8.filter((receipt) => receipt.context.scientificSource)).toHaveLength(2);
      expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
      expect(raw() === before).toBe(true);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
