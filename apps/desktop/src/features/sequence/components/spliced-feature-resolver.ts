import {
  promoteBacterialCds,
  synthesizeTranscript,
  type GenomeFeature,
  type ResolvedAnnotation,
  type ResolvedGene,
  type ResolvedTranscript,
} from '@waypoint/genome-data';

export const TRANSCRIPT_RESOLUTION_CONTRACT_TOKEN =
  'resolved-composite-v5-source-type-and-junction-semantics';

export interface ResolvedFeature extends GenomeFeature {
  segments?: Array<{ start: number; end: number }>;
  childCount?: number;
}

const DEFAULT_PARENT_TYPES: ReadonlySet<string> = new Set(['mRNA', 'transcript']);
const DEFAULT_CHILD_TYPES: ReadonlySet<string> = new Set(['exon']);
const DEFAULT_MULTIPART_RECONSTITUTE_TYPES: ReadonlySet<string> = new Set([
  'mRNA',
  'transcript',
  'CDS',
]);

const TRANSCRIPT_CLASS_TYPES: ReadonlySet<string> = new Set([
  'mRNA',
  'transcript',
  'ncRNA',
  'lnc_RNA',
  'lncRNA',
  'miRNA',
  'snoRNA',
  'snRNA',
  'tRNA',
  'rRNA',
  'primary_transcript',
  'scaRNA',
  'antisense_RNA',
  'pseudogenic_transcript',
]);

const GENE_CLASS_TYPES: ReadonlySet<string> = new Set(['gene', 'pseudogene']);

const DIRECT_TRANSCRIPT_PARENT_TYPES: ReadonlySet<string> = new Set([
  'pseudogene',
  'V_gene_segment',
]);

const TRANSCRIPT_EXON_COMPONENT_TYPES: ReadonlySet<string> = new Set([
  'exon',
  'five_prime_UTR',
  'three_prime_UTR',
  'UTR',
]);

const TRANSCRIPT_CHILD_COMPONENT_TYPES: ReadonlySet<string> = new Set([
  ...TRANSCRIPT_EXON_COMPONENT_TYPES,
  'CDS',
  'start_codon',
  'stop_codon',
]);

export function resolveSplicedFeatures(
  features: readonly GenomeFeature[],
  options?: {
    parentTypes?: ReadonlySet<string>;
    childTypes?: ReadonlySet<string>;
    multipartReconstituteTypes?: ReadonlySet<string>;
  }
): ResolvedFeature[] {
  const parentTypes = options?.parentTypes ?? DEFAULT_PARENT_TYPES;
  const childTypes = options?.childTypes ?? DEFAULT_CHILD_TYPES;
  const multipartTypes =
    options?.multipartReconstituteTypes ?? DEFAULT_MULTIPART_RECONSTITUTE_TYPES;

  const byId = new Map<string, GenomeFeature>();
  for (const f of features) {
    const id = f.attributes.ID?.[0];
    if (id) byId.set(id, f);
  }

  const partsBySyntheticParent = new Map<string, GenomeFeature[]>();
  const consumed = new Set<GenomeFeature>();
  for (const f of features) {
    if (!multipartTypes.has(f.type)) continue;
    const parentRefs = f.attributes.Parent;
    if (!parentRefs || parentRefs.length === 0) continue;
    for (const parentRef of parentRefs) {
      if (byId.has(parentRef)) continue;
      const list = partsBySyntheticParent.get(parentRef);
      if (list) list.push(f);
      else partsBySyntheticParent.set(parentRef, [f]);
      consumed.add(f);
    }
  }

  const childrenByRealParentId = new Map<string, GenomeFeature[]>();
  for (const f of features) {
    if (!childTypes.has(f.type)) continue;
    const parentIds = f.attributes.Parent;
    if (!parentIds || parentIds.length === 0) continue;
    for (const parentId of parentIds) {
      const parent = byId.get(parentId);
      if (!parent || !parentTypes.has(parent.type)) continue;
      const list = childrenByRealParentId.get(parentId);
      if (list) list.push(f);
      else childrenByRealParentId.set(parentId, [f]);
      consumed.add(f);
    }
  }

  const out: ResolvedFeature[] = [];

  for (const [parentRef, parts] of partsBySyntheticParent) {
    if (parts.length === 0) continue;
    const synthesized = synthesizeMultipartParent(parentRef, parts);
    if (synthesized) out.push(synthesized);
  }

  for (const f of features) {
    if (consumed.has(f)) continue;
    if (parentTypes.has(f.type)) {
      const id = f.attributes.ID?.[0];
      const kids = id ? childrenByRealParentId.get(id) : undefined;
      if (kids && kids.length > 0) {
        const segments = kids
          .map((k) => ({ start: k.start + 1, end: k.end }))
          .sort((a, b) => a.start - b.start);
        out.push({ ...f, segments, childCount: kids.length });
        continue;
      }
    }
    out.push(f);
  }
  return out;
}

function synthesizeMultipartParent(
  parentRef: string,
  parts: GenomeFeature[]
): ResolvedFeature | null {
  if (parts.length === 0) return null;
  const first = parts[0];
  const start = parts.reduce((acc, p) => Math.min(acc, p.start), first.start);
  const end = parts.reduce((acc, p) => Math.max(acc, p.end), first.end);
  return {
    chrom: first.chrom,
    source: first.source,
    type: first.type,
    start,
    end,
    score: first.score,
    strand: first.strand,
    phase: first.phase,
    attributes: {
      ...first.attributes,
      ID: [parentRef],
      Parent: [],
    },
    raw: '',
    segments: parts
      .map((p) => ({ start: p.start + 1, end: p.end }))
      .sort((a, b) => a.start - b.start),
    childCount: parts.length,
  };
}

export function joinLocationString(segments: Array<{ start: number; end: number }>): string {
  return `join(${segments.map((s) => `${s.start}..${s.end}`).join(',')})`;
}

function indexGenomeFeaturesById(features: readonly GenomeFeature[]): Map<string, GenomeFeature> {
  const byId = new Map<string, GenomeFeature>();
  for (const f of features) {
    const id = f.attributes.ID?.[0];
    if (id) byId.set(id, f);
  }
  return byId;
}

function pushByKey(map: Map<string, GenomeFeature[]>, key: string, feature: GenomeFeature): void {
  const list = map.get(key);
  if (list) list.push(feature);
  else map.set(key, [feature]);
}

function collectTranscriptChildRows(
  features: readonly GenomeFeature[],
  byId: Map<string, GenomeFeature>,
  canCarryTranscriptParts: (type: string) => boolean
): {
  exonsByTxId: Map<string, GenomeFeature[]>;
  exonFallbackByTxId: Map<string, GenomeFeature[]>;
  cdsByTxId: Map<string, GenomeFeature[]>;
  consumed: Set<GenomeFeature>;
} {
  const exonsByTxId = new Map<string, GenomeFeature[]>();
  const exonFallbackByTxId = new Map<string, GenomeFeature[]>();
  const cdsByTxId = new Map<string, GenomeFeature[]>();
  const consumed = new Set<GenomeFeature>();
  for (const f of features) {
    if (!TRANSCRIPT_CHILD_COMPONENT_TYPES.has(f.type)) continue;
    const parentRefs = f.attributes.Parent;
    if (!parentRefs || parentRefs.length === 0) continue;
    for (const parentRef of parentRefs) {
      const parent = byId.get(parentRef);
      if (!parent || !canCarryTranscriptParts(parent.type)) continue;
      if (f.strand !== parent.strand && f.strand !== '.') {
        consumed.add(f);
        continue;
      }
      if (f.type === 'CDS' && isPseudoFeature(parent)) continue;
      if (f.type === 'CDS') {
        pushByKey(cdsByTxId, parentRef, f);
        pushByKey(exonFallbackByTxId, parentRef, f);
      } else if (TRANSCRIPT_EXON_COMPONENT_TYPES.has(f.type)) {
        if (f.type === 'exon') pushByKey(exonsByTxId, parentRef, f);
        pushByKey(exonFallbackByTxId, parentRef, f);
      }
      consumed.add(f);
    }
  }
  return { exonsByTxId, exonFallbackByTxId, cdsByTxId, consumed };
}

function collectLegacyMultipartParts(
  features: readonly GenomeFeature[],
  byId: Map<string, GenomeFeature>,
  consumed: Set<GenomeFeature>,
  canCarryTranscriptParts: (type: string) => boolean
): {
  legacyMrnaPartsByRef: Map<string, GenomeFeature[]>;
  legacyCdsPartsByRef: Map<string, GenomeFeature[]>;
} {
  const legacyMrnaPartsByRef = new Map<string, GenomeFeature[]>();
  const legacyCdsPartsByRef = new Map<string, GenomeFeature[]>();
  for (const f of features) {
    if (consumed.has(f)) continue;
    if (!canCarryTranscriptParts(f.type) && f.type !== 'CDS') continue;
    const parentRefs = f.attributes.Parent;
    if (!parentRefs || parentRefs.length === 0) continue;
    for (const parentRef of parentRefs) {
      if (byId.has(parentRef)) continue;
      pushByKey(f.type === 'CDS' ? legacyCdsPartsByRef : legacyMrnaPartsByRef, parentRef, f);
      consumed.add(f);
    }
  }
  return { legacyMrnaPartsByRef, legacyCdsPartsByRef };
}

function collectLegacyMultipartIds(
  legacyMrnaPartsByRef: Map<string, GenomeFeature[]>
): Set<string> {
  const ids = new Set<string>();
  for (const parts of legacyMrnaPartsByRef.values()) {
    for (const p of parts) {
      const id = p.attributes.ID?.[0];
      if (id) ids.add(id);
    }
  }
  return ids;
}

function cdsTranslationsOf(rows: readonly GenomeFeature[]): string[] {
  return rows
    .map((c) => c.attributes.translation?.[0])
    .filter((t): t is string => typeof t === 'string');
}

function emitRealParentTranscripts(args: {
  features: readonly GenomeFeature[];
  byId: Map<string, GenomeFeature>;
  geneTypes: ReadonlySet<string>;
  canCarryTranscriptParts: (type: string) => boolean;
  exonsByTxId: Map<string, GenomeFeature[]>;
  exonFallbackByTxId: Map<string, GenomeFeature[]>;
  cdsByTxId: Map<string, GenomeFeature[]>;
  legacyMultipartIds: Set<string>;
  transcriptsById: Map<string, ResolvedTranscript>;
  consumed: Set<GenomeFeature>;
}): void {
  const {
    features,
    byId,
    geneTypes,
    canCarryTranscriptParts,
    exonsByTxId,
    exonFallbackByTxId,
    cdsByTxId,
    legacyMultipartIds,
    transcriptsById,
    consumed,
  } = args;
  for (const f of features) {
    if (!canCarryTranscriptParts(f.type)) continue;
    const id = f.attributes.ID?.[0];
    if (!id) continue;
    if (legacyMultipartIds.has(id)) continue;
    const explicitExonParts = (exonsByTxId.get(id) ?? []).map(featureInterval);
    if (isPseudoFeature(f) && explicitExonParts.length === 0) continue;
    const exonParts =
      explicitExonParts.length > 0
        ? explicitExonParts
        : mergeIntervals((exonFallbackByTxId.get(id) ?? []).map(featureInterval));
    const cdsParts = (cdsByTxId.get(id) ?? []).map((c) => ({
      start: c.start + 1,
      end: c.end,
    }));
    if (exonParts.length === 0) {
      exonParts.push({ start: f.start + 1, end: f.end });
    }
    const geneId = f.attributes.Parent?.find((p) => {
      const parent = byId.get(p);
      return parent && geneTypes.has(parent.type);
    });
    transcriptsById.set(
      id,
      synthesizeTranscript({
        transcriptId: id,
        geneId,
        chrom: f.chrom,
        source: f.source,
        type: f.type,
        strand: f.strand,
        exonParts,
        cdsParts,
        cdsTranslations: cdsTranslationsOf(cdsByTxId.get(id) ?? []),
        attributes: { ...f.attributes },
        sourceAnnotationAliases: sourceAnnotationAliasesForFeatures([
          f,
          ...(exonsByTxId.get(id) ?? []),
          ...(exonFallbackByTxId.get(id) ?? []),
          ...(cdsByTxId.get(id) ?? []),
        ]),
        raw: f.raw,
        score: f.score,
        phase: f.phase,
      })
    );
    consumed.add(f);
  }
}

function takeLegacyCdsRowsForMrna(
  parentRef: string,
  parts: GenomeFeature[],
  legacyCdsPartsByRef: Map<string, GenomeFeature[]>
): GenomeFeature[] {
  const exact = legacyCdsPartsByRef.get(parentRef);
  if (exact) {
    legacyCdsPartsByRef.delete(parentRef);
    return exact;
  }

  const first = parts[0];
  if (!first || !isCodingTranscriptCarrier(first.type)) return [];
  const key = featureAssociationKey(first);
  if (!key) return [];

  const exonParts = parts.map(featureInterval);
  let bestRef: string | null = null;
  let bestScore = 0;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const [candidateRef, cdsRows] of legacyCdsPartsByRef) {
    if (cdsRows.length === 0) continue;
    const cdsFirst = cdsRows[0];
    if (featureAssociationKey(cdsFirst) !== key) continue;
    if (!compatibleStrands(first.strand, cdsFirst.strand)) continue;
    const cdsParts = cdsRows.map(featureInterval);
    const score = intervalCoverageRatio(cdsParts, exonParts);
    if (score < 0.95) continue;
    const span = intervalSpan(exonParts);
    if (score > bestScore || (score === bestScore && span < bestSpan)) {
      bestRef = candidateRef;
      bestScore = score;
      bestSpan = span;
    }
  }
  if (!bestRef) return [];
  const rows = legacyCdsPartsByRef.get(bestRef) ?? [];
  legacyCdsPartsByRef.delete(bestRef);
  return rows;
}

function emitLegacyMultipartTranscripts(
  legacyMrnaPartsByRef: Map<string, GenomeFeature[]>,
  legacyCdsPartsByRef: Map<string, GenomeFeature[]>,
  transcriptsById: Map<string, ResolvedTranscript>
): void {
  for (const [parentRef, parts] of legacyMrnaPartsByRef) {
    if (parts.length === 0) continue;
    const first = parts[0];
    const exonParts = parts.map((p) => ({ start: p.start + 1, end: p.end }));
    const cdsRows = takeLegacyCdsRowsForMrna(parentRef, parts, legacyCdsPartsByRef);
    transcriptsById.set(
      parentRef,
      synthesizeTranscript({
        transcriptId: parentRef,
        chrom: first.chrom,
        source: first.source,
        type: first.type,
        strand: first.strand,
        exonParts,
        cdsParts: cdsRows.map((c) => ({ start: c.start + 1, end: c.end })),
        cdsTranslations: cdsTranslationsOf(cdsRows),
        attributes: { ...first.attributes, _legacyMultipart: ['true'] },
        sourceAnnotationAliases: sourceAnnotationAliasesForFeatures([...parts, ...cdsRows]),
        raw: '',
        score: first.score,
        phase: first.phase,
      })
    );
  }

  for (const [parentRef, cdsRows] of legacyCdsPartsByRef) {
    if (cdsRows.length === 0) continue;
    const first = cdsRows[0];
    const intervals = cdsRows.map((c) => ({ start: c.start + 1, end: c.end }));
    transcriptsById.set(
      parentRef,
      synthesizeTranscript({
        transcriptId: parentRef,
        chrom: first.chrom,
        source: first.source,
        type: first.type,
        strand: first.strand,
        exonParts: intervals,
        cdsParts: intervals,
        cdsTranslations: cdsTranslationsOf(cdsRows),
        attributes: { ...first.attributes, _legacyMultipart: ['true'] },
        sourceAnnotationAliases: sourceAnnotationAliasesForFeatures(cdsRows),
        raw: '',
        score: first.score,
        phase: first.phase,
        compositeKind: 'compound-cds',
      })
    );
  }
}

function recoverBareCds(
  features: readonly GenomeFeature[],
  transcriptsById: Map<string, ResolvedTranscript>,
  consumed: Set<GenomeFeature>
): void {
  const transcriptsByAssociationKey = new Map<string, ResolvedTranscript[]>();
  for (const t of transcriptsById.values()) {
    if (!isCodingTranscriptCarrier(t.type)) continue;
    const key = featureAssociationKey(t);
    if (!key) continue;
    const list = transcriptsByAssociationKey.get(key);
    if (list) list.push(t);
    else transcriptsByAssociationKey.set(key, [t]);
  }
  const originallyEmptyCds = new WeakSet<ResolvedTranscript>();
  for (const list of transcriptsByAssociationKey.values()) {
    for (const t of list) {
      if (t.cds.length === 0) originallyEmptyCds.add(t);
    }
  }
  for (const f of features) {
    if (f.type !== 'CDS') continue;
    if (consumed.has(f)) continue;
    const parentRefs = f.attributes.Parent;
    if (parentRefs && parentRefs.length > 0) continue;
    const key = featureAssociationKey(f);
    if (!key) continue;
    const candidates = transcriptsByAssociationKey.get(key);
    if (!candidates || candidates.length === 0) continue;
    const matchIndex = bestTranscriptForCds(f, candidates, originallyEmptyCds);
    if (matchIndex < 0) {
      if (isOrphanCdsBpDuplicateOfCandidateCds(f, candidates)) {
        consumed.add(f);
        continue;
      }
      if (candidates.length > 1) {
        const orphanId = f.attributes.ID?.[0] ?? `<no-id>:${f.start}-${f.end}`;
        const candidateSummary = candidates
          .map((c) => `${c.transcriptId}(cds=${c.cds.length})`)
          .join(', ');
        // eslint-disable-next-line no-console
        console.warn(
          `[/resolveTranscripts] refused to force-attach orphan CDS "${orphanId}"` +
            ` (gene-association "${key}", bp=${f.start}-${f.end}, strand=${f.strand}):` +
            ` ${candidates.length} candidate transcripts and no unambiguous empty-cds match.` +
            ` Candidates: [${candidateSummary}].` +
            ` Falling through to bacterial promotion (this orphan will render as its own compound CDS glyph).` +
            ` Fix at source: add a Parent= attribute pointing to the intended mRNA, OR remove the orphan if it's redundant.`
        );
      }
      continue;
    }
    const current = candidates[matchIndex];
    const updated = synthesizeTranscript({
      transcriptId: current.transcriptId,
      geneId: current.geneId,
      chrom: current.chrom,
      source: current.source,
      type: current.type,
      strand: current.strand,
      exonParts: current.exons,
      cdsParts: [...current.cds, featureInterval(f)],
      cdsTranslations: f.attributes.translation,
      attributes: { ...current.attributes },
      sourceAnnotationAliases: current.sourceAnnotationAliases,
      raw: current.raw,
      score: current.score,
      phase: current.phase,
    });
    transcriptsById.set(updated.transcriptId, updated);
    if (originallyEmptyCds.has(current)) originallyEmptyCds.add(updated);
    candidates[matchIndex] = updated;
    consumed.add(f);
  }
}

function promoteGeneParentedBacterialCds(
  features: readonly GenomeFeature[],
  byId: ReadonlyMap<string, GenomeFeature>,
  geneTypes: ReadonlySet<string>,
  transcriptsById: Map<string, ResolvedTranscript>,
  consumed: Set<GenomeFeature>
): void {
  const cdsGroupsByGeneId = new Map<string, Map<string, GenomeFeature[]>>();
  for (const feature of features) {
    if (feature.type !== 'CDS' || consumed.has(feature)) continue;
    const geneId = feature.attributes.Parent?.find((parentId) => {
      const parent = byId.get(parentId);
      return parent !== undefined && geneTypes.has(parent.type);
    });
    if (!geneId) continue;
    const parent = byId.get(geneId);
    if (isPseudoFeature(feature) || (parent && isPseudoFeature(parent))) continue;
    let cdsGroups = cdsGroupsByGeneId.get(geneId);
    if (!cdsGroups) {
      cdsGroups = new Map<string, GenomeFeature[]>();
      cdsGroupsByGeneId.set(geneId, cdsGroups);
    }
    const proteinId = feature.attributes.protein_id?.[0]?.trim();
    const originalProteinId = feature.attributes.orig_protein_id?.[0]?.trim();
    const declaredId = feature.attributes.ID?.[0]?.trim();
    const name = feature.attributes.Name?.[0]?.trim();
    const cdsIdentity =
      proteinId || originalProteinId || declaredId || name || `${geneId}.anonymous-CDS`;
    pushByKey(cdsGroups, cdsIdentity, feature);
  }

  for (const [geneId, cdsGroups] of cdsGroupsByGeneId) {
    for (const cdsRows of cdsGroups.values()) {
      const first = cdsRows[0];
      if (!first) continue;
      const proteinId = first.attributes.protein_id?.[0]?.trim();
      const originalProteinId = first.attributes.orig_protein_id?.[0]?.trim();
      const declaredId = first.attributes.ID?.[0]?.trim();
      const name = first.attributes.Name?.[0]?.trim();
      const baseTranscriptId =
        proteinId || originalProteinId || declaredId || name || `${geneId}.compound-CDS`;
      let transcriptId = baseTranscriptId;
      let collision = 1;
      while (transcriptsById.has(transcriptId)) {
        transcriptId = `${baseTranscriptId}.${collision++}`;
      }
      const intervals = cdsRows.map(featureInterval);
      transcriptsById.set(
        transcriptId,
        synthesizeTranscript({
          transcriptId,
          geneId,
          chrom: first.chrom,
          source: first.source,
          type: first.type,
          strand: first.strand,
          exonParts: intervals,
          cdsParts: intervals,
          cdsTranslations: cdsTranslationsOf(cdsRows),
          attributes: {
            ...first.attributes,
            _syntheticCompositeFeature: ['true'],
            _syntheticCompositeFeatureSource: ['gene-parented-CDS'],
          },
          raw: first.raw,
          score: first.score,
          phase: first.phase,
          compositeKind: 'compound-cds',
          sourceAnnotationAliases: sourceAnnotationAliasesForFeatures(cdsRows),
        })
      );
      for (const row of cdsRows) consumed.add(row);
    }
  }
}

function aggregateResolvedGenes(
  features: readonly GenomeFeature[],
  geneTypes: ReadonlySet<string>,
  transcriptsById: Map<string, ResolvedTranscript>,
  consumed: Set<GenomeFeature>
): Map<string, ResolvedGene> {
  const transcriptsByGeneId = new Map<string, ResolvedTranscript[]>();
  for (const t of transcriptsById.values()) {
    if (!t.geneId) continue;
    const list = transcriptsByGeneId.get(t.geneId);
    if (list) list.push(t);
    else transcriptsByGeneId.set(t.geneId, [t]);
  }
  const genesById = new Map<string, ResolvedGene>();
  for (const f of features) {
    if (!geneTypes.has(f.type)) continue;
    const id = f.attributes.ID?.[0];
    if (!id) continue;
    if (DIRECT_TRANSCRIPT_PARENT_TYPES.has(f.type) && transcriptsById.has(id)) continue;
    const transcripts = transcriptsByGeneId.get(id) ?? [];
    genesById.set(id, {
      chrom: f.chrom,
      source: f.source,
      type: f.type,
      start: f.start,
      end: f.end,
      score: f.score,
      strand: f.strand,
      phase: f.phase,
      attributes: { ...f.attributes },
      sourceAnnotationAliases: f.sourceAnnotationAliases,
      raw: f.raw,
      transcripts,
      geneId: id,
    });
    consumed.add(f);
    for (const t of transcripts) {
      const tid = t.attributes.ID?.[0];
      if (tid) transcriptsById.delete(tid);
    }
  }
  return genesById;
}

function promoteUnconsumedBacterialCds(
  features: readonly GenomeFeature[],
  consumed: Set<GenomeFeature>
): ResolvedTranscript[] {
  const promoted: ResolvedTranscript[] = [];
  for (const f of features) {
    if (f.type !== 'CDS') continue;
    if (consumed.has(f)) continue;
    if (isPseudoFeature(f)) continue;
    const parentRefs = f.attributes.Parent;
    if (parentRefs && parentRefs.length > 0) continue;
    promoted.push(promoteBacterialCds(f));
    consumed.add(f);
  }
  return promoted;
}

function isPseudoFeature(feature: GenomeFeature): boolean {
  if (feature.type === 'pseudogene') return true;
  if (feature.attributes.gene_biotype?.some((value) => value.toLowerCase() === 'pseudogene')) {
    return true;
  }
  return feature.attributes.pseudo?.some((value) => value.toLowerCase() === 'true') ?? false;
}

export function resolveTranscripts(
  features: readonly GenomeFeature[],
  options?: {
    transcriptTypes?: ReadonlySet<string>;
    geneTypes?: ReadonlySet<string>;
  }
): ResolvedAnnotation[] {
  features = withSourceAnnotationAncestryAliases(features);
  const transcriptTypes = options?.transcriptTypes ?? TRANSCRIPT_CLASS_TYPES;
  const geneTypes = options?.geneTypes ?? GENE_CLASS_TYPES;
  const canCarryTranscriptParts = (type: string): boolean =>
    transcriptTypes.has(type) || DIRECT_TRANSCRIPT_PARENT_TYPES.has(type);

  const byId = indexGenomeFeaturesById(features);
  const { exonsByTxId, exonFallbackByTxId, cdsByTxId, consumed } = collectTranscriptChildRows(
    features,
    byId,
    canCarryTranscriptParts
  );
  const { legacyMrnaPartsByRef, legacyCdsPartsByRef } = collectLegacyMultipartParts(
    features,
    byId,
    consumed,
    canCarryTranscriptParts
  );

  const transcriptsById = new Map<string, ResolvedTranscript>();
  const legacyMultipartIds = collectLegacyMultipartIds(legacyMrnaPartsByRef);
  emitRealParentTranscripts({
    features,
    byId,
    geneTypes,
    canCarryTranscriptParts,
    exonsByTxId,
    exonFallbackByTxId,
    cdsByTxId,
    legacyMultipartIds,
    transcriptsById,
    consumed,
  });
  emitLegacyMultipartTranscripts(legacyMrnaPartsByRef, legacyCdsPartsByRef, transcriptsById);
  recoverBareCds(features, transcriptsById, consumed);
  promoteGeneParentedBacterialCds(features, byId, geneTypes, transcriptsById, consumed);
  const genesById = aggregateResolvedGenes(features, geneTypes, transcriptsById, consumed);
  const promoted = promoteUnconsumedBacterialCds(features, consumed);

  const out: ResolvedAnnotation[] = [];
  for (const gene of genesById.values()) out.push(gene);
  for (const t of transcriptsById.values()) out.push(t);
  for (const t of promoted) out.push(t);
  for (const f of features) {
    if (consumed.has(f)) continue;
    out.push(f);
  }
  return out;
}

function sourceAnnotationAliasesForFeatures(features: readonly GenomeFeature[]): string[] {
  return [
    ...new Set(
      features.flatMap((feature) => [
        ...(feature.sourceAnnotationAliases ?? []),
        ...['ID', 'locus_tag', 'gene_id', 'transcript_id'].flatMap(
          (key) => feature.attributes[key] ?? []
        ),
      ])
    ),
  ].sort();
}

function withSourceAnnotationAncestryAliases(features: readonly GenomeFeature[]): GenomeFeature[] {
  const byChrom = new Map<string, Map<string, GenomeFeature[]>>();
  for (const feature of features) {
    let byId = byChrom.get(feature.chrom);
    if (!byId) byChrom.set(feature.chrom, (byId = new Map()));
    for (const id of feature.attributes.ID ?? []) pushByKey(byId, id, feature);
  }
  const cached = new Map<GenomeFeature, readonly string[]>();
  return features.map((feature) => {
    const ancestors: GenomeFeature[] = [];
    const pending = [feature];
    const seen = new Set<GenomeFeature>();
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const aliases = cached.get(current);
      if (aliases) {
        ancestors.push({ ...current, sourceAnnotationAliases: aliases });
        continue;
      }
      ancestors.push(current);
      for (const parentId of current.attributes.Parent ?? []) {
        pending.push(...(byChrom.get(current.chrom)?.get(parentId) ?? []));
      }
    }
    const sourceAnnotationAliases = sourceAnnotationAliasesForFeatures(ancestors);
    cached.set(feature, sourceAnnotationAliases);
    return { ...feature, sourceAnnotationAliases };
  });
}

function featureInterval(f: GenomeFeature): { start: number; end: number } {
  return { start: f.start + 1, end: f.end };
}

function isCodingTranscriptCarrier(type: string): boolean {
  return type === 'mRNA' || type === 'transcript';
}

function featureAssociationKey(f: GenomeFeature): string | null {
  const raw =
    f.attributes.gene?.[0] ??
    f.attributes.Name?.[0] ??
    f.attributes.locus_tag?.[0] ??
    f.attributes.transcript_id?.[0];
  const key = raw?.trim().toLowerCase();
  return key ? key : null;
}

function extractTranscriptVariantNumber(
  attrs: Record<string, ReadonlyArray<string> | undefined> | undefined
): string | null {
  if (!attrs) return null;
  const candidateFields = [attrs.product?.[0], attrs.note?.[0]];
  for (const raw of candidateFields) {
    if (!raw) continue;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {}
    const m = /transcript\s+variant\s+(\d+)\b/i.exec(decoded);
    if (m) return m[1];
  }
  return null;
}

function isOrphanCdsBpDuplicateOfCandidateCds(
  cds: GenomeFeature,
  candidates: ReadonlyArray<ResolvedTranscript>
): boolean {
  const interval = featureInterval(cds);
  for (const candidate of candidates) {
    for (const existing of candidate.cds) {
      if (existing.start === interval.start && existing.end === interval.end) {
        return true;
      }
    }
  }
  return false;
}

function compatibleStrands(a: GenomeFeature['strand'], b: GenomeFeature['strand']): boolean {
  return a === b || a === '.' || b === '.';
}

function intervalLength(intervals: ReadonlyArray<{ start: number; end: number }>): number {
  return mergeIntervals(intervals).reduce(
    (sum, part) => sum + Math.max(0, part.end - part.start),
    0
  );
}

function intervalSpan(intervals: ReadonlyArray<{ start: number; end: number }>): number {
  if (intervals.length === 0) return Number.POSITIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const part of intervals) {
    lo = Math.min(lo, part.start);
    hi = Math.max(hi, part.end);
  }
  return hi - lo;
}

function intervalCoverageRatio(
  query: ReadonlyArray<{ start: number; end: number }>,
  coveredBy: ReadonlyArray<{ start: number; end: number }>
): number {
  const total = intervalLength(query);
  if (total <= 0) return 0;
  const q = mergeIntervals(query);
  const c = mergeIntervals(coveredBy);
  let covered = 0;
  let j = 0;
  for (const part of q) {
    while (j < c.length && c[j].end <= part.start) j++;
    for (let k = j; k < c.length && c[k].start < part.end; k++) {
      covered += Math.max(0, Math.min(part.end, c[k].end) - Math.max(part.start, c[k].start));
    }
  }
  return covered / total;
}

function bestTranscriptForCds(
  cds: GenomeFeature,
  candidates: ResolvedTranscript[],
  originallyEmptyCds: { has(t: ResolvedTranscript): boolean }
): number {
  const cdsInterval = featureInterval(cds);
  const matching: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!compatibleStrands(candidate.strand, cds.strand)) continue;
    const score = intervalCoverageRatio([cdsInterval], candidate.exons);
    if (score < 0.95) continue;
    matching.push(i);
  }
  if (matching.length === 0) return -1;
  if (matching.length === 1) return matching[0];

  const emptyCdsMatches = matching.filter((i) => originallyEmptyCds.has(candidates[i]));
  if (emptyCdsMatches.length === 1) return emptyCdsMatches[0];

  if (emptyCdsMatches.length > 1) {
    const orphanVariant = extractTranscriptVariantNumber(cds.attributes);
    if (orphanVariant !== null) {
      const byVariant = emptyCdsMatches.filter(
        (i) => extractTranscriptVariantNumber(candidates[i].attributes) === orphanVariant
      );
      if (byVariant.length === 1) return byVariant[0];
    }
  }

  return -1;
}

function mergeIntervals(intervals: ReadonlyArray<{ start: number; end: number }>): Array<{
  start: number;
  end: number;
}> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals]
    .filter((part) => part.end >= part.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const part of sorted) {
    const last = merged[merged.length - 1];
    if (!last || part.start > last.end + 1) {
      merged.push({ start: part.start, end: part.end });
    } else if (part.end > last.end) {
      last.end = part.end;
    }
  }
  return merged;
}
