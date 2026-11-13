import {
  resolveSequenceGeneticCode,
  type Annotation,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import { getCDSTranslation } from '@waypoint/workspace-editor';
import type { AnnotationDraft } from './types';

export interface OrfInput {
  start: number;
  end: number;
  strand: '+' | '-';
  frame: number;
  length: number;
}

export function buildOrfDraft(orf: OrfInput, sequence: AnnotatedSequence): AnnotationDraft | null {
  const startBio = orf.start + 1;
  const endBio = orf.end + 1;
  if (endBio < startBio) return null;

  const direction: 1 | -1 = orf.strand === '+' ? 1 : -1;
  const lengthBp = endBio - startBio + 1;

  const geneticCode = resolveSequenceGeneticCode(sequence).code;

  let translation: string | undefined;
  if (lengthBp % 3 === 0) {
    const tempCDS: Annotation = {
      name: '',
      type: 'CDS',
      start: startBio,
      end: endBio,
      direction,
    };
    translation = getCDSTranslation(tempCDS, sequence.sequence, geneticCode);
  }

  const qualifiers: Record<string, string[]> = {};
  if (translation && translation.length > 0) {
    qualifiers.translation = [translation];
    qualifiers.transl_table = [String(geneticCode)];
  }

  return {
    type: 'CDS',
    name: `ORF_frame${orf.frame}_${startBio}_${endBio}`,
    start: startBio,
    end: endBio,
    direction,
    ...(Object.keys(qualifiers).length > 0 ? { qualifiers } : {}),
  };
}
