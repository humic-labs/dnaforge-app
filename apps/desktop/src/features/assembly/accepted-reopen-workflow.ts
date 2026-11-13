import { computeChecksum } from '@waypoint/sequence-utils';
import {
  createPackageAssemblyWorkingCopy,
  readPackageAssemblyWorkingCopy,
} from '../../db/sequence-package-working-copy-storage';
import { getCatalogEventsForEntity, recordCatalogEvent } from '../../db/workspace-catalog';
import { parseWorkspaceArtifact } from '../../db/workspace-artifacts';
import { platform } from '../../platform';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import { findContainingPathBoundary } from '../../shared/path-boundary';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useDesignStore } from '../design/public/store';
import { useDesignRecoveryStore } from '../design/public/design-recovery';
import { packageAssemblyWorkingCopyDesignId } from '../design/public/package-working-copy-identity';
import type { SequenceDesign } from '../design/public/types';
import type { AcceptedAssemblyVersion } from './accepted-types';
import {
  resolveAcceptedAssemblyRecord,
  type AcceptedRecordSelector,
  type ResolvedAcceptedAssemblyRecord,
} from './accepted-record-reader';
import {
  acceptedAssemblyVersionFromSidecar,
  sequenceDesignFromAcceptedAssemblyVersion,
} from './accepted-reopen';

const inFlightReopens = new Map<string, Promise<ReopenAcceptedAssemblyResult>>();

type ReopenedDesign = ReturnType<typeof sequenceDesignFromAcceptedAssemblyVersion>;

interface LegacyReopen {
  path: string;
  name: string;
  checksum: string;
  design: SequenceDesign;
  updatedAt: string;
}

export interface ReopenAcceptedAssemblyResult {
  status: 'completed';
  idempotentReplay: boolean;
  constructId: string;
  parentAcceptedAssemblyVersionId: string;
  designId: string;
  draftPath: string;
  resourceUri: string;
  openTabRequired: true;
}

interface ReopenedDraftIdentity {
  designId: string;
  constructId: string;
  parentAcceptedAssemblyVersionId: string;
}

export async function reopenAcceptedAssemblyWorkflow(input: {
  selector: AcceptedRecordSelector;
  idempotencyKey: string;
  actor?: string;
  requireProductIntegrity?: boolean;
  resolveRecord?: (selector: AcceptedRecordSelector) => Promise<ResolvedAcceptedAssemblyRecord>;
  abortSignal?: AbortSignal;
}): Promise<ReopenAcceptedAssemblyResult> {
  const operationKey = `${input.selector.constructId ?? input.selector.locator ?? ''}:${input.selector.acceptedAssemblyVersionId ?? ''}:${input.idempotencyKey}`;
  const existingOperation = inFlightReopens.get(operationKey);
  if (existingOperation) {
    const replay = await existingOperation;
    return { ...replay, idempotentReplay: true };
  }
  const operation = performReopenAcceptedAssemblyWorkflow(input);
  inFlightReopens.set(operationKey, operation);
  try {
    return await operation;
  } finally {
    if (inFlightReopens.get(operationKey) === operation) inFlightReopens.delete(operationKey);
  }
}

async function performReopenAcceptedAssemblyWorkflow(input: {
  selector: AcceptedRecordSelector;
  idempotencyKey: string;
  actor?: string;
  requireProductIntegrity?: boolean;
  resolveRecord?: (selector: AcceptedRecordSelector) => Promise<ResolvedAcceptedAssemblyRecord>;
  abortSignal?: AbortSignal;
}): Promise<ReopenAcceptedAssemblyResult> {
  const resolveRecord = input.resolveRecord ?? resolveAcceptedAssemblyRecord;
  const record = await resolveRecord(input.selector);
  const requireProductIntegrity = input.requireProductIntegrity !== false;
  if (
    requireProductIntegrity &&
    record.recordIsCurrent !== false &&
    record.integrity.productGenBank !== 'verified'
  ) {
    throw new Error(
      `Accepted assembly product integrity is ${record.integrity.productGenBank}; reopen requires verified immutable product bytes.`
    );
  }
  const acceptedVersion = acceptedAssemblyVersionFromSidecar(record.accepted);
  const designId = await packageAssemblyWorkingCopyDesignId(record.constructId, acceptedVersion.id);
  const identity: ReopenedDraftIdentity = {
    designId,
    constructId: record.constructId,
    parentAcceptedAssemblyVersionId: acceptedVersion.id,
  };
  const actor = input.actor ?? 'local-user';
  const workspaceRoot =
    findContainingPathBoundary(
      useWorkspaceStore.getState().folders.filter((folder) => !folder.pinned),
      record.packageRoot
    )?.path ?? null;
  if (!workspaceRoot) {
    throw new Error('The accepted plasmid package is not inside an open writable project.');
  }
  if (input.abortSignal?.aborted) throw new Error('Reopen was canceled before creating a draft.');

  return withRendererWorkspaceMutation(workspaceRoot, async (mutationToken) => {
    const activeCopy = await readPackageAssemblyWorkingCopy(record.packageRoot);
    if (activeCopy) {
      if (activeCopy.published) {
        throw new Error(
          'The accepted assembly was written, but retirement of its working copy was interrupted. ' +
            'This copy cannot be edited or reopened until publication is reconciled.'
        );
      }
      if (
        activeCopy.design.constructId !== record.constructId ||
        activeCopy.design.parentAcceptedAssemblyVersionId !== acceptedVersion.id
      ) {
        throw new Error(
          'This package already has an unfinished assembly from another accepted version.'
        );
      }
      await retireMatchingLegacyDrafts(
        await findLegacyReopens(record),
        activeCopy.design,
        mutationToken
      );
      useDesignStore.getState().resolveExistingDraft({
        designId: activeCopy.design.id,
        artifactDesign: activeCopy.design,
        identity,
      });
      await recordReopenEvent(
        record,
        activeCopy.design.id,
        activeCopy.path,
        actor,
        input.idempotencyKey
      );
      return result(record, acceptedVersion.id, activeCopy.design.id, activeCopy.path, true);
    }

    const legacyDrafts = await findLegacyReopens(record);
    const legacyDesign = resumableLegacyDesign(legacyDrafts, identity);
    if (await findReopenLineageEvent(record.constructId, identity)) {
      throw new Error(
        'The prior assembly working copy was consumed or removed. It will not be recreated silently.'
      );
    }
    const design = legacyDesign ?? newReopenedDraft(acceptedVersion, identity);
    const { copy } = await createPackageAssemblyWorkingCopy({
      packageRoot: record.packageRoot,
      packageId: record.packageId,
      design,
      mutationToken,
    });
    await retireMatchingLegacyDrafts(legacyDrafts, copy.design, mutationToken);
    useDesignStore.getState().upsertDesignFromArtifact(copy.design);
    await recordReopenEvent(record, copy.design.id, copy.path, actor, input.idempotencyKey);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-files-changed', {
          detail: { path: record.packageRoot, workspaceRoot },
        })
      );
    }
    return result(record, acceptedVersion.id, copy.design.id, copy.path, false);
  });
}

async function findLegacyReopens(record: ResolvedAcceptedAssemblyRecord): Promise<LegacyReopen[]> {
  const parent = parentDirectoryOf(record.packageRoot);
  const entries = await platform().fs.readDir(parent);
  const matches: LegacyReopen[] = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith('.wpdesign.json')) continue;
    const path = `${parent}/${entry.name}`;
    try {
      const raw = await platform().fs.readTextFile(path);
      const artifact = parseWorkspaceArtifact(raw);
      if (
        artifact.kind === 'assembly-design' &&
        artifact.design?.constructId === record.constructId &&
        artifact.design.parentAcceptedAssemblyVersionId
      ) {
        matches.push({
          path,
          name: entry.name,
          checksum: await computeChecksum(raw),
          design: artifact.design,
          updatedAt: typeof artifact.raw.updatedAt === 'string' ? artifact.raw.updatedAt : '',
        });
      }
    } catch {
      if (entry.name.startsWith(`${record.accepted.designName}-reopened-`)) {
        throw new Error(`Legacy assembly ${entry.name} could not be read. It was not migrated.`);
      }
    }
  }
  return matches;
}

function comparableLegacyDesign(design: SequenceDesign): string {
  return JSON.stringify(
    { ...design, id: '', createdAt: '', updatedAt: '' },
    (key, value: unknown) => {
      if (key === 'proposedPlans') return undefined;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value;
    }
  );
}

function resumableLegacyDesign(
  drafts: LegacyReopen[],
  identity: ReopenedDraftIdentity
): ReopenedDesign | null {
  if (drafts.length === 0) return null;
  const first = drafts[0];
  const comparison = comparableLegacyDesign(first.design);
  if (
    drafts.some(
      (draft) =>
        draft.design.parentAcceptedAssemblyVersionId !== identity.parentAcceptedAssemblyVersionId ||
        comparableLegacyDesign(draft.design) !== comparison
    )
  ) {
    throw new Error(
      `This sequence has ${drafts.length} different legacy assembly drafts outside its package: ` +
        `${drafts.map((draft) => draft.name).join(', ')}. They must be reconciled explicitly; no new draft was created.`
    );
  }
  for (const draft of drafts) {
    const loaded = useDesignStore.getState().designs[draft.design.id];
    const recovery = useDesignRecoveryStore.getState().records[draft.design.id];
    if (
      (loaded && comparableLegacyDesign(loaded) !== comparison) ||
      (recovery &&
        (recovery.pending ||
          recovery.conflict ||
          recovery.alternatives?.length ||
          comparableLegacyDesign(recovery.design) !== comparison))
    ) {
      throw new Error(
        `Legacy assembly ${draft.name} has unsaved or conflicting edits. It was not migrated.`
      );
    }
  }
  const loadedCanonical = useDesignStore.getState().loadedDraft(identity.designId, identity);
  if (loadedCanonical && comparableLegacyDesign(loadedCanonical) !== comparison) {
    throw new Error('The loaded assembly differs from the legacy files. Neither was overwritten.');
  }
  const selected = [...drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return { ...selected.design, id: identity.designId } as ReopenedDesign;
}

async function retireMatchingLegacyDrafts(
  drafts: LegacyReopen[],
  activeDesign: SequenceDesign,
  mutationToken?: string
): Promise<void> {
  const comparison = comparableLegacyDesign(activeDesign);
  for (const draft of drafts) {
    if (comparableLegacyDesign(draft.design) !== comparison) {
      throw new Error(`Legacy assembly ${draft.name} differs from the package working copy.`);
    }
    if ((await computeChecksum(await platform().fs.readTextFile(draft.path))) !== draft.checksum) {
      throw new Error(
        `Legacy assembly ${draft.name} changed during migration; it was not removed.`
      );
    }
    await platform().shell.trashItem(draft.path, mutationToken);
  }
}

async function recordReopenEvent(
  record: ResolvedAcceptedAssemblyRecord,
  designId: string,
  draftPath: string,
  actor: string,
  idempotencyKey: string
): Promise<void> {
  const events = await getCatalogEventsForEntity(record.constructId);
  const exists = events.some((event) => {
    if (event.event_type !== 'accepted_assembly_reopened' || !event.payload) return false;
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      return payload.reopenedDesignId === designId;
    } catch {
      return false;
    }
  });
  if (exists) return;
  await recordCatalogEvent({
    entityId: record.constructId,
    eventType: 'accepted_assembly_reopened',
    actor,
    summary: 'Opened a package-owned assembly working copy',
    payload: {
      acceptedAssemblyVersionId: record.acceptedAssemblyVersionId,
      reopenedDesignId: designId,
      draftPath,
      idempotencyKey,
    },
  });
}

function newReopenedDraft(
  acceptedVersion: AcceptedAssemblyVersion,
  identity: ReopenedDraftIdentity
): ReopenedDesign {
  const loaded = useDesignStore.getState().loadedDraft(identity.designId, identity);
  if (loaded) return loaded;
  return {
    ...sequenceDesignFromAcceptedAssemblyVersion(acceptedVersion, { designId: identity.designId }),
    constructId: identity.constructId,
    parentAcceptedAssemblyVersionId: identity.parentAcceptedAssemblyVersionId,
  };
}

async function findReopenLineageEvent(
  constructId: string,
  identity: ReopenedDraftIdentity
): Promise<boolean> {
  const events = await getCatalogEventsForEntity(constructId);
  return events.some((event) => {
    if (event.event_type !== 'accepted_assembly_reopened' || !event.payload) return false;
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      return (
        payload.reopenedDesignId === identity.designId &&
        payload.acceptedAssemblyVersionId === identity.parentAcceptedAssemblyVersionId
      );
    } catch {
      return false;
    }
  });
}

function result(
  record: ResolvedAcceptedAssemblyRecord,
  acceptedAssemblyVersionId: string,
  designId: string,
  draftPath: string,
  idempotentReplay: boolean
): ReopenAcceptedAssemblyResult {
  return {
    status: 'completed',
    idempotentReplay,
    constructId: record.constructId,
    parentAcceptedAssemblyVersionId: acceptedAssemblyVersionId,
    designId,
    draftPath,
    resourceUri: `waypoint://design/${encodeURIComponent(designId)}`,
    openTabRequired: true,
  };
}

function parentDirectoryOf(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : '/';
}
