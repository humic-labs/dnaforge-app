import {
  projectCodingSequence,
  type RecordGeneticCodeBasis,
  reverseComplement,
  STANDARD_GENETIC_CODE_ID,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';
import type { Annotation } from '@waypoint/sequence-utils';

import type { SplicedCodingSequence, IntronInfo } from './types';

export { isSplicedCDS } from '@waypoint/sequence-utils';

export function buildSplicedCodingSequence(
  cds: Annotation,
  fullSequence: string,
  sequenceGeneticCode: GeneticCodeSpec = STANDARD_GENETIC_CODE_ID,
  geneticCodeBasis?: RecordGeneticCodeBasis
): SplicedCodingSequence {
  const projection = projectCodingSequence(cds, fullSequence, {
    sequenceGeneticCode,
    geneticCodeBasis,
  });
  const { segments, spliced, codingSequence: codingBases, codonStartOffset } = projection;
  const isReverse = cds.direction === -1;
  const seqLen = fullSequence.length;

  const introns: IntronInfo[] = [];
  const totalCodingBases = codingBases.length;
  if (spliced && segments.length > 1) {
    let cumulativeExonBases = 0;

    for (let i = 0; i < segments.length - 1; i++) {
      const currentSegEnd = segments[i].end;
      const nextSegStart = segments[i + 1].start;

      const exonLength =
        segments[i].end >= segments[i].start
          ? segments[i].end - segments[i].start + 1
          : seqLen - segments[i].start + 1 + segments[i].end;
      cumulativeExonBases += exonLength;

      const genomicStart = currentSegEnd;
      const genomicEnd = nextSegStart - 2;

      const crossesOrigin = cds.start > cds.end && nextSegStart < segments[i].start;
      const junctionGap = crossesOrigin
        ? seqLen - currentSegEnd + nextSegStart - 1
        : nextSegStart - currentSegEnd - 1;
      if (junctionGap <= 1) continue;

      const intronLength =
        genomicEnd >= genomicStart
          ? genomicEnd - genomicStart + 1
          : seqLen - genomicStart + genomicEnd + 1;

      const effectiveExonBases = isReverse
        ? totalCodingBases - cumulativeExonBases
        : cumulativeExonBases;
      const phase = (effectiveExonBases - codonStartOffset + 300) % 3;

      let donorSite: string;
      let acceptorSite: string;

      if (isReverse) {
        const lastTwo = fullSequence.slice(genomicEnd - 1, genomicEnd + 1);
        const firstTwo = fullSequence.slice(genomicStart, genomicStart + 2);
        donorSite = reverseComplement(lastTwo);
        acceptorSite = reverseComplement(firstTwo);
      } else {
        donorSite = fullSequence.slice(genomicStart, genomicStart + 2);
        acceptorSite = fullSequence.slice(genomicEnd - 1, genomicEnd + 1);
      }

      const codingSeqBoundary = isReverse
        ? totalCodingBases - cumulativeExonBases
        : cumulativeExonBases;

      introns.push({
        number: i + 1,
        genomicStart,
        genomicEnd,
        length: intronLength,
        phase,
        donorSite: donorSite.toUpperCase(),
        acceptorSite: acceptorSite.toUpperCase(),
        codingSeqBoundary,
      });
    }
  }

  return { ...projection, introns };
}
