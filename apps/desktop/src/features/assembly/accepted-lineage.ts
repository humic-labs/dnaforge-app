import type {
  AcceptedAssemblySidecarPayload,
  AcceptedAssemblySourceProvenanceSnapshot,
} from './accepted-types';
import { acceptedAssemblyVersionFromSidecar } from './accepted-reopen';

export type AcceptedLineageNodeKind =
  | 'construct'
  | 'draft_revision'
  | 'accepted_assembly_version'
  | 'source_sequence_version'
  | 'product_sequence_version'
  | 'artifact';

export type AcceptedLineageEdgeKind =
  | 'revision_of'
  | 'reopened_from'
  | 'accepted_from_draft'
  | 'uses_source_version'
  | 'produces_product_version'
  | 'has_artifact';

export interface AcceptedLineageNode {
  id: string;
  kind: AcceptedLineageNodeKind;
  [key: string]: unknown;
}

export interface AcceptedLineageEdge {
  id: string;
  kind: AcceptedLineageEdgeKind;
  from: string;
  to: string;
  [key: string]: unknown;
}

export interface AcceptedLineageWarning {
  code: 'legacy_source_identity' | 'missing_source_checksum';
  message: string;
  regionId: string;
}

export interface AcceptedLineageCatalogEvent {
  id: string;
  eventType: string;
  actor: string;
  summary: string | null;
  payload: Record<string, unknown> | null;
  createdAt: number;
}

export interface AcceptedAssemblyLineage {
  schemaVersion: 1;
  rootConstructId: string;
  acceptedAssemblyVersionId: string;
  nodes: AcceptedLineageNode[];
  edges: AcceptedLineageEdge[];
  catalogEvents: AcceptedLineageCatalogEvent[];
  warnings: AcceptedLineageWarning[];
}

export function buildAcceptedAssemblyLineage(
  acceptedInput: AcceptedAssemblySidecarPayload | readonly AcceptedAssemblySidecarPayload[],
  context: {
    constructId: string;
    packageId: string;
    packageRoot: string;
    catalogEvents: AcceptedLineageCatalogEvent[];
    currentSourceChecksums?: Readonly<Record<string, string>>;
  }
): AcceptedAssemblyLineage {
  const acceptedRecords = Array.isArray(acceptedInput) ? acceptedInput : [acceptedInput];
  if (acceptedRecords.length === 0)
    throw new Error('Accepted lineage requires at least one record.');
  const projected = acceptedRecords.map((accepted) =>
    buildSingleAcceptedAssemblyLineage(accepted, context)
  );
  const nodes = dedupeById(projected.flatMap((lineage) => lineage.nodes));
  const edges = dedupeById(projected.flatMap((lineage) => lineage.edges));
  for (const event of context.catalogEvents) {
    if (event.eventType !== 'accepted_assembly_reopened' || !event.payload) continue;
    const designId = stringValue(event.payload.reopenedDesignId);
    const acceptedVersionId = stringValue(event.payload.acceptedAssemblyVersionId);
    if (!designId || !acceptedVersionId) continue;
    const draftNodeId = `draft:${designId}`;
    if (!nodes.some((node) => node.id === draftNodeId)) {
      nodes.push({
        id: draftNodeId,
        kind: 'draft_revision',
        designId,
        parentAcceptedAssemblyVersionId: acceptedVersionId,
        locator: stringValue(event.payload.draftPath),
        reopenIdempotencyKey: stringValue(event.payload.idempotencyKey),
      });
    }
    edges.push(edge('reopened_from', draftNodeId, `accepted-assembly:${acceptedVersionId}`));
  }
  return {
    schemaVersion: 1,
    rootConstructId: context.constructId,
    acceptedAssemblyVersionId: projected[projected.length - 1].acceptedAssemblyVersionId,
    nodes: dedupeById(nodes),
    edges: dedupeById(edges),
    catalogEvents: context.catalogEvents,
    warnings: projected.flatMap((lineage) => lineage.warnings),
  };
}

function buildSingleAcceptedAssemblyLineage(
  accepted: AcceptedAssemblySidecarPayload,
  context: {
    constructId: string;
    packageId: string;
    packageRoot: string;
    catalogEvents: AcceptedLineageCatalogEvent[];
    currentSourceChecksums?: Readonly<Record<string, string>>;
  }
): AcceptedAssemblyLineage {
  const acceptedVersionId = acceptedAssemblyVersionFromSidecar(accepted).id;
  const constructNodeId = `construct:${context.constructId}`;
  const draftNodeId = `draft:${accepted.designId}:v${accepted.validationSnapshot.designVersion}`;
  const acceptedNodeId = `accepted-assembly:${acceptedVersionId}`;
  const productChecksum = accepted.artifacts.productSequenceChecksum;
  const productNodeId = `product-sequence:${productChecksum}`;
  const nodes: AcceptedLineageNode[] = [
    {
      id: constructNodeId,
      kind: 'construct',
      constructId: context.constructId,
      packageId: context.packageId,
      name: accepted.designName,
      packageRoot: context.packageRoot,
    },
    {
      id: draftNodeId,
      kind: 'draft_revision',
      designId: accepted.designId,
      designVersion: accepted.validationSnapshot.designVersion,
      canonicalDraftChecksum: accepted.projectionInput.canonicalDraftChecksum,
    },
    {
      id: acceptedNodeId,
      kind: 'accepted_assembly_version',
      acceptedAssemblyVersionId: acceptedVersionId,
      acceptedAt: accepted.acceptedAt,
      acceptedBy: accepted.acceptedBy ?? null,
      lifecycleState: accepted.lifecycleState ?? 'written',
      canonicalDraftChecksum: accepted.projectionInput.canonicalDraftChecksum,
      validationClean: accepted.validationSnapshot.clean,
    },
    {
      id: productNodeId,
      kind: 'product_sequence_version',
      constructId: context.constructId,
      versionId: productChecksum,
      checksum: productChecksum,
      genBankChecksum: accepted.artifacts.productGenBankChecksum ?? null,
      locator: accepted.artifacts.productGenBankPath,
      topology: accepted.projectionInput.topology,
      length: accepted.projectionInput.productSequence.length,
    },
  ];
  const edges: AcceptedLineageEdge[] = [
    edge('revision_of', draftNodeId, constructNodeId),
    edge('accepted_from_draft', acceptedNodeId, draftNodeId),
    edge('revision_of', acceptedNodeId, constructNodeId),
    edge('produces_product_version', acceptedNodeId, productNodeId),
    edge('revision_of', productNodeId, constructNodeId),
  ];
  const warnings: AcceptedLineageWarning[] = [];

  for (const source of accepted.projectionInput.sourceProvenance) {
    const sourceIdentity = sourceVersionIdentity(source);
    if (!nodes.some((node) => node.id === sourceIdentity.nodeId)) {
      nodes.push({
        id: sourceIdentity.nodeId,
        kind: 'source_sequence_version',
        constructId: source.sourceConstructId ?? null,
        versionId: source.sourceSequenceVersionId ?? null,
        sourceSequenceId: source.sourceSequenceId,
        name: source.sourceSequenceName,
        locator: source.sourceLocator ?? source.sourceSequenceId,
        checksum: source.sourceSequenceChecksum ?? null,
        length: source.sourceLength ?? null,
        topology:
          source.sourceIsCircular === undefined
            ? null
            : source.sourceIsCircular
              ? 'circular'
              : 'linear',
        identityStatus: sourceIdentity.identityStatus,
        freshness: sourceFreshness(source, context.currentSourceChecksums),
      });
    }
    edges.push({
      ...edge('uses_source_version', acceptedNodeId, sourceIdentity.nodeId),
      regionId: source.regionId,
      sourceType: source.sourceType,
      copiedDirection: source.copiedDirection,
      selectedSourceRange: source.selectedSourceRange,
      includedSourceSegments: source.includedSourceSegments,
    });
    if (sourceIdentity.identityStatus === 'legacy-locator') {
      warnings.push({
        code: 'legacy_source_identity',
        regionId: source.regionId,
        message:
          `Source ${source.sourceSequenceName} predates stable source-version identity; ` +
          'its locator and checksum remain pinned, but move-safe construct/version IDs are unavailable.',
      });
    }
    if (!source.sourceSequenceChecksum) {
      warnings.push({
        code: 'missing_source_checksum',
        regionId: source.regionId,
        message: `Source ${source.sourceSequenceName} has no recorded content checksum.`,
      });
    }
  }

  for (const artifact of artifactVersions(accepted)) {
    nodes.push(artifact.node);
    edges.push(edge('has_artifact', acceptedNodeId, artifact.node.id));
  }

  return {
    schemaVersion: 1,
    rootConstructId: context.constructId,
    acceptedAssemblyVersionId: acceptedVersionId,
    nodes,
    edges,
    catalogEvents: context.catalogEvents,
    warnings,
  };
}

function sourceFreshness(
  source: AcceptedAssemblySourceProvenanceSnapshot,
  current: Readonly<Record<string, string>> | undefined
): 'current' | 'source_outdated' | 'unknown' {
  const locator = source.sourceLocator ?? source.sourceSequenceId;
  const currentChecksum = current?.[locator] ?? current?.[source.sourceSequenceId];
  if (!currentChecksum || !source.sourceSequenceChecksum) return 'unknown';
  return currentChecksum === source.sourceSequenceChecksum ? 'current' : 'source_outdated';
}

function dedupeById<T extends { id: string }>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sourceVersionIdentity(source: AcceptedAssemblySourceProvenanceSnapshot): {
  nodeId: string;
  identityStatus: 'stable' | 'legacy-locator';
} {
  if (source.sourceConstructId && source.sourceSequenceVersionId) {
    return {
      nodeId: `source-sequence:${source.sourceConstructId}:${source.sourceSequenceVersionId}`,
      identityStatus: 'stable',
    };
  }
  const locator = encodeURIComponent(source.sourceSequenceId);
  const checksum = encodeURIComponent(source.sourceSequenceChecksum ?? 'checksum-unavailable');
  return {
    nodeId: `source-sequence:legacy:${locator}:${checksum}`,
    identityStatus: 'legacy-locator',
  };
}

function artifactVersions(accepted: AcceptedAssemblySidecarPayload): Array<{
  node: AcceptedLineageNode;
}> {
  const artifacts = [
    {
      artifactKind: 'product_genbank',
      locator: accepted.artifacts.productGenBankPath,
      checksum: accepted.artifacts.productGenBankChecksum,
    },
    {
      artifactKind: 'accepted_record',
      locator: accepted.artifacts.sidecarJsonPath,
      checksum: accepted.artifacts.sidecarChecksum,
    },
    {
      artifactKind: 'primer_csv',
      locator: accepted.artifacts.primerCsvPath,
      checksum: accepted.artifacts.primerCsvChecksum,
    },
    {
      artifactKind: 'primer_fasta',
      locator: accepted.artifacts.primerFastaPath,
      checksum: accepted.artifacts.primerFastaChecksum,
    },
  ].filter((artifact) => artifact.locator);

  return artifacts.map((artifact) => ({
    node: {
      id: `artifact:${artifact.artifactKind}:${encodeURIComponent(artifact.checksum ?? artifact.locator ?? 'unknown')}`,
      kind: 'artifact',
      artifactKind: artifact.artifactKind,
      locator: artifact.locator,
      checksum: artifact.checksum ?? null,
    },
  }));
}

function edge(kind: AcceptedLineageEdgeKind, from: string, to: string): AcceptedLineageEdge {
  return { id: `${kind}:${from}->${to}`, kind, from, to };
}
