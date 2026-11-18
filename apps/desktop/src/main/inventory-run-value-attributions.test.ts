// @vitest-environment node
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  canonicalProtocolJson,
  parseProtocolPackage,
  parseInventoryState,
  type InventoryRunValueAttributionChoices,
} from '@waypoint/domain-services';
import * as wire from '../shared/inventory-run-value-attributions';
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
import { createNativeProtocolPackages } from './native-protocol-packages';
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { replayNativeInventoryJournal, applyNativeInventoryAdoption } from './inventory-archive';
import {
  parseNativeInventoryJournalEntry,
  nativeInventoryRequestDigest,
} from './inventory-journal';

it('records exact saved values as terminal metadata with native file HTTP recovery, current comparison and adopted source proof', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-run-attribution-'))),
    path = join(root, 'project'),
    copyPath = join(root, 'copy');
  mkdirSync(path);
  mkdirSync(copyPath);
  db = openFileTestDb(join(root, 'catalog.sqlite'));
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  try {
    ensureSchema(db, join(root, 'catalog.sqlite'));
    for (const [id, projectId, projectPath] of [
      [61, 'attribution-project', path],
      [62, 'copy-project', copyPath],
    ] as const)
      db.prepare(
        "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(?, 'Attribution project',?,?,'writable',1)"
      ).run(id, projectPath, projectId);
    rememberOriginalDefaultProject(db, 61);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema','entity','science','Science','{}','schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-v1','schema',1,'{}',1)"
    ).run();
    for (const [id, workspace] of [
      ['material', 61],
      ['mapped-material', 62],
    ] as const)
      db.prepare(
        "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES(?,'record','schema','schema-v1','Material','{}',?,'registered',1,1)"
      ).run(id, workspace);
    db.prepare('UPDATE lims_entity SET fields=? WHERE id=?').run(
      JSON.stringify({ sequence: { mode: 'file', workspaceId: 62 } }),
      'mapped-material'
    );
    const projectAuthority = createRegisteredProjectAuthority({
        db: () => db,
        managedRootDir: () => join(root, 'managed'),
      }),
      workspaces = new NativeDocumentWorkspaces({ authority: projectAuthority });
    const protocols = createNativeProtocolPackages({
      db: () => db,
      projectAuthority,
      workspaces,
      profileDirectory: () => join(root, 'profile'),
      actor: () => 'native:attribution',
    });
    const ready = (result: Awaited<ReturnType<typeof protocols.createProtocol>>) => {
      expect(result.kind, JSON.stringify(result)).toBe('ready');
      if (result.kind !== 'ready') throw Error(JSON.stringify(result));
      return result.package;
    };
    const scope = { project: 'attribution-project', inventoryId: 'inventory' },
      foreign = { project: 'copy-project', inventoryId: 'copy' };
    const template = ready(
      await protocols.createProtocol({
        project: scope.project,
        requestId: 'template',
        title: 'Manual preparation',
      })
    );
    const oldRun = ready(
      await protocols.startRun({
        project: scope.project,
        requestId: 'old-run',
        title: 'Physical preparation',
        protocolId: template.entityId,
        expectedSourceSha256: template.sourceSha256,
      })
    );
    let run = ready(
      await protocols.startRun({
        project: scope.project,
        requestId: 'values-run',
        title: 'Recorded results',
        protocolId: template.entityId,
        expectedSourceSha256: template.sourceSha256,
      })
    );
    run = ready(
      await protocols.recordRunValues({
        project: scope.project,
        entityId: run.entityId,
        requestId: 'value-zero',
        expectedSourceSha256: run.sourceSha256,
        choices: {
          reason: 'Operator entered demonstration values',
          upserts: [
            {
              collection: 'outputs',
              key: 'score',
              label: 'Recorded score',
              value: { type: 'number', value: 0 },
              origin: { kind: 'local-actual' },
            },
            {
              collection: 'measurements',
              key: 'flag',
              label: 'Recorded flag',
              value: { type: 'boolean', value: false },
              origin: { kind: 'local-actual' },
            },
          ],
        },
      })
    );
    const rowRaw = parseProtocolPackage(run.originalText).raw;
    ((rowRaw.outputs as Record<string, unknown>[])[0].value as Record<string, unknown>).opaque = {
      keep: [0, false, 'exact'],
    };
    (rowRaw.outputs as Record<string, unknown>[])[0].opaque = 'row';
    rowRaw.inputs = [
      {
        key: 'quantity',
        label: 'Readonly quantity',
        value: {
          type: 'quantity',
          lexical: '4uL',
          value: 4,
          unit: 'uL',
          unitCompatibility: 'recognized',
        },
      },
    ];
    run = ready(
      await protocols.savePackage({
        project: scope.project,
        entityId: run.entityId,
        requestId: 'raw-extras',
        expectedSourceSha256: run.sourceSha256,
        originalText: canonicalProtocolJson(rowRaw) + '\n',
      })
    );
    let captures = 0,
      now = 1000;
    const sourceOwner: Pick<typeof protocols, 'listPackages' | 'withSavedRunSource'> = {
      listPackages: protocols.listPackages,
      withSavedRunSource: (project, runId, action) =>
        protocols.withSavedRunSource(project, runId, (capture) => {
          captures++;
          return action({ ...capture, sourceSha256: `sha256:${'f'.repeat(64)}` });
        }),
    };
    const make = () =>
      createNativeInventoryOwner({
        db: () => db,
        projectAuthority,
        protocolSources: sourceOwner,
        profileKey: 'a'.repeat(64),
        actor: () => 'native:attribution',
        now: () => now,
      });
    const owner = make();
    owner.initialize();
    expect(
      owner.execute({
        ...scope,
        operationId: 'physical',
        expectedRevision: 0,
        commands: [
          {
            kind: 'create-layout-storage',
            id: 'plate',
            name: 'Plate',
            layout: { kind: 'fixed-well', rows: 2, columns: 3 },
            placement: { kind: 'root' },
          },
          { kind: 'create-vessel', id: 'vial', name: 'Vial', placement: { kind: 'unplaced' } },
          {
            kind: 'receive-stock',
            id: 'stock',
            vesselId: 'vial',
            materialId: 'material',
            quantity: { kind: 'known', value: '16', unit: 'uL' },
            quality: 'usable',
          },
        ],
      }).status
    ).toBe('committed');
    const planChoices = {
      identity: { namespace: 'plans', planId: 'one' },
      reason: 'Instructions',
      definition: {
        schema: 'dnaforge.inventory-plate-plan-definition.v1' as const,
        title: 'One manual transfer',
        layout: { kind: 'fixed-well' as const, rows: 2, columns: 3 },
        sourceSlots: [{ key: 'sample', label: 'Sample' }],
        transfers: [
          {
            actionId: 'dispense',
            sourceSlotKey: 'sample',
            destinationPosition: 'A3',
            quantity: { value: '4', unit: 'uL' as const },
            label: 'Aliquot',
          },
        ],
      },
    };
    const plan = owner.previewPlatePlanVersion({
      ...scope,
      expectedRevision: 1,
      choices: planChoices,
    });
    if (plan.kind !== 'ready') throw Error(JSON.stringify(plan));
    expect(
      owner.applyPlatePlanVersion({
        ...scope,
        kind: 'save-plate-plan-version',
        operationId: 'plan',
        expectedRevision: 1,
        expectedPlanDigest: plan.planDigest,
        choices: planChoices,
      }).status
    ).toBe('committed');
    const version = Object.values(owner.inspect(scope)!.platePlanVersions)[0];
    const physicalChoices = {
      identity: { namespace: 'manual', observationId: 'old-context' },
      context: {
        kind: 'protocol-run' as const,
        entityId: oldRun.entityId,
        sourceSha256: oldRun.sourceSha256,
      },
      binding: {
        versionId: version.id,
        definitionSha256: version.definitionSha256,
        destinationPlateId: 'plate',
        sources: [{ sourceSlotKey: 'sample', stockId: 'stock' }],
      },
      reason: 'Operator reports completed transfer',
    };
    const pp = await owner.previewPlatePlanObservation({
      ...scope,
      expectedRevision: 2,
      choices: physicalChoices,
    });
    if (pp.kind !== 'ready') throw Error(JSON.stringify(pp));
    expect(
      (
        await owner.applyPlatePlanObservation({
          ...scope,
          kind: 'record-plate-plan-observation',
          operationId: 'observed',
          expectedRevision: 2,
          expectedPlanDigest: pp.planDigest,
          choices: physicalChoices,
        })
      ).status
    ).toBe('committed');
    const physicalObservation = Object.values(owner.inspect(scope)!.platePlanObservations)[0];
    const physicalState = () => {
      const {
        schema: _,
        revision: __,
        lastRecordedAt: ___,
        runValueAttributions: ____,
        runValueAttributionWithdrawals: _____,
        ...physical
      } = owner.inspect(scope)!;
      return physical;
    };
    const raw = () =>
      JSON.stringify({
        states: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
        history: db.prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision').all(),
      });
    const beforePhysical = physicalState(),
      runBytes = readFileSync(run.path),
      oldBytes = readFileSync(oldRun.path),
      before = raw();
    const authority = { ownerInstanceId: 'attribution-owner', token: 'attribution-token' },
      agent = { identityId: 'operator', capabilities: ['read-workspace', 'write-workspace'] },
      projectScope = { kind: 'project-roots' as const, roots: [path, copyPath] };
    let onGrant: (() => void) | undefined;
    server = await startNativeDocumentCommandServer({
      owner: { inspect: vi.fn(), apply: vi.fn(), close: vi.fn() },
      inventory: owner,
      projectAuthority,
      getAuthority: () => authority,
      authorizeInventoryAgent: async () => {
        onGrant?.();
      },
    });
    const envelope = (command: string, request: unknown, capabilities = agent.capabilities) => ({
      ownerInstanceId: authority.ownerInstanceId,
      projectScope,
      command: 'inventory.' + command,
      request,
      agent: { ...agent, capabilities },
    });
    const call = async (
      command: string,
      request: unknown,
      key = 'result',
      capabilities?: string[]
    ) => {
      const response = await fetch(server!.url + '/internal/native-documents/call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DNAForge-Native-Document-Authority': authority.token,
        },
        body: JSON.stringify(envelope(command, request, capabilities)),
      });
      const body = await response.json();
      return { status: response.status, value: body.result?.[key], result: body.result };
    };
    const candidates = wire.inventoryRunValueCandidatesReadSchema.parse(
      (await call('run-value-candidates', { ...scope, runId: run.entityId, limit: 1 })).value
    );
    if (candidates.kind !== 'ready') throw Error(JSON.stringify(candidates));
    expect(candidates.run.sourceSha256).not.toBe(`sha256:${'f'.repeat(64)}`);
    expect(candidates.rows[0].eligibility.kind).toBe('unsupported');
    expect(candidates.nextCursor).not.toBeNull();
    const next = wire.inventoryRunValueCandidatesReadSchema.parse(
      (
        await call('run-value-candidates', {
          ...scope,
          runId: run.entityId,
          limit: 1,
          cursor: candidates.nextCursor,
        })
      ).value
    );
    if (next.kind !== 'ready') throw Error(JSON.stringify(next));
    const candidate = next.rows[0];
    expect(candidate.row).toEqual((rowRaw.outputs as unknown[])[0]);
    const choices: InventoryRunValueAttributionChoices = {
      identity: { namespace: 'results', attributionId: 'one' },
      runValue: {
        entityId: run.entityId,
        sourceSha256: next.run.sourceSha256,
        collection: candidate.collection,
        key: candidate.key,
        rowSha256: candidate.rowSha256,
      },
      physical: {
        observationId: physicalObservation.id,
        observationIntentSha256: physicalObservation.intentSha256,
        subject: {
          kind: 'output-action',
          actionId: 'dispense',
          stockId: physicalObservation.effects.destinations[0].after.id,
        },
      },
      predecessor: null,
      reason: 'This recorded value describes the selected aliquot',
    };
    expect(physicalObservation.context.entityId).not.toBe(choices.runValue.entityId);
    const preview = wire.inventoryRunValueAttributionPreviewSnapshotSchema.parse(
      (
        await call(
          'preview-run-value-attribution',
          { ...scope, expectedRevision: 3, choices },
          'preview'
        )
      ).value
    );
    if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
    expect(raw()).toBe(before);
    const request: wire.InventoryApplyRunValueAttributionRequest = {
      ...scope,
      kind: 'record-run-value-attribution',
      operationId: 'lost-ack',
      expectedRevision: 3,
      choices,
      expectedPlanDigest: preview.planDigest,
    };
    expect(
      (await call('apply-run-value-attribution', request, 'execution', ['read-workspace'])).result
    ).toMatchObject({ ok: false, stateChanged: false });
    expect(
      (
        await call(
          'preview-run-value-attribution',
          { ...scope, expectedRevision: 3, choices, source: { originalText: 'forged' } },
          'preview'
        )
      ).status
    ).toBe(400);
    const address = new URL(server.url),
      socket = createConnection({ host: address.hostname, port: Number(address.port) });
    socket.pause();
    socket.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const body = JSON.stringify(envelope('apply-run-value-attribution', request));
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
            '' + body,
          ].join('\r\n'),
          (e) => (e ? reject(e) : resolve())
        )
      );
      let receipt = null;
      for (let i = 0; i < 200 && !receipt; i++) {
        receipt = owner.operation({ ...scope, operationId: request.operationId });
        if (!receipt) await new Promise((r) => setTimeout(r, 5));
      }
      expect(receipt).toMatchObject({
        status: 'committed',
        revision: 4,
        context: {
          version: 11,
          scientificSource: {
            schema: 'dnaforge.protocol-run-saved-source.v1',
            originalText: run.originalText,
          },
        },
      });
      expect(socket.bytesRead).toBe(0);
    } finally {
      socket.destroy();
    }
    const record = Object.values(owner.inspect(scope)!.runValueAttributions)[0],
      pin = { ...scope, attributionId: record.id, intentSha256: record.intentSha256 };
    let detail = wire.inventoryRunValueAttributionReadSchema.parse(
      (await call('run-value-attribution', pin)).value
    );
    expect(detail).toMatchObject({
      kind: 'available',
      currentComparison: { kind: 'same-source' },
      attribution: { valueSnapshot: candidate.row },
      withdrawal: null,
    });
    expect(readFileSync(run.path)).toEqual(runBytes);
    expect(physicalState()).toEqual(beforePhysical);
    const change = async (value: number, id: string) => {
      const current = await protocols.readPackage({
        project: scope.project,
        entityId: run.entityId,
      });
      return ready(
        await protocols.recordRunValues({
          project: scope.project,
          entityId: run.entityId,
          requestId: id,
          expectedSourceSha256: current.sourceSha256,
          choices: {
            reason: 'Operator changes the recorded value',
            upserts: [
              {
                collection: 'outputs',
                key: 'score',
                label: 'Recorded score',
                value: { type: 'number', value },
                origin: { kind: 'local-actual' },
              },
            ],
          },
        })
      );
    };
    await change(1, 'value-one');
    detail = wire.inventoryRunValueAttributionReadSchema.parse(
      (await call('run-value-attribution', pin)).value
    );
    expect(detail).toMatchObject({
      kind: 'available',
      currentComparison: { kind: 'changed-row', row: { row: { value: { value: 1 } } } },
      attribution: { valueSnapshot: { value: { value: 0 } } },
    });
    expect(owner.inspect(scope)!.revision).toBe(4);
    expect(
      (
        await call('run-value-candidates', {
          ...scope,
          runId: run.entityId,
          cursor: candidates.nextCursor,
        })
      ).value
    ).toMatchObject({ kind: 'unavailable', code: 'INVENTORY_QUERY_STALE' });
    const wdChoices = {
      identity: { namespace: 'corrections', withdrawalId: 'wrong' },
      attributionId: record.id,
      attributionIntentSha256: record.intentSha256,
      reason: 'Replace this assertion explicitly',
    };
    renameSync(run.path, run.path + '.retained');
    const captureBefore = captures;
    const wp = wire.inventoryRunValueAttributionWithdrawalPreviewSnapshotSchema.parse(
      (
        await call(
          'preview-run-value-attribution-withdrawal',
          { ...scope, expectedRevision: 4, choices: wdChoices },
          'preview'
        )
      ).value
    );
    if (wp.kind !== 'ready') throw Error(JSON.stringify(wp));
    expect(
      (
        await call(
          'apply-run-value-attribution-withdrawal',
          {
            ...scope,
            kind: 'withdraw-run-value-attribution',
            operationId: 'withdraw',
            expectedRevision: 4,
            choices: wdChoices,
            expectedPlanDigest: wp.planDigest,
          },
          'execution'
        )
      ).value
    ).toMatchObject({ status: 'committed', revision: 5 });
    expect(captures).toBe(captureBefore);
    expect((await owner.applyRunValueAttribution(request)).status).toBe('committed');
    expect(
      await owner.previewRunValueAttribution({
        ...scope,
        expectedRevision: 5,
        choices: { ...choices, identity: { namespace: 'fresh', attributionId: 'duplicate' } },
      })
    ).toMatchObject({ kind: 'no-change', entry: { withdrawal: { reason: wdChoices.reason } } });
    expect(captures).toBe(captureBefore);
    expect(
      wire.inventoryRunValueAttributionSourceReadSchema.parse(
        (await call('run-value-attribution-source', pin)).value
      )
    ).toMatchObject({ kind: 'available', source: { originalText: run.originalText } });
    renameSync(run.path + '.retained', run.path);
    await change(0, 'value-zero-again');
    expect(readFileSync(run.path)).toEqual(runBytes);
    detail = wire.inventoryRunValueAttributionReadSchema.parse(
      (await call('run-value-attribution', pin)).value
    );
    expect(detail).toMatchObject({
      kind: 'available',
      currentComparison: { kind: 'same-source' },
      withdrawal: { reason: wdChoices.reason },
    });
    const wd = Object.values(owner.inspect(scope)!.runValueAttributionWithdrawals)[0],
      child = {
        ...choices,
        identity: { namespace: 'results', attributionId: 'corrected' },
        predecessor: {
          attributionId: record.id,
          attributionIntentSha256: record.intentSha256,
          withdrawalId: wd.id,
          withdrawalIntentSha256: wd.intentSha256,
        },
        reason: 'Explicit successor of the withdrawn assertion',
      };
    const cp = await owner.previewRunValueAttribution({
      ...scope,
      expectedRevision: 5,
      choices: child,
    });
    if (cp.kind !== 'ready') throw Error(JSON.stringify(cp));
    expect(
      (
        await owner.applyRunValueAttribution({
          ...scope,
          kind: 'record-run-value-attribution',
          operationId: 'child',
          expectedRevision: 5,
          choices: child,
          expectedPlanDigest: cp.planDigest,
        })
      ).status
    ).toBe('committed');
    const list = wire.inventoryRunValueAttributionsReadSchema.parse(
      (
        await call('run-value-attributions', {
          ...scope,
          run: { entityId: run.entityId },
          slot: { collection: 'outputs', key: 'score' },
          limit: 1,
        })
      ).value
    );
    if (list.kind !== 'ready') throw Error(JSON.stringify(list));
    expect(list.entries).toHaveLength(1);
    const secondPage = wire.inventoryRunValueAttributionsReadSchema.parse(
      (
        await call('run-value-attributions', {
          ...scope,
          run: { entityId: run.entityId },
          slot: { collection: 'outputs', key: 'score' },
          cursor: list.nextCursor,
        })
      ).value
    );
    if (secondPage.kind !== 'ready') throw Error(JSON.stringify(secondPage));
    const pages = [...list.entries, ...secondPage.entries];
    expect(new Set(pages.map((row) => row.attribution.id))).toEqual(
      new Set([record.id, cp.attribution.id])
    );
    expect(pages.find((row) => row.attribution.id === record.id)?.withdrawal?.reason).toBe(
      wdChoices.reason
    );
    expect(pages.find((row) => row.attribution.id === cp.attribution.id)?.withdrawal).toBeNull();
    const beforeGuards = raw(),
      newChoices = {
        ...choices,
        identity: { namespace: 'results', attributionId: 'different-subject' },
        physical: {
          ...choices.physical,
          subject: { kind: 'source-stock' as const, stockId: 'stock' },
        },
      };
    const sp = await owner.previewRunValueAttribution({
      ...scope,
      expectedRevision: 6,
      choices: newChoices,
    });
    if (sp.kind !== 'ready') throw Error(JSON.stringify(sp));
    const changedRequest = {
      ...scope,
      kind: 'record-run-value-attribution' as const,
      operationId: 'late-source',
      expectedRevision: 6,
      choices: newChoices,
      expectedPlanDigest: sp.planDigest,
    };
    await expect(
      owner.applyRunValueAttribution(changedRequest, () => {}, {
        beforeScientificCommit: async () => {
          writeFileSync(run.path, run.originalText.replace('Recorded results', 'Late results'));
        },
      })
    ).rejects.toThrow();
    expect(raw()).toBe(beforeGuards);
    writeFileSync(run.path, run.originalText);
    await expect(
      owner.applyRunValueAttribution({ ...changedRequest, operationId: 'late-grant' }, () => {}, {
        beforeScientificCommit: async () => {
          throw Error('Grant revoked');
        },
      })
    ).rejects.toThrow('Grant revoked');
    expect(raw()).toBe(beforeGuards);
    let reads = 0;
    onGrant = () => {
      if (++reads === 2) throw Error('INVENTORY_CAPABILITY_DENIED: Read revoked');
    };
    expect((await call('run-value-attribution', pin)).result).toMatchObject({
      ok: false,
      stateChanged: false,
    });
    onGrant = undefined;
    expect(raw()).toBe(beforeGuards);
    const archive = owner.exportSnapshot({ ...scope, format: 'native-v1' }),
      importOptions = {
        bindings: [{ sourceMaterialId: 'material', destinationMaterialId: 'mapped-material' }],
      };
    const ip = owner.previewImport({
      ...foreign,
      sourceText: archive.sourceText,
      options: importOptions,
    });
    if (ip.kind !== 'ready') throw Error(JSON.stringify(ip));
    const adopt = {
      ...foreign,
      kind: 'adopt-archive' as const,
      operationId: 'copy',
      expectedRevision: 0,
      sourceText: archive.sourceText,
      options: ip.options,
      expectedPlanDigest: ip.planDigest,
    };
    expect(owner.applyImport(adopt).status).toBe('committed');
    const beforeForeignCapture = captures;
    expect(
      await owner.runValueAttribution({
        ...pin,
        project: foreign.project,
        inventoryId: foreign.inventoryId,
      })
    ).toMatchObject({
      kind: 'available',
      currentComparison: { kind: 'unavailable', code: 'FOREIGN_RUN_CONTEXT' },
    });
    expect(captures).toBe(beforeForeignCapture);
    expect(
      owner.runValueAttributionSource({
        ...pin,
        project: foreign.project,
        inventoryId: foreign.inventoryId,
      })
    ).toMatchObject({ kind: 'available', source: { originalText: run.originalText } });
    const context = {
      at: now,
      principal: { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
      authority: { kind: 'local-profile' as const, profileKey: 'a'.repeat(64) },
    };
    expect(() =>
      applyNativeInventoryAdoption(null, adopt, context, 0, { receiptContextVersion: 10 })
    ).toThrow();
    expect(() =>
      applyNativeInventoryAdoption(null, adopt, context, 0, {
        receiptContextVersion: 11,
        allowRunValueAttributions: false,
      })
    ).toThrow();
    const nested = owner.exportSnapshot({ ...foreign, format: 'native-v1' });
    const nestedScope = { ...scope, inventoryId: 'nested-copy' };
    const nestedPreview = owner.previewImport({
      ...nestedScope,
      sourceText: nested.sourceText,
      options: {
        bindings: [{ sourceMaterialId: 'mapped-material', destinationMaterialId: 'material' }],
      },
    });
    if (nestedPreview.kind !== 'ready') throw Error(JSON.stringify(nestedPreview));
    expect(() =>
      applyNativeInventoryAdoption(
        null,
        {
          ...nestedScope,
          kind: 'adopt-archive',
          operationId: 'nested-old-outer',
          expectedRevision: 0,
          sourceText: nested.sourceText,
          options: nestedPreview.options,
          expectedPlanDigest: nestedPreview.planDigest,
        },
        context,
        0,
        { receiptContextVersion: 10 }
      )
    ).toThrow();
    const entries = (
      db
        .prepare('SELECT * FROM inventory_journal WHERE inventory_id=? ORDER BY revision')
        .all(scope.inventoryId) as {
        inventory_id: string;
        operation_id: string;
        revision: number;
        request_json: string;
        receipt_json: string;
      }[]
    ).map((row) =>
      parseNativeInventoryJournalEntry(row, scope.project, {
        request: JSON.parse(row.request_json),
        receipt: JSON.parse(row.receipt_json),
      })
    );
    const attached = entries.find(
      (row) => 'kind' in row.request && row.request.kind === 'record-run-value-attribution'
    )!;
    expect(() =>
      parseNativeInventoryJournalEntry(
        {
          inventory_id: scope.inventoryId,
          operation_id: attached.request.operationId,
          revision: attached.receipt.revision,
        },
        scope.project,
        {
          request: attached.request,
          receipt: { ...attached.receipt, context: { ...attached.receipt.context, version: 10 } },
        }
      )
    ).toThrow();
    expect(() =>
      replayNativeInventoryJournal(entries, 0, { allowRunValueAttributions: false })
    ).toThrow();
    expect(replayNativeInventoryJournal(entries)).toEqual(owner.inspect(scope));
    expect(make().runValueAttributionSource(pin)).toMatchObject({
      kind: 'available',
      source: { originalText: run.originalText },
    });
    expect(physicalState()).toEqual(beforePhysical);
    expect(readFileSync(run.path)).toEqual(runBytes);
    expect(readFileSync(oldRun.path)).toEqual(oldBytes);
  } finally {
    await server?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.runIf(Boolean(process.env.INVENTORY_RUN_VALUE_ATTRIBUTION_ACTUAL_DB))(
  'retries and replays all copied actual 216 receipts with zero SQL and raw-byte changes',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-run-attribution-actual-'))),
      path = join(root, 'catalog.sqlite');
    copyFileSync(process.env.INVENTORY_RUN_VALUE_ATTRIBUTION_ACTUAL_DB!, path);
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
        expect(Object.keys(expected.runValueAttributions)).toHaveLength(0);
        expect(Object.keys(expected.runValueAttributionWithdrawals)).toHaveLength(0);
        expect(owner.runValueAttributions(scope)).toMatchObject({
          kind: 'ready',
          entries: [],
          filters: { run: null, slot: null },
        });
        if (JSON.parse(row.state_json).schema === 'dnaforge.inventory.v27') {
          expect(expected.revision).toBe(99);
          expect(Object.keys(expected.platePlanObservations)).toHaveLength(1);
        }
        const retry = (request: InventoryAcceptedRequest) => {
          if (!('kind' in request)) return owner.execute(request);
          switch (request.kind) {
            case 'record-run-value-attribution':
              return owner.applyRunValueAttribution(request);
            case 'withdraw-run-value-attribution':
              return owner.applyRunValueAttributionWithdrawal(request);
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
      expect(receipts).toHaveLength(216);
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
