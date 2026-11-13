import {
  isCustomGeneticCodeSpec,
  resolveAnnotationGeneticCode,
  resolveSequenceGeneticCode,
  reverseComplement,
  type AnnotatedSequence,
  type Annotation,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import {
  standaloneProteinMoleculeIdFromEntity,
  translatedCdsFeatureKey,
  translatedCdsMoleculeId,
} from '@waypoint/workspace-editor';
import { extractHintsFromAnnotation } from './extract-hints';
import {
  buildFeatureIdentity,
  buildIdentityRequestKey,
  buildProteinSequenceIdentity,
  makeIdentityEvidence,
  type FeatureLocationSegment,
} from './protein-identity';
import { deriveStructureProteinFromCds } from './structure-protein';
import type { StructureDrawerRefusal, StructureDrawerRequest } from '../types/structure-drawer';

interface BuildStructureDrawerRequestInput {
  cds: Annotation;
  sequence: AnnotatedSequence;
  entityId?: string;
}

export function buildStructureDrawerRequestFromCds({
  cds,
  sequence,
  entityId,
}: BuildStructureDrawerRequestInput): StructureDrawerRequest | null {
  const sequenceGeneticCode = resolveSequenceGeneticCode(sequence).code;
  const derivation = deriveStructureProteinFromCds(cds, sequence.sequence, {
    circular: !!sequence.circular,
    sequenceGeneticCode,
  });
  if (!derivation) return null;
  const refusal = derivation.protein.endsWith('*')
    ? {
        code: 'internal_stop',
        message:
          'The coding annotation contains a stop before its final codon. Resolve its translation before mapping mutations to a protein structure.',
      }
    : nonStandardResidueRefusal(
        derivation.protein,
        resolveAnnotationGeneticCode(cds, sequenceGeneticCode)
      );
  const hints = extractHintsFromAnnotation(cds);
  const translationEvidence = makeIdentityEvidence({
    kind:
      derivation.source === 'qualifier_translation'
        ? 'qualifier_translation'
        : 'derived_cds_translation',
    source: derivation.source === 'qualifier_translation' ? 'genbank' : 'waypoint',
    confidence: 'authoritative',
    label:
      derivation.source === 'qualifier_translation'
        ? 'GenBank qualifier translation'
        : 'Coordinate-derived CDS translation',
    details: {
      length: derivation.protein.length,
      startCodon: derivation.startCodon,
    },
  });
  const evidence = [translationEvidence];
  if (derivation.initiatorNormalized) {
    evidence.push(
      makeIdentityEvidence({
        kind: 'initiator_normalization',
        source: 'waypoint',
        confidence: 'authoritative',
        label: 'Bacterial initiator normalization',
        details: {
          startCodon: derivation.startCodon,
          rawResidue: derivation.rawProtein[0] ?? null,
          normalizedResidue: derivation.protein[0] ?? null,
        },
      })
    );
  }
  const sequenceIdentity = buildProteinSequenceIdentity({
    lookupSequence: derivation.protein,
    rawSequence: derivation.rawProtein,
    source: derivation.source,
    startCodon: derivation.startCodon,
    initiatorNormalized: derivation.initiatorNormalized,
    translationConfig: translationConfigFromCds(cds),
    evidenceIds: evidence.map((item) => item.id),
  });
  if (!sequenceIdentity) return null;
  const featureIdentity = buildFeatureIdentity({
    type: cds.type,
    label: cds.name,
    entityId,
    circular: !!sequence.circular,
    segments: featureSegments(cds, sequence.sequence.length, !!sequence.circular),
    hintSummary: {
      dbXrefCount: hints.dbXrefs?.length ?? 0,
      hasProteinId: !!hints.proteinId,
      hasLocusTag: !!hints.locusTag,
      hasGeneName: !!hints.geneName,
      taxonId: hints.taxonId,
    },
  });
  const proteinIdentity = {
    schemaVersion: 2 as const,
    feature: featureIdentity,
    sequence: sequenceIdentity,
    externalProteins: [],
    resolutionSets: [],
    structures: [],
    evidence,
  };
  const cdsBounds =
    cds.direction === 1 || cds.direction === -1
      ? {
          cdsStart: cds.start - 1,
          cdsEnd: cds.end - 1,
          strand: cds.direction as 1 | -1,
        }
      : undefined;

  return {
    translation: derivation.protein,
    proteinIdentity,
    identityRequestKey: buildIdentityRequestKey(
      featureIdentity.featureKey,
      sequenceIdentity.identityKey
    ),
    cdsLabel: cds.name,
    entityId,
    ...(entityId
      ? {
          residueMolecule: {
            moleculeId: translatedCdsMoleculeId(entityId, cds),
            moleculeKind: 'translated-cds' as const,
            label: translatedCdsFeatureKey(cds),
          },
        }
      : {}),
    hints,
    cdsBounds,
    ...(refusal ? { refusal } : {}),
  };
}

function nonStandardResidueRefusal(
  protein: string,
  geneticCode: GeneticCodeSpec
): StructureDrawerRefusal | undefined {
  if (!isCustomGeneticCodeSpec(geneticCode)) return undefined;
  const positions: number[] = [];
  for (let index = 0; index < protein.length; index++) {
    if (protein[index] === 'X') positions.push(index + 1);
  }
  if (positions.length === 0) return undefined;
  const shown = positions.slice(0, 5).join(', ');
  const more = positions.length > 5 ? `, and ${positions.length - 5} more` : '';
  return {
    code: 'non_standard_residues',
    message:
      `"${geneticCode.name}" encodes residues outside the standard twenty at ` +
      `${positions.length === 1 ? 'position' : 'positions'} ${shown}${more}. ` +
      `Structure lookup and prediction need standard amino acids.`,
  };
}

function translationConfigFromCds(cds: Annotation): {
  geneticCode: number;
  frame: 0 | 1 | 2;
} {
  const qualifierValue = (key: string): string | undefined => {
    const raw = cds.qualifiers?.[key];
    if (Array.isArray(raw)) return raw[0];
    return typeof raw === 'string' ? raw : undefined;
  };
  const geneticCodeValue = Number.parseInt(qualifierValue('transl_table') ?? '1', 10);
  const codonStartValue = Number.parseInt(qualifierValue('codon_start') ?? '1', 10);
  const geneticCode =
    Number.isInteger(geneticCodeValue) && geneticCodeValue > 0 ? geneticCodeValue : 1;
  const frame = codonStartValue === 2 ? 1 : codonStartValue === 3 ? 2 : 0;
  return { geneticCode, frame };
}

export function buildStructureDrawerRequestFromAnnotation({
  annotation,
  sequence,
  entityId,
}: {
  annotation: Annotation;
  sequence: AnnotatedSequence;
  entityId?: string;
}): StructureDrawerRequest | null {
  if (annotation.type === 'CDS') {
    return buildStructureDrawerRequestFromCds({ cds: annotation, sequence, entityId });
  }
  if (!isRnaStructureAnnotation(annotation)) return null;
  const rnaSequence = deriveRnaSequenceFromFeature(annotation, sequence);
  if (!rnaSequence) return null;
  const hints = extractHintsFromAnnotation(annotation);
  const featureIdentity = buildFeatureIdentity({
    type: annotation.type,
    label: annotation.name,
    entityId,
    circular: !!sequence.circular,
    segments: featureSegments(annotation, sequence.sequence.length, !!sequence.circular),
    hintSummary: {
      dbXrefCount: hints.dbXrefs?.length ?? 0,
      hasProteinId: !!hints.proteinId,
      hasLocusTag: !!hints.locusTag,
      hasGeneName: !!hints.geneName,
      taxonId: hints.taxonId,
    },
  });
  return {
    translation: rnaSequence,
    moleculeType: 'rna',
    identityRequestKey: `req:${featureIdentity.featureKey}:rna-sequence:v1`,
    cdsLabel: annotation.name,
    entityId,
    hints,
  };
}

export function buildStructureDrawerRequestFromIndexedCds({
  cds,
  protein,
  location,
  entityId,
}: {
  cds: Annotation;
  protein: string;
  location: { referenceId: string; chrom: string; start0: number; end0: number; strand: 1 | -1 };
  entityId: string;
}): StructureDrawerRequest | null {
  const lookup = protein.endsWith('*') ? protein.slice(0, -1) : protein;
  if (!lookup || lookup.includes('*')) return null;
  const hints = extractHintsFromAnnotation(cds);
  const evidence = [
    makeIdentityEvidence({
      kind: 'derived_cds_translation',
      source: 'waypoint',
      confidence: 'authoritative',
      label: 'Spliced CDS translation from the indexed reference',
      details: {
        length: lookup.length,
        reference: location.referenceId,
        chrom: location.chrom,
      },
    }),
  ];
  const sequenceIdentity = buildProteinSequenceIdentity({
    lookupSequence: lookup,
    rawSequence: protein,
    source: 'derived_cds',
    startCodon: null,
    initiatorNormalized: false,
    translationConfig: translationConfigFromCds(cds),
    evidenceIds: evidence.map((item) => item.id),
  });
  if (!sequenceIdentity) return null;
  const featureIdentity = buildFeatureIdentity({
    type: cds.type,
    label: cds.name,
    entityId: `${location.referenceId}:${location.chrom}`,
    circular: false,
    segments: [{ start0: location.start0, end0: location.end0, strand: location.strand }],
    hintSummary: {
      dbXrefCount: hints.dbXrefs?.length ?? 0,
      hasProteinId: !!hints.proteinId,
      hasLocusTag: !!hints.locusTag,
      hasGeneName: !!hints.geneName,
      taxonId: hints.taxonId,
    },
  });
  return {
    translation: sequenceIdentity.lookupSequence,
    proteinIdentity: {
      schemaVersion: 2 as const,
      feature: featureIdentity,
      sequence: sequenceIdentity,
      externalProteins: [],
      resolutionSets: [],
      structures: [],
      evidence,
    },
    identityRequestKey: buildIdentityRequestKey(
      featureIdentity.featureKey,
      sequenceIdentity.identityKey
    ),
    cdsLabel: cds.name,
    entityId,
    hints,
  };
}

export function buildStructureDrawerRequestFromProteinEntity({
  entityId,
  aaSequence,
  label,
}: {
  entityId: string;
  aaSequence: string;
  label?: string;
}): StructureDrawerRequest | null {
  const evidence = [
    makeIdentityEvidence({
      kind: 'registered_protein_entity',
      source: 'waypoint',
      confidence: 'authoritative',
      label: 'Registered protein registry entity',
      details: { entityId },
    }),
  ];
  const sequenceIdentity = buildProteinSequenceIdentity({
    lookupSequence: aaSequence,
    source: 'standalone_protein_entity',
    startCodon: null,
    initiatorNormalized: false,
    evidenceIds: evidence.map((item) => item.id),
  });
  if (!sequenceIdentity) return null;

  const proteinIdentity = {
    schemaVersion: 2 as const,
    sequence: sequenceIdentity,
    externalProteins: [],
    resolutionSets: [],
    structures: [],
    evidence,
  };

  return {
    translation: sequenceIdentity.lookupSequence,
    proteinIdentity,
    identityRequestKey: buildIdentityRequestKey(entityId, sequenceIdentity.identityKey),
    cdsLabel: label,
    entityId,
    residueMolecule: {
      moleculeId: standaloneProteinMoleculeIdFromEntity(entityId, sequenceIdentity.digests.sha256),
      moleculeKind: 'protein',
      label,
    },
    hints: {},
  };
}

export function isRnaStructureAnnotation(annotation: Annotation): boolean {
  const type = annotation.type.toLowerCase();
  return (
    type === 'rrna' ||
    type === 'trna' ||
    type === 'ncrna' ||
    type === 'tmrna' ||
    type === 'mrna' ||
    type === 'misc_rna' ||
    type === 'antisense_rna' ||
    type === 'snrna' ||
    type === 'snorna' ||
    type.endsWith('_rna')
  );
}

function deriveRnaSequenceFromFeature(
  annotation: Annotation,
  sequence: AnnotatedSequence
): string | null {
  const nucleotide = extractFeatureNucleotideSequence(
    annotation,
    sequence.sequence,
    !!sequence.circular
  );
  if (!nucleotide) return null;
  const oriented = annotation.direction === -1 ? reverseComplement(nucleotide) : nucleotide;
  const rna = oriented.toUpperCase().replace(/T/g, 'U').replace(/\s+/g, '');
  if (rna.length < 25) return null;
  if (!/^[ACUGNI]+$/.test(rna)) return null;
  return rna;
}

function extractFeatureNucleotideSequence(
  annotation: Annotation,
  sequence: string,
  circular: boolean
): string | null {
  if (!sequence) return null;
  const segments = annotation.segments?.length
    ? annotation.segments
    : [{ start: annotation.start, end: annotation.end }];
  const pieces = segments.map((segment) =>
    sliceFeatureSegment(sequence, segment.start, segment.end, circular)
  );
  if (pieces.some((piece) => piece == null)) return null;
  return pieces.join('');
}

function sliceFeatureSegment(
  sequence: string,
  start1: number,
  end1: number,
  circular: boolean
): string | null {
  const length = sequence.length;
  if (length === 0) return null;
  const start0 = start1 - 1;
  const end0 = end1 - 1;
  if (start0 < 0 || start0 >= length || end0 < 0 || end0 >= length) return null;
  if (start0 <= end0) return sequence.slice(start0, end0 + 1);
  if (!circular) return null;
  return sequence.slice(start0) + sequence.slice(0, end0 + 1);
}

function featureSegments(
  annotation: Annotation,
  sequenceLength: number,
  circular: boolean
): FeatureLocationSegment[] {
  const strand = annotation.direction === -1 ? -1 : 1;
  const start0 = Math.max(0, annotation.start - 1);
  const end0 = Math.max(0, annotation.end - 1);
  if (!circular || start0 <= end0) {
    return [{ start0, end0, strand }];
  }
  return [
    { start0, end0: sequenceLength - 1, strand },
    { start0: 0, end0, strand },
  ];
}
