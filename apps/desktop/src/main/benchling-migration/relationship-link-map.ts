import type {
  ProjectionReceipt,
  RelationshipEvidence,
  RelationshipResolution,
  SourceObject,
} from '../../shared/benchling-migration';

export const GENERIC_RELATION_TYPE = 'generic';

export type OutboundLocalLink = {
  state: 'live_local';
  relationshipId: string;
  relationType: string;
  sourceTargetId: string;
  destinationTargetId: string;
  destinationPath: string;
  evidence: RelationshipEvidence[];
};

export type PreservedExternalLink = {
  state: 'external';
  relationshipId: string;
  relationType: string;
  targetUrl: string | null;
  evidence: RelationshipEvidence[];
};

export type PreservedSourceBrokenLink = {
  state: 'source_broken';
  relationshipId: string;
  relationType: string;
  sourceTargetId: string | null;
  evidence: RelationshipEvidence[];
};

export type OutboundLinkSet = {
  localLinks: OutboundLocalLink[];
  externalLinks: PreservedExternalLink[];
  sourceBrokenLinks: PreservedSourceBrokenLink[];
};

export type OutboundLocalLinkMap = ReadonlyMap<string, OutboundLinkSet>;

export type ProjectionTargetIdentity = Pick<
  ProjectionReceipt,
  'sourceObjectId' | 'destinationObjectId' | 'destinationPath'
> & { id?: string };

export type BuildOutboundLocalLinkMapInput = {
  resolutions: readonly RelationshipResolution[];
  receipts: readonly ProjectionTargetIdentity[];
  sourceObjects: readonly SourceObject[];
};

export function buildOutboundLocalLinkMap(
  input: BuildOutboundLocalLinkMapInput
): OutboundLocalLinkMap {
  const receiptBySourceObjectId = indexReceipts(input.receipts);
  const sourceObjectIdByStableIdentity = indexSourceObjectIdentities(input.sourceObjects);
  const relationshipIds = new Set<string>();
  const linksBySourceObjectId = new Map<string, OutboundLinkSet>();

  for (const resolution of sortedResolutions(input.resolutions)) {
    const relationshipId = requireText(resolution.relationshipId, 'Relationship ID');
    if (relationshipIds.has(relationshipId)) {
      throw new Error(`Relationship ${relationshipId} has multiple resolution records.`);
    }
    relationshipIds.add(relationshipId);

    if (!isPreservedClassification(resolution.classification)) continue;

    const sourceIdentity = requireText(resolution.sourceObjectId, 'Relationship source object ID');
    const sourceObjectId = sourceObjectIdByStableIdentity.get(sourceIdentity) ?? sourceIdentity;
    const linkSet = linksBySourceObjectId.get(sourceObjectId) ?? emptyLinkSet();
    const relationType = normalizedRelationType(resolution.relationType);
    const evidence = sortedEvidence(resolution.evidence);

    if (resolution.classification === 'exact') {
      const sourceTargetId = requireText(
        resolution.targetSourceId,
        `Exact relationship ${relationshipId} target source ID`
      );
      const receiptSourceObjectId =
        sourceObjectIdByStableIdentity.get(sourceTargetId) ?? sourceTargetId;
      const receipt = receiptBySourceObjectId.get(receiptSourceObjectId);
      if (!receipt) {
        throw new Error(
          `Exact relationship ${relationshipId} target ${sourceTargetId} has no projection receipt.`
        );
      }
      linkSet.localLinks.push({
        state: 'live_local',
        relationshipId,
        relationType,
        sourceTargetId,
        destinationTargetId: requireText(
          receipt.destinationObjectId,
          `Projection target ${receipt.id ?? receipt.sourceObjectId} destination object ID`
        ),
        destinationPath: requireText(
          receipt.destinationPath,
          `Projection target ${receipt.id ?? receipt.sourceObjectId} destination path`
        ),
        evidence,
      });
    } else if (resolution.classification === 'external') {
      linkSet.externalLinks.push({
        state: 'external',
        relationshipId,
        relationType,
        targetUrl: firstEvidenceUrl(evidence),
        evidence,
      });
    } else {
      linkSet.sourceBrokenLinks.push({
        state: 'source_broken',
        relationshipId,
        relationType,
        sourceTargetId: resolution.targetSourceId?.trim() || null,
        evidence,
      });
    }

    linksBySourceObjectId.set(sourceObjectId, linkSet);
  }

  return new Map(
    [...linksBySourceObjectId.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceObjectId, linkSet]) => [
        sourceObjectId,
        {
          localLinks: linkSet.localLinks.sort(compareLinks),
          externalLinks: linkSet.externalLinks.sort(compareLinks),
          sourceBrokenLinks: linkSet.sourceBrokenLinks.sort(compareLinks),
        },
      ])
  );
}

function indexSourceObjectIdentities(sourceObjects: readonly SourceObject[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const sourceObject of sourceObjects) {
    const sourceObjectId = requireText(sourceObject.id, 'Source object ID');
    for (const identity of new Set([
      sourceObjectId,
      requireText(sourceObject.stableId, `Source object ${sourceObjectId} stable ID`),
    ])) {
      const prior = result.get(identity);
      if (prior && prior !== sourceObjectId) {
        throw new Error(`Source identity ${identity} belongs to multiple source objects.`);
      }
      result.set(identity, sourceObjectId);
    }
  }
  return result;
}

function indexReceipts(
  receipts: readonly ProjectionTargetIdentity[]
): Map<string, ProjectionTargetIdentity> {
  const result = new Map<string, ProjectionTargetIdentity>();
  for (const receipt of receipts) {
    const sourceObjectId = requireText(
      receipt.sourceObjectId,
      'Projection receipt source object ID'
    );
    if (result.has(sourceObjectId)) {
      throw new Error(`Source object ${sourceObjectId} has multiple projection receipts.`);
    }
    result.set(sourceObjectId, receipt);
  }
  return result;
}

function sortedResolutions(
  resolutions: readonly RelationshipResolution[]
): RelationshipResolution[] {
  return [...resolutions].sort(
    (left, right) =>
      left.sourceObjectId.localeCompare(right.sourceObjectId) ||
      left.relationshipId.localeCompare(right.relationshipId)
  );
}

function sortedEvidence(evidence: readonly RelationshipEvidence[]): RelationshipEvidence[] {
  return evidence
    .map((item) => ({ ...item }))
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.value.localeCompare(right.value) ||
        (left.sourcePath ?? '').localeCompare(right.sourcePath ?? '')
    );
}

function firstEvidenceUrl(evidence: readonly RelationshipEvidence[]): string | null {
  return evidence.find((item) => item.kind === 'url' && item.value.trim())?.value.trim() ?? null;
}

function isPreservedClassification(
  classification: RelationshipResolution['classification']
): classification is 'exact' | 'external' | 'source_broken' {
  return (
    classification === 'exact' ||
    classification === 'external' ||
    classification === 'source_broken'
  );
}

function normalizedRelationType(value: string): string {
  return value.trim() || GENERIC_RELATION_TYPE;
}

function emptyLinkSet(): OutboundLinkSet {
  return { localLinks: [], externalLinks: [], sourceBrokenLinks: [] };
}

function compareLinks(
  left: { relationshipId: string; relationType: string },
  right: { relationshipId: string; relationType: string }
): number {
  return (
    left.relationshipId.localeCompare(right.relationshipId) ||
    left.relationType.localeCompare(right.relationType)
  );
}

function requireText(value: string | null, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
