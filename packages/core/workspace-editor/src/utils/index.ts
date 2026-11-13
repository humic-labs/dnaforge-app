export {
  parseHexColor,
  parseAnyColorToRgb,
  getDarkenedColor,
  getLightenedColor,
  getEmphasizedColor,
  getEmphasizedColorAny,
  getAnnotationDisplayColor,
  clearColorCache,
} from './color-utils';

export {
  isPositionDeleted,
  countDeletedBefore,
  getSortedDeletedRanges,
  effectiveToVisual,
  rangeOverlapsInsertions,
  clearRangeCache,
} from './range-utils';

export { getCharIndexOnLine, getCDSVisibleSegments } from './coordinate-mapper';

export type { CDSVisibleSegment } from './coordinate-mapper';
