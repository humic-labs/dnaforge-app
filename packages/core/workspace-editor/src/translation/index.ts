export {
  getCodonsForSingleCDS,
  contiguousCodonRangeForLine,
  getCodonsForLine,
  getDraftCodonsForCDS,
  getDeletedCodons,
  getFrameshiftRanges,
  getAlignmentCodonsForCDS,
  computeAllAlignmentCodons,
  filterAlignmentCodonsForLine,
  getCachedSplicedSequence,
  resolveResidueIndex,
} from './codon-calculator';

export type { CodonInfo, DraftCodonInfo, AlignmentCodonInfo } from './codon-calculator';

export { buildSplicedCodingSequence, isSplicedCDS } from './spliced-coding-sequence';
export type { SplicedCodingSequence, IntronInfo } from './types';

export {
  getIntronLineSegments,
  getIntronLabel,
  getResidueNumberVisibility,
  INTRON_DASH_PATTERN,
  INTRON_STROKE_WIDTH,
  INTRON_OPACITY,
} from './intron-rendering';
export type { IntronLineSegment } from './intron-rendering';

export { getCDSTranslation, aminoAcidCreationBlockedReason } from './cds-translation';
export type { AminoAcidCreationBlockReason } from './cds-translation';
