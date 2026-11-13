import {
  parseGenBankFull,
  isGenBankFormat as _isGenBankFormat,
  GenBankParseError as _GenBankParseError,
  reverseComplement as sharedReverseComplement,
  type Annotation,
} from '@waypoint/sequence-utils';

import type {
  ParsedPlasmid,
  PlasmidFeature,
  FeatureQualifiers,
  FeatureDirection,
  Primer,
  OligoMismatch,
} from './types';
import { getFeatureColor } from './types';
import { calculateTm, calculateGC, generatePrimerId } from './primer-calculations';

export const GenBankParseError = _GenBankParseError;
export const isGenBankFormat = _isGenBankFormat;

const PRIMER_FEATURE_TYPES = ['primer_bind', 'primer'];

function extractOligoSequenceFromNote(note: string | undefined): string | null {
  if (!note) return null;
  const match = note.match(/sequence:\s*([ACGTacgt]+)/i);
  return match ? match[1] : null;
}

const reverseComplement = sharedReverseComplement;

interface PrimerLocation {
  readonly start: number;
  readonly end: number;
  readonly complement: boolean;
  readonly segments?: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

function templateRegionForPrimer(templateSequence: string, location: PrimerLocation): string {
  const start = location.start - 1;
  const end = location.end;
  if (start <= end) return templateSequence.substring(start, end);
  if (location.segments && location.segments.length > 1) {
    return location.segments
      .map((segment) => templateSequence.substring(segment.start - 1, segment.end))
      .join('');
  }
  return templateSequence.substring(start) + templateSequence.substring(0, end);
}

function detectMismatches(
  oligoSequence: string,
  templateSequence: string,
  location: PrimerLocation,
  direction: 'forward' | 'reverse'
): OligoMismatch[] {
  const mismatches: OligoMismatch[] = [];
  let templateRegion = templateRegionForPrimer(templateSequence, location);
  if (direction === 'reverse') {
    templateRegion = reverseComplement(templateRegion);
  }
  const compareLen = Math.min(oligoSequence.length, templateRegion.length);
  for (let i = 0; i < compareLen; i++) {
    if (oligoSequence[i].toUpperCase() !== templateRegion[i].toUpperCase()) {
      mismatches.push({
        position: i,
        oligoBase: oligoSequence[i],
        templateBase: templateRegion[i],
      });
    }
  }
  return mismatches;
}

export function parseGenBank(content: string): ParsedPlasmid {
  const parsed = parseGenBankFull(content);
  const { features, primers } = convertAnnotations(parsed.annotations, parsed.sequence);

  return {
    name: parsed.name,
    length: parsed.length,
    circular: parsed.circular ?? false,
    sequence: parsed.sequence,
    features,
    primers,
    definition: parsed.description,
  };
}

function convertAnnotations(
  annotations: readonly Annotation[],
  templateSequence: string
): { features: PlasmidFeature[]; primers: Primer[] } {
  const features: PlasmidFeature[] = [];
  const primers: Primer[] = [];
  for (const annotation of annotations) {
    const qualifiers = annotation.qualifiers ?? {};
    if (PRIMER_FEATURE_TYPES.includes(annotation.type)) {
      const primer = finalizePrimer(
        qualifiers,
        {
          start: annotation.start,
          end: annotation.end,
          complement: annotation.direction === -1,
          segments: annotation.segments,
        },
        templateSequence
      );
      if (primer) primers.push(primer);
      continue;
    }

    const direction: FeatureDirection =
      annotation.direction === 1 ? 'forward' : annotation.direction === -1 ? 'reverse' : 'none';
    features.push({
      type: annotation.type,
      start: annotation.start,
      end: annotation.end,
      direction,
      qualifiers,
      displayName: annotation.name,
      color: annotation.color ?? getFeatureColor(annotation.type),
      ...(annotation.segments ? { segments: annotation.segments } : {}),
    });
  }

  return { features, primers };
}

function finalizePrimer(
  qualifiers: FeatureQualifiers,
  location: PrimerLocation,
  templateSequence: string
): Primer | null {
  const direction: 'forward' | 'reverse' = location.complement ? 'reverse' : 'forward';
  const start = location.start - 1;
  const end = location.end;

  const explicitSequence = extractOligoSequenceFromNote(qualifiers.note?.[0]);
  let bases: string;
  let mismatches: OligoMismatch[] = [];
  let hasExplicitSequence = false;

  if (explicitSequence) {
    bases = explicitSequence;
    hasExplicitSequence = true;
    mismatches = detectMismatches(bases, templateSequence, location, direction);
  } else {
    if (templateSequence && start >= 0 && end <= templateSequence.length) {
      bases = templateRegionForPrimer(templateSequence, location);
      if (direction === 'reverse') bases = reverseComplement(bases);
    } else {
      bases = '';
    }
  }

  if (!bases) return null;

  let name = qualifiers.label?.[0] || qualifiers.gene?.[0] || qualifiers.product?.[0] || '';
  if (!name && qualifiers.note?.[0]) {
    const noteBeforeSeq = qualifiers.note[0].split(/sequence:/i)[0].trim();
    name = noteBeforeSeq || 'Primer';
  }
  if (!name) name = 'Primer';

  return {
    id: generatePrimerId(),
    name,
    start,
    end,
    direction,
    bases,
    tm: calculateTm(bases.toUpperCase()),
    gc: calculateGC(bases.toUpperCase()),
    mismatches,
    hasExplicitSequence,
  };
}
