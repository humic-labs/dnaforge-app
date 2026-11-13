import {
  parseGenBankFull,
  resolveSequenceGeneticCode,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import { extractHintsFromAnnotation } from './extract-hints';
import {
  deriveStructureProteinFromCds,
  type StructureProteinDerivation,
} from './structure-protein';
import type { ResolveHints } from '../types/structure-drawer';

export { deriveStructureProteinFromCds } from './structure-protein';
export type { StructureProteinDerivation, StructureProteinSource } from './structure-protein';

export type StructureCorpusClassification =
  | 'translation_mismatch_start_codon'
  | 'internal_stop'
  | 'no_identifier_hint'
  | 'no_translation';

export type StructureCorpusSidecarProbeClassification =
  | 'external_match'
  | 'alphafold_match'
  | 'no_external_match'
  | 'no_alphafold_prediction'
  | 'alphafold_not_probed'
  | 'structure_bytes_loaded'
  | 'structure_bytes_not_probed'
  | 'structure_bytes_failed'
  | 'provider_error';

export interface StructureCorpusFeature {
  sourcePath: string;
  sequenceName: string;
  featureIndex: number;
  label: string;
  start: number;
  end: number;
  direction: Annotation['direction'];
  hints: ResolveHints;
  derivation: StructureProteinDerivation | null;
  classifications: StructureCorpusClassification[];
}

export interface StructureCorpusSummary {
  sourcePath: string;
  sequenceName: string;
  sequenceLength: number;
  cdsCount: number;
  withQualifierTranslation: number;
  withDbXref: number;
  withProteinId: number;
  withLocusTag: number;
  withGene: number;
  derivedProteinCount: number;
  initiatorNormalizedCount: number;
  internalStopCount: number;
}

export interface StructureCorpusReport {
  summary: StructureCorpusSummary;
  features: StructureCorpusFeature[];
}

export interface StructureCorpusSidecarProbe {
  sourcePath: string;
  featureIndex: number;
  label: string;
  resolutionMode?: 'exact_sequence' | 'gene_sequence_overlap';
  bySequenceStatus: number;
  geneSearchStatus?: number | null;
  uniprotHitCount: number | null;
  topAccession: string | null;
  pdbIds: string[];
  afdbStatus: number | null;
  afdbExists: boolean | null;
  afdbMeanPlddt: number | null;
  sequenceOverlap?: {
    overlapLength: number;
    queryCoverage: number;
    hitCoverage: number;
  } | null;
  structureBytesStatus?: number | null;
  structureBytesOk?: boolean | null;
  classifications?: StructureCorpusSidecarProbeClassification[];
}

export interface StructureCorpusProbeControl {
  control: string;
  labelPattern: RegExp;
  expectedTopAccession: string;
  requireAlphafoldMatch: boolean;
  requireStructureBytes?: boolean;
}

export interface StructureCorpusProbeControlFailure {
  control: string;
  label?: string;
  reason:
    | 'missing_probe'
    | 'provider_error'
    | 'no_external_match'
    | 'unexpected_top_accession'
    | 'missing_alphafold_match'
    | 'missing_structure_bytes';
  expected?: string;
  actual?: string | null;
}

export interface StructureCorpusProbeControlEvaluation {
  ok: boolean;
  failures: StructureCorpusProbeControlFailure[];
}

export const MG1655_STRUCTURE_PROBE_CONTROLS: StructureCorpusProbeControl[] = [
  {
    control: 'arsC',
    labelPattern: /^arsC\b/,
    expectedTopAccession: 'P0AB96',
    requireAlphafoldMatch: true,
    requireStructureBytes: true,
  },
  {
    control: 'hdfR',
    labelPattern: /^hdfR\b/,
    expectedTopAccession: 'P0A8R9',
    requireAlphafoldMatch: true,
    requireStructureBytes: true,
  },
  {
    control: 'rbsR',
    labelPattern: /^rbsR\b/,
    expectedTopAccession: 'P0ACQ0',
    requireAlphafoldMatch: true,
    requireStructureBytes: true,
  },
  {
    control: 'mioC',
    labelPattern: /^mioC\b/,
    expectedTopAccession: 'P03817',
    requireAlphafoldMatch: true,
    requireStructureBytes: true,
  },
];

export function classifyStructureCorpusFeature(input: {
  derivation: StructureProteinDerivation | null;
  hints?: ResolveHints;
}): StructureCorpusClassification[] {
  const classifications: StructureCorpusClassification[] = [];
  if (!input.derivation) {
    classifications.push('no_translation');
    return classifications;
  }
  if (input.derivation.initiatorNormalized) {
    classifications.push('translation_mismatch_start_codon');
  }
  if (input.derivation.protein.includes('*')) {
    classifications.push('internal_stop');
  }
  const hints = input.hints;
  if (
    hints &&
    !hints.dbXrefs?.length &&
    !hints.proteinId &&
    !hints.locusTag &&
    !hints.geneName &&
    hints.taxonId === undefined
  ) {
    classifications.push('no_identifier_hint');
  }
  return classifications;
}

export function classifyStructureCorpusSidecarProbe(
  probe: StructureCorpusSidecarProbe
): StructureCorpusSidecarProbeClassification[] {
  if (probe.bySequenceStatus < 200 || probe.bySequenceStatus >= 300) {
    return ['provider_error'];
  }
  if (
    probe.geneSearchStatus !== null &&
    probe.geneSearchStatus !== undefined &&
    (probe.geneSearchStatus < 200 || probe.geneSearchStatus >= 300)
  ) {
    return ['provider_error'];
  }
  if (!probe.topAccession) {
    return ['no_external_match'];
  }

  const classifications: StructureCorpusSidecarProbeClassification[] = ['external_match'];
  if (probe.afdbStatus === null) {
    classifications.push('alphafold_not_probed');
  } else if (probe.afdbStatus < 200 || probe.afdbStatus >= 300) {
    classifications.push('provider_error');
  } else if (probe.afdbExists) {
    classifications.push('alphafold_match');
    if (probe.structureBytesOk === true) {
      classifications.push('structure_bytes_loaded');
    } else if (probe.structureBytesOk === false) {
      classifications.push('structure_bytes_failed');
    } else {
      classifications.push('structure_bytes_not_probed');
    }
  } else {
    classifications.push('no_alphafold_prediction');
  }
  return classifications;
}

export function evaluateStructureCorpusProbeControls(
  probes: StructureCorpusSidecarProbe[],
  controls: StructureCorpusProbeControl[]
): StructureCorpusProbeControlEvaluation {
  const failures: StructureCorpusProbeControlFailure[] = [];

  for (const control of controls) {
    const probe = probes.find((candidate) => matchesControl(control, candidate.label));
    if (!probe) {
      failures.push({ control: control.control, reason: 'missing_probe' });
      continue;
    }

    const classifications = probe.classifications ?? classifyStructureCorpusSidecarProbe(probe);
    if (classifications.includes('provider_error')) {
      failures.push({
        control: control.control,
        label: probe.label,
        reason: 'provider_error',
        actual: String(probe.bySequenceStatus),
      });
      continue;
    }
    if (classifications.includes('structure_bytes_failed')) {
      failures.push({
        control: control.control,
        label: probe.label,
        reason: 'missing_structure_bytes',
        actual:
          probe.structureBytesStatus === undefined || probe.structureBytesStatus === null
            ? null
            : String(probe.structureBytesStatus),
      });
      continue;
    }
    if (classifications.includes('no_external_match')) {
      failures.push({
        control: control.control,
        label: probe.label,
        reason: 'no_external_match',
      });
      continue;
    }
    if (probe.topAccession !== control.expectedTopAccession) {
      failures.push({
        control: control.control,
        label: probe.label,
        reason: 'unexpected_top_accession',
        expected: control.expectedTopAccession,
        actual: probe.topAccession,
      });
    }
    if (control.requireAlphafoldMatch && !classifications.includes('alphafold_match')) {
      failures.push({
        control: control.control,
        label: probe.label,
        reason: 'missing_alphafold_match',
      });
    }
    if (control.requireStructureBytes && !classifications.includes('structure_bytes_loaded')) {
      failures.push({
        control: control.control,
        label: probe.label,
        reason: 'missing_structure_bytes',
        actual:
          probe.structureBytesStatus === undefined || probe.structureBytesStatus === null
            ? null
            : String(probe.structureBytesStatus),
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

export function collectStructureCorpusFromSequence(
  parsed: AnnotatedSequence,
  opts: { sourcePath: string }
): StructureCorpusReport {
  const features: StructureCorpusFeature[] = [];
  const parsedGeneticCode = resolveSequenceGeneticCode(parsed).code;
  let cdsCount = 0;
  let withQualifierTranslation = 0;
  let withDbXref = 0;
  let withProteinId = 0;
  let withLocusTag = 0;
  let withGene = 0;
  let derivedProteinCount = 0;
  let initiatorNormalizedCount = 0;
  let internalStopCount = 0;

  parsed.annotations.forEach((annotation, featureIndex) => {
    if (annotation.type !== 'CDS') return;
    cdsCount += 1;
    const qualifiers = annotation.qualifiers;
    if (qualifiers?.translation?.[0]) withQualifierTranslation += 1;
    if (qualifiers?.db_xref?.length) withDbXref += 1;
    if (qualifiers?.protein_id?.[0]) withProteinId += 1;
    if (qualifiers?.locus_tag?.[0]) withLocusTag += 1;
    if (qualifiers?.gene?.[0]) withGene += 1;

    const hints = extractHintsFromAnnotation(annotation);
    const derivation = deriveStructureProteinFromCds(annotation, parsed.sequence, {
      circular: !!parsed.circular,
      sequenceGeneticCode: parsedGeneticCode,
    });
    if (derivation) derivedProteinCount += 1;
    if (derivation?.initiatorNormalized) initiatorNormalizedCount += 1;
    if (derivation?.protein.includes('*')) internalStopCount += 1;
    features.push({
      sourcePath: opts.sourcePath,
      sequenceName: parsed.name,
      featureIndex,
      label: annotation.name,
      start: annotation.start,
      end: annotation.end,
      direction: annotation.direction,
      hints,
      derivation,
      classifications: classifyStructureCorpusFeature({ derivation, hints }),
    });
  });

  return {
    summary: {
      sourcePath: opts.sourcePath,
      sequenceName: parsed.name,
      sequenceLength: parsed.length,
      cdsCount,
      withQualifierTranslation,
      withDbXref,
      withProteinId,
      withLocusTag,
      withGene,
      derivedProteinCount,
      initiatorNormalizedCount,
      internalStopCount,
    },
    features,
  };
}

export function collectStructureCorpusFromGenBank(
  genbank: string,
  opts: { sourcePath: string }
): StructureCorpusReport {
  return collectStructureCorpusFromSequence(parseGenBankFull(genbank), opts);
}

function matchesControl(control: StructureCorpusProbeControl, label: string): boolean {
  control.labelPattern.lastIndex = 0;
  return control.labelPattern.test(label);
}
