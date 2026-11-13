import {
  isResolvedGene,
  isResolvedTranscript,
  type GenomeFeature,
  type IndexableProteinSearchFeatureV1,
  type PrepackedProteinSubsequenceFinderV1,
  type ResolvedAnnotation,
  type ResolvedTranscript,
} from '@waypoint/genome-data';
import { annotationCanonicalIdentityV2 } from '@waypoint/genome-renderer/pure';
import { Buffer } from 'node:buffer';

import {
  ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN,
  ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS,
} from '../../features/sequence/annotation-layer-identity';
import {
  rendererAnnotationIdentityProjection,
  transcriptCarrierFeatureForRendererIdentity,
} from '../../features/sequence/components/indexed-genome-legacy-adapter';

const CODON_BASES = 'TCAG';
const CODON_TABLE_AA_BY_NCBI_ID: Readonly<Record<number, string>> = {
  1: 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  2: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSS**VVVVAAAADDEEGGGG',
  3: 'FFLLSSSSYY**CCWWTTTTPPPPHHQQRRRRIIMMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  4: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  5: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSSSSVVVVAAAADDEEGGGG',
  6: 'FFLLSSSSYYQQCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  9: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNNKSSSSVVVVAAAADDEEGGGG',
  10: 'FFLLSSSSYY**CCCWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  11: 'FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  12: 'FFLLSSSSYY**CC*WLLLSPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  13: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNKKSSGGVVVVAAAADDEEGGGG',
  14: 'FFLLSSSSYYY*CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNNKSSSSVVVVAAAADDEEGGGG',
  15: 'FFLLSSSSYY*QCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  16: 'FFLLSSSSYY*LCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  21: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIMMTTTTNNNKSSSSVVVVAAAADDEEGGGG',
  22: 'FFLLSS*SYY*LCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  23: 'FF*LSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  24: 'FFLLSSSSYY**CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSSKVVVVAAAADDEEGGGG',
  25: 'FFLLSSSSYY**CCGWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  26: 'FFLLSSSSYY**CC*WLLLAPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  27: 'FFLLSSSSYYQQCCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  28: 'FFLLSSSSYYQQCCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  29: 'FFLLSSSSYYYYCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  30: 'FFLLSSSSYYEECC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  31: 'FFLLSSSSYYEECCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  32: 'FFLLSSSSYY*WCC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG',
  33: 'FFLLSSSSYYY*CCWWLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSSKVVVVAAAADDEEGGGG',
};
const START_CODONS_BY_NCBI_ID: Readonly<Record<number, ReadonlySet<string>>> = {
  1: new Set(['TTG', 'CTG', 'ATG']),
  2: new Set(['ATT', 'ATC', 'ATA', 'ATG', 'GTG']),
  3: new Set(['ATA', 'ATG', 'GTG']),
  4: new Set(['TTA', 'TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG']),
  5: new Set(['TTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG']),
  6: new Set(['ATG']),
  9: new Set(['ATG', 'GTG']),
  10: new Set(['ATG']),
  11: new Set(['TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG']),
  12: new Set(['CTG', 'ATG']),
  13: new Set(['TTG', 'ATA', 'ATG', 'GTG']),
  14: new Set(['ATG']),
  15: new Set(['ATG']),
  16: new Set(['ATG']),
  21: new Set(['ATG', 'GTG']),
  22: new Set(['ATG']),
  23: new Set(['ATT', 'ATG', 'GTG']),
  24: new Set(['TTG', 'CTG', 'ATG', 'GTG']),
  25: new Set(['TTG', 'ATG', 'GTG']),
  26: new Set(['CTG', 'ATG']),
  27: new Set(['ATG']),
  28: new Set(['ATG']),
  29: new Set(['ATG']),
  30: new Set(['ATG']),
  31: new Set(['ATG']),
  32: new Set(['TTG', 'CTG', 'ATT', 'ATC', 'ATA', 'ATG', 'GTG']),
  33: new Set(['TTG', 'CTG', 'ATG', 'GTG']),
};

export const ASSEMBLY_PROTEIN_SEARCH_LEGACY_COMPILER_SEMANTICS_V2 =
  'assembly-protein-search-compiler.v2:source-first-derived-when-absent-quarantine' as const;
export const ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2 =
  `${ASSEMBLY_PROTEIN_SEARCH_LEGACY_COMPILER_SEMANTICS_V2}|${ANNOTATION_TRACK_IDENTITY_CONTRACT_TOKEN}` as const;
export const ASSEMBLY_PROTEIN_SEARCH_PREVIOUS_COMPILER_SEMANTICS_V2: readonly string[] =
  ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS.map(
    (token) => `${ASSEMBLY_PROTEIN_SEARCH_LEGACY_COMPILER_SEMANTICS_V2}|${token}`
  );

export const ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1 = 1_024 as const;

export type ProteinSearchIsoformQuarantineReasonV1 =
  | 'unknown-strand'
  | 'invalid-cds-bounds'
  | 'overlapping-cds-segments'
  | 'invalid-genetic-code'
  | 'conflicting-genetic-codes'
  | 'unsupported-genetic-code'
  | 'invalid-leading-frame'
  | 'invalid-source-translation'
  | 'source-translation-exceeds-cds'
  | 'empty-derived-translation'
  | 'fasta-read-length-mismatch';

export interface ProteinSearchIsoformQuarantineDiagnosticV1 {
  chrom: string;
  source: string;
  isoformId: string;
  reason: ProteinSearchIsoformQuarantineReasonV1;
}

export interface ProteinSearchCompilerWorkV1 {
  transcriptCount: number;
  sourceTranslationCount: number;
  derivedTranslationCount: number;
  skippedEmptyTranslationCount: number;
  quarantinedIsoformCount: number;
  quarantinedIsoforms: ProteinSearchIsoformQuarantineDiagnosticV1[];
  quarantineDiagnosticsTruncated: boolean;
}

export interface CompileChromosomeProteinSearchFeaturesV1Input {
  chromosomeLengthBp: number;
  globalStartBp: number;
  chromosomeSequence: string;
  resolvedAnnotations: ReadonlyArray<ResolvedAnnotation>;
  rawFeatures: ReadonlyArray<GenomeFeature>;
  genomeIdentity: string;
  sourceOrdinalStart?: number;
}

export interface CompileChromosomeProteinSearchFeaturesFromRangesV1Input extends Omit<
  CompileChromosomeProteinSearchFeaturesV1Input,
  'chromosomeSequence'
> {
  readSequence(start: number, end: number): Promise<string>;
}

export interface CompileChromosomeProteinSearchFeaturesV1Result {
  features: IndexableProteinSearchFeatureV1[];
  work: ProteinSearchCompilerWorkV1;
}

interface PreparedProteinTranscriptV1 {
  transcript: ResolvedTranscript;
  identityFeature: ResolvedAnnotation;
  biologicalRows: GenomeFeature[];
  geneticCode: number;
  leadingFrameOffset: 0 | 1 | 2;
  segments: IndexableProteinSearchFeatureV1['segments'];
  explicitTranslation: string | null;
}

interface ProteinTranscriptCandidateV1 {
  transcript: ResolvedTranscript;
  identityFeature: ResolvedAnnotation;
  sourceRows: GenomeFeature[];
  diagnosticIdentity: ProteinSearchIsoformIdentityV1;
}

interface ProteinSearchIsoformIdentityV1 {
  chrom: string;
  source: string;
  isoformId: string;
}

interface ProteinSearchQuarantineAccumulatorV1 {
  count: number;
  diagnostics: ProteinSearchIsoformQuarantineDiagnosticV1[];
  truncated: boolean;
}

interface PreparedProteinTranscriptsV1 {
  prepared: PreparedProteinTranscriptV1[];
  candidateCount: number;
  quarantine: ProteinSearchQuarantineAccumulatorV1;
}

export const nodeBufferProteinSubsequenceFinderV1: PrepackedProteinSubsequenceFinderV1 = (
  haystack,
  needle,
  fromIndex
) => {
  const source = Buffer.isBuffer(haystack)
    ? haystack
    : Buffer.from(haystack.buffer as ArrayBuffer, haystack.byteOffset, haystack.byteLength);
  const query = Buffer.isBuffer(needle)
    ? needle
    : Buffer.from(needle.buffer as ArrayBuffer, needle.byteOffset, needle.byteLength);
  return source.indexOf(query, fromIndex);
};

export function compileChromosomeProteinSearchFeaturesV1(
  input: CompileChromosomeProteinSearchFeaturesV1Input
): CompileChromosomeProteinSearchFeaturesV1Result {
  validateCompilerInput(input);
  const preparation = prepareProteinTranscripts(input);
  const features: IndexableProteinSearchFeatureV1[] = [];
  let sourceTranslationCount = 0;
  let derivedTranslationCount = 0;
  let skippedEmptyTranslationCount = 0;

  for (const item of preparation.prepared) {
    let proteinSequence = item.explicitTranslation ?? '';
    if (proteinSequence) {
      sourceTranslationCount += 1;
    } else {
      const codingDna = orderedLocalCds(item.transcript)
        .map((segment) =>
          orientSegmentBases(
            input.chromosomeSequence.slice(segment.start - 1, segment.end),
            item.transcript
          )
        )
        .join('');
      proteinSequence = translatePreparedCodingDna(item, codingDna);
      if (proteinSequence) derivedTranslationCount += 1;
    }
    if (!proteinSequence) {
      skippedEmptyTranslationCount += 1;
      quarantineIsoform(
        preparation.quarantine,
        proteinTranscriptIdentity(item.transcript),
        'empty-derived-translation'
      );
      continue;
    }
    features.push(materializeProteinFeature(input, item, proteinSequence, features.length));
  }

  return proteinCompilerResult(
    features,
    preparation.candidateCount,
    sourceTranslationCount,
    derivedTranslationCount,
    skippedEmptyTranslationCount,
    preparation.quarantine
  );
}

export async function compileChromosomeProteinSearchFeaturesFromRangesV1(
  input: CompileChromosomeProteinSearchFeaturesFromRangesV1Input
): Promise<CompileChromosomeProteinSearchFeaturesV1Result> {
  validateCompilerBaseInput(input);
  if (typeof input.readSequence !== 'function') {
    throw new Error('Protein search compiler range reader is invalid.');
  }
  const preparation = prepareProteinTranscripts(input);
  const features: IndexableProteinSearchFeatureV1[] = [];
  let sourceTranslationCount = 0;
  let derivedTranslationCount = 0;
  let skippedEmptyTranslationCount = 0;

  for (const item of preparation.prepared) {
    let proteinSequence = item.explicitTranslation ?? '';
    if (proteinSequence) {
      sourceTranslationCount += 1;
    } else {
      const parts: string[] = [];
      let shortRead = false;
      for (const segment of orderedLocalCds(item.transcript)) {
        const bases = await input.readSequence(segment.start - 1, segment.end);
        const expectedLength = segment.end - segment.start + 1;
        if (typeof bases !== 'string' || bases.length !== expectedLength) {
          quarantineIsoform(
            preparation.quarantine,
            proteinTranscriptIdentity(item.transcript),
            'fasta-read-length-mismatch'
          );
          shortRead = true;
          break;
        }
        parts.push(orientSegmentBases(bases, item.transcript));
      }
      if (shortRead) continue;
      proteinSequence = translatePreparedCodingDna(item, parts.join(''));
      if (proteinSequence) derivedTranslationCount += 1;
    }
    if (!proteinSequence) {
      skippedEmptyTranslationCount += 1;
      quarantineIsoform(
        preparation.quarantine,
        proteinTranscriptIdentity(item.transcript),
        'empty-derived-translation'
      );
      continue;
    }
    features.push(materializeProteinFeature(input, item, proteinSequence, features.length));
  }

  return proteinCompilerResult(
    features,
    preparation.candidateCount,
    sourceTranslationCount,
    derivedTranslationCount,
    skippedEmptyTranslationCount,
    preparation.quarantine
  );
}

export function translateCodingDnaWithGeneticCodeV1(
  codingDna: string,
  geneticCode: number,
  recodeCompleteStart: boolean
): string {
  assertSupportedGeneticCode(geneticCode);
  const table = CODON_TABLE_AA_BY_NCBI_ID[geneticCode];
  const startCodons = START_CODONS_BY_NCBI_ID[geneticCode];
  const sequence = codingDna.toUpperCase().replace(/U/g, 'T');
  let protein = '';
  for (let offset = 0; offset + 3 <= sequence.length; offset += 3) {
    const codon = sequence.slice(offset, offset + 3);
    const index = codonIndex(codon);
    let aminoAcid = index < 0 ? 'X' : table[index];
    if (offset === 0 && recodeCompleteStart && startCodons.has(codon)) {
      aminoAcid = 'M';
    }
    protein += aminoAcid;
  }
  return protein;
}

function prepareProteinTranscripts(
  input: Omit<CompileChromosomeProteinSearchFeaturesV1Input, 'chromosomeSequence'>
): PreparedProteinTranscriptsV1 {
  const transcripts = flattenCodingTranscripts(input.resolvedAnnotations);
  const rawCds = input.rawFeatures.filter((feature) => feature.type === 'CDS');
  const rawCdsByParent = indexRawCdsByParent(rawCds);
  const claimedRows = new Set<GenomeFeature>();
  const candidates: ProteinTranscriptCandidateV1[] = [];
  const quarantine = emptyQuarantineAccumulator();
  let candidateCount = 0;
  for (const transcript of transcripts) {
    const sourceRows = sourceCdsRowsForTranscript(transcript, rawCds, rawCdsByParent);
    for (const row of sourceRows) claimedRows.add(row);
    candidates.push({
      transcript,
      identityFeature: transcript,
      sourceRows,
      diagnosticIdentity: proteinTranscriptIdentity(transcript),
    });
    candidateCount += 1;
  }
  const unresolved = unresolvedRawCdsCandidates(
    input.resolvedAnnotations,
    input.rawFeatures,
    rawCds,
    claimedRows,
    input.chromosomeLengthBp,
    quarantine
  );
  candidates.push(...unresolved.candidates);
  candidateCount += unresolved.candidateCount;

  const prepared: PreparedProteinTranscriptV1[] = [];
  for (const { transcript, identityFeature, sourceRows, diagnosticIdentity } of candidates) {
    const geometryReason = transcriptGeometryQuarantineReason(transcript, input.chromosomeLengthBp);
    if (geometryReason) {
      quarantineIsoform(quarantine, diagnosticIdentity, geometryReason);
      continue;
    }
    if (!hasKnownProteinStrand(transcript)) {
      quarantineIsoform(quarantine, diagnosticIdentity, 'unknown-strand');
      continue;
    }
    const biologicalRows = sortRowsBiologically(sourceRows, transcript.strand);
    const geneticCode = declaredGeneticCodeResult(transcript, biologicalRows);
    if (!geneticCode.ok) {
      quarantineIsoform(quarantine, diagnosticIdentity, geneticCode.reason);
      continue;
    }
    const leadingFrameOffset = declaredLeadingFrameOffsetResult(transcript, biologicalRows);
    if (!leadingFrameOffset.ok) {
      quarantineIsoform(quarantine, diagnosticIdentity, 'invalid-leading-frame');
      continue;
    }
    const segments = orderedLocalCds(transcript).map((segment) => ({
      start: input.globalStartBp + segment.start - 1,
      end: input.globalStartBp + segment.end,
    }));
    const nucleotideCount = segments.reduce(
      (total, segment) => total + segment.end - segment.start,
      0
    );
    const sourceProtein = sourceTranslationResult(transcript, biologicalRows);
    if (sourceProtein.kind === 'invalid') {
      quarantineIsoform(quarantine, diagnosticIdentity, 'invalid-source-translation');
      continue;
    }
    if (
      sourceProtein.kind === 'valid' &&
      leadingFrameOffset.value + sourceProtein.protein.length * 3 > nucleotideCount
    ) {
      quarantineIsoform(quarantine, diagnosticIdentity, 'source-translation-exceeds-cds');
      continue;
    }
    prepared.push({
      transcript,
      identityFeature,
      biologicalRows,
      geneticCode: geneticCode.value,
      leadingFrameOffset: leadingFrameOffset.value,
      segments,
      explicitTranslation: sourceProtein.kind === 'valid' ? sourceProtein.protein : null,
    });
  }
  return { prepared, candidateCount, quarantine };
}

function orderedLocalCds(transcript: ResolvedTranscript): Array<ResolvedTranscript['cds'][number]> {
  return transcript.cds
    .slice()
    .sort((left, right) =>
      transcript.strand === '-'
        ? right.start - left.start || right.end - left.end
        : left.start - right.start || left.end - right.end
    );
}

function orientSegmentBases(bases: string, transcript: ResolvedTranscript): string {
  return transcript.strand === '-' ? reverseComplement(bases) : bases;
}

function translatePreparedCodingDna(item: PreparedProteinTranscriptV1, codingDna: string): string {
  return translateCodingDnaWithGeneticCodeV1(
    codingDna.slice(item.leadingFrameOffset),
    item.geneticCode,
    isCompleteFivePrimeCds(item.transcript, item.biologicalRows, item.leadingFrameOffset)
  ).replace(/\*$/, '');
}

function materializeProteinFeature(
  input: Omit<CompileChromosomeProteinSearchFeaturesV1Input, 'chromosomeSequence'>,
  item: PreparedProteinTranscriptV1,
  proteinSequence: string,
  outputIndex: number
): IndexableProteinSearchFeatureV1 {
  const rendererIdentity = rendererAnnotationIdentityProjection(
    transcriptCarrierFeatureForRendererIdentity(item.identityFeature)
  );
  const start = input.globalStartBp + rendererIdentity.start;
  const end = input.globalStartBp + rendererIdentity.end;
  const geneId = item.transcript.geneId ?? sourceGeneId(item.biologicalRows);
  return {
    sourceOrdinal: (input.sourceOrdinalStart ?? 0) + outputIndex,
    proteinSequence,
    segments: item.segments,
    strand: proteinSearchStrand(item.transcript),
    geneticCode: item.geneticCode,
    leadingFrameOffset: item.leadingFrameOffset,
    label: displayLabel(item.transcript, item.biologicalRows),
    ...(geneId ? { geneId } : {}),
    transcriptId: item.transcript.transcriptId,
    featureType: rendererIdentity.type,
    annotationTrackId: rendererIdentity.annotationTrackId,
    canonicalIdentity: annotationCanonicalIdentityV2({
      genomeIdentity: input.genomeIdentity,
      sourceId: rendererIdentity.sourceId,
      transcriptId: rendererIdentity.transcriptId,
      trackId: rendererIdentity.annotationTrackId,
      type: rendererIdentity.type,
      startBp: start,
      endBp: end,
      direction: rendererIdentity.direction,
    }),
  };
}

function proteinCompilerResult(
  features: IndexableProteinSearchFeatureV1[],
  transcriptCount: number,
  sourceTranslationCount: number,
  derivedTranslationCount: number,
  skippedEmptyTranslationCount: number,
  quarantine: ProteinSearchQuarantineAccumulatorV1
): CompileChromosomeProteinSearchFeaturesV1Result {
  return {
    features,
    work: {
      transcriptCount,
      sourceTranslationCount,
      derivedTranslationCount,
      skippedEmptyTranslationCount,
      quarantinedIsoformCount: quarantine.count,
      quarantinedIsoforms: quarantine.diagnostics,
      quarantineDiagnosticsTruncated: quarantine.truncated,
    },
  };
}

function flattenCodingTranscripts(
  annotations: ReadonlyArray<ResolvedAnnotation>
): ResolvedTranscript[] {
  const output: ResolvedTranscript[] = [];
  const seen = new Set<string>();
  const append = (transcript: ResolvedTranscript) => {
    if (transcript.cds.length === 0 || seen.has(transcript.transcriptId)) return;
    seen.add(transcript.transcriptId);
    output.push(transcript);
  };
  for (const annotation of annotations) {
    if (isResolvedGene(annotation)) {
      for (const transcript of annotation.transcripts) append(transcript);
    } else if (isResolvedTranscript(annotation)) {
      append(annotation);
    }
  }
  return output;
}

function unresolvedRawCdsCandidates(
  annotations: ReadonlyArray<ResolvedAnnotation>,
  rawFeatures: ReadonlyArray<GenomeFeature>,
  rawCds: ReadonlyArray<GenomeFeature>,
  claimedRows: ReadonlySet<GenomeFeature>,
  chromosomeLengthBp: number,
  quarantine: ProteinSearchQuarantineAccumulatorV1
): { candidates: ProteinTranscriptCandidateV1[]; candidateCount: number } {
  const carrierByKey = new Map<string, GenomeFeature>();
  for (const annotation of annotations) {
    if (
      annotation.type === 'CDS' &&
      !isResolvedGene(annotation) &&
      !isResolvedTranscript(annotation)
    ) {
      carrierByKey.set(rawCdsCarrierKey(annotation), annotation);
    }
  }
  const featureById = new Map<string, GenomeFeature>();
  for (const feature of rawFeatures) {
    const id = feature.attributes.ID?.[0]?.trim();
    if (id && !featureById.has(id)) featureById.set(id, feature);
  }
  const groups = new Map<
    string,
    {
      rows: GenomeFeature[];
      identityFeature: GenomeFeature;
      parentId: string | null;
      isoformId: string;
    }
  >();
  for (const row of rawCds) {
    if (claimedRows.has(row)) continue;
    const identityFeature = carrierByKey.get(rawCdsCarrierKey(row));
    if (!identityFeature) continue;
    const parents = uniqueNonempty(row.attributes.Parent);
    const owners: Array<string | null> = parents.length > 0 ? parents : [null];
    const explicitIsoformId = firstNonemptyAttribute(row, ['transcript_id', 'protein_id', 'ID']);
    for (const parentId of owners) {
      const isoformId = explicitIsoformId ?? stableAnonymousRawCdsIsoformId(row, parentId);
      const groupingIdentity = explicitIsoformId
        ? `isoform:${explicitIsoformId}`
        : `row:${stableAnonymousRawCdsIsoformId(row, parentId)}`;
      const key = JSON.stringify([row.chrom, row.source, row.strand, parentId, groupingIdentity]);
      const incumbent = groups.get(key);
      if (incumbent) {
        incumbent.rows.push(row);
      } else {
        groups.set(key, { rows: [row], identityFeature, parentId, isoformId });
      }
    }
  }

  const output: ProteinTranscriptCandidateV1[] = [];
  for (const group of groups.values()) {
    const first = group.rows[0];
    const identity = {
      chrom: first.chrom,
      source: first.source,
      isoformId: group.isoformId,
    };
    const intervals = normalizedRawCdsIntervals(group.rows, chromosomeLengthBp);
    if (!intervals.ok) {
      quarantineIsoform(quarantine, identity, intervals.reason);
      continue;
    }
    const geneId = fallbackGeneId(first, group.parentId, featureById);
    const transcript: ResolvedTranscript = {
      ...first,
      start: intervals.value[0].start - 1,
      end: intervals.value[intervals.value.length - 1].end,
      attributes: { ...first.attributes },
      exons: intervals.value,
      cds: intervals.value,
      transcriptId: group.isoformId,
      ...(geneId ? { geneId } : {}),
    };
    output.push({
      transcript,
      identityFeature: group.identityFeature,
      sourceRows: group.rows,
      diagnosticIdentity: identity,
    });
  }
  return { candidates: output, candidateCount: groups.size };
}

function normalizedRawCdsIntervals(
  rows: ReadonlyArray<GenomeFeature>,
  chromosomeLengthBp: number
):
  | { ok: true; value: ResolvedTranscript['cds'] }
  | {
      ok: false;
      reason: Extract<
        ProteinSearchIsoformQuarantineReasonV1,
        'invalid-cds-bounds' | 'overlapping-cds-segments'
      >;
    } {
  const byInterval = new Map<string, ResolvedTranscript['cds'][number]>();
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.start) ||
      !Number.isSafeInteger(row.end) ||
      row.start < 0 ||
      row.end <= row.start ||
      row.end > chromosomeLengthBp
    ) {
      return { ok: false, reason: 'invalid-cds-bounds' };
    }
    byInterval.set(`${row.start}:${row.end}`, { start: row.start + 1, end: row.end });
  }
  const intervals = [...byInterval.values()].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].start <= intervals[index - 1].end) {
      return { ok: false, reason: 'overlapping-cds-segments' };
    }
  }
  return intervals.length > 0
    ? { ok: true, value: intervals }
    : { ok: false, reason: 'invalid-cds-bounds' };
}

function stableAnonymousRawCdsIsoformId(row: GenomeFeature, parentId: string | null): string {
  return [
    parentId || 'unparented',
    'CDS',
    row.chrom,
    row.strand,
    `${row.start + 1}-${row.end}`,
    row.fileOffset ?? stableTextHash(row.raw),
  ].join(':');
}

function stableTextHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function proteinTranscriptIdentity(
  transcript: Pick<ResolvedTranscript, 'chrom' | 'source' | 'transcriptId'>
): ProteinSearchIsoformIdentityV1 {
  return {
    chrom: transcript.chrom,
    source: transcript.source,
    isoformId: transcript.transcriptId,
  };
}

function emptyQuarantineAccumulator(): ProteinSearchQuarantineAccumulatorV1 {
  return { count: 0, diagnostics: [], truncated: false };
}

function quarantineIsoform(
  accumulator: ProteinSearchQuarantineAccumulatorV1,
  identity: ProteinSearchIsoformIdentityV1,
  reason: ProteinSearchIsoformQuarantineReasonV1
): void {
  accumulator.count += 1;
  if (accumulator.diagnostics.length < ASSEMBLY_PROTEIN_SEARCH_MAX_QUARANTINE_DIAGNOSTICS_V1) {
    accumulator.diagnostics.push({ ...identity, reason });
  } else {
    accumulator.truncated = true;
  }
}

function transcriptGeometryQuarantineReason(
  transcript: ResolvedTranscript,
  chromosomeLengthBp: number
): Extract<
  ProteinSearchIsoformQuarantineReasonV1,
  'invalid-cds-bounds' | 'overlapping-cds-segments'
> | null {
  const intervals = transcript.cds
    .map((segment) => ({ start: segment.start, end: segment.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const interval of intervals) {
    if (
      !Number.isSafeInteger(interval.start) ||
      !Number.isSafeInteger(interval.end) ||
      interval.start < 1 ||
      interval.end < interval.start ||
      interval.end > chromosomeLengthBp
    ) {
      return 'invalid-cds-bounds';
    }
  }
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].start <= intervals[index - 1].end) {
      return 'overlapping-cds-segments';
    }
  }
  return intervals.length > 0 ? null : 'invalid-cds-bounds';
}

function rawCdsCarrierKey(feature: GenomeFeature): string {
  return JSON.stringify([
    feature.chrom,
    feature.source,
    feature.type,
    feature.start,
    feature.end,
    feature.strand,
    feature.attributes.ID?.[0] ?? '',
    feature.fileOffset ?? null,
  ]);
}

function uniqueNonempty(values: ReadonlyArray<string> | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function firstNonemptyAttribute(
  feature: GenomeFeature,
  keys: ReadonlyArray<string>
): string | null {
  for (const key of keys) {
    const value = feature.attributes[key]?.[0]?.trim();
    if (value) return value;
  }
  return null;
}

function fallbackGeneId(
  row: GenomeFeature,
  parentId: string | null,
  featureById: ReadonlyMap<string, GenomeFeature>
): string | undefined {
  const direct = firstNonemptyAttribute(row, ['gene_id', 'gene', 'locus_tag']);
  if (direct) return direct;
  if (!parentId) return undefined;
  const parent = featureById.get(parentId);
  if (parent?.type === 'gene' || parent?.type === 'pseudogene') return parentId;
  return parent?.attributes.Parent?.find((candidate) => {
    const grandparent = featureById.get(candidate);
    return grandparent?.type === 'gene' || grandparent?.type === 'pseudogene';
  });
}

function hasKnownProteinStrand(
  feature: Pick<GenomeFeature, 'strand'>
): feature is Pick<GenomeFeature, 'strand'> & { strand: '+' | '-' } {
  return feature.strand === '+' || feature.strand === '-';
}

function proteinSearchStrand(
  transcript: Pick<ResolvedTranscript, 'strand'>
): IndexableProteinSearchFeatureV1['strand'] {
  if (transcript.strand === '+') return 'forward';
  if (transcript.strand === '-') return 'reverse';
  throw new Error('Protein search compiler rejected a CDS with unknown strand.');
}

function indexRawCdsByParent(
  rows: ReadonlyArray<GenomeFeature>
): ReadonlyMap<string, GenomeFeature[]> {
  const index = new Map<string, GenomeFeature[]>();
  for (const row of rows) {
    for (const parent of row.attributes.Parent ?? []) {
      const list = index.get(parent);
      if (list) list.push(row);
      else index.set(parent, [row]);
    }
  }
  return index;
}

function sourceCdsRowsForTranscript(
  transcript: ResolvedTranscript,
  rawCds: ReadonlyArray<GenomeFeature>,
  byParent: ReadonlyMap<string, GenomeFeature[]>
): GenomeFeature[] {
  const exact = byParent.get(transcript.transcriptId);
  if (exact && exact.length > 0) return matchingTranscriptIntervals(transcript, exact);
  const directId = rawCds.filter(
    (row) => row.attributes.ID?.[0] === transcript.transcriptId && row.strand === transcript.strand
  );
  if (directId.length > 0) return matchingTranscriptIntervals(transcript, directId);
  const intervalKeys = new Set(
    transcript.cds.map((segment) => `${segment.start - 1}:${segment.end}`)
  );
  const association = associationKey(transcript);
  return rawCds.filter(
    (row) =>
      intervalKeys.has(`${row.start}:${row.end}`) &&
      row.strand === transcript.strand &&
      (!association || associationKey(row) === association)
  );
}

function matchingTranscriptIntervals(
  transcript: ResolvedTranscript,
  rows: ReadonlyArray<GenomeFeature>
): GenomeFeature[] {
  const intervals = new Set(transcript.cds.map((segment) => `${segment.start - 1}:${segment.end}`));
  return rows.filter((row) => intervals.has(`${row.start}:${row.end}`));
}

function sortRowsBiologically(
  rows: ReadonlyArray<GenomeFeature>,
  strand: GenomeFeature['strand']
): GenomeFeature[] {
  return [...rows].sort((left, right) =>
    strand === '-'
      ? right.start - left.start || right.end - left.end
      : left.start - right.start || left.end - right.end
  );
}

function sourceTranslationResult(
  transcript: ResolvedTranscript,
  biologicalRows: ReadonlyArray<GenomeFeature>
): { kind: 'absent' } | { kind: 'invalid' } | { kind: 'valid'; protein: string } {
  const rowDeclarations = biologicalRows
    .map((row) => row.attributes.translation?.[0])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (rowDeclarations.length > 0) {
    const rowTranslations = rowDeclarations.map(normalizeProtein);
    if (rowTranslations.some((value) => value === null)) return { kind: 'invalid' };
    const valid = rowTranslations as string[];
    const first = valid[0];
    return {
      kind: 'valid',
      protein: valid.every((value) => value === first) ? first : valid.join(''),
    };
  }
  if (typeof transcript.translation !== 'string' || transcript.translation.trim().length === 0) {
    return { kind: 'absent' };
  }
  const normalized = normalizeProtein(transcript.translation);
  return normalized ? { kind: 'valid', protein: normalized } : { kind: 'invalid' };
}

function normalizeProtein(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, '').toUpperCase().replace(/\*$/, '');
  return normalized && /^[ACDEFGHIKLMNPQRSTVWYX*]+$/.test(normalized) ? normalized : null;
}

function declaredGeneticCodeResult(
  transcript: ResolvedTranscript,
  biologicalRows: ReadonlyArray<GenomeFeature>
):
  | { ok: true; value: number }
  | {
      ok: false;
      reason: Extract<
        ProteinSearchIsoformQuarantineReasonV1,
        'invalid-genetic-code' | 'conflicting-genetic-codes' | 'unsupported-genetic-code'
      >;
    } {
  const declarations = [
    ...(transcript.attributes.transl_table ?? []),
    ...biologicalRows.flatMap((row) => row.attributes.transl_table ?? []),
  ].filter((value) => value.trim().length > 0);
  if (declarations.length === 0) return { ok: true, value: 1 };
  if (declarations.some((value) => !/^[1-9]\d*$/.test(value.trim()))) {
    return { ok: false, reason: 'invalid-genetic-code' };
  }
  const declared = declarations.map((value) => Number(value.trim()));
  if (declared.some((value) => !Number.isSafeInteger(value))) {
    return { ok: false, reason: 'invalid-genetic-code' };
  }
  if (declared.some((value) => value !== declared[0])) {
    return { ok: false, reason: 'conflicting-genetic-codes' };
  }
  if (!CODON_TABLE_AA_BY_NCBI_ID[declared[0]] || !START_CODONS_BY_NCBI_ID[declared[0]]) {
    return { ok: false, reason: 'unsupported-genetic-code' };
  }
  return { ok: true, value: declared[0] };
}

function declaredLeadingFrameOffsetResult(
  transcript: ResolvedTranscript,
  biologicalRows: ReadonlyArray<GenomeFeature>
): { ok: true; value: 0 | 1 | 2 } | { ok: false } {
  const first = biologicalRows[0];
  const codonStartDeclaration =
    first?.attributes.codon_start?.[0] ?? transcript.attributes.codon_start?.[0];
  if (codonStartDeclaration !== undefined && codonStartDeclaration.trim().length > 0) {
    if (!/^[123]$/.test(codonStartDeclaration.trim())) return { ok: false };
    return {
      ok: true,
      value: (Number(codonStartDeclaration.trim()) - 1) as 0 | 1 | 2,
    };
  }
  const phaseDeclaration = first?.phase;
  if (
    phaseDeclaration !== undefined &&
    phaseDeclaration !== null &&
    phaseDeclaration.trim().length > 0 &&
    phaseDeclaration.trim() !== '.'
  ) {
    if (!/^[012]$/.test(phaseDeclaration.trim())) return { ok: false };
    return { ok: true, value: Number(phaseDeclaration.trim()) as 0 | 1 | 2 };
  }
  return { ok: true, value: 0 };
}

function isCompleteFivePrimeCds(
  transcript: ResolvedTranscript,
  biologicalRows: ReadonlyArray<GenomeFeature>,
  leadingFrameOffset: number
): boolean {
  if (leadingFrameOffset !== 0) return false;
  const attributes = biologicalRows[0]?.attributes ?? transcript.attributes;
  const partial = attributes.partial?.some((value) => value.toLowerCase() === 'true');
  return !partial && !(attributes.start_range?.length > 0);
}

function displayLabel(transcript: ResolvedTranscript, rows: ReadonlyArray<GenomeFeature>): string {
  const sources = [transcript.attributes, rows[0]?.attributes ?? {}];
  for (const key of [
    'Name',
    'label',
    'gene',
    'gene_name',
    'transcript_name',
    'product',
    'protein_id',
    'ID',
  ]) {
    for (const source of sources) {
      const value = source[key]?.[0]?.trim();
      if (value) return value;
    }
  }
  return transcript.transcriptId;
}

function sourceGeneId(rows: ReadonlyArray<GenomeFeature>): string | undefined {
  return rows[0]?.attributes.gene?.[0] ?? rows[0]?.attributes.locus_tag?.[0];
}

function associationKey(feature: GenomeFeature): string | null {
  const value =
    feature.attributes.gene?.[0] ??
    feature.attributes.Name?.[0] ??
    feature.attributes.locus_tag?.[0] ??
    feature.attributes.transcript_id?.[0];
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function reverseComplement(sequence: string): string {
  let output = '';
  for (let index = sequence.length - 1; index >= 0; index -= 1) {
    const base = sequence[index].toUpperCase();
    output +=
      base === 'A' ? 'T' : base === 'T' ? 'A' : base === 'C' ? 'G' : base === 'G' ? 'C' : 'N';
  }
  return output;
}

function codonIndex(codon: string): number {
  if (codon.length !== 3) return -1;
  const first = CODON_BASES.indexOf(codon[0]);
  const second = CODON_BASES.indexOf(codon[1]);
  const third = CODON_BASES.indexOf(codon[2]);
  return first < 0 || second < 0 || third < 0 ? -1 : first * 16 + second * 4 + third;
}

function assertSupportedGeneticCode(geneticCode: number): void {
  if (!CODON_TABLE_AA_BY_NCBI_ID[geneticCode] || !START_CODONS_BY_NCBI_ID[geneticCode]) {
    throw new Error(
      `Protein search compiler rejected unsupported NCBI genetic code ${geneticCode}.`
    );
  }
}

function validateCompilerInput(input: CompileChromosomeProteinSearchFeaturesV1Input): void {
  validateCompilerBaseInput(input);
  if (
    typeof input.chromosomeSequence !== 'string' ||
    input.chromosomeSequence.length !== input.chromosomeLengthBp
  ) {
    throw new Error('Protein search compiler chromosome sequence is invalid.');
  }
}

function validateCompilerBaseInput(
  input: Omit<CompileChromosomeProteinSearchFeaturesV1Input, 'chromosomeSequence'>
): void {
  if (
    !Number.isSafeInteger(input.chromosomeLengthBp) ||
    input.chromosomeLengthBp <= 0 ||
    !Number.isSafeInteger(input.globalStartBp) ||
    input.globalStartBp < 0 ||
    !Array.isArray(input.resolvedAnnotations) ||
    !Array.isArray(input.rawFeatures) ||
    typeof input.genomeIdentity !== 'string' ||
    input.genomeIdentity.length === 0 ||
    !Number.isSafeInteger(input.sourceOrdinalStart ?? 0) ||
    (input.sourceOrdinalStart ?? 0) < 0
  ) {
    throw new Error('Protein search compiler input is invalid.');
  }
}
