import type {
  BpInterval,
  CompositeFeatureJunction,
  CompositeFeatureKind,
  GenomeFeature,
  ResolvedTranscript,
} from './types';

export interface TranscriptSynthesisInput {
  transcriptId: string;
  geneId?: string;
  chrom: string;
  source: string;
  type: string;
  strand: '+' | '-' | '.';
  exonParts: ReadonlyArray<BpInterval>;
  cdsParts: ReadonlyArray<BpInterval>;
  attributes?: Record<string, string[]>;
  sourceAnnotationAliases?: readonly string[];
  cdsTranslations?: ReadonlyArray<string>;
  raw?: string;
  score?: string | null;
  phase?: string | null;
  compositeKind?: CompositeFeatureKind;
}

export function synthesizeTranscript(input: TranscriptSynthesisInput): ResolvedTranscript {
  const exons = normalizeIntervals(input.exonParts);
  if (exons.length === 0) {
    throw new Error(
      `synthesizeTranscript: transcriptId="${input.transcriptId}" has no exons. ` +
        `Non-coding transcripts must still have at least one exon. ` +
        `Bacterial CDS-only rows should be promoted via promoteBacterialCds() instead.`
    );
  }

  const cds = collapseOverlappingCds(
    clipToExons(normalizeIntervals(input.cdsParts), exons),
    input.transcriptId
  );
  const translation = cds.length === 0 ? undefined : aggregateTranslation(input.cdsTranslations);

  const bboxStart = exons[0].start - 1;
  const bboxEnd = exons[exons.length - 1].end;
  const compositeKind = input.compositeKind ?? inferCompositeKind(input.type, input.attributes);
  const junctions = classifyCompositeJunctions(exons, compositeKind, input.attributes);

  return {
    chrom: input.chrom,
    source: input.source,
    type: input.type,
    start: bboxStart,
    end: bboxEnd,
    score: input.score ?? null,
    strand: input.strand,
    phase: input.phase ?? null,
    sourceAnnotationAliases: [
      ...new Set([
        ...(input.sourceAnnotationAliases ?? []),
        ...['ID', 'locus_tag', 'gene_id', 'transcript_id'].flatMap(
          (key) => input.attributes?.[key] ?? []
        ),
      ]),
    ].sort(),
    attributes: {
      ...(input.attributes ?? {}),
      ID: [input.transcriptId],
      ...(input.geneId ? { Parent: [input.geneId] } : {}),
    },
    raw: input.raw ?? '',
    exons,
    cds,
    translation,
    transcriptId: input.transcriptId,
    geneId: input.geneId,
    compositeKind,
    junctions,
  };
}

export function promoteBacterialCds(
  cdsRow: GenomeFeature,
  options?: { transcriptId?: string }
): ResolvedTranscript {
  const transcriptId =
    options?.transcriptId ?? cdsRow.attributes.ID?.[0] ?? `_synth.${cdsRow.start}_${cdsRow.end}`;
  const interval: BpInterval = { start: cdsRow.start + 1, end: cdsRow.end };
  const translation = cdsRow.attributes.translation?.[0];

  return {
    chrom: cdsRow.chrom,
    source: cdsRow.source,
    type: cdsRow.type,
    start: cdsRow.start,
    end: cdsRow.end,
    score: cdsRow.score,
    strand: cdsRow.strand,
    phase: cdsRow.phase,
    sourceAnnotationAliases: [
      ...new Set([
        ...(cdsRow.sourceAnnotationAliases ?? []),
        ...['ID', 'locus_tag', 'gene_id', 'transcript_id'].flatMap(
          (key) => cdsRow.attributes[key] ?? []
        ),
      ]),
    ].sort(),
    attributes: {
      ...cdsRow.attributes,
      ID: [transcriptId],
      _syntheticCompositeFeature: ['true'],
    },
    raw: cdsRow.raw,
    exons: [interval],
    cds: [interval],
    translation,
    transcriptId,
    compositeKind: 'compound-cds',
    junctions: [],
  };
}

function inferCompositeKind(
  type: string,
  attributes: Record<string, string[]> | undefined
): CompositeFeatureKind {
  if (type === 'CDS') return 'compound-cds';
  if (
    type === 'pseudogene' ||
    attributes?.pseudo?.some((value) => value.toLowerCase() === 'true') ||
    attributes?.gene_biotype?.some((value) => value.toLowerCase() === 'pseudogene')
  ) {
    return 'disrupted-locus';
  }
  return 'transcript';
}

function classifyCompositeJunctions(
  parts: ReadonlyArray<BpInterval>,
  compositeKind: CompositeFeatureKind,
  attributes: Record<string, string[]> | undefined
): ReadonlyArray<CompositeFeatureJunction> {
  if (parts.length < 2) return [];
  const hasQualifier = (key: string, pattern?: RegExp): boolean => {
    const values = attributes?.[key] ?? [];
    return pattern ? values.some((value) => pattern.test(value)) : values.length > 0;
  };
  const hasSlippage =
    hasQualifier('ribosomal_slippage') ||
    hasQualifier('exception', /ribosomal\s+slippage/i) ||
    hasQualifier('Note', /programmed\s+frameshift|ribosomal\s+slippage/i) ||
    hasQualifier('note', /programmed\s+frameshift|ribosomal\s+slippage/i);
  const hasTransSplicing = hasQualifier('trans_splicing');
  const hasArtificialLocation = hasQualifier('artificial_location');

  return parts.slice(0, -1).map((left, afterPartIndex) => {
    const right = parts[afterPartIndex + 1];
    const gapBp = right.start - left.end - 1;
    const relation = gapBp > 0 ? 'gap' : gapBp < 0 ? 'overlap' : 'adjacent';
    const evidence: string[] = [];
    let interpretation: CompositeFeatureJunction['interpretation'] = 'unknown';
    if (compositeKind === 'disrupted-locus') {
      interpretation = 'disruption';
      evidence.push('composite-kind:disrupted-locus');
    } else if (hasTransSplicing) {
      interpretation = 'trans-splicing';
      evidence.push('qualifier:trans_splicing');
    } else if (hasArtificialLocation) {
      interpretation = 'artificial';
      evidence.push('qualifier:artificial_location');
    } else if (hasSlippage && gapBp === 1) {
      interpretation = 'ribosomal-slippage-plus-one';
      evidence.push('qualifier:ribosomal_slippage', 'geometry:one-base-gap');
    } else if (hasSlippage && gapBp === -1) {
      interpretation = 'ribosomal-slippage-minus-one';
      evidence.push('qualifier:ribosomal_slippage', 'geometry:one-base-overlap');
    } else if (gapBp === 0) {
      interpretation = 'adjacent';
      evidence.push('geometry:adjacent');
    } else if (compositeKind === 'transcript' && gapBp > 0) {
      interpretation = 'intron';
      evidence.push('model:transcript-exon-gap');
    }
    return { afterPartIndex, gapBp, relation, interpretation, evidence };
  });
}

function normalizeIntervals(parts: ReadonlyArray<BpInterval>): ReadonlyArray<BpInterval> {
  if (parts.length === 0) return [];
  const seen = new Set<string>();
  const out: BpInterval[] = [];
  for (const p of parts) {
    const key = `${p.start}:${p.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start: p.start, end: p.end });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
}

function clipToExons(
  cds: ReadonlyArray<BpInterval>,
  exons: ReadonlyArray<BpInterval>
): ReadonlyArray<BpInterval> {
  if (cds.length === 0 || exons.length === 0) return [];
  const clipped: BpInterval[] = [];
  for (const c of cds) {
    for (const e of exons) {
      const start = Math.max(c.start, e.start);
      const end = Math.min(c.end, e.end);
      if (start <= end) {
        clipped.push({ start, end });
      }
    }
  }
  return normalizeIntervals(clipped);
}

function collapseOverlappingCds(
  cds: ReadonlyArray<BpInterval>,
  transcriptId: string
): ReadonlyArray<BpInterval> {
  if (cds.length < 2) return cds;
  const out: BpInterval[] = [];
  for (const interval of cds) {
    const last = out[out.length - 1];
    if (last && interval.start < last.end) {
      const lastLen = last.end - last.start;
      const thisLen = interval.end - interval.start;
      const kept = thisLen > lastLen ? interval : last;
      const dropped = thisLen > lastLen ? last : interval;
      if (kept !== last) out[out.length - 1] = kept;
      // eslint-disable-next-line no-console
      console.warn(
        `[/synthesizeTranscript] transcript "${transcriptId}" had overlapping CDS segments` +
          ` [${last.start}-${last.end}] and [${interval.start}-${interval.end}]:` +
          ` kept the longer ([${kept.start}-${kept.end}]) and dropped the shorter ([${dropped.start}-${dropped.end}]).` +
          ` This is a source-GFF3 data quality issue — multiple CDS records with the same Parent= are biologically invalid.` +
          ` Fix at source: drop the duplicate/spurious CDS row(s) or correct their Parent= references.`
      );
    } else {
      out.push(interval);
    }
  }
  return out;
}

function aggregateTranslation(parts: ReadonlyArray<string> | undefined): string | undefined {
  if (!parts || parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  if (parts.every((p) => p === first)) return first;
  return parts.join('');
}

export function pickCanonicalIsoform(
  transcripts: ReadonlyArray<ResolvedTranscript>
): ResolvedTranscript | undefined {
  if (transcripts.length === 0) return undefined;
  if (transcripts.length === 1) return transcripts[0];

  const maneSelect = transcripts.find((t) => {
    const tags = t.attributes.tag ?? t.attributes.Tag ?? [];
    return tags.includes('MANE_Select') || tags.includes('MANE Select');
  });
  if (maneSelect) return maneSelect;

  return transcripts.reduce((best, candidate) => {
    const candCdsLen = totalCoverage(candidate.cds);
    const bestCdsLen = totalCoverage(best.cds);
    if (candCdsLen > bestCdsLen) return candidate;
    if (candCdsLen < bestCdsLen) return best;
    const candExonLen = totalCoverage(candidate.exons);
    const bestExonLen = totalCoverage(best.exons);
    if (candExonLen > bestExonLen) return candidate;
    if (candExonLen < bestExonLen) return best;
    return candidate.start < best.start ? candidate : best;
  });
}

function totalCoverage(intervals: ReadonlyArray<BpInterval>): number {
  let total = 0;
  for (const i of intervals) {
    total += i.end - i.start + 1;
  }
  return total;
}
