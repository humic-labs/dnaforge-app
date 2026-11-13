import type {
  LinkedItemRecoveryObjectType,
  MigrationRun,
  RelationshipResolution,
  SourceObject,
  SourceRelationship,
  ValidationLinkedItemRecoveryAttemptEvidence,
  ValidationLinkedItemRecoveryEvidence,
  ValidationLinkedItemRecoveryFolderEvidence,
  ValidationLinkedItemRecoveryTargetEvidence,
} from '../../shared/benchling-migration';
import { selectedSnapshotRelationshipTargetAuthority } from './relationship-resolver';
import { benchlingOrganizationBaseUrlFromSourceUrl } from './source-identity';

export type BuildLinkedItemRecoveryEvidenceInput = Readonly<{
  run: MigrationRun;
  sourceObjects: readonly SourceObject[];
  resolutions: readonly RelationshipResolution[];
  priorEvidence?: ValidationLinkedItemRecoveryEvidence | null;
  attempts?: readonly ValidationLinkedItemRecoveryAttemptEvidence[];
}>;

export type LinkedItemRecoveryLocationKind = 'folder' | 'target';

type RelationshipSeed = {
  relationshipId: string;
  targetSourceId: string;
  fromCurrentUnresolvedResolution: boolean;
  currentUnresolvedResolution: RelationshipResolution | null;
  priorTarget: ValidationLinkedItemRecoveryTargetEvidence | null;
};

type RelationshipAuthorityCandidate = {
  seed: RelationshipSeed;
  relationship: SourceRelationship;
  owner: SourceObject;
  observedUrl: string;
  organizationBaseUrl: string;
};

type ExactRecoveryLocation = {
  folderId: string;
  folderName: string;
  folderUrl: string;
  folderItemRouteUrl: string;
  targetName: string;
  targetUrl: string;
  objectType: LinkedItemRecoveryObjectType;
};

type PlannedRelationship = RelationshipAuthorityCandidate & ExactRecoveryLocation;

type PlannedTarget = {
  sourceId: string;
  name: string;
  sourceUrl: string;
  objectType: LinkedItemRecoveryObjectType;
  folderId: string;
  folderName: string;
  folderUrl: string;
  relationshipIds: string[];
};

const RECOVERY_SCHEMA = 'dnaforge.benchling.linked-item-recovery-validation.v1' as const;
const RECOVERY_OBJECT_TYPES: readonly LinkedItemRecoveryObjectType[] = [
  'dna_rna_sequence',
  'protein',
  'protocol',
  'other',
];
const BENCHLING_SOURCE_ID_PATTERN = /^[a-z][a-z0-9]{1,15}_[A-Za-z0-9_]{3,}$/u;
const BENCHLING_FOLDER_ID_PATTERN = /^(?:lib|fld|src)_[A-Za-z0-9_]{3,}$/u;

export function buildLinkedItemRecoveryEvidence(
  input: BuildLinkedItemRecoveryEvidenceInput
): ValidationLinkedItemRecoveryEvidence | null {
  const { run, sourceObjects, resolutions, priorEvidence = null, attempts = [] } = input;
  if (!isEligibleOriginalZipRun(run)) return null;

  const relationshipsById = indexRelationshipsById(sourceObjects);
  const seeds = collectRelationshipSeeds(resolutions, priorEvidence);
  if (seeds.size === 0) return null;

  const authorityCandidates: RelationshipAuthorityCandidate[] = [];
  for (const seed of seeds.values()) {
    const matches = relationshipsById.get(seed.relationshipId) ?? [];
    if (matches.length !== 1) continue;
    const { owner, relationship } = matches[0];
    if (!relationshipCapturesTarget(owner, relationship, seed)) continue;
    const observedUrl = oneExactObservedRelationshipUrl(relationship);
    if (!observedUrl) continue;
    const organizationBaseUrl = organizationBaseUrlOrNull(observedUrl);
    if (!organizationBaseUrl) continue;
    authorityCandidates.push({
      seed,
      relationship,
      owner,
      observedUrl,
      organizationBaseUrl,
    });
  }
  if (authorityCandidates.length === 0) return null;

  const conflictingTargetIds = conflictingObservedTargetIds(authorityCandidates);
  const eligibleCandidates = authorityCandidates.filter(
    (candidate) => !conflictingTargetIds.has(candidate.seed.targetSourceId)
  );
  const organizationBaseUrl = selectRecoveryOrganization(eligibleCandidates);
  if (!organizationBaseUrl) return null;

  const plannedRelationships: PlannedRelationship[] = [];
  for (const candidate of eligibleCandidates) {
    if (candidate.organizationBaseUrl !== organizationBaseUrl) continue;
    const authority = selectedSnapshotRelationshipTargetAuthority({
      relationship: candidate.relationship,
      targetSourceId: candidate.seed.targetSourceId,
      benchlingOrganizationBaseUrl: organizationBaseUrl,
    });
    if (authority.kind !== 'authorized' || authority.observedUrl !== candidate.observedUrl) {
      continue;
    }
    const location = exactRecoveryLocationOrNull(
      authority.observedUrl,
      organizationBaseUrl,
      candidate.seed.targetSourceId
    );
    if (!location) continue;
    if (
      !candidate.seed.fromCurrentUnresolvedResolution &&
      candidate.seed.priorTarget &&
      !priorTargetMatchesLocation(candidate.seed.priorTarget, location)
    ) {
      continue;
    }
    plannedRelationships.push({ ...candidate, ...location });
  }

  const staticTargets = aggregatePlannedTargets(plannedRelationships);
  if (staticTargets.length === 0) return null;

  const currentResolutionsById = indexCurrentResolutions(resolutions);
  const recoveredSourceIds = recoveredSourceIdSet(sourceObjects);
  const targetEvidence = staticTargets.map((target) => {
    const repairedRelationshipIds = target.relationshipIds.filter((relationshipId) =>
      isRepairedRelationship(
        currentResolutionsById.get(relationshipId) ?? [],
        relationshipsById.get(relationshipId) ?? [],
        target.sourceId,
        recoveredSourceIds.has(target.sourceId)
      )
    );
    return {
      sourceId: target.sourceId,
      name: target.name,
      sourceUrl: target.sourceUrl,
      objectType: target.objectType,
      folderId: target.folderId,
      relationshipCount: target.relationshipIds.length,
      relationshipIds: [...target.relationshipIds],
      recovered:
        target.relationshipIds.length > 0 &&
        repairedRelationshipIds.length === target.relationshipIds.length,
    } satisfies ValidationLinkedItemRecoveryTargetEvidence;
  });

  const repairedRelationshipCount = staticTargets.reduce((total, target) => {
    if (!recoveredSourceIds.has(target.sourceId)) return total;
    return (
      total +
      target.relationshipIds.filter((relationshipId) =>
        isRepairedRelationship(
          currentResolutionsById.get(relationshipId) ?? [],
          relationshipsById.get(relationshipId) ?? [],
          target.sourceId,
          true
        )
      ).length
    );
  }, 0);
  const folders = buildFolderEvidence(staticTargets, targetEvidence);
  const folderRank = new Map(folders.map((folder, index) => [folder.sourceId, index]));
  targetEvidence.sort(
    (left, right) =>
      (folderRank.get(left.folderId) ?? Number.MAX_SAFE_INTEGER) -
        (folderRank.get(right.folderId) ?? Number.MAX_SAFE_INTEGER) ||
      left.name.localeCompare(right.name) ||
      left.sourceId.localeCompare(right.sourceId)
  );

  const relationshipCount = targetEvidence.reduce(
    (total, target) => total + target.relationshipCount,
    0
  );
  const recoveredUniqueObjectCount = targetEvidence.filter((target) => target.recovered).length;
  return {
    schema: RECOVERY_SCHEMA,
    organizationBaseUrl,
    relationshipCount,
    uniqueTargetCount: targetEvidence.length,
    folderCount: folders.length,
    recoveredUniqueObjectCount,
    remainingUniqueObjectCount: targetEvidence.length - recoveredUniqueObjectCount,
    repairedRelationshipCount,
    remainingRelationshipCount: relationshipCount - repairedRelationshipCount,
    folders,
    targets: targetEvidence,
    attempts: mergeAttemptEvidence(priorEvidence?.attempts ?? [], attempts),
  };
}

export function resolveLinkedItemRecoveryLocation(
  evidence: ValidationLinkedItemRecoveryEvidence,
  kind: LinkedItemRecoveryLocationKind,
  sourceId: string
): string | null {
  if (
    evidence.schema !== RECOVERY_SCHEMA ||
    (kind !== 'folder' && kind !== 'target') ||
    !BENCHLING_SOURCE_ID_PATTERN.test(sourceId)
  ) {
    return null;
  }
  const entries = kind === 'folder' ? evidence.folders : evidence.targets;
  const matches = entries.filter((entry) => entry.sourceId === sourceId);
  if (matches.length !== 1) return null;
  const entry = matches[0];
  if (kind === 'folder') {
    const folder = entry as ValidationLinkedItemRecoveryFolderEvidence;
    const targets = evidence.targets.filter((target) => target.folderId === sourceId);
    if (
      targets.length === 0 ||
      targets.length !== folder.targetCount ||
      targets.reduce((total, target) => total + target.relationshipCount, 0) !==
        folder.relationshipCount
    ) {
      return null;
    }
    const locations = targets.map((target) =>
      exactRecoveryLocationOrNull(target.sourceUrl, evidence.organizationBaseUrl, target.sourceId)
    );
    if (locations.some((location) => !location || location.folderId !== sourceId)) return null;
    const exactLocations = locations as ExactRecoveryLocation[];
    const folderUrls = new Set(exactLocations.map((location) => location.folderUrl));
    const itemRouteFolderUrls = new Set(
      exactLocations.map((location) => location.folderItemRouteUrl)
    );
    if (folderUrls.size !== 1 || itemRouteFolderUrls.size !== 1) return null;
    const folderUrl = exactLocations[0].folderUrl;
    const itemRouteFolderUrl = exactLocations[0].folderItemRouteUrl;
    if (folder.sourceUrl !== folderUrl && folder.sourceUrl !== itemRouteFolderUrl) return null;
    return isExactRecoveryFolderUrl(folderUrl, evidence.organizationBaseUrl, sourceId)
      ? folderUrl
      : null;
  }
  const target = entry as ValidationLinkedItemRecoveryTargetEvidence;
  const location = exactRecoveryLocationOrNull(
    target.sourceUrl,
    evidence.organizationBaseUrl,
    sourceId
  );
  return location &&
    location.targetUrl === target.sourceUrl &&
    location.folderId === target.folderId &&
    location.objectType === target.objectType
    ? target.sourceUrl
    : null;
}

function isEligibleOriginalZipRun(run: MigrationRun): boolean {
  return (
    run.scope.acquisition === 'local_bundle' &&
    run.binding === null &&
    run.localExportArtifact?.schema === 'dnaforge.benchling.local-export-artifact.v1' &&
    run.localExportArtifact.format === 'zip' &&
    run.localExportArtifact.archive !== null &&
    run.localExportArtifact.resources.length === 0
  );
}

function indexRelationshipsById(
  sourceObjects: readonly SourceObject[]
): Map<string, Array<{ owner: SourceObject; relationship: SourceRelationship }>> {
  const index = new Map<string, Array<{ owner: SourceObject; relationship: SourceRelationship }>>();
  for (const owner of sourceObjects) {
    for (const relationship of owner.relationships) {
      const matches = index.get(relationship.id) ?? [];
      matches.push({ owner, relationship });
      index.set(relationship.id, matches);
    }
  }
  return index;
}

function collectRelationshipSeeds(
  resolutions: readonly RelationshipResolution[],
  priorEvidence: ValidationLinkedItemRecoveryEvidence | null
): Map<string, RelationshipSeed> {
  const candidates = new Map<string, RelationshipSeed[]>();
  for (const resolution of resolutions) {
    if (
      resolution.classification !== 'unresolved' ||
      resolution.requiresTargetedRead ||
      !resolution.targetSourceId ||
      !BENCHLING_SOURCE_ID_PATTERN.test(resolution.targetSourceId)
    ) {
      continue;
    }
    const seeds = candidates.get(resolution.relationshipId) ?? [];
    seeds.push({
      relationshipId: resolution.relationshipId,
      targetSourceId: resolution.targetSourceId,
      fromCurrentUnresolvedResolution: true,
      currentUnresolvedResolution: resolution,
      priorTarget: null,
    });
    candidates.set(resolution.relationshipId, seeds);
  }

  if (priorEvidence?.schema === RECOVERY_SCHEMA) {
    for (const priorTarget of priorEvidence.targets) {
      if (!BENCHLING_SOURCE_ID_PATTERN.test(priorTarget.sourceId)) continue;
      for (const relationshipId of priorTarget.relationshipIds) {
        const seeds = candidates.get(relationshipId) ?? [];
        seeds.push({
          relationshipId,
          targetSourceId: priorTarget.sourceId,
          fromCurrentUnresolvedResolution: false,
          currentUnresolvedResolution: null,
          priorTarget,
        });
        candidates.set(relationshipId, seeds);
      }
    }
  }

  const result = new Map<string, RelationshipSeed>();
  for (const [relationshipId, seeds] of candidates) {
    const targetIds = new Set(seeds.map((seed) => seed.targetSourceId));
    if (targetIds.size !== 1) continue;
    const currentSeeds = seeds.filter((seed) => seed.fromCurrentUnresolvedResolution);
    if (currentSeeds.length > 1) continue;
    const current = currentSeeds[0];
    const prior = seeds.find((seed) => seed.priorTarget !== null)?.priorTarget ?? null;
    result.set(relationshipId, {
      relationshipId,
      targetSourceId: [...targetIds][0],
      fromCurrentUnresolvedResolution: Boolean(current),
      currentUnresolvedResolution: current?.currentUnresolvedResolution ?? null,
      priorTarget: prior,
    });
  }
  return result;
}

function relationshipCapturesTarget(
  owner: SourceObject,
  relationship: SourceRelationship,
  seed: RelationshipSeed
): boolean {
  if (
    relationship.id !== seed.relationshipId ||
    owner.id !== relationship.sourceObjectId ||
    relationship.sourceBroken
  ) {
    return false;
  }
  const resolution = seed.currentUnresolvedResolution;
  if (
    resolution &&
    (resolution.relationshipId !== relationship.id ||
      resolution.sourceObjectId !== relationship.sourceObjectId ||
      resolution.relationType !== (relationship.relationType?.trim() || 'generic') ||
      JSON.stringify(resolution.evidence) !== JSON.stringify(relationship.evidence))
  ) {
    return false;
  }
  const capturedTargetIds = [
    relationship.targetSourceId,
    ...relationship.evidence.filter((item) => item.kind === 'stable_id').map((item) => item.value),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return (
    capturedTargetIds.length > 0 &&
    capturedTargetIds.every((targetSourceId) => targetSourceId === seed.targetSourceId)
  );
}

function oneExactObservedRelationshipUrl(relationship: SourceRelationship): string | null {
  const values = [
    relationship.targetUrl,
    ...relationship.evidence.filter((item) => item.kind === 'url').map((item) => item.value),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (values.length === 0 || values.some((value) => value !== value.trim())) return null;
  const observedUrls = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        (hostname !== 'benchling.com' && !hostname.endsWith('.benchling.com'))
      ) {
        return null;
      }
      observedUrls.add(url.toString());
    } catch {
      return null;
    }
  }
  return observedUrls.size === 1 ? [...observedUrls][0] : null;
}

function organizationBaseUrlOrNull(sourceUrl: string): string | null {
  try {
    return benchlingOrganizationBaseUrlFromSourceUrl(sourceUrl);
  } catch {
    return null;
  }
}

function conflictingObservedTargetIds(
  candidates: readonly RelationshipAuthorityCandidate[]
): Set<string> {
  const urlsByTarget = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const urls = urlsByTarget.get(candidate.seed.targetSourceId) ?? new Set<string>();
    urls.add(candidate.observedUrl);
    urlsByTarget.set(candidate.seed.targetSourceId, urls);
  }
  return new Set(
    [...urlsByTarget.entries()]
      .filter(([, urls]) => urls.size !== 1)
      .map(([targetSourceId]) => targetSourceId)
  );
}

function selectRecoveryOrganization(
  candidates: readonly RelationshipAuthorityCandidate[]
): string | null {
  const groups = new Map<string, { targetIds: Set<string>; relationshipIds: Set<string> }>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.organizationBaseUrl) ?? {
      targetIds: new Set<string>(),
      relationshipIds: new Set<string>(),
    };
    group.targetIds.add(candidate.seed.targetSourceId);
    group.relationshipIds.add(candidate.seed.relationshipId);
    groups.set(candidate.organizationBaseUrl, group);
  }
  const ranked = [...groups.entries()].sort(
    ([leftUrl, left], [rightUrl, right]) =>
      right.targetIds.size - left.targetIds.size ||
      right.relationshipIds.size - left.relationshipIds.size ||
      leftUrl.localeCompare(rightUrl)
  );
  const first = ranked[0];
  if (!first) return null;
  const second = ranked[1];
  if (
    second &&
    first[1].targetIds.size === second[1].targetIds.size &&
    first[1].relationshipIds.size === second[1].relationshipIds.size
  ) {
    return null;
  }
  return first[0];
}

function exactRecoveryLocationOrNull(
  sourceUrl: string,
  organizationBaseUrl: string,
  targetSourceId: string
): ExactRecoveryLocation | null {
  try {
    const url = new URL(sourceUrl);
    const base = new URL(organizationBaseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.origin !== base.origin ||
      organizationBaseUrlOrNull(sourceUrl) !== organizationBaseUrl
    ) {
      return null;
    }
    const encodedSegments = url.pathname.split('/').filter(Boolean);
    const decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment));
    const baseSegments = base.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (
      decodedSegments
        .slice(0, baseSegments.length)
        .some((segment, index) => segment !== baseSegments[index])
    ) {
      return null;
    }
    const relative = decodedSegments.slice(baseSegments.length);
    const hasTerminalView = relative.at(-1) === 'edit' || relative.at(-1) === 'sbs';
    const route = hasTerminalView ? relative.slice(0, -1) : relative;
    if (route.length !== 3 || route[0] !== 'f') return null;
    const folderPresentation = presentationSegment(route[1], BENCHLING_FOLDER_ID_PATTERN);
    const targetPresentation = presentationSegment(route[2], targetSourceId);
    if (
      !folderPresentation ||
      !targetPresentation ||
      targetPresentation.sourceId !== targetSourceId
    ) {
      return null;
    }
    const folderSegmentIndex = baseSegments.length + 1;
    const folderItemRouteUrl = `${url.origin}/${encodedSegments
      .slice(0, folderSegmentIndex + 1)
      .join('/')}`;
    const folderLandingSegment = benchlingFolderLandingSegment(folderPresentation);
    if (!folderLandingSegment) return null;
    const folderUrl = `${url.origin}/${[
      ...encodedSegments.slice(0, baseSegments.length),
      'f_',
      encodeURIComponent(folderLandingSegment),
    ].join('/')}/`;
    const objectType = objectTypeFromSourceId(targetSourceId);
    return {
      folderId: folderPresentation.sourceId,
      folderName: readablePresentationName(folderPresentation.presentation, 'Benchling folder'),
      folderUrl,
      folderItemRouteUrl,
      targetName: readablePresentationName(
        targetPresentation.presentation,
        readableTargetFallback(objectType)
      ),
      targetUrl: sourceUrl,
      objectType,
    };
  } catch {
    return null;
  }
}

function isExactRecoveryFolderUrl(
  sourceUrl: string,
  organizationBaseUrl: string,
  folderId: string
): boolean {
  try {
    const url = new URL(sourceUrl);
    const base = new URL(organizationBaseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.origin !== base.origin ||
      organizationBaseUrlOrNull(sourceUrl) !== organizationBaseUrl
    ) {
      return false;
    }
    const decodedSegments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const baseSegments = base.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const relative = decodedSegments.slice(baseSegments.length);
    if (
      decodedSegments
        .slice(0, baseSegments.length)
        .some((segment, index) => segment !== baseSegments[index]) ||
      relative.length !== 2 ||
      relative[0] !== 'f_'
    ) {
      return false;
    }
    const publicFolderId = benchlingFolderPublicId(folderId);
    return (
      publicFolderId !== null &&
      presentationSegment(relative[1], publicFolderId)?.sourceId === publicFolderId
    );
  } catch {
    return false;
  }
}

function benchlingFolderLandingSegment(folder: {
  sourceId: string;
  presentation: string;
}): string | null {
  const publicFolderId = benchlingFolderPublicId(folder.sourceId);
  if (!publicFolderId) return null;
  return folder.presentation ? `${publicFolderId}-${folder.presentation}` : publicFolderId;
}

function benchlingFolderPublicId(folderId: string): string | null {
  if (!BENCHLING_FOLDER_ID_PATTERN.test(folderId)) return null;
  const separator = folderId.indexOf('_');
  const publicFolderId = separator === -1 ? '' : folderId.slice(separator + 1);
  return publicFolderId.length > 0 ? publicFolderId : null;
}

function presentationSegment(
  value: string,
  expected: RegExp | string
): { sourceId: string; presentation: string } | null {
  if (typeof expected === 'string') {
    if (value === expected) return { sourceId: expected, presentation: '' };
    if (!value.startsWith(`${expected}-`)) return null;
    const presentation = value.slice(expected.length + 1);
    return presentation.length > 0 ? { sourceId: expected, presentation } : null;
  }
  const separator = value.indexOf('-');
  const sourceId = separator === -1 ? value : value.slice(0, separator);
  if (!expected.test(sourceId)) return null;
  const presentation = separator === -1 ? '' : value.slice(separator + 1);
  return separator === -1 || presentation.length > 0 ? { sourceId, presentation } : null;
}

function readablePresentationName(presentation: string, fallback: string): string {
  const words = presentation.replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!words) return fallback;
  return `${words[0].toLocaleUpperCase('en-US')}${words.slice(1)}`;
}

function readableTargetFallback(objectType: LinkedItemRecoveryObjectType): string {
  const label =
    objectType === 'dna_rna_sequence'
      ? 'DNA/RNA sequence'
      : objectType === 'protein'
        ? 'Protein'
        : objectType === 'protocol'
          ? 'Protocol'
          : 'Linked item';
  return label;
}

function objectTypeFromSourceId(sourceId: string): LinkedItemRecoveryObjectType {
  if (sourceId.startsWith('seq_')) return 'dna_rna_sequence';
  if (sourceId.startsWith('prtn_')) return 'protein';
  if (sourceId.startsWith('prt_')) return 'protocol';
  return 'other';
}

function priorTargetMatchesLocation(
  priorTarget: ValidationLinkedItemRecoveryTargetEvidence,
  location: ExactRecoveryLocation
): boolean {
  return (
    priorTarget.sourceUrl === location.targetUrl &&
    priorTarget.folderId === location.folderId &&
    priorTarget.objectType === location.objectType
  );
}

function aggregatePlannedTargets(
  plannedRelationships: readonly PlannedRelationship[]
): PlannedTarget[] {
  const relationshipsByTarget = new Map<string, PlannedRelationship[]>();
  for (const relationship of plannedRelationships) {
    const values = relationshipsByTarget.get(relationship.seed.targetSourceId) ?? [];
    values.push(relationship);
    relationshipsByTarget.set(relationship.seed.targetSourceId, values);
  }

  const targets: PlannedTarget[] = [];
  for (const [sourceId, relationships] of relationshipsByTarget) {
    const locations = new Set(
      relationships.map((relationship) =>
        JSON.stringify({
          sourceUrl: relationship.targetUrl,
          name: relationship.targetName,
          objectType: relationship.objectType,
          folderId: relationship.folderId,
          folderName: relationship.folderName,
          folderUrl: relationship.folderUrl,
        })
      )
    );
    if (locations.size !== 1) continue;
    const first = relationships[0];
    targets.push({
      sourceId,
      name: first.targetName,
      sourceUrl: first.targetUrl,
      objectType: first.objectType,
      folderId: first.folderId,
      folderName: first.folderName,
      folderUrl: first.folderUrl,
      relationshipIds: [...new Set(relationships.map((item) => item.seed.relationshipId))].sort(),
    });
  }

  const folderLocations = new Map<string, Set<string>>();
  const folderIdsByUrl = new Map<string, Set<string>>();
  for (const target of targets) {
    const locations = folderLocations.get(target.folderId) ?? new Set<string>();
    locations.add(JSON.stringify({ name: target.folderName, sourceUrl: target.folderUrl }));
    folderLocations.set(target.folderId, locations);
    const folderIds = folderIdsByUrl.get(target.folderUrl) ?? new Set<string>();
    folderIds.add(target.folderId);
    folderIdsByUrl.set(target.folderUrl, folderIds);
  }
  const conflictingFolderIds = new Set<string>();
  for (const [folderId, locations] of folderLocations) {
    if (locations.size !== 1) conflictingFolderIds.add(folderId);
  }
  for (const folderIds of folderIdsByUrl.values()) {
    if (folderIds.size > 1) folderIds.forEach((folderId) => conflictingFolderIds.add(folderId));
  }
  return targets.filter((target) => !conflictingFolderIds.has(target.folderId));
}

function indexCurrentResolutions(
  resolutions: readonly RelationshipResolution[]
): Map<string, RelationshipResolution[]> {
  const index = new Map<string, RelationshipResolution[]>();
  for (const resolution of resolutions) {
    const matches = index.get(resolution.relationshipId) ?? [];
    matches.push(resolution);
    index.set(resolution.relationshipId, matches);
  }
  return index;
}

function recoveredSourceIdSet(sourceObjects: readonly SourceObject[]): Set<string> {
  const counts = new Map<string, number>();
  for (const sourceObject of sourceObjects) {
    for (const sourceId of new Set([sourceObject.id, sourceObject.stableId])) {
      counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    }
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count === 1).map(([sourceId]) => sourceId)
  );
}

function isRepairedRelationship(
  resolutions: readonly RelationshipResolution[],
  relationships: readonly { owner: SourceObject; relationship: SourceRelationship }[],
  targetSourceId: string,
  targetExists: boolean
): boolean {
  if (!targetExists || resolutions.length !== 1 || relationships.length !== 1) return false;
  const resolution = resolutions[0];
  const { owner, relationship } = relationships[0];
  return (
    resolution.classification === 'exact' &&
    resolution.targetSourceId === targetSourceId &&
    resolution.relationshipId === relationship.id &&
    resolution.sourceObjectId === owner.id &&
    relationship.sourceObjectId === owner.id &&
    resolution.relationType === (relationship.relationType?.trim() || 'generic') &&
    JSON.stringify(resolution.evidence) === JSON.stringify(relationship.evidence)
  );
}

function buildFolderEvidence(
  staticTargets: readonly PlannedTarget[],
  targetEvidence: readonly ValidationLinkedItemRecoveryTargetEvidence[]
): ValidationLinkedItemRecoveryFolderEvidence[] {
  const targetEvidenceById = new Map(targetEvidence.map((target) => [target.sourceId, target]));
  const targetsByFolder = new Map<string, PlannedTarget[]>();
  for (const target of staticTargets) {
    const targets = targetsByFolder.get(target.folderId) ?? [];
    targets.push(target);
    targetsByFolder.set(target.folderId, targets);
  }
  return [...targetsByFolder.values()]
    .map((targets) => {
      const first = targets[0];
      const countsByType = Object.fromEntries(
        RECOVERY_OBJECT_TYPES.map((objectType) => [
          objectType,
          targets.filter((target) => target.objectType === objectType).length,
        ])
      ) as Record<LinkedItemRecoveryObjectType, number>;
      return {
        sourceId: first.folderId,
        name: first.folderName,
        sourceUrl: first.folderUrl,
        targetCount: targets.length,
        relationshipCount: targets.reduce(
          (total, target) => total + target.relationshipIds.length,
          0
        ),
        countsByType,
        recoveredTargetCount: targets.filter(
          (target) => targetEvidenceById.get(target.sourceId)?.recovered
        ).length,
      } satisfies ValidationLinkedItemRecoveryFolderEvidence;
    })
    .sort(
      (left, right) =>
        right.targetCount - left.targetCount ||
        right.relationshipCount - left.relationshipCount ||
        left.name.localeCompare(right.name) ||
        left.sourceId.localeCompare(right.sourceId)
    );
}

function mergeAttemptEvidence(
  priorAttempts: readonly ValidationLinkedItemRecoveryAttemptEvidence[],
  currentAttempts: readonly ValidationLinkedItemRecoveryAttemptEvidence[]
): ValidationLinkedItemRecoveryAttemptEvidence[] {
  const byId = new Map<string, ValidationLinkedItemRecoveryAttemptEvidence>();
  for (const attempt of [...priorAttempts, ...currentAttempts]) {
    byId.set(attempt.attemptId, { ...attempt });
  }
  return [...byId.values()].sort(
    (left, right) =>
      Date.parse(left.completedAt) - Date.parse(right.completedAt) ||
      left.attemptId.localeCompare(right.attemptId)
  );
}
