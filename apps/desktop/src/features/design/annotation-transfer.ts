import {
  normalizeRichSequenceFragment,
  type RichSequenceFragment,
} from '../sequence-clipboard/public/rich-sequence-clipboard';
import { isRestrictionDigestRegion } from './restriction-digest';
import type { DesignRegion } from './types';

export {
  buildCopiedRegionFromSelection,
  buildRichSequenceFragmentFromSelection,
  extractDesignAnnotationsForRange,
  type BuildRichSequenceFragmentInput as BuildCopiedRegionInput,
  type CopiedSequenceOrientation,
  type CopiedSequenceRange,
  type RichSequenceFragment as CopiedSequenceRegion,
} from '../sequence-clipboard/public/rich-sequence-clipboard';

export function buildCopiedRegionFromDesignRegion(region: DesignRegion): RichSequenceFragment {
  const restrictionDigest = isRestrictionDigestRegion(region);

  return normalizeRichSequenceFragment({
    sequence: region.sequence,
    ...(region.sourceSequence !== undefined ? { sourceSequence: region.sourceSequence } : {}),
    sourceId: region.sourceSequenceId,
    sourceName: region.sourceSequenceName,
    start: region.sourceStart,
    end: region.sourceEnd,
    annotations: region.annotations,
    ...(region.sourceAnnotations !== undefined
      ? { sourceAnnotations: region.sourceAnnotations }
      : {}),
    ...(region.sourceIsCircular !== undefined ? { sourceIsCircular: region.sourceIsCircular } : {}),
    sourceType: restrictionDigest ? 'rd' : 'pcr',
    ...(restrictionDigest && region.ggType !== undefined ? { ggType: region.ggType } : {}),
    ...(restrictionDigest && region.rdOverhangs !== undefined
      ? { rdOverhangs: region.rdOverhangs }
      : {}),
    ...(restrictionDigest && region.rdSourceEnzyme !== undefined
      ? { rdSourceEnzyme: region.rdSourceEnzyme }
      : {}),
    ...(restrictionDigest && region.rdSourceEnzymeName !== undefined
      ? { rdSourceEnzymeName: region.rdSourceEnzymeName }
      : {}),
    ...(restrictionDigest && region.rdEnds !== undefined ? { rdEnds: region.rdEnds } : {}),
    ...(restrictionDigest && region.rdSiblingOverhangs !== undefined
      ? { rdSiblingOverhangs: region.rdSiblingOverhangs }
      : {}),
  });
}
