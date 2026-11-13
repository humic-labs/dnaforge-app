import {
  loadAllEnzymes,
  parseGenBankFull,
  type Annotation,
  type RestrictionEnzyme,
} from '@waypoint/sequence-utils';
import {
  searchCatalogReferencesByName,
  searchCatalogSequencePackagesByIds,
  type CatalogReferenceCandidate,
} from '../../db/catalog-reference-search';
import { platform } from '../../platform';
import { sequenceDocumentKey } from '../../shared/managed-sequence-document';
import {
  fragmentToRegion,
  sourceAnnotationsToDesignAnnotations,
} from '../assembly-panel/public/utils/fragmentToRegion';
import { ENZYME_SPECS, type DesignRegion } from './types';
import { resolveSequenceDocument } from '../sequence/public/sequence-document-repository';
import {
  computeVirtualDigest,
  toDigestSourceAnnotations,
  type VirtualDigestFragment,
} from '../assembly-panel/public/hooks/useVirtualDigest';
import {
  classifyGoldenGateCandidate,
  type GoldenGateAssemblySchema,
  type GoldenGateCandidateCompatibility,
  type GoldenGatePartCandidate,
  type GoldenGateRoleEvidence,
} from './golden-gate-schema';
import { resolveMocloKitMemberships, type MocloKitDefinition } from './moclo-kit-definition';

export interface MocloCatalogCandidate extends GoldenGatePartCandidate {
  componentLabel?: { text: string; source: 'annotation' | 'record-description' };
  kitMemberships?: Array<{
    kit: { id: string; name: string };
    memberId: string;
    partTypeId: string | null;
    roleEvidence: GoldenGateRoleEvidence[];
  }>;
  kitMemberId: string | null;
  kitPartTypeId: string | null;
  source: CatalogReferenceCandidate;
  fragment: VirtualDigestFragment;
  digestFragments: VirtualDigestFragment[];
  sourceSequence: string;
  sourceAnnotations: Annotation[];
  sourceIsCircular: boolean;
}

export interface RankedMocloCatalogCandidate extends MocloCatalogCandidate {
  compatibility: GoldenGateCandidateCompatibility;
}

export function mocloCatalogCandidateToRegion(
  candidate: MocloCatalogCandidate,
  enzymeName: GoldenGateAssemblySchema['enzyme']
): Omit<DesignRegion, 'id'> {
  const document = candidate.source.sequenceDocument;
  if (!document) throw new Error('A MoClo source requires a sequence document identity.');
  return {
    ...fragmentToRegion({
      fragment: candidate.fragment,
      sourceSequence: candidate.sourceSequence,
      sourceSequenceId: sequenceDocumentKey(document),
      sourceSequenceName: candidate.source.name,
      overhangLength: ENZYME_SPECS[enzymeName].overhangLength,
      enzymeName,
      sourceAnnotations: sourceAnnotationsToDesignAnnotations(candidate.sourceAnnotations),
      sourceIsCircular: candidate.sourceIsCircular,
      allFragments: candidate.digestFragments,
    }),
    sourceSequenceName: candidate.source.name,
    isPlaceholder: false,
  };
}

interface AnalyzeMocloCatalogSourceInput {
  reference: CatalogReferenceCandidate;
  content: string;
  enzyme: RestrictionEnzyme;
  kitDefinitions?: readonly MocloKitDefinition[];
}

interface RankMocloCatalogCandidatesInput {
  candidates: readonly MocloCatalogCandidate[];
  schema: GoldenGateAssemblySchema;
  slotIndex: number;
  topology: 'linear' | 'circular';
  query: string;
  partTypeFilter?: string | null;
  includePhysicallyIncompatible: boolean;
}

export interface LoadMocloCatalogCandidatesInput {
  workspaceRoot: string | null;
  enzymeName: GoldenGateAssemblySchema['enzyme'];
  kitDefinitions?: readonly MocloKitDefinition[];
  abortSignal?: AbortSignal;
}

export interface LoadMocloCatalogCandidatesResult {
  candidates: MocloCatalogCandidate[];
  skippedSourceCount: number;
}

export interface MocloCatalogLoadDependencies {
  loadEnzymes: () => Promise<RestrictionEnzyme[]>;
  searchRecentReferences: typeof searchCatalogReferencesByName;
  searchPackageReferences: typeof searchCatalogSequencePackagesByIds;
  resolveDocument: typeof resolveSequenceDocument;
  readTextFileSlice: (
    path: string,
    maxBytes: number
  ) => Promise<{ text: string; bytesRead: number }>;
  cache: Map<string, Promise<MocloCatalogCandidate[]>>;
}

const MAX_CATALOG_SOURCE_BYTES = 1_000_000;
const MAX_CATALOG_SOURCES = 1_000;
const CATALOG_READ_CONCURRENCY = 12;
const analyzedSourceCache = new Map<string, Promise<MocloCatalogCandidate[]>>();
const defaultLoadDependencies: MocloCatalogLoadDependencies = {
  loadEnzymes: loadAllEnzymes,
  searchRecentReferences: searchCatalogReferencesByName,
  searchPackageReferences: searchCatalogSequencePackagesByIds,
  resolveDocument: resolveSequenceDocument,
  readTextFileSlice: (path, maxBytes) => platform().fs.readTextFileSlice(path, maxBytes),
  cache: analyzedSourceCache,
};

export function analyzeMocloCatalogSource({
  reference,
  content,
  enzyme,
  kitDefinitions = [],
}: AnalyzeMocloCatalogSourceInput): MocloCatalogCandidate[] {
  const parsed = parseGenBankFull(content);
  const sourceIsCircular = parsed.circular !== false;
  const digest = computeVirtualDigest(
    parsed.sequence,
    enzyme,
    toDigestSourceAnnotations(parsed.annotations),
    { circular: sourceIsCircular, maxFragments: 500 }
  );
  const memberships =
    reference.sequenceDocument?.kind === 'managed-sequence'
      ? resolveMocloKitMemberships(kitDefinitions, {
          packageId: reference.sequenceDocument.packageId,
        })
      : [];
  const membership = memberships[0];
  const insertCount = digest.fragments.filter((fragment) => fragment.ggType === 'insert').length;

  return digest.fragments
    .filter((fragment) => fragment.ggType === 'insert' || fragment.ggType === 'backbone')
    .map((fragment) => ({
      id: `${reference.entityId}:${enzyme.name}:${fragment.index}:${fragment.startPosition}:${fragment.endPosition}`,
      name: reference.name,
      componentLabel: componentLabelForFragment(
        fragment,
        parsed.annotations,
        reference.name,
        insertCount === 1 ? parsed.description : undefined
      ),
      route: 'restriction-digest' as const,
      upstreamOverhang: fragment.upstream.sequence || null,
      downstreamOverhang: fragment.downstream.sequence || null,
      roleEvidence: deduplicateRoleEvidence([
        ...memberships.flatMap((item) => item.roleEvidence),
        ...deriveRoleEvidence(content, parsed.annotations, fragment),
      ]),
      kit: membership?.kit ?? null,
      kitMemberships: memberships.map((item) => ({
        kit: item.kit,
        memberId: item.member.id,
        partTypeId: item.partType?.id ?? null,
        roleEvidence: item.roleEvidence,
      })),
      kitMemberId: membership?.member.id ?? null,
      kitPartTypeId: membership?.partType?.id ?? null,
      source: reference,
      fragment,
      digestFragments: digest.fragments,
      sourceSequence: parsed.sequence,
      sourceAnnotations: parsed.annotations,
      sourceIsCircular,
    }));
}

export async function loadMocloCatalogCandidates(
  { workspaceRoot, enzymeName, kitDefinitions = [], abortSignal }: LoadMocloCatalogCandidatesInput,
  dependencies: MocloCatalogLoadDependencies = defaultLoadDependencies
): Promise<LoadMocloCatalogCandidatesResult> {
  if (!workspaceRoot) return { candidates: [], skippedSourceCount: 0 };
  const enzyme = (await dependencies.loadEnzymes()).find(
    (candidate) => candidate.name === enzymeName
  );
  if (!enzyme) throw new Error(`Restriction enzyme ${enzymeName} is unavailable.`);

  const declaredPackageIds = Array.from(
    new Set(
      kitDefinitions.flatMap((definition) =>
        definition.members.map((member) => member.sequencePackageId)
      )
    )
  );
  if (declaredPackageIds.length > MAX_CATALOG_SOURCES) {
    throw new Error(
      `MoClo kit definitions declare ${declaredPackageIds.length.toLocaleString()} parts; the picker supports at most ${MAX_CATALOG_SOURCES.toLocaleString()} per project.`
    );
  }
  const recentReferenceLimit = MAX_CATALOG_SOURCES - declaredPackageIds.length;
  const [recentReferences, declaredReferences] = await Promise.all([
    recentReferenceLimit > 0
      ? dependencies.searchRecentReferences({
          query: '',
          entityType: 'sequence',
          workspaceRoot,
          limit: recentReferenceLimit,
        })
      : Promise.resolve([]),
    dependencies.searchPackageReferences({
      sequencePackageIds: declaredPackageIds,
      workspaceRoot,
    }),
  ]);
  const references = deduplicateCatalogReferences([...declaredReferences, ...recentReferences]);
  if (references.length > MAX_CATALOG_SOURCES) {
    throw new Error(
      `The MoClo part catalog resolved more than ${MAX_CATALOG_SOURCES.toLocaleString()} distinct project sources.`
    );
  }
  let skippedSourceCount = 0;

  const analyzed = await mapWithConcurrency(
    references,
    CATALOG_READ_CONCURRENCY,
    async (reference) => {
      if (abortSignal?.aborted) throw new DOMException('MoClo catalog load aborted.', 'AbortError');
      if (!reference.sequenceDocument) {
        skippedSourceCount += 1;
        return [];
      }
      let resolved: Awaited<ReturnType<MocloCatalogLoadDependencies['resolveDocument']>>;
      try {
        resolved = await dependencies.resolveDocument(reference.sequenceDocument);
      } catch (error: unknown) {
        if (isAbortError(error)) throw error;
        skippedSourceCount += 1;
        return [];
      }
      if (!isSupportedSequencePath(resolved.sourcePath)) {
        skippedSourceCount += 1;
        return [];
      }
      if (reference.sizeBytes !== null && reference.sizeBytes > MAX_CATALOG_SOURCE_BYTES) {
        skippedSourceCount += 1;
        return [];
      }

      const cacheKey = sourceCacheKey(reference, enzymeName, kitDefinitions);
      const cached = cacheKey ? dependencies.cache.get(cacheKey) : undefined;
      const analysis =
        cached ??
        analyzeReference(
          reference,
          resolved.sourcePath,
          enzyme,
          kitDefinitions,
          dependencies.readTextFileSlice
        );
      if (cacheKey && !cached) dependencies.cache.set(cacheKey, analysis);
      let result: MocloCatalogCandidate[];
      try {
        result = await analysis;
      } catch (error: unknown) {
        if (cacheKey && dependencies.cache.get(cacheKey) === analysis) {
          dependencies.cache.delete(cacheKey);
        }
        if (isAbortError(error)) throw error;
        skippedSourceCount += 1;
        return [];
      }
      if (abortSignal?.aborted) {
        throw new DOMException('MoClo catalog load aborted.', 'AbortError');
      }
      return result;
    }
  );

  return { candidates: analyzed.flat(), skippedSourceCount };
}

export function rankMocloCatalogCandidates({
  candidates,
  schema,
  slotIndex,
  topology,
  query,
  partTypeFilter = null,
  includePhysicallyIncompatible,
}: RankMocloCatalogCandidatesInput): RankedMocloCatalogCandidate[] {
  const slot = schema.slots[slotIndex];
  if (!slot) return [];
  const needle = query.trim().toLowerCase();

  return candidates
    .map((candidate): RankedMocloCatalogCandidate => {
      const preferredKitId = schema.origin.type === 'kit' ? schema.origin.kitId : null;
      const membership = candidate.kitMemberships?.find((item) => item.kit.id === preferredKitId);
      const selected = membership
        ? {
            ...candidate,
            kit: membership.kit,
            kitMemberId: membership.memberId,
            kitPartTypeId: membership.partTypeId,
            roleEvidence: deduplicateRoleEvidence([
              ...membership.roleEvidence,
              ...candidate.roleEvidence,
            ]),
          }
        : candidate;
      return {
        ...selected,
        compatibility: classifyGoldenGateCandidate(schema, slotIndex, topology, selected),
      };
    })
    .filter(
      (candidate) =>
        includePhysicallyIncompatible || candidate.compatibility.physical.type !== 'incompatible'
    )
    .filter(
      (candidate) =>
        !partTypeFilter ||
        getMocloCandidatePartTypeLabels(candidate).some(
          (label) => label.toLowerCase() === partTypeFilter.toLowerCase()
        )
    )
    .filter((candidate) => !needle || candidateSearchText(candidate).includes(needle))
    .sort((left, right) => compareRankedCandidates(left, right, schema));
}

export function getMocloCandidatePartTypeLabels(
  candidate: Pick<MocloCatalogCandidate, 'roleEvidence'>
): string[] {
  const primaryLabel = candidate.roleEvidence[0]?.label.trim();
  return primaryLabel ? [primaryLabel] : [];
}

function componentLabelForFragment(
  fragment: VirtualDigestFragment,
  annotations: readonly Annotation[],
  packageName: string,
  recordDescription: string | undefined
): MocloCatalogCandidate['componentLabel'] {
  if (fragment.ggType !== 'insert') return undefined;
  const memberNames = new Set(fragment.annotations.map((name) => name.toLowerCase()));
  const names = new Map<string, string>();
  for (const annotation of annotations) {
    if (!memberNames.has(annotation.name.toLowerCase())) continue;
    const role = roleFromAnnotation(annotation);
    const name = annotation.name.trim();
    if (!role || !name || name.toLowerCase() === role.toLowerCase()) continue;
    names.set(name.toLowerCase(), name);
  }
  if (names.size > 1) return undefined;
  const name = [...names.values()][0];
  const text = (name ?? recordDescription)?.trim();
  if (!text || text.toLowerCase() === packageName.toLowerCase()) return undefined;
  return { text, source: name ? 'annotation' : 'record-description' };
}

function deriveRoleEvidence(
  content: string,
  annotations: readonly Annotation[],
  fragment: VirtualDigestFragment
): GoldenGateRoleEvidence[] {
  const evidence: GoldenGateRoleEvidence[] = [];
  const header = content.slice(0, Math.max(0, content.search(/^FEATURES\s/m)) || content.length);

  for (const match of header.matchAll(/"(Part subtype|Part type)\s*:\s*([^".]+)"/gi)) {
    const label = normalizeRoleLabel(match[2] ?? '');
    if (label) evidence.push({ label, source: `GenBank KEYWORDS ${match[1]}` });
  }

  if (fragment.ggType === 'backbone') {
    evidence.push({ label: 'Destination vector', source: 'restriction digest geometry' });
  }

  const fragmentAnnotationNames = new Set(fragment.annotations.map((name) => name.toLowerCase()));
  for (const annotation of annotations) {
    if (!fragmentAnnotationNames.has(annotation.name.toLowerCase())) continue;
    const role = roleFromAnnotation(annotation);
    if (role) evidence.push({ label: role, source: `GenBank ${annotation.type} annotation` });
  }

  return deduplicateRoleEvidence(evidence);
}

function roleFromAnnotation(annotation: Annotation): string | null {
  const type = annotation.type.trim().toLowerCase();
  if (type === 'promoter') return 'Promoter';
  if (type === 'rbs' || type === 'ribosome_binding_site') return 'RBS';
  if (type === 'cds') return 'CDS';
  if (type === 'terminator') return 'Terminator';
  if (type === 'rep_origin' || type === 'replication_ori' || type === 'origin') {
    return 'Origin of replication';
  }

  const searchable = `${annotation.name} ${annotation.label ?? ''}`.toLowerCase();
  if (/destination|backbone|vector/.test(searchable)) return 'Destination vector';
  if (/ribosome.?binding|\brbs\b/.test(searchable)) return 'RBS';
  if (/promoter/.test(searchable)) return 'Promoter';
  if (/terminator/.test(searchable)) return 'Terminator';
  if (/origin|\bori\b/.test(searchable)) return 'Origin of replication';
  return null;
}

function normalizeRoleLabel(value: string): string | null {
  const label = value.trim();
  if (!label || label === '--') return null;
  if (/^rbs$/i.test(label)) return 'RBS';
  if (/^5['′]?\s*utr$/i.test(label)) return '5′ UTR';
  if (/coding|^cds$/i.test(label)) return 'CDS';
  if (/promoter/i.test(label)) return 'Promoter';
  if (/terminator/i.test(label)) return 'Terminator';
  if (/destination|backbone|vector/i.test(label)) return 'Destination vector';
  return label;
}

function deduplicateRoleEvidence(
  evidence: readonly GoldenGateRoleEvidence[]
): GoldenGateRoleEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.label.toLowerCase()}\0${item.source.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function candidateSearchText(candidate: RankedMocloCatalogCandidate): string {
  return [
    candidate.name,
    candidate.componentLabel?.text,
    candidate.route.replace('-', ' '),
    candidate.upstreamOverhang,
    candidate.downstreamOverhang,
    candidate.kit?.id,
    candidate.kit?.name,
    ...(candidate.kitMemberships ?? []).flatMap((membership) => [
      membership.kit.id,
      membership.kit.name,
    ]),
    candidate.source.workspaceRelativePath,
    ...candidate.roleEvidence.flatMap((role) => [role.label, role.source]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
}

function compareRankedCandidates(
  left: RankedMocloCatalogCandidate,
  right: RankedMocloCatalogCandidate,
  schema: GoldenGateAssemblySchema
): number {
  const physicalRank = { exact: 0, 'pcr-adaptable': 1, incompatible: 2 } as const;
  const physicalDelta =
    physicalRank[left.compatibility.physical.type] -
    physicalRank[right.compatibility.physical.type];
  if (physicalDelta !== 0) return physicalDelta;

  const preferredKitId = schema.origin.type === 'kit' ? schema.origin.kitId : null;
  const leftKitRank = preferredKitId !== null && left.kit?.id === preferredKitId ? 0 : 1;
  const rightKitRank = preferredKitId !== null && right.kit?.id === preferredKitId ? 0 : 1;
  if (leftKitRank !== rightKitRank) return leftKitRank - rightKitRank;

  return left.name.localeCompare(right.name) || left.fragment.index - right.fragment.index;
}

async function analyzeReference(
  reference: CatalogReferenceCandidate,
  sourcePath: string,
  enzyme: RestrictionEnzyme,
  kitDefinitions: readonly MocloKitDefinition[],
  readTextFileSlice: MocloCatalogLoadDependencies['readTextFileSlice']
): Promise<MocloCatalogCandidate[]> {
  const loaded = await readTextFileSlice(sourcePath, MAX_CATALOG_SOURCE_BYTES + 1);
  if (loaded.bytesRead > MAX_CATALOG_SOURCE_BYTES) return [];
  return analyzeMocloCatalogSource({
    reference,
    content: loaded.text,
    enzyme,
    kitDefinitions,
  });
}

function deduplicateCatalogReferences(
  references: readonly CatalogReferenceCandidate[]
): CatalogReferenceCandidate[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key =
      reference.sequenceDocument?.kind === 'managed-sequence'
        ? `package:${reference.sequenceDocument.packageId}`
        : `entity:${reference.entityId}:${reference.absolutePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  worker: (input: Input) => Promise<Output>
): Promise<Output[]> {
  const results = new Array<Output>(inputs.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const input = inputs[index];
      if (input !== undefined) results[index] = await worker(input);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => runWorker())
  );
  return results;
}

function sourceCacheKey(
  reference: CatalogReferenceCandidate,
  enzymeName: GoldenGateAssemblySchema['enzyme'],
  kitDefinitions: readonly MocloKitDefinition[]
): string | null {
  const contentIdentity =
    reference.sequenceDocument?.kind === 'managed-sequence'
      ? reference.contentHash
      : (reference.contentHash ?? reference.objectUuid);
  const documentIdentity =
    reference.sequenceDocument?.kind === 'managed-sequence'
      ? `package:${reference.sequenceDocument.packageId}`
      : `entity:${reference.entityId}:${reference.objectUuid ?? reference.absolutePath}`;
  const kitRevisionKey = kitDefinitions
    .map((definition) => `${definition.id}@${definition.revision}`)
    .sort()
    .join(',');
  return contentIdentity
    ? `${documentIdentity}:${contentIdentity}:${reference.sizeBytes ?? 'unknown'}:${enzymeName}:${kitRevisionKey}`
    : null;
}

function isSupportedSequencePath(path: string): boolean {
  return /\.(?:gb|gbk|genbank)$/i.test(path);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
