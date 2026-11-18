import type { LimsEntity, LimsImportPlan } from '../../lims';
import { normalizePathForBoundary } from '../../path-boundary';
import { sheetSyncJsonValue } from './import';
import {
  planSheetSync,
  sheetSyncMergedFields,
  type SheetSyncCheckpoint,
  type SheetSyncRecord,
} from './planner';
import {
  excelSourceSchema,
  type StoredSheetSyncConnection,
  sheetSyncConnectionRelativePath,
  sheetSyncWorkspacePath,
  type SheetSyncConnection,
  type GoogleSyncSource,
  type SheetSyncSnapshot,
} from './persistence';
import type { ExcelSyncSource } from './sources';
import { sheetSyncEntityRecord } from './artifacts';
import type { SheetSyncRuntimePorts } from './ports';
export interface SheetSyncPullSummary {
  created: number;
  updated: number;
  unchanged: number;
  conflicts: Array<{ key: string; reason: string }>;
  localEdits: string[];
  missingRows: string[];
}
export function createSheetSyncRuntime(deps: SheetSyncRuntimePorts) {
  const {
    newConnectionId,
    publicationPaths,
    fs,
    googleSheets,
    resolveWorkspaceId,
    withRendererWorkspaceMutation,
    reconcileWorkspaceAfterFilesChanged,
    updateLimsEntity,
    gitCommitPaths,
    gitStatus,
    isGitRepo,
    gitHead,
    gitShowCommit,
    readPrimerArtifactAtPath,
    queryLimsEntities,
    persistImportSet,
    parseGoogleSyncSource,
    readExcelSyncSource,
    localSheetSyncAuthorization,
    localGoogleSheetSyncGrant,
    authorizeGoogleSheetSync,
    authorizeLocalSheetSync,
    setLocalSheetSyncActive,
    sheetSyncFinalizationAcknowledged,
    acknowledgeSheetSyncFinalization,
    createSheetSyncArtifact,
    sheetSyncCreateIntent,
    updateSheetSyncPrimer,
    loadSheetSyncConnection,
    listSheetSyncConnections,
    readSheetSyncSnapshot,
    writeSheetSyncConnection,
    writeSheetSyncSnapshot,
  } = deps;
  function connectorSource(connection: SheetSyncConnection, revision: string) {
    return {
      connector: {
        connectorType: 'provider' in connection.source ? 'google-sheets' : 'local-excel',
        connectionId: connection.id,
        externalDocumentId:
          'provider' in connection.source
            ? connection.source.spreadsheetId
            : connection.source.path,
        externalSheetId:
          'provider' in connection.source
            ? String(connection.source.sheetId)
            : connection.source.sheetName,
        revisionToken: revision,
      },
    };
  }

  async function saveConnection(
    workspaceRoot: string,
    stored: StoredSheetSyncConnection,
    connection: SheetSyncConnection,
    parentToken?: string
  ): Promise<StoredSheetSyncConnection> {
    return withRendererWorkspaceMutation(
      workspaceRoot,
      async (mutationToken) => {
        if (!mutationToken)
          throw new Error('Spreadsheet sync requires a desktop project mutation lease.');
        return writeSheetSyncConnection({
          workspaceRoot,
          connection,
          expectedContent: stored.content,
          mutationToken,
        });
      },
      parentToken
    );
  }

  function snapshotFromSource(
    source: Pick<Awaited<ReturnType<typeof readExcelSyncSource>>, 'revision' | 'plan' | 'rows'>
  ): SheetSyncSnapshot {
    for (const column of source.plan.columns) {
      if (column.mappingMode !== 'mapped') continue;
      if (
        column.mappedField &&
        column.mappedField !== 'entity.name' &&
        !column.mappedField.startsWith('fields.')
      )
        throw new Error(
          `The ${column.sourceColumn} mapping is not supported by spreadsheet sync yet. Retain it as source data instead.`
        );
      if (
        column.mappedField === 'fields.artifact' ||
        column.mappedField === 'fields.sourceMetadata'
      )
        throw new Error('A spreadsheet cannot replace record ownership fields.');
    }
    const records = new Map(source.plan.records.map((record) => [record.externalRowId, record]));
    return {
      schema: 'dnaforge.sheet-sync-snapshot',
      schemaVersion: 1,
      sourceRevision: source.revision,
      rows: source.rows.map((row) => {
        const original = records.get(row.key);
        if (!original) throw new Error('Spreadsheet row identity was not preserved by its parser.');
        return {
          ...row,
          values: Object.fromEntries(
            Object.entries(original.source).map(([key, value]) => [key, sheetSyncJsonValue(value)])
          ),
          ...(original.sourceRow === undefined ? {} : { sourceRow: original.sourceRow }),
        };
      }),
    };
  }

  async function preparePending(
    workspaceRoot: string,
    stored: StoredSheetSyncConnection,
    snapshot: SheetSyncSnapshot,
    operation: NonNullable<SheetSyncConnection['pending']>['operation'],
    finalizationId: string
  ): Promise<StoredSheetSyncConnection> {
    return withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
      if (!mutationToken)
        throw new Error('Spreadsheet sync requires a desktop project mutation lease.');
      const keys = new Set(
        operation.kind === 'create' ? operation.rows.map((row) => row.key) : [operation.key]
      );
      const saved = await writeSheetSyncSnapshot({
        workspaceRoot,
        snapshot: { ...snapshot, rows: snapshot.rows.filter((row) => keys.has(row.key)) },
        mutationToken,
      });
      return saveConnection(
        workspaceRoot,
        stored,
        {
          ...stored.connection,
          finalization: {
            id: finalizationId,
            sourceRevision: snapshot.sourceRevision,
            snapshotPaths: [
              ...new Set([
                ...(stored.connection.finalization?.id === finalizationId
                  ? stored.connection.finalization.snapshotPaths
                  : []),
                saved.relativePath,
              ]),
            ],
          },
          pending: {
            revision: snapshot.sourceRevision,
            snapshotHash: saved.hash,
            snapshotRelativePath: saved.relativePath,
            operation,
          },
        },
        mutationToken
      );
    });
  }

  function upsertCheckpoint(
    connection: SheetSyncConnection,
    checkpoint: SheetSyncCheckpoint
  ): SheetSyncCheckpoint[] {
    return [
      ...connection.checkpoints.filter((current) => current.key !== checkpoint.key),
      checkpoint,
    ];
  }

  async function recoverPending(
    workspaceRoot: string,
    stored: StoredSheetSyncConnection,
    assertCurrent: () => void
  ): Promise<{ stored: StoredSheetSyncConnection; created: number; updated: number }> {
    const pending = stored.connection.pending;
    if (!pending) return { stored, created: 0, updated: 0 };
    const snapshot = await readSheetSyncSnapshot({ workspaceRoot, pending });
    const rows = new Map(snapshot.rows.map((row) => [row.key, row]));
    const operation = pending.operation;
    const checkpoints = new Map(
      stored.connection.checkpoints.map((checkpoint) => [checkpoint.key, checkpoint])
    );
    let created = 0;
    let updated = 0;
    if (operation.kind === 'create') {
      for (const intent of operation.rows) {
        assertCurrent();
        const row = rows.get(intent.key);
        if (!row) throw new Error('Pending spreadsheet row is absent from its immutable snapshot.');
        const checkpoint = await createSheetSyncArtifact({
          workspaceRoot,
          connection: stored.connection,
          row,
          intent,
        });
        checkpoints.set(checkpoint.key, checkpoint);
        created += 1;
      }
    } else {
      assertCurrent();
      const row = rows.get(operation.key);
      const prior = checkpoints.get(operation.key);
      if (!row || !prior || prior.entityId !== operation.entityId)
        throw new Error('Pending spreadsheet target identity changed.');
      let checkpoint: SheetSyncCheckpoint;
      if (operation.kind === 'update-primer') {
        checkpoint = await updateSheetSyncPrimer({
          workspaceRoot,
          row,
          checkpoint: prior,
          pending: operation,
        });
      } else {
        const workspaceId = await resolveWorkspaceId(workspaceRoot);
        if (workspaceId == null) throw new Error('Spreadsheet project ownership is unavailable.');
        const [target] = await queryLimsEntities({
          id: operation.entityId,
          workspaceId,
          includeArchived: true,
          limit: 1,
        });
        if (!target || target.tombstone || target.archivedAt != null)
          throw new Error('The spreadsheet target is missing or archived.');
        const entity = await updateLimsEntity({
          id: operation.entityId,
          workspaceId,
          operationId: operation.operationId,
          expectedEventSeq: operation.expectedEventSeq,
          name: operation.name,
          fields: operation.fields,
          replaceFields: true,
          actor: 'spreadsheet-sync',
        });
        checkpoint = {
          ...prior,
          source: row.record,
          applied: sheetSyncEntityRecord(entity, row.record),
        };
      }
      checkpoints.set(checkpoint.key, checkpoint);
      updated += 1;
    }
    const next = await saveConnection(workspaceRoot, stored, {
      ...stored.connection,
      checkpoints: [...checkpoints.values()],
      pending: null,
    });
    return { stored: next, created, updated };
  }

  function targetScope(source: SheetSyncRecord, checkpoint: SheetSyncCheckpoint): SheetSyncRecord {
    return { ...source, fields: { ...checkpoint.applied.fields, ...source.fields } };
  }

  function currentTargets(
    connection: SheetSyncConnection,
    snapshot: SheetSyncSnapshot,
    entities: readonly LimsEntity[]
  ) {
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    const byKey = new Map(snapshot.rows.map((row) => [row.key, row]));
    return connection.checkpoints.flatMap((checkpoint) => {
      const entity = byId.get(checkpoint.entityId);
      if (!entity) return [];
      const source = byKey.get(checkpoint.key)?.record ?? checkpoint.source;
      return [
        {
          entityId: entity.id,
          eventSeq: entity.eventSeq,
          archived: entity.tombstone || entity.archivedAt != null,
          record: sheetSyncEntityRecord(entity, targetScope(source, checkpoint)),
        },
      ];
    });
  }

  async function persistConnectionImportSet(
    workspaceRoot: string,
    connection: SheetSyncConnection,
    plan: LimsImportPlan,
    mutationToken: string
  ) {
    const rows = new Map(plan.records.map((record) => [record.externalRowId, record]));
    const destinationDir = connection.destinationRelativePath
      ? sheetSyncWorkspacePath(workspaceRoot, connection.destinationRelativePath)
      : workspaceRoot;
    const saved = await persistImportSet({
      workspaceRoot,
      destinationDir,
      source: connectorSource(connection, connection.revision),
      mutationToken,
      partitions: [
        {
          plan,
          members: connection.checkpoints.map((checkpoint) => ({
            sourceRecordId: `sheet-sync:${connection.id}:${checkpoint.key}`,
            sourceRowId: checkpoint.key,
            externalRowId: checkpoint.key,
            sourceRow: rows.get(checkpoint.key)?.sourceRow,
            entityId: checkpoint.entityId,
            entityKind: checkpoint.source.kind,
            artifactRelativePath: checkpoint.artifactRelativePath,
          })),
        },
      ],
    });
    if (saved.importSet.id !== connection.importSetId)
      throw new Error('Spreadsheet import-set identity changed.');
    return saved.relativePaths;
  }

  async function createExcelSheetSyncConnection(input: {
    workspaceRoot: string;
    source: ExcelSyncSource;
    destinationRelativePath: string;
  }): Promise<StoredSheetSyncConnection> {
    const syncSource = excelSourceSchema.parse(input.source);
    const source = await readExcelSyncSource(syncSource);
    snapshotFromSource(source);
    const provisional: SheetSyncConnection = {
      schema: 'dnaforge.sheet-sync',
      schemaVersion: 1,
      id: newConnectionId(),
      importSetId: 'pending',
      source: {
        ...syncSource,
        columnMappings: syncSource.columnMappings.map((mapping) => ({ ...mapping })),
      },
      destinationRelativePath: input.destinationRelativePath,
      revision: source.revision,
      enabled: true,
      pending: null,
      finalization: null,
      checkpoints: [],
    };
    return withRendererWorkspaceMutation(input.workspaceRoot, async (mutationToken) => {
      if (!mutationToken)
        throw new Error('Spreadsheet sync requires a desktop project mutation lease.');
      const existing = await listSheetSyncConnections(input.workspaceRoot);
      if (
        existing.some(
          (entry) =>
            entry.kind === 'connection' &&
            !('provider' in entry.stored.connection.source) &&
            normalizePathForBoundary(entry.stored.connection.source.path) ===
              normalizePathForBoundary(input.source.path) &&
            entry.stored.connection.source.sheetName.toLowerCase() ===
              input.source.sheetName.toLowerCase()
        )
      )
        throw new Error(
          'That worksheet is already connected to this project. Open its existing connection.'
        );
      const destinationDir = input.destinationRelativePath
        ? sheetSyncWorkspacePath(input.workspaceRoot, input.destinationRelativePath)
        : input.workspaceRoot;
      const importSet = await persistImportSet({
        workspaceRoot: input.workspaceRoot,
        destinationDir,
        source: connectorSource(provisional, source.revision),
        mutationToken,
        partitions: [{ plan: source.plan, members: [] }],
      });
      const saved = await writeSheetSyncConnection({
        workspaceRoot: input.workspaceRoot,
        connection: { ...provisional, importSetId: importSet.importSet.id },
        mutationToken,
      });
      await authorizeLocalSheetSync(input.workspaceRoot, saved.connection, input.source.path);
      if (await isGitRepo(input.workspaceRoot, mutationToken))
        await gitCommitPaths(
          input.workspaceRoot,
          'Connect spreadsheet source',
          [sheetSyncConnectionRelativePath(saved.connection.id), ...importSet.relativePaths],
          mutationToken
        );
      return saved;
    });
  }

  async function createGoogleSheetSyncConnection(input: {
    workspaceRoot: string;
    source: GoogleSyncSource;
    grantId: string;
    destinationRelativePath: string;
  }): Promise<StoredSheetSyncConnection> {
    const source = await parseGoogleSyncSource(
      input.source,
      await googleSheets.worksheet({
        grantId: input.grantId,
        spreadsheetId: input.source.spreadsheetId,
        sheetId: input.source.sheetId,
      })
    );
    snapshotFromSource(source);
    const provisional: SheetSyncConnection = {
      schema: 'dnaforge.sheet-sync',
      schemaVersion: 1,
      id: newConnectionId(),
      importSetId: 'pending',
      source: input.source,
      destinationRelativePath: input.destinationRelativePath,
      revision: source.revision,
      enabled: true,
      pending: null,
      finalization: null,
      checkpoints: [],
    };
    return withRendererWorkspaceMutation(input.workspaceRoot, async (mutationToken) => {
      if (!mutationToken)
        throw new Error('Spreadsheet sync requires a desktop project mutation lease.');
      const existing = await listSheetSyncConnections(input.workspaceRoot);
      if (
        existing.some(
          (entry) =>
            entry.kind === 'connection' &&
            'provider' in entry.stored.connection.source &&
            entry.stored.connection.source.spreadsheetId === input.source.spreadsheetId &&
            entry.stored.connection.source.sheetId === input.source.sheetId
        )
      )
        throw new Error(
          'That worksheet is already connected to this project. Open its existing connection.'
        );
      const destinationDir = input.destinationRelativePath
        ? sheetSyncWorkspacePath(input.workspaceRoot, input.destinationRelativePath)
        : input.workspaceRoot;
      const importSet = await persistImportSet({
        workspaceRoot: input.workspaceRoot,
        destinationDir,
        source: connectorSource(provisional, source.revision),
        mutationToken,
        partitions: [{ plan: source.plan, members: [] }],
      });
      const saved = await writeSheetSyncConnection({
        workspaceRoot: input.workspaceRoot,
        connection: { ...provisional, importSetId: importSet.importSet.id },
        mutationToken,
      });
      await authorizeGoogleSheetSync(input.workspaceRoot, saved.connection, input.grantId);
      if (await isGitRepo(input.workspaceRoot, mutationToken))
        await gitCommitPaths(
          input.workspaceRoot,
          'Connect Google worksheet source',
          [sheetSyncConnectionRelativePath(saved.connection.id), ...importSet.relativePaths],
          mutationToken
        );
      return saved;
    });
  }

  async function setSheetSyncEnabled(
    workspaceRoot: string,
    id: string,
    enabled: boolean
  ): Promise<void> {
    const stored = await loadSheetSyncConnection(workspaceRoot, id);
    await setLocalSheetSyncActive(workspaceRoot, stored.connection, enabled);
    await saveConnection(workspaceRoot, stored, { ...stored.connection, enabled });
  }

  async function pullExcelSheetConnection(input: {
    workspaceRoot: string;
    id: string;
    assertCurrent?: () => void;
  }): Promise<SheetSyncPullSummary | null> {
    const { workspaceRoot } = input;
    const assertCurrent = input.assertCurrent ?? (() => {});
    assertCurrent();
    let stored = await loadSheetSyncConnection(workspaceRoot, input.id);
    if (!stored.connection.enabled) return null;
    const authorization = await localSheetSyncAuthorization(workspaceRoot, stored.connection);
    if (authorization === 'paused') return null;
    if (authorization !== 'authorized')
      throw new Error('Choose the workbook on this device before enabling synchronization.');
    const acknowledged = await sheetSyncFinalizationAcknowledged(workspaceRoot, stored.connection);
    const finalizationId =
      stored.connection.finalization && !acknowledged
        ? stored.connection.finalization.id
        : crypto.randomUUID();
    const paths = new Set<string>([sheetSyncConnectionRelativePath(input.id)]);
    if (stored.connection.pending) paths.add(stored.connection.pending.snapshotRelativePath);
    if (stored.connection.finalization && !acknowledged)
      for (const path of stored.connection.finalization.snapshotPaths) paths.add(path);
    const recovered = await recoverPending(workspaceRoot, stored, assertCurrent);
    stored = recovered.stored;
    assertCurrent();
    const source =
      'provider' in stored.connection.source
        ? await parseGoogleSyncSource(
            stored.connection.source,
            await googleSheets.worksheet({
              grantId: await localGoogleSheetSyncGrant(workspaceRoot, stored.connection),
              spreadsheetId: stored.connection.source.spreadsheetId,
              sheetId: stored.connection.source.sheetId,
            })
          )
        : await readExcelSyncSource(stored.connection.source);
    const snapshot = snapshotFromSource(source);
    const snapshotRows = new Map(snapshot.rows.map((row) => [row.key, row]));
    const workspaceId = await resolveWorkspaceId(workspaceRoot);
    if (workspaceId == null) throw new Error('Spreadsheet sync requires an owned project.');
    const entities = await queryLimsEntities({ workspaceId, includeArchived: true, limit: 50001 });
    if (entities.length >= 50001)
      throw new Error('This project exceeds the current spreadsheet sync record limit.');
    const targets = currentTargets(stored.connection, snapshot, entities);
    const changes = planSheetSync({
      sourceRows: snapshot.rows,
      checkpoints: stored.connection.checkpoints,
      targets,
    });
    const creates = changes.filter((change) => change.kind === 'create');
    let created = recovered.created;
    let updated = recovered.updated;
    if (creates.length) {
      const rows = [];
      for (const change of creates) {
        const row = snapshotRows.get(change.key);
        if (!row) throw new Error('Spreadsheet creation row is missing.');
        rows.push(await sheetSyncCreateIntent(stored.connection, row));
      }
      assertCurrent();
      stored = await preparePending(
        workspaceRoot,
        stored,
        snapshot,
        { kind: 'create', rows },
        finalizationId
      );
      if (stored.connection.pending) paths.add(stored.connection.pending.snapshotRelativePath);
      const result = await recoverPending(workspaceRoot, stored, assertCurrent);
      stored = result.stored;
      created += result.created;
    }
    const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
    for (const change of changes) {
      if (change.kind !== 'update' && change.kind !== 'adopt') continue;
      assertCurrent();
      const row = snapshotRows.get(change.key);
      const checkpoint = stored.connection.checkpoints.find(
        (candidate) => candidate.key === change.key
      );
      const entity = entitiesById.get(change.entityId);
      if (!row || !checkpoint || !entity)
        throw new Error('Spreadsheet target changed during planning.');
      if (change.kind === 'adopt') {
        stored = await saveConnection(workspaceRoot, stored, {
          ...stored.connection,
          finalization: {
            id: finalizationId,
            sourceRevision: source.revision,
            snapshotPaths: [...paths].filter((path) =>
              path.startsWith('.waypoint/sheet-sync/snapshots/')
            ),
          },
          checkpoints: upsertCheckpoint(stored.connection, {
            ...checkpoint,
            source: row.record,
            applied: sheetSyncEntityRecord(entity, row.record),
          }),
        });
        continue;
      }
      let operation: NonNullable<SheetSyncConnection['pending']>['operation'];
      if (row.record.kind === 'oligo' || row.record.kind === 'rna_oligo') {
        const loaded = await readPrimerArtifactAtPath(
          sheetSyncWorkspacePath(workspaceRoot, checkpoint.artifactRelativePath),
          workspaceRoot
        );
        operation = {
          kind: 'update-primer',
          key: row.key,
          entityId: checkpoint.entityId,
          artifactRelativePath: checkpoint.artifactRelativePath,
          priorContent: loaded.content,
        };
      } else {
        const fields = Object.fromEntries(
          Object.entries(entity.fields).map(([key, value]) => [key, sheetSyncJsonValue(value)])
        );
        operation = {
          kind: 'update-record',
          key: row.key,
          entityId: checkpoint.entityId,
          expectedEventSeq: change.expectedEventSeq,
          operationId: crypto.randomUUID(),
          name: row.record.name,
          fields: sheetSyncMergedFields(row.record, checkpoint.source, fields),
        };
      }
      stored = await preparePending(workspaceRoot, stored, snapshot, operation, finalizationId);
      if (stored.connection.pending) paths.add(stored.connection.pending.snapshotRelativePath);
      const result = await recoverPending(workspaceRoot, stored, assertCurrent);
      stored = result.stored;
      updated += result.updated;
    }
    const summary: SheetSyncPullSummary = {
      created,
      updated,
      unchanged: changes.filter((change) => change.kind === 'unchanged' || change.kind === 'adopt')
        .length,
      conflicts: changes
        .filter((change) => change.kind === 'conflict')
        .map((change) => ({ key: change.key, reason: change.reason })),
      localEdits: changes
        .filter((change) => change.kind === 'local-edit')
        .map((change) => change.key),
      missingRows: changes
        .filter((change) => change.kind === 'missing-source')
        .map((change) => change.key),
    };
    if (
      !created &&
      !updated &&
      !changes.some((change) => change.kind === 'adopt') &&
      source.revision === stored.connection.revision &&
      (await sheetSyncFinalizationAcknowledged(workspaceRoot, stored.connection))
    )
      return summary;
    assertCurrent();
    stored = await saveConnection(workspaceRoot, stored, {
      ...stored.connection,
      revision: source.revision,
      finalization: {
        id: finalizationId,
        sourceRevision: source.revision,
        snapshotPaths: [...paths].filter((path) =>
          path.startsWith('.waypoint/sheet-sync/snapshots/')
        ),
      },
    });
    await withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
      if (!mutationToken)
        throw new Error('Spreadsheet sync requires a desktop project mutation lease.');
      for (const path of await persistConnectionImportSet(
        workspaceRoot,
        stored.connection,
        source.plan,
        mutationToken
      ))
        paths.add(path);
      await reconcileWorkspaceAfterFilesChanged({
        workspaceRoot,
        mutationToken,
        strict: true,
        notifyGitStatus: true,
      });
      for (const checkpoint of stored.connection.checkpoints)
        if (await fs.exists(sheetSyncWorkspacePath(workspaceRoot, checkpoint.artifactRelativePath)))
          paths.add(checkpoint.artifactRelativePath);
      if (await isGitRepo(workspaceRoot, mutationToken)) {
        const status = await gitStatus(workspaceRoot, mutationToken);
        for (const path of await publicationPaths(workspaceRoot, status)) paths.add(path);
        const dirty = [...status.keys()].filter(
          (path) => paths.has(path) || path.startsWith('.waypoint/lims/')
        );
        if (dirty.length)
          await gitCommitPaths(
            workspaceRoot,
            `Sync spreadsheet records (${finalizationId})`,
            dirty,
            mutationToken
          );
        const commit = await gitHead(workspaceRoot, mutationToken);
        if (!commit) throw new Error('Spreadsheet history commit could not be verified.');
        for (const path of paths) {
          const committed = await gitShowCommit(path, commit, workspaceRoot, mutationToken);
          const current = await fs.readTextFile(sheetSyncWorkspacePath(workspaceRoot, path));
          if (
            committed === null ||
            committed.replace(/\r\n/g, '\n') !== current.replace(/\r\n/g, '\n')
          )
            throw new Error('Spreadsheet history does not contain the completed publication.');
        }
        await acknowledgeSheetSyncFinalization(workspaceRoot, stored.connection, commit);
      } else {
        await acknowledgeSheetSyncFinalization(workspaceRoot, stored.connection, null);
      }
    });
    return summary;
  }
  return {
    createExcelSheetSyncConnection,
    createGoogleSheetSyncConnection,
    setSheetSyncEnabled,
    pullExcelSheetConnection,
  };
}
export type SheetSyncRuntime = ReturnType<typeof createSheetSyncRuntime>;
