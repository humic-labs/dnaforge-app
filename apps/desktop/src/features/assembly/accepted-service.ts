import { FinalizationPreconditionError } from './finalization-error';
import { computeChecksum } from '@waypoint/sequence-utils';
import {
  buildAcceptedAssemblyProjectionInput,
  buildAcceptedAssemblyValidationSnapshot,
  buildSourceProvenanceSnapshot,
} from './accepted-canonical';
import { requireConstructId } from './accepted-construct-id';
import {
  appendAcceptedAssemblyVersionToDesign,
  buildAcceptedAssemblyVersion,
} from './accepted-finalization';
import type { AcceptedAssemblyPrimerOligo } from './accepted-types';
import type {
  AcceptedAssemblyArtifactManifest,
  AcceptedAssemblySourceAnnotationSnapshot,
  AcceptedAssemblySourceProvenanceSnapshot,
  AcceptedAssemblyQualifierBag,
  AcceptedAssemblyQualifierValue,
  AcceptedAssemblyVersion,
  AcceptedAssemblyWriteTarget,
} from './accepted-types';
import {
  prepareAcceptedAssemblyFiles,
  projectionInputToAnnotatedSequence,
  writeAcceptedAssemblyFiles,
  type AcceptedAssemblyFileOps,
  type AcceptedAssemblyWorkspaceFolder,
  type AcceptedAssemblyWorkspaceFolderMap,
  type PreparedAcceptedAssemblyFiles,
} from './accepted-writer';
import type { SequenceDesign } from '../design/public/types';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type {
  SchemaBoundSequenceEntityMetadata,
  SequencePackageDocument,
} from '../../db/sequence-package';
import {
  deriveAssemblyIssues,
  issueBlocksGate,
  issuesToAcceptedValidationIssues,
} from './issues/assembly-issues';
import { assertHistoricalComponentSelectionsCurrent } from './historical-component-composition';

export type AcceptedAssemblySequenceCache = Record<string, AnnotatedSequence>;
export type AcceptedAssemblySourceIdentityResolver = (
  sourceSequenceId: string,
  sourceSequenceChecksum: string | undefined
) => Promise<{
  sourceConstructId: string;
  sourceSequenceVersionId: string;
  sourceLocator: string;
} | null>;

export type FinalizeAcceptedAssemblyDraftInput = {
  design: SequenceDesign;
  writeTarget: AcceptedAssemblyWriteTarget;
  workspaceFolders: AcceptedAssemblyWorkspaceFolderMap;
  fs: AcceptedAssemblyFileOps;
  sequenceCache?: AcceptedAssemblySequenceCache;
  acceptedAt?: string;
  acceptedBy?: string;
  createId?: () => string;
  existingPackageDocument?: SequencePackageDocument;
  entityMetadata?: SchemaBoundSequenceEntityMetadata;
  agentOperation?: {
    idempotencyKey: string;
    previewFingerprint: string;
  };
  sourceIdentityResolver?: AcceptedAssemblySourceIdentityResolver;
};

export type FinalizeAcceptedAssemblyDraftResult = {
  acceptedVersion: AcceptedAssemblyVersion;
  files: PreparedAcceptedAssemblyFiles;
  nextDesign: SequenceDesign;
  productSequence: AnnotatedSequence;
};

export type PrepareAcceptedAssemblyDraftInput = Omit<FinalizeAcceptedAssemblyDraftInput, 'fs'> & {
  constructId?: string;
  savedPrimerOligos?: readonly AcceptedAssemblyPrimerOligo[];
};

export type PrepareAcceptedAssemblyDraftResult = {
  acceptedVersion: AcceptedAssemblyVersion;
  files: PreparedAcceptedAssemblyFiles;
  productSequence: AnnotatedSequence;
};

export function workspaceFoldersToAcceptedAssemblyMap(
  folders: readonly AcceptedAssemblyWorkspaceFolder[]
): AcceptedAssemblyWorkspaceFolderMap {
  return Object.fromEntries(folders.map((folder) => [folder.path, folder]));
}

export function defaultAcceptedAssemblyWriteTarget(
  design: Pick<SequenceDesign, 'name'>,
  workspaceFolderId: string
): AcceptedAssemblyWriteTarget {
  return {
    workspaceFolderId,
    relativeDirectory: 'assemblies',
    basename: sanitizeAcceptedAssemblyDefaultBasename(`${design.name || 'assembly'} accepted`),
  };
}

export function defaultAcceptedAssemblyProductPath(
  design: Pick<SequenceDesign, 'name'>,
  baseDirectory: string
): string {
  const separator = baseDirectory.includes('\\') ? '\\' : '/';
  const root = stripTrailingSeparators(baseDirectory);
  return acceptedAssemblyProductPathInDirectory(design, `${root}${separator}assemblies`);
}

export function acceptedAssemblyProductPathInDirectory(
  design: Pick<SequenceDesign, 'name'>,
  directory: string
): string {
  const separator = directory.includes('\\') ? '\\' : '/';
  const root = stripTrailingSeparators(directory);
  const basename = sanitizeAcceptedAssemblyDefaultBasename(`${design.name || 'assembly'} accepted`);
  return `${root}${separator}${basename}.gb`;
}

export function acceptedAssemblyWriteTargetFromProductPath(
  productPath: string,
  options: { overwrite?: boolean; parentIsExistingPackage?: boolean } = {}
): AcceptedAssemblyWriteTarget {
  return {
    absoluteProductPath: productPath,
    overwrite: options.overwrite ?? false,
    parentIsExistingPackage: options.parentIsExistingPackage ?? false,
  };
}

export function sanitizeAcceptedAssemblyDefaultBasename(input: string): string {
  const sanitized = input
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || 'assembly-accepted';
}

function stripTrailingSeparators(input: string): string {
  return input.replace(/[\\/]+$/, '');
}

export async function mergeLoadedSourceSequencesForAcceptedProvenance(
  design: SequenceDesign,
  sequenceCache: AcceptedAssemblySequenceCache,
  loadSource: (sourceSequenceId: string) => Promise<AnnotatedSequence | null>
): Promise<AcceptedAssemblySequenceCache> {
  const next: AcceptedAssemblySequenceCache = { ...sequenceCache };
  for (const region of design.regions) {
    if (region.sourceAnnotations && region.sourceAnnotations.length > 0) continue;
    const cached = next[region.sourceSequenceId];
    if (cached?.annotations && cached.annotations.length > 0) continue;
    const loaded = await loadSource(region.sourceSequenceId);
    if (loaded) next[region.sourceSequenceId] = loaded;
  }
  return next;
}

export async function buildAcceptedAssemblySourceProvenance(
  design: SequenceDesign,
  sequenceCache: AcceptedAssemblySequenceCache = {},
  sourceIdentityResolver?: AcceptedAssemblySourceIdentityResolver
): Promise<AcceptedAssemblySourceProvenanceSnapshot[]> {
  await assertHistoricalComponentSelectionsCurrent(design);
  const hasHistoricalComposition = Boolean(design.historicalComponentSources?.length);
  return Promise.all(
    design.regions.map(async (region) => {
      const pinned = design.historicalComponentSources?.find(
        (item) =>
          item.kind === 'region' && item.targetComponentId === JSON.stringify(['region', region.id])
      )?.sourceProvenance;
      if (pinned) return pinned;
      const source = hasHistoricalComposition ? undefined : sequenceCache[region.sourceSequenceId];
      const sourceSequence = source?.sequence ?? region.sourceSequence;
      const sourceSequenceChecksum = sourceSequence
        ? await computeChecksum(sourceSequence)
        : undefined;
      const stableIdentity =
        !hasHistoricalComposition && sourceIdentityResolver
          ? await sourceIdentityResolver(region.sourceSequenceId, sourceSequenceChecksum)
          : null;

      return buildSourceProvenanceSnapshot(region, {
        ...(stableIdentity ?? {}),
        sourceSequenceChecksum,
        sourceLength: source?.length ?? sourceSequence?.length,
        sourceIsCircular: source?.circular ?? region.sourceIsCircular,
        sourceAnnotations: resolveSourceAnnotationsForRegion(region, source),
      });
    })
  );
}

function resolveSourceAnnotationsForRegion(
  region: SequenceDesign['regions'][number],
  source: AnnotatedSequence | undefined
): AcceptedAssemblySourceAnnotationSnapshot[] | undefined {
  if (region.sourceAnnotations && region.sourceAnnotations.length > 0) {
    return undefined;
  }
  if (source?.annotations && source.annotations.length > 0) {
    return acceptedSourceAnnotationsFromSequence(source.annotations);
  }
  return undefined;
}

function acceptedSourceAnnotationsFromSequence(
  annotations: NonNullable<AnnotatedSequence['annotations']>
): AcceptedAssemblySourceAnnotationSnapshot[] {
  return annotations.map((annotation) => ({
    name: annotation.name,
    type: annotation.type,
    start: Math.max(0, annotation.start - 1),
    end: annotation.end,
    strand:
      annotation.direction === 1 ? 'forward' : annotation.direction === -1 ? 'reverse' : 'none',
    color: annotation.color,
    qualifiers: acceptedQualifierBagFromSequence(annotation.qualifiers),
  }));
}

function acceptedQualifierBagFromSequence(
  qualifiers: NonNullable<AnnotatedSequence['annotations']>[number]['qualifiers']
): AcceptedAssemblyQualifierBag | undefined {
  if (!qualifiers) return undefined;
  const bag: AcceptedAssemblyQualifierBag = {};
  for (const [key, value] of Object.entries(qualifiers)) {
    const normalized = acceptedQualifierValue(value);
    if (normalized !== undefined) bag[key] = normalized;
  }
  return Object.keys(bag).length > 0 ? bag : undefined;
}

function acceptedQualifierValue(
  value: string | readonly string[] | undefined
): AcceptedAssemblyQualifierValue | undefined {
  if (Array.isArray(value)) return value.length > 0 ? [...value] : undefined;
  return value;
}

export async function finalizeAcceptedAssemblyDraft(
  input: FinalizeAcceptedAssemblyDraftInput
): Promise<FinalizeAcceptedAssemblyDraftResult> {
  const prepared = await prepareAcceptedAssemblyDraft(input);
  await writeAcceptedAssemblyFiles(prepared.files, input.fs);

  const writtenVersion = markAcceptedAssemblyVersionLifecycle(prepared.acceptedVersion, 'written');
  const nextDesign = appendAcceptedAssemblyVersionToDesign(input.design, writtenVersion);
  const productSequence = projectionInputToAnnotatedSequence(writtenVersion.projectionInput, {
    outputPath: prepared.files.productGenBankPath,
  });

  return {
    acceptedVersion: writtenVersion,
    files: prepared.files,
    nextDesign,
    productSequence,
  };
}

export async function prepareAcceptedAssemblyDraft(
  input: PrepareAcceptedAssemblyDraftInput
): Promise<PrepareAcceptedAssemblyDraftResult> {
  assertDesignCanBeFinalized(input.design);
  await assertHistoricalComponentSelectionsCurrent(input.design);
  if (
    input.design.historicalComponentSources?.length &&
    input.design.historicalComponentValidatedVersion !== input.design.version
  ) {
    throw new Error('Validate the current historical component choices before finalizing.');
  }

  const sourceProvenance = await buildAcceptedAssemblySourceProvenance(
    input.design,
    input.sequenceCache,
    input.sourceIdentityResolver
  );
  const projectionInput = await buildAcceptedAssemblyProjectionInput(input.design, {
    sourceProvenance,
    constructId: input.constructId,
  });
  const validationSnapshot = buildAcceptedAssemblyValidationSnapshot({
    designId: input.design.id,
    designVersion: input.design.version,
    assemblyMethod: input.design.assemblyMethod,
    projectionInputChecksum: projectionInput.canonicalDraftChecksum,
    issues: issuesToAcceptedValidationIssues(deriveAssemblyIssues({ design: input.design })),
    validatedAt: input.acceptedAt,
  });

  const acceptedVersion = await buildAcceptedAssemblyVersion({
    design: input.design,
    sourceProvenance,
    validationSnapshot,
    acceptedAt: input.acceptedAt,
    acceptedBy: input.acceptedBy,
    createId: input.createId,
    ...(input.savedPrimerOligos?.length ? { savedPrimerOligos: input.savedPrimerOligos } : {}),
  });
  const files = await prepareAcceptedAssemblyFiles({
    projectionInput: acceptedVersion.projectionInput,
    validationSnapshot: acceptedVersion.validationSnapshot,
    writeTarget: input.writeTarget,
    workspaceFolders: input.workspaceFolders,
    acceptedAt: acceptedVersion.acceptedAt,
    productDate: new Date(input.design.updatedAt),
    acceptedBy: acceptedVersion.acceptedBy,
    acceptedVersionId: acceptedVersion.id,
    packageId: requireConstructId(
      acceptedVersion.projectionInput.constructId,
      'Accepted assembly package'
    ),
    agentOperation: input.agentOperation,
    existingPackageDocument: input.existingPackageDocument,
    entityMetadata: input.entityMetadata,
    ...(acceptedVersion.savedPrimerOligos?.length
      ? { savedPrimerOligos: acceptedVersion.savedPrimerOligos }
      : {}),
  });

  const writingVersion: AcceptedAssemblyVersion = {
    ...acceptedVersion,
    lifecycleState: 'writing',
    artifacts: artifactManifestFromPreparedFiles(files),
  };
  const productSequence = projectionInputToAnnotatedSequence(writingVersion.projectionInput, {
    outputPath: files.productGenBankPath,
  });

  return {
    acceptedVersion: writingVersion,
    files,
    productSequence,
  };
}

export function markAcceptedAssemblyVersionLifecycle(
  acceptedVersion: AcceptedAssemblyVersion,
  lifecycleState: AcceptedAssemblyVersion['lifecycleState']
): AcceptedAssemblyVersion {
  return {
    ...acceptedVersion,
    lifecycleState,
  };
}

export function assertDesignCanBeFinalized(design: SequenceDesign): void {
  if (design.assemblyState !== 'ready' && design.assemblyState !== 'assembled') {
    throw new FinalizationPreconditionError(
      'draft_required',
      'Validate this assembly before finalizing it.'
    );
  }
  const errors = deriveAssemblyIssues({ design }).filter((issue) =>
    issueBlocksGate(issue, 'finalize')
  );
  if (errors.length > 0) {
    throw new Error(
      errors.length === 1
        ? errors[0].shortMessage
        : 'Resolve assembly issues before finalizing this assembly.'
    );
  }
  if (design.regions.length < 2) {
    throw new Error('At least two assembly parts are required before finalizing.');
  }
}

function artifactManifestFromPreparedFiles(
  files: PreparedAcceptedAssemblyFiles
): AcceptedAssemblyArtifactManifest {
  return {
    productGenBankPath: files.productGenBankPath,
    sidecarJsonPath: files.metaPath,
    primerCsvPath: files.primerCsvPath,
    primerFastaPath: files.primerFastaPath,
    productSequenceChecksum: files.productSequenceChecksum,
    productGenBankChecksum: files.productGenBankChecksum,
    primerCsvChecksum: files.primerCsvChecksum,
    primerFastaChecksum: files.primerFastaChecksum,
    sidecarChecksum: files.sidecarChecksum,
    canonicalDraftChecksum: files.canonicalDraftChecksum,
  };
}
