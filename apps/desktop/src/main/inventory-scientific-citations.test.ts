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
  parseInventoryState,
  inventoryScientificCitationChoices,
  inventoryScientificCitationWithdrawalChoices,
  type InventoryScientificCitationChoices,
  type InventoryScientificCitationPredecessor,
} from '@waypoint/domain-services';
import type {
  InventoryApplyScientificCitationRequest,
  InventoryApplyScientificCitationWithdrawalRequest,
} from '../shared/inventory-scientific-citations';
import {
  inventoryScientificCitationPreviewSnapshotSchema,
  inventoryScientificCitationWithdrawalPreviewSnapshotSchema,
  inventoryScientificCitationsReadSchema,
  inventoryScientificCitationSourceReadSchema,
} from '../shared/inventory-scientific-citations';
import type {
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from '../shared/inventory-command';
let db: Database.Database;
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp', getVersion: () => 'test' },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('./ipc/database', () => ({ getDb: () => db }));
import { openFileTestDb, openReadonlyFileTestDb } from './__tests__/test-db';
import { ensureSchema } from './schema';
import { rememberOriginalDefaultProject } from './original-default-project';
import { createRegisteredProjectAuthority } from './registered-project-authority';
import { NativeDocumentWorkspaces } from './native-document-workspaces';
import { createNativeNotebookWorkingCopies } from './native-notebook-working-copies';
import { createNativeProtocolPackages } from './native-protocol-packages';
import { createNativeInventoryOwner } from './inventory-owner';
import { startNativeDocumentCommandServer } from './native-document-command-server';
import { parseNativeInventoryJournalEntry } from './inventory-journal';
import { notebookPackagePaths } from '../db/notebook-package';
import { replayNativeInventoryJournal, applyNativeInventoryAdoption } from './inventory-archive';

it('retains one real saved citation through zero-byte lost acknowledgement, terminal withdrawals and explicit generations without physical effects', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-citation-owner-'))),
    projectPath = join(root, 'project'),
    dbPath = join(root, 'catalog.sqlite');
  mkdirSync(projectPath);
  db = openFileTestDb(dbPath);
  let server: Awaited<ReturnType<typeof startNativeDocumentCommandServer>> | undefined;
  const scope = { project: 'citation-project', inventoryId: 'inventory' };
  try {
    ensureSchema(db, dbPath);
    db.prepare(
      "INSERT INTO workspaces(id,name,path,repo_uuid,access_mode,created_at) VALUES(41,'Citations',?,'citation-project','writable',1)"
    ).run(projectPath);
    rememberOriginalDefaultProject(db, 41);
    db.prepare(
      "INSERT INTO lims_schema(id,kind,name,display_name,fields,current_revision_id,created_at,updated_at) VALUES('schema','entity','science','Science','{}','schema-v1',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_schema_revision(id,schema_id,version,fields,created_at) VALUES('schema-v1','schema',1,'{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO lims_entity(id,kind,schema_id,schema_revision_id,name,fields,workspace_id,registration_status,created_at,updated_at) VALUES('material','record','schema','schema-v1','Material','{}',41,'registered',1,1)"
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
      title: 'Saved supporting Notebook',
      workspaceRoot: projectPath,
      requestId: 'support-page',
    });
    const protocols = createNativeProtocolPackages({
      db: () => db,
      projectAuthority,
      workspaces,
      profileDirectory: () => join(root, 'profile'),
      actor: () => 'native:citation-proof',
    });
    const template = await protocols.createProtocol({
      project: scope.project,
      requestId: 'template-once',
      title: 'Manual protocol',
    });
    if (template.kind !== 'ready') throw Error(JSON.stringify(template));
    const started = await protocols.startRun({
      project: scope.project,
      requestId: 'run-once',
      protocolId: template.package.entityId,
      expectedSourceSha256: template.package.sourceSha256,
      title: 'Run with observed work',
    });
    if (started.kind !== 'ready') throw Error(JSON.stringify(started));
    const makeOwner = () =>
      createNativeInventoryOwner({
        db: () => db,
        projectAuthority,
        notebookSources: notebook,
        protocolSources: protocols,
        profileKey: 'a'.repeat(64),
        actor: () => 'native:citation-proof',
        now: () => 1000,
      });
    let owner = makeOwner();
    owner.initialize();
    const seed = owner.execute({
      ...scope,
      operationId: 'seed-once',
      expectedRevision: 0,
      commands: [
        { kind: 'create-vessel', id: 'vial', name: 'Source', placement: { kind: 'unplaced' } },
        {
          kind: 'create-layout-storage',
          id: 'plate',
          name: 'Plate',
          layout: { kind: 'fixed-well', rows: 1, columns: 2 },
          placement: { kind: 'root' },
        },
        {
          kind: 'receive-stock',
          id: 'stock',
          vesselId: 'vial',
          materialId: 'material',
          quantity: { kind: 'known', value: '100', unit: 'uL' },
          quality: 'usable',
        },
      ],
    });
    expect(seed.status).toBe('committed');
    const physical = {
      identity: { namespace: 'manual', workId: 'physical-once' },
      context: {
        kind: 'protocol-run',
        entityId: started.package.entityId,
        sourceSha256: started.package.sourceSha256,
      },
      sourceStockId: 'stock',
      destinationVesselId: 'well:plate#A2',
      quantity: { value: '10', unit: 'uL' },
      reason: 'Completed manual transfer',
    };
    const workPreview = await owner.previewScientificTransferV2({
      ...scope,
      expectedRevision: 1,
      choices: physical,
    });
    if (workPreview.kind !== 'ready') throw Error(JSON.stringify(workPreview));
    expect(
      (
        await owner.applyScientificTransferV2({
          ...scope,
          kind: 'record-scientific-transfer-v2',
          operationId: 'physical-once',
          expectedRevision: 1,
          choices: physical,
          expectedPlanDigest: workPreview.planDigest,
        })
      ).status
    ).toBe('committed');
    const physicalState = owner.inspect(scope)!,
      work = Object.values(physicalState.scientificWorks)[0];
    const notebookRoot = (
      db
        .prepare("SELECT path FROM catalog_entity_files WHERE entity_id=? AND status='current'")
        .get(page.pageId) as { path: string }
    ).path;
    const notebookPaths = notebookPackagePaths(notebookRoot),
      notebookPath = notebookPaths.metaPath;
    const sourceFiles = [
        notebookPath,
        notebookPaths.markdownPath,
        template.package.path,
        started.package.path,
      ],
      sourceBytes = sourceFiles.map((path) => readFileSync(path));
    const authority = { ownerInstanceId: 'citation-owner', token: 'synthetic-citation-token' },
      agent = {
        identityId: 'citation-writer',
        capabilities: ['read-workspace', 'write-workspace'],
      },
      projectScope = { kind: 'project-roots' as const, roots: [projectPath] };
    server = await startNativeDocumentCommandServer({
      owner: {
        inspect: async () => {
          throw Error('Unrelated annotation');
        },
        apply: async () => {
          throw Error('Unrelated annotation');
        },
        close: async () => {},
      },
      inventory: owner,
      projectAuthority,
      getAuthority: () => authority,
      authorizeInventoryAgent: async () => {},
    });
    const call = async (command: string, request: unknown, key: string) => {
      const response = await fetch(server!.url + '/internal/native-documents/call', {
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
      const body = (await response.json()) as {
        ok: boolean;
        error?: unknown;
        result?: Record<string, unknown>;
      };
      expect(body.ok, JSON.stringify(body.error)).toBe(true);
      return body.result![key];
    };
    const raw = () =>
      JSON.stringify({
        state: db.prepare('SELECT * FROM inventory_state').all(),
        history: db.prepare('SELECT * FROM inventory_journal ORDER BY revision').all(),
      });
    const savedPages = await notebook.savedSources(scope.project, '', 20),
      saved = savedPages.find((row) => row.pageId === page.pageId)!;
    const choices: InventoryScientificCitationChoices = {
      identity: { namespace: 'support', citationId: 'citation-once' },
      workId: work.id,
      workIntentSha256: work.intentSha256,
      context: { kind: 'notebook-page', entityId: page.pageId, sourceSha256: saved.sourceSha256 },
      reinstates: null,
      reason: 'Saved support for observed work',
    };
    const citationRequest = async (
      input: InventoryScientificCitationChoices,
      operationId: string
    ): Promise<InventoryApplyScientificCitationRequest> => {
      const before = raw(),
        revision = owner.inspect(scope)!.revision;
      const preview = inventoryScientificCitationPreviewSnapshotSchema.parse(
        await call(
          'inventory.preview-scientific-citation',
          { ...scope, expectedRevision: revision, choices: input },
          'preview'
        )
      );
      expect(raw() === before).toBe(true);
      if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
      return {
        ...scope,
        kind: 'record-scientific-citation',
        expectedRevision: revision,
        operationId,
        choices: input,
        expectedPlanDigest: preview.planDigest,
      };
    };
    const request = await citationRequest(choices, 'cite-operation-once');
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
        command: 'inventory.apply-scientific-citation',
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
      expect(receipt?.context?.version).toBe(8);
      expect(socket.bytesRead).toBe(0);
    } finally {
      socket.destroy();
    }
    expect(await call('inventory.apply-scientific-citation', request, 'execution')).toEqual(
      receipt
    );
    owner = makeOwner();
    const base = Object.values(owner.inspect(scope)!.scientificCitations)[0];
    const citedRead = inventoryScientificCitationsReadSchema.parse(
      owner.scientificCitations({ ...scope, workId: work.id, workIntentSha256: work.intentSha256 })
    );
    expect(citedRead).toMatchObject({
      kind: 'ready',
      entries: [{ citation: base, withdrawal: null }],
    });
    expect(
      owner.scientificWorksForContext({
        ...scope,
        context: { kind: 'notebook-page', entityId: page.pageId },
      })
    ).toMatchObject({ kind: 'ready', works: [] });
    const retained = inventoryScientificCitationSourceReadSchema.parse(
      owner.scientificCitationSource({ ...scope, citationId: base.id })
    );
    expect(retained.kind).toBe('available');
    const missingPath = notebookPath + '.temporarily-unavailable';
    renameSync(notebookPath, missingPath);
    let withdrawn: ReturnType<typeof inventoryScientificCitationWithdrawalChoices>;
    try {
      const before = raw();
      expect(
        await owner.applyScientificCitation({
          ...request,
          operationId: 'duplicate-with-current-source-missing',
          expectedRevision: owner.inspect(scope)!.revision,
          choices: {
            ...choices,
            identity: { ...choices.identity, citationId: 'fresh-base-duplicate' },
          },
        })
      ).toMatchObject({ status: 'rejected', code: 'INVENTORY_SCIENTIFIC_CITATION_NO_CHANGES' });
      expect(
        await owner.applyScientificCitation({
          ...request,
          choices: { ...choices, reason: 'Changed raw operation' },
        })
      ).toMatchObject({ status: 'rejected', code: 'INVENTORY_OPERATION_CONFLICT' });
      expect(
        await owner.applyScientificCitation({
          ...request,
          operationId: 'changed-citation-intent',
          choices: { ...choices, reason: 'Changed stable citation intent' },
        })
      ).toMatchObject({ status: 'rejected', code: 'SCIENTIFIC_CITATION_CONFLICT' });
      expect(raw() === before).toBe(true);
      const withdrawalChoices = {
        identity: { namespace: 'corrections', withdrawalId: 'withdraw-base' },
        citationId: base.id,
        citationIntentSha256: base.intentSha256,
        workId: work.id,
        workIntentSha256: work.intentSha256,
        reason: 'Supporting citation corrected',
      };
      const preview = inventoryScientificCitationWithdrawalPreviewSnapshotSchema.parse(
        await call(
          'inventory.preview-scientific-citation-withdrawal',
          {
            ...scope,
            expectedRevision: owner.inspect(scope)!.revision,
            choices: withdrawalChoices,
          },
          'preview'
        )
      );
      if (preview.kind !== 'ready') throw Error(JSON.stringify(preview));
      const withdrawalRequest: InventoryApplyScientificCitationWithdrawalRequest = {
        ...scope,
        kind: 'withdraw-scientific-citation',
        operationId: 'withdraw-operation-once',
        expectedRevision: owner.inspect(scope)!.revision,
        choices: withdrawalChoices,
        expectedPlanDigest: preview.planDigest,
      };
      const applied = (await call(
        'inventory.apply-scientific-citation-withdrawal',
        withdrawalRequest,
        'execution'
      )) as NativeInventoryExecution;
      expect(applied.status).toBe('committed');
      if (applied.status !== 'committed') throw Error(JSON.stringify(applied));
      expect(applied.context?.scientificSource).toBeUndefined();
      expect(
        await call('inventory.apply-scientific-citation-withdrawal', withdrawalRequest, 'execution')
      ).toEqual(applied);
      expect(owner.scientificCitationSource({ ...scope, citationId: base.id })).toEqual(retained);
      withdrawn = inventoryScientificCitationWithdrawalChoices(
        Object.values(owner.inspect(scope)!.scientificCitationWithdrawals)[0]
      );
    } finally {
      renameSync(missingPath, notebookPath);
    }
    const firstWithdrawal = Object.values(owner.inspect(scope)!.scientificCitationWithdrawals)[0];
    const reinstates: InventoryScientificCitationPredecessor = {
      citationId: base.id,
      citationIntentSha256: base.intentSha256,
      withdrawalId: firstWithdrawal.id,
      withdrawalIntentSha256: firstWithdrawal.intentSha256,
    };
    const childChoices = {
      ...choices,
      identity: { ...choices.identity, citationId: 'explicit-child' },
      reinstates,
    };
    const childRequest = await citationRequest(childChoices, 'child-operation');
    expect(
      (
        (await call(
          'inventory.apply-scientific-citation',
          childRequest,
          'execution'
        )) as NativeInventoryExecution
      ).status
    ).toBe('committed');
    const child = Object.values(owner.inspect(scope)!.scientificCitations).find(
      (row) => row.id !== base.id
    )!;
    const childWithdrawChoices = {
      ...withdrawn!,
      identity: { namespace: 'corrections', withdrawalId: 'withdraw-child' },
      citationId: child.id,
      citationIntentSha256: child.intentSha256,
    };
    const childWithdrawPreview = await owner.previewScientificCitationWithdrawal({
      ...scope,
      expectedRevision: owner.inspect(scope)!.revision,
      choices: childWithdrawChoices,
    });
    if (childWithdrawPreview.kind !== 'ready') throw Error(JSON.stringify(childWithdrawPreview));
    expect(
      (
        await owner.applyScientificCitationWithdrawal({
          ...scope,
          kind: 'withdraw-scientific-citation',
          operationId: 'withdraw-child-operation',
          expectedRevision: owner.inspect(scope)!.revision,
          choices: childWithdrawChoices,
          expectedPlanDigest: childWithdrawPreview.planDigest,
        })
      ).status
    ).toBe('committed');
    const historyBeforeDuplicates = raw();
    for (const input of [choices, childChoices])
      expect(
        await owner.applyScientificCitation({
          ...request,
          operationId: `old-generation-${input.identity.citationId}`,
          expectedRevision: owner.inspect(scope)!.revision,
          choices: {
            ...input,
            identity: { ...input.identity, citationId: `fresh-${input.identity.citationId}` },
          },
        })
      ).toMatchObject({ status: 'rejected', code: 'INVENTORY_SCIENTIFIC_CITATION_NO_CHANGES' });
    expect(raw() === historyBeforeDuplicates).toBe(true);
    const childWithdrawal = Object.values(owner.inspect(scope)!.scientificCitationWithdrawals).find(
      (row) => row.citationId === child.id
    )!;
    const nextChoices = {
      ...choices,
      identity: { ...choices.identity, citationId: 'next-explicit' },
      reinstates: {
        citationId: child.id,
        citationIntentSha256: child.intentSha256,
        withdrawalId: childWithdrawal.id,
        withdrawalIntentSha256: childWithdrawal.intentSha256,
      },
    };
    const nextPreview = await owner.previewScientificCitation({
      ...scope,
      expectedRevision: owner.inspect(scope)!.revision,
      choices: nextChoices,
    });
    if (nextPreview.kind !== 'ready') throw Error(JSON.stringify(nextPreview));
    const beforeFence = raw(),
      original = readFileSync(notebookPath);
    try {
      await expect(
        owner.applyScientificCitation(
          {
            ...scope,
            kind: 'record-scientific-citation',
            operationId: 'source-fenced',
            expectedRevision: owner.inspect(scope)!.revision,
            choices: nextChoices,
            expectedPlanDigest: nextPreview.planDigest,
          },
          () => {},
          {
            beforeScientificCommit: async () => {
              writeFileSync(notebookPath, '{}');
            },
          }
        )
      ).rejects.toThrow();
      expect(raw() === beforeFence).toBe(true);
    } finally {
      writeFileSync(notebookPath, original);
    }
    const final = owner.inspect(scope)!;
    for (const key of [
      'scientificWorks',
      'stocks',
      'storage',
      'vessels',
      'lots',
      'reservations',
    ] as const)
      expect(final[key]).toEqual(physicalState[key]);
    expect(sourceFiles.every((path, index) => readFileSync(path).equals(sourceBytes[index]))).toBe(
      true
    );
    const history = owner.history(scope);
    expect(replayNativeInventoryJournal(history)).toEqual(final);
    const first = history.find(
      (row) => 'kind' in row.request && row.request.kind === 'record-scientific-citation'
    )!;
    expect(() =>
      parseNativeInventoryJournalEntry(
        {
          inventory_id: scope.inventoryId,
          operation_id: first.request.operationId,
          revision: first.receipt.revision,
        },
        scope.project,
        {
          request: first.request,
          receipt: { ...first.receipt, context: { ...first.receipt.context, version: 7 } },
        }
      )
    ).toThrow('matching native source witness');
    const archive = owner.exportSnapshot({ ...scope, format: 'native-v1' });
    const adoptedScope = { ...scope, inventoryId: 'adopted-citations' };
    const importedPreview = owner.previewImport({
      ...adoptedScope,
      sourceText: archive.sourceText,
      options: { bindings: [{ sourceMaterialId: 'material', destinationMaterialId: 'material' }] },
    });
    if (importedPreview.kind !== 'ready') throw Error(JSON.stringify(importedPreview));
    expect(
      owner.applyImport({
        ...adoptedScope,
        kind: 'adopt-archive',
        operationId: 'adopt-citation-history',
        expectedRevision: 0,
        sourceText: archive.sourceText,
        options: importedPreview.options,
        expectedPlanDigest: importedPreview.planDigest,
      }).status
    ).toBe('committed');
    expect(owner.scientificCitationSource({ ...adoptedScope, citationId: base.id })).toEqual(
      retained
    );
    const withdrawnEntry = history.find(
      (row) => 'kind' in row.request && row.request.kind === 'withdraw-scientific-citation'
    )!;
    expect(() =>
      parseNativeInventoryJournalEntry(
        {
          inventory_id: scope.inventoryId,
          operation_id: withdrawnEntry.request.operationId,
          revision: withdrawnEntry.receipt.revision,
        },
        scope.project,
        {
          request: withdrawnEntry.request,
          receipt: {
            ...withdrawnEntry.receipt,
            context: {
              ...withdrawnEntry.receipt.context,
              scientificSource: first.receipt.context?.scientificSource,
            },
          },
        }
      )
    ).toThrow('Only scientific work');

    expect(() =>
      applyNativeInventoryAdoption(
        null,
        {
          ...scope,
          kind: 'adopt-archive',
          operationId: 'old-context-adoption',
          expectedRevision: 0,
          sourceText: archive.sourceText,
          options: { bindings: [] },
          expectedPlanDigest: `sha256:${'0'.repeat(64)}`,
        },
        {
          at: 1000,
          principal: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
          authority: { kind: 'local-profile', profileKey: 'a'.repeat(64) },
        },
        0,
        { receiptContextVersion: 7 }
      )
    ).toThrow('pre-V8');
  } finally {
    await server?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.runIf(Boolean(process.env.INVENTORY_CITATION_ACTUAL_DB))(
  'replays and reads the copied actual 210 receipts without rewriting raw v24 state or source packets',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dnaforge-citation-actual-'))),
      path = join(root, 'catalog.sqlite');
    copyFileSync(process.env.INVENTORY_CITATION_ACTUAL_DB!, path);
    db = openReadonlyFileTestDb(path);
    try {
      const raw = () =>
        JSON.stringify({
          state: db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all(),
          history: db
            .prepare('SELECT * FROM inventory_journal ORDER BY inventory_id,revision')
            .all(),
        });
      const before = raw(),
        bytes = readFileSync(path);
      const rows = db.prepare('SELECT * FROM inventory_state ORDER BY inventory_id').all() as {
        inventory_id: string;
        project_id: string;
        state_json: string;
      }[];
      for (const row of rows) {
        const expected = parseInventoryState(JSON.parse(row.state_json));
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
        if (!Object.keys(expected.scientificWorks).length) continue;
        const project = db
          .prepare('SELECT path FROM workspaces WHERE repo_uuid=?')
          .get(row.project_id) as { path: string };
        const projectAuthority = createRegisteredProjectAuthority({
            db: () => db,
            managedRootDir: () => dirname(dirname(project.path)),
          }),
          owner = createNativeInventoryOwner({
            db: () => db,
            projectAuthority,
            actor: () => 'native:read-oracle',
            profileKey: 'a'.repeat(64),
          });
        for (const work of Object.values(expected.scientificWorks))
          expect(
            owner.scientificCitations({
              project: row.project_id,
              inventoryId: row.inventory_id,
              workId: work.id,
              workIntentSha256: work.intentSha256,
            })
          ).toMatchObject({ kind: 'ready', entries: [] });
        for (const entry of history)
          expect(
            owner.operation({
              project: row.project_id,
              inventoryId: row.inventory_id,
              operationId: entry.request.operationId,
            })
          ).toEqual(entry.receipt);
      }
      expect(
        (db.prepare('SELECT count(*) AS count FROM inventory_journal').get() as { count: number })
          .count
      ).toBe(210);
      expect(raw() === before).toBe(true);
      expect(readFileSync(path).equals(bytes)).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
