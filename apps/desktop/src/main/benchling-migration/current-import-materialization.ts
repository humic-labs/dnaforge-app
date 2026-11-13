import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { MigrationRun, SourceObject } from '../../shared/benchling-migration';
import { inspectBenchlingMigrationActionJournal } from './action-journal';
import type { MigrationStore } from './store';
import { scientificSourceObjectSha256 } from './linked-item-recovery-decoder';
import { collectionDestinationId } from './collection-projection';
import { scopedProjectionId } from '../../shared/workspace-scoped-identity';
import { readNativeSourceFolderMemberships } from './native-source-memberships';

export async function readCurrentImportMaterialization(input: {
  db?: Database.Database;
  run: MigrationRun;
  store: MigrationStore;
  actionId?: string;
  sources: readonly SourceObject[];
  mapSource?: (source: SourceObject) => SourceObject;
}) {
  const historicalHeads = input.store.listProjectionReceipts(input.run.id);
  const captures = input.store.listLinkedItemRecoveryCaptures(input.run.id);
  const incomingCaptures = captures.filter((capture) => capture.attemptId === input.actionId);
  const incomingIds = new Set(incomingCaptures.map((capture) => capture.sourceObjectId));
  const completedAttemptIds = new Set(
    input.store
      .listLinkedItemRecoveryAttempts(input.run.id)
      .filter((attempt) => attempt.state === 'completed')
      .map((attempt) => attempt.id)
  );
  const admittedCapturedIds = new Set([
    ...(input.store.getSourceSnapshot(input.run.id)?.initialSourceObjectIds ?? []),
    ...incomingIds,
    ...captures
      .filter((capture) => completedAttemptIds.has(capture.attemptId))
      .map((capture) => capture.sourceObjectId),
  ]);
  const historicalSourceIds = new Set(historicalHeads.map((receipt) => receipt.sourceObjectId));
  const uninstalledCapturedIds = new Set(
    captures
      .map((capture) => capture.sourceObjectId)
      .filter(
        (sourceId) => !admittedCapturedIds.has(sourceId) && !historicalSourceIds.has(sourceId)
      )
  );
  if (!input.db || !input.run.workspaceDbId)
    return {
      sources: input.sources.filter((source) => !uninstalledCapturedIds.has(source.id)),
      receipts: historicalHeads,
      historicalHeads,
      uninstalledCapturedSourceIds: uninstalledCapturedIds,
      selectedFolderIds: new Set<string>(),
      materializedSourceIds: new Set<string>(),
      nativeMembershipAuthority: undefined,
    };
  const selected = new Map(historicalHeads.map((receipt) => [receipt.sourceObjectId, receipt]));
  const currentAttempt = input.actionId
    ? input.store.getLinkedItemRecoveryAttempt(input.run.id, input.actionId)
    : null;
  const currentArtifactIds = new Set(currentAttempt?.artifactIds ?? []);
  const hierarchyHistory = input.store.listWorkspaceAppendHierarchyCaptures(input.run.id);
  const incomingHierarchy = hierarchyHistory.filter((capture) =>
    currentArtifactIds.has(capture.artifactId)
  );
  const incomingFolderIds = new Set(
    incomingHierarchy
      .flatMap((capture) => [
        capture.destinationRootSourceId,
        ...capture.folders.map((folder) => folder.sourceId),
      ])
      .map(collectionDestinationId)
  );
  const incomingMemberships = new Map<string, Set<string>>();
  for (const capture of incomingHierarchy)
    for (const membership of capture.memberships) {
      const selected = incomingMemberships.get(membership.sourceObjectId) ?? new Set<string>();
      selected.add(membership.folderSourceId);
      incomingMemberships.set(membership.sourceObjectId, selected);
    }
  for (const capture of incomingCaptures) {
    const source = input.sources.find((source) => source.id === capture.sourceObjectId);
    const memberships = incomingMemberships.get(capture.sourceObjectId) ?? new Set<string>();
    for (const membership of capture.sourceFolderMemberships ??
      (source ? readNativeSourceFolderMemberships(source, input.run.id) : []))
      memberships.add(membership.sourceFolderId);
    incomingMemberships.set(capture.sourceObjectId, memberships);
  }
  const liveMemberships = new Set(
    input.db
      .prepare(
        `SELECT link.source_entity_id,link.target_entity_id FROM catalog_entity_links AS link
         JOIN catalog_entities AS source ON source.id=link.source_entity_id
         JOIN catalog_entities AS target ON target.id=link.target_entity_id
         WHERE link.relation='contains' AND source.type='folder'
           AND source.workspace_id=? AND target.workspace_id=?`
      )
      .all(input.run.workspaceDbId, input.run.workspaceDbId)
      .map((row) => {
        const link = z
          .object({ source_entity_id: z.string(), target_entity_id: z.string() })
          .parse(row);
        return JSON.stringify([link.source_entity_id, link.target_entity_id]);
      })
  );
  if (input.actionId) {
    const journal = await inspectBenchlingMigrationActionJournal(
      input.run.workspacePath,
      input.actionId
    );
    for (const allocation of journal?.allocations ?? []) {
      if (allocation.installState === 'reserved' || allocation.installState === 'staged') continue;
      const receipt = historicalHeads.find(
        (candidate) => candidate.sourceObjectId === allocation.sourceObjectId
      );
      if (!receipt || receipt.destinationObjectId !== allocation.destinationEntityId) continue;
      const captured = incomingCaptures.find(
        (capture) => capture.sourceObjectId === receipt.sourceObjectId
      );
      const pinned = captured
        ? input.store.getProjectionReceiptSource(input.run.id, receipt.id)
        : null;
      if (
        !captured ||
        !pinned ||
        scientificSourceObjectSha256(pinned) !== captured.sourceScientificContentSha256
      )
        continue;
      if (!isDeepStrictEqual(receipt.destination, allocation.destination))
        throw new Error('Current import installation receipt changed.');
      selected.set(receipt.sourceObjectId, receipt);
    }
  }
  const sources: SourceObject[] = [];
  const liveEntityIds = new Set(
    input.db
      .prepare("SELECT id FROM catalog_entities WHERE workspace_id=? AND status='active'")
      .all(input.run.workspaceDbId)
      .map((row) => z.object({ id: z.string() }).parse(row).id)
  );
  const materializedSourceIds = new Set(
    [...selected.values()]
      .filter((receipt) =>
        liveEntityIds.has(
          scopedProjectionId(
            input.run.projectionScopeId ?? input.run.workspaceId,
            receipt.destinationObjectId
          )
        )
      )
      .map((receipt) => receipt.sourceObjectId)
  );
  for (const source of input.sources) {
    if (incomingIds.has(source.id)) {
      sources.push(source);
      continue;
    }
    const receipt = selected.get(source.id);
    if (!receipt) {
      if (!uninstalledCapturedIds.has(source.id)) sources.push(source);
      continue;
    }
    const snapshot = input.store.getProjectionReceiptSource(input.run.id, receipt.id);
    if (!snapshot) throw new Error('Current import source snapshot is unavailable.');
    sources.push(input.mapSource ? input.mapSource(snapshot) : snapshot);
  }
  const latestById = new Map(input.sources.map((source) => [source.id, source]));
  const capturedNativeMemberships = new Map<
    string,
    Map<string, ReturnType<typeof readNativeSourceFolderMemberships>[number]>
  >();
  for (const capture of captures) {
    const memberships =
      capturedNativeMemberships.get(capture.sourceObjectId) ??
      new Map<string, ReturnType<typeof readNativeSourceFolderMemberships>[number]>();
    for (const membership of capture.sourceFolderMemberships ?? [])
      memberships.set(membership.sourceFolderId, membership);
    capturedNativeMemberships.set(capture.sourceObjectId, memberships);
  }
  const historicalMemberships = new Map<string, Set<string>>();
  for (const capture of hierarchyHistory)
    for (const membership of capture.memberships) {
      const candidates = historicalMemberships.get(membership.sourceObjectId) ?? new Set<string>();
      candidates.add(membership.folderSourceId);
      historicalMemberships.set(membership.sourceObjectId, candidates);
    }
  const currentSources = sources.map((source) => {
    const destinationId = selected.get(source.id)?.destinationObjectId;
    const latest = latestById.get(source.id);
    const nativeMemberships = new Map(
      [
        ...readNativeSourceFolderMemberships(source, input.run.id),
        ...(latest ? readNativeSourceFolderMemberships(latest, input.run.id) : []),
        ...(capturedNativeMemberships.get(source.id)?.values() ?? []),
      ].map((membership) => [membership.sourceFolderId, membership])
    );
    const candidates = new Set([
      ...source.memberships,
      ...(latestById.get(source.id)?.memberships ?? []),
      ...(historicalMemberships.get(source.id) ?? []),
      ...nativeMemberships.keys(),
    ]);
    const currentMemberships = [...candidates].filter((folderSourceId) => {
      const folderId = collectionDestinationId(folderSourceId);
      const linked =
        destinationId !== undefined &&
        liveMemberships.has(
          JSON.stringify([
            scopedProjectionId(input.run.projectionScopeId ?? input.run.workspaceId, folderId),
            scopedProjectionId(input.run.projectionScopeId ?? input.run.workspaceId, destinationId),
          ])
        );
      const publishedNativeWorkspace =
        input.run.state === 'unlocked' &&
        (input.run.externalZipSource || input.run.baseline?.kind === 'adopted_workspace');
      return linked || (!publishedNativeWorkspace && source.memberships.includes(folderSourceId));
    });
    const memberships = [
      ...new Set([...currentMemberships, ...(incomingMemberships.get(source.id) ?? [])]),
    ].sort();
    const metadataMemberships = [...nativeMemberships.values()].filter((membership) =>
      memberships.includes(membership.sourceFolderId)
    );
    const appendMetadata = source.metadata?.workspaceAppend;
    return {
      ...source,
      memberships,
      ...(nativeMemberships.size
        ? {
            metadata: {
              ...source.metadata,
              workspaceAppend: {
                ...(appendMetadata &&
                typeof appendMetadata === 'object' &&
                !Array.isArray(appendMetadata)
                  ? appendMetadata
                  : {}),
                sourceFolderMemberships: metadataMemberships,
              },
            },
          }
        : {}),
    };
  });
  return {
    sources: currentSources,
    receipts: [...selected.values()],
    historicalHeads,
    uninstalledCapturedSourceIds: uninstalledCapturedIds,
    materializedSourceIds,
    selectedFolderIds: incomingFolderIds,
    nativeMembershipAuthority: currentSources.map((source) => ({
      sourceObjectId: source.id,
      folderSourceIds: source.memberships,
    })),
  };
}
