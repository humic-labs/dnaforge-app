import { computeChecksum } from '@waypoint/sequence-utils';
import { readPackageAssemblyWorkingCopy } from '../../db/sequence-package-working-copy-storage';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { findContainingPathBoundary } from '../../shared/path-boundary';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  drainDesignArtifactMirrors,
  retryDesignArtifactMirror,
} from '../design/public/design-artifact-mirror';
import {
  captureDesignRecovery,
  designContentIdentity,
  useDesignRecoveryStore,
} from '../design/public/design-recovery';
import { useDesignStore } from '../design/public/store';
import { packageAssemblyWorkingCopyDesignId } from '../design/public/package-working-copy-identity';
import type { SequenceDesign } from '../design/public/types';
import {
  resolveAcceptedAssemblyRecord,
  type AcceptedRecordSelector,
} from './accepted-record-reader';
import { reopenAcceptedAssemblyWorkflow } from './accepted-reopen-workflow';
import {
  acceptedAssemblyVersionFromSidecar,
  sequenceDesignFromAcceptedAssemblyVersion,
} from './accepted-reopen';
import {
  catalogHistoricalAssemblyComponents,
  composeHistoricalAssemblyComponents,
  type HistoricalAssemblyCatalog,
  type HistoricalAssemblySelection,
  type HistoricalAssemblyTarget,
} from './historical-component-composition';

export type ListHistoricalAssemblyComponentsInput = {
  constructId: string;
  referenceAcceptedAssemblyVersionId?: string;
};

export async function listHistoricalAssemblyComponents(
  input: ListHistoricalAssemblyComponentsInput
): Promise<HistoricalAssemblyCatalog> {
  const record = await resolveAcceptedAssemblyRecord({
    constructId: input.constructId,
    acceptedAssemblyVersionId: input.referenceAcceptedAssemblyVersionId,
  });
  const checked = await Promise.all(
    record.acceptedRecords.map(async (candidate) => {
      const acceptedAssemblyVersionId = acceptedAssemblyVersionFromSidecar(candidate).id;
      try {
        const verified = await resolveAcceptedAssemblyRecord({
          constructId: input.constructId,
          acceptedAssemblyVersionId,
        });
        return { accepted: verified.accepted, unavailable: null };
      } catch (error) {
        return {
          accepted: null,
          unavailable: {
            acceptedAssemblyVersionId,
            reason: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })
  );
  const catalog = await catalogHistoricalAssemblyComponents(
    checked.flatMap((item) => (item.accepted ? [item.accepted] : []))
  );
  return {
    components: catalog.components,
    unavailable: [
      ...catalog.unavailable,
      ...checked.flatMap((item) => (item.unavailable ? [item.unavailable] : [])),
    ],
  };
}

export type StageHistoricalAssemblyComponentsInput = {
  constructId: string;
  baseAcceptedAssemblyVersionId: string;
  expectedDesignVersion: number;
  expectedDraftDigest: string;
  selections: readonly HistoricalAssemblySelection[];
  reopenIdempotencyKey: string;
  actor?: string;
  abortSignal?: AbortSignal;
};

export type HistoricalAssemblyStageTarget = {
  constructId: string;
  baseAcceptedAssemblyVersionId: string;
  exists: boolean;
  designId: string;
  designVersion: number;
  draftDigest: string;
  draftPath: string | null;
  targets: HistoricalAssemblyTarget[];
};

function targetsForDesign(design: SequenceDesign): HistoricalAssemblyTarget[] {
  const targets: HistoricalAssemblyTarget[] = [];
  for (const region of design.regions) {
    targets.push({ kind: 'region', regionId: region.id });
    targets.push({ kind: 'primer-pair', regionId: region.id });
  }
  const gapCount = design.regions.length - 1 + (design.topology === 'circular' ? 1 : 0);
  for (let index = 0; index < gapCount; index += 1) {
    const leftRegionId = design.regions[index].id;
    const rightRegionId = design.regions[(index + 1) % design.regions.length].id;
    targets.push({ kind: 'spacer', leftRegionId, rightRegionId });
    targets.push({ kind: 'join', leftRegionId, rightRegionId });
  }
  return targets;
}

async function stageDraftDigest(design: SequenceDesign): Promise<string> {
  return computeChecksum(
    designContentIdentity({
      ...design,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
  );
}

async function stageTargetForRecord(
  record: Awaited<ReturnType<typeof resolveAcceptedAssemblyRecord>>
): Promise<{
  inspection: HistoricalAssemblyStageTarget;
  design: SequenceDesign;
}> {
  const baseAcceptedAssemblyVersionId = record.acceptedAssemblyVersionId;
  const owned = await readPackageAssemblyWorkingCopy(record.packageRoot);
  let design: SequenceDesign;
  if (owned) {
    if (owned.published) {
      throw new Error(
        'The prior accepted assembly was written but its working copy is not retired.'
      );
    }
    if (
      owned.design.constructId !== record.constructId ||
      owned.design.parentAcceptedAssemblyVersionId !== baseAcceptedAssemblyVersionId
    ) {
      throw new Error(
        `This package has an unfinished copy from ${owned.design.parentAcceptedAssemblyVersionId}; ` +
          'keep that original base rather than replacing the copy.'
      );
    }
    design = useDesignStore.getState().designs[owned.design.id] ?? owned.design;
    const diskIdentity = designContentIdentity(owned.design);
    const recovery = useDesignRecoveryStore.getState().records[owned.design.id];
    if (recovery?.status === 'conflict' || recovery?.retired || recovery?.status === 'unbound') {
      throw new Error('Resolve the unfinished assembly copy before composing historical parts.');
    }
    if (recovery?.pending) {
      if (
        recovery.base !== diskIdentity &&
        recovery.attempted !== diskIdentity &&
        recovery.revision !== diskIdentity
      ) {
        throw new Error('The package copy changed beneath a pending local edit.');
      }
      if (recovery.revision !== designContentIdentity(design)) {
        throw new Error('The assembly editor and its pending recovery copy disagree.');
      }
    } else if (designContentIdentity(design) !== diskIdentity) {
      throw new Error('The assembly editor is stale relative to the package member.');
    }
  } else {
    const designId = await packageAssemblyWorkingCopyDesignId(
      record.constructId,
      baseAcceptedAssemblyVersionId
    );
    const identity = {
      designId,
      constructId: record.constructId,
      parentAcceptedAssemblyVersionId: baseAcceptedAssemblyVersionId,
    };
    design = useDesignStore.getState().loadedDraft(designId, identity) ?? {
      ...sequenceDesignFromAcceptedAssemblyVersion(
        acceptedAssemblyVersionFromSidecar(record.accepted),
        { designId }
      ),
      constructId: record.constructId,
      parentAcceptedAssemblyVersionId: baseAcceptedAssemblyVersionId,
    };
  }
  return {
    inspection: {
      constructId: record.constructId,
      baseAcceptedAssemblyVersionId,
      exists: Boolean(owned),
      designId: design.id,
      designVersion: design.version,
      draftDigest: await stageDraftDigest(design),
      draftPath: owned?.path ?? null,
      targets: targetsForDesign(design),
    },
    design,
  };
}

export async function inspectHistoricalAssemblyStageTarget(input: {
  constructId: string;
  baseAcceptedAssemblyVersionId: string;
}): Promise<HistoricalAssemblyStageTarget> {
  const record = await resolveAcceptedAssemblyRecord({
    constructId: input.constructId,
    acceptedAssemblyVersionId: input.baseAcceptedAssemblyVersionId,
  });
  return (await stageTargetForRecord(record)).inspection;
}

export type StageHistoricalAssemblyComponentsResult = {
  constructId: string;
  designId: string;
  designVersion: number;
  draftPath: string;
  stagedCount: number;
};

type StagePreflightInput = Pick<
  StageHistoricalAssemblyComponentsInput,
  | 'constructId'
  | 'baseAcceptedAssemblyVersionId'
  | 'expectedDesignVersion'
  | 'expectedDraftDigest'
  | 'selections'
>;

async function preflightStage(input: StagePreflightInput) {
  if (!Number.isSafeInteger(input.expectedDesignVersion) || input.expectedDesignVersion < 0) {
    throw new Error('Stage requires the observed assembly working-copy version.');
  }
  if (input.selections.length === 0) throw new Error('Choose at least one historical component.');
  if (!input.expectedDraftDigest.startsWith('sha256:')) {
    throw new Error('Stage requires an exact inspected assembly working-copy fingerprint.');
  }
  const baseSelector: AcceptedRecordSelector = {
    constructId: input.constructId,
    acceptedAssemblyVersionId: input.baseAcceptedAssemblyVersionId,
  };
  const baseRecord = await resolveAcceptedAssemblyRecord(baseSelector);
  const sourceVersionIds = [
    ...new Set(input.selections.map((selection) => selection.source.acceptedAssemblyVersionId)),
  ];
  const sourceRecords = await Promise.all(
    sourceVersionIds.map(async (versionId) => {
      const source = await resolveAcceptedAssemblyRecord({
        constructId: input.constructId,
        acceptedAssemblyVersionId: versionId,
      });
      if (
        source.packageId !== baseRecord.packageId ||
        source.packageRoot !== baseRecord.packageRoot
      ) {
        throw new Error('Historical component source belongs to another sequence package.');
      }
      return source.accepted;
    })
  );
  const freshCatalog = await catalogHistoricalAssemblyComponents(sourceRecords);
  for (const selection of input.selections) {
    if (
      !freshCatalog.components.some(
        (entry) =>
          entry.kind === selection.source.kind &&
          entry.componentId === selection.source.componentId &&
          entry.acceptedAssemblyVersionId === selection.source.acceptedAssemblyVersionId &&
          entry.canonicalDraftChecksum === selection.source.canonicalDraftChecksum &&
          entry.componentDigest === selection.source.componentDigest
      )
    ) {
      throw new Error('Historical component pin changed or is ambiguous; refresh History.');
    }
  }
  const targetBeforeReopen = await stageTargetForRecord(baseRecord);
  if (
    targetBeforeReopen.inspection.designVersion !== input.expectedDesignVersion ||
    targetBeforeReopen.inspection.draftDigest !== input.expectedDraftDigest
  ) {
    throw new Error('Assembly working copy changed since the History selection was inspected.');
  }
  await composeHistoricalAssemblyComponents(
    targetBeforeReopen.design,
    sourceRecords,
    input.selections
  );
  return { baseSelector, baseRecord, sourceRecords, target: targetBeforeReopen.inspection };
}

export async function previewHistoricalAssemblyComponentStage(
  input: StagePreflightInput
): Promise<
  | { status: 'ready'; target: HistoricalAssemblyStageTarget; nextDesignVersion: number }
  | { status: 'blocked'; reason: string }
> {
  try {
    const checked = await preflightStage(input);
    return {
      status: 'ready',
      target: checked.target,
      nextDesignVersion: checked.target.designVersion + 1,
    };
  } catch (error) {
    return { status: 'blocked', reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function stageHistoricalAssemblyComponents(
  input: StageHistoricalAssemblyComponentsInput
): Promise<StageHistoricalAssemblyComponentsResult> {
  if (input.abortSignal?.aborted) throw new Error('Historical component staging was canceled.');
  const { baseSelector, baseRecord, sourceRecords } = await preflightStage(input);
  const reopened = await reopenAcceptedAssemblyWorkflow({
    selector: baseSelector,
    idempotencyKey: input.reopenIdempotencyKey,
    actor: input.actor,
    requireProductIntegrity: false,
    abortSignal: input.abortSignal,
  });
  const workspaceRoot = findContainingPathBoundary(
    useWorkspaceStore.getState().folders.filter((folder) => !folder.pinned),
    baseRecord.packageRoot
  )?.path;
  if (!workspaceRoot) throw new Error('Assembly package is outside the open writable project.');

  const staged = await withRendererWorkspaceMutation(workspaceRoot, async () => {
    if (input.abortSignal?.aborted) throw new Error('Historical component staging was canceled.');
    const owned = await readPackageAssemblyWorkingCopy(baseRecord.packageRoot);
    if (
      !owned ||
      owned.published ||
      owned.design.id !== reopened.designId ||
      owned.design.constructId !== input.constructId ||
      owned.design.parentAcceptedAssemblyVersionId !== input.baseAcceptedAssemblyVersionId
    ) {
      throw new Error('The original package-owned assembly copy changed or was consumed.');
    }
    const current = useDesignStore.getState().designs[reopened.designId];
    if (
      !current ||
      current.constructId !== input.constructId ||
      current.parentAcceptedAssemblyVersionId !== input.baseAcceptedAssemblyVersionId
    ) {
      throw new Error('The package-owned assembly copy is not loaded as the editing owner.');
    }
    const recovery = useDesignRecoveryStore.getState().records[current.id];
    if (recovery?.status === 'conflict' || recovery?.retired || recovery?.status === 'unbound') {
      throw new Error('Resolve the assembly working-copy save conflict before staging.');
    }
    const diskIdentity = designContentIdentity(owned.design);
    if (recovery?.pending) {
      if (
        recovery.base !== diskIdentity &&
        recovery.attempted !== diskIdentity &&
        recovery.revision !== diskIdentity
      ) {
        throw new Error('Assembly working-copy disk state changed during a pending local edit.');
      }
      if (recovery.revision !== designContentIdentity(current)) {
        throw new Error('Assembly working-copy recovery and editor states disagree.');
      }
    } else if (designContentIdentity(current) !== diskIdentity) {
      throw new Error('Assembly working-copy editor is stale relative to its package member.');
    }
    if (current.version !== input.expectedDesignVersion) {
      throw new Error(
        `Assembly working copy changed: expected version ${input.expectedDesignVersion}, ` +
          `current version ${current.version}.`
      );
    }
    if ((await stageDraftDigest(current)) !== input.expectedDraftDigest) {
      throw new Error(
        'Assembly working copy changed while its historical parts were being staged.'
      );
    }
    const candidate = await composeHistoricalAssemblyComponents(
      current,
      sourceRecords,
      input.selections
    );
    if (input.abortSignal?.aborted) throw new Error('Historical component staging was canceled.');
    if (
      !useDesignStore
        .getState()
        .commitWorkbenchDesign(current.id, candidate, input.expectedDesignVersion)
    ) {
      throw new Error('Assembly working copy changed before the selected components were staged.');
    }
    captureDesignRecovery(candidate, current);
    return { designId: candidate.id, designVersion: candidate.version, draftPath: owned.path };
  });
  retryDesignArtifactMirror(staged.designId);
  await drainDesignArtifactMirrors([staged.designId]);
  return {
    constructId: input.constructId,
    ...staged,
    stagedCount: input.selections.length,
  };
}
