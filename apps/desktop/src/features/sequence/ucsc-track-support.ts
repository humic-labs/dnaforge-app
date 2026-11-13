import type { UcscCatalogLeaf } from '@waypoint/genome-data';

export type UcscCatalogTrackSupport =
  | {
      readonly supported: true;
      readonly path:
        | 'bigwig-quantitative'
        | 'bigbed-semantic'
        | 'native-table'
        | 'hub-reads'
        | 'hub-variants';
    }
  | { readonly supported: false; readonly reason: string };

export function classifyUcscCatalogTrackSupport(track: UcscCatalogLeaf): UcscCatalogTrackSupport {
  if (track.formatId === 'bigwig' && track.scientificKind === 'quantitative') {
    return { supported: true, path: 'bigwig-quantitative' };
  }
  if (
    track.sourceKind === 'ucsc-native' &&
    track.formatId === 'ucsc-native' &&
    (track.scientificKind === 'interval' ||
      track.scientificKind === 'transcript' ||
      track.scientificKind === 'peak' ||
      track.scientificKind === 'repeat')
  ) {
    return { supported: true, path: 'native-table' };
  }
  if (
    track.formatId === 'bigbed' &&
    (track.scientificKind === 'transcript' ||
      track.scientificKind === 'interval' ||
      track.scientificKind === 'peak' ||
      track.scientificKind === 'repeat')
  ) {
    return { supported: true, path: 'bigbed-semantic' };
  }
  if (track.scientificKind === 'reads') {
    if (track.sourceKind === 'ucsc-hub' && track.bigDataUrl) {
      return { supported: true, path: 'hub-reads' };
    }
    return {
      supported: false,
      reason:
        track.sourceKind === 'ucsc-hub'
          ? 'This hub read track publishes no indexed file to stream.'
          : 'Use Aligned reads so BAM and CRAM data follow the managed pileup workflow.',
    };
  }
  if (track.scientificKind === 'variants') {
    if (track.sourceKind === 'ucsc-hub' && track.bigDataUrl) {
      return { supported: true, path: 'hub-variants' };
    }
    return {
      supported: false,
      reason:
        track.sourceKind === 'ucsc-hub'
          ? 'This hub variant track publishes no indexed file to stream.'
          : 'Use Mutations so variant calls follow the managed mutation workflow.',
    };
  }
  if (track.formatId === 'bigbed') {
    return {
      supported: false,
      reason: 'This BigBed track has no supported scientific meaning.',
    };
  }
  if (track.scientificKind === 'interval') {
    return {
      supported: false,
      reason: 'Only native UCSC tables and BigBed files have a proven interval path.',
    };
  }
  return {
    supported: false,
    reason: 'This track does not have a proven reader and renderer yet.',
  };
}
