import type { TrackTypeDefinition } from './types';
import { CYTOBAND_REQUIRED_TRACK_HEIGHT_PX } from './cytoband-vertical-layout';
import {
  TRACK_MANAGEMENT_HEADER_MIN_HEIGHT_PX,
  TRACK_MANAGEMENT_STACKED_CONTROL_MIN_HEIGHT_PX,
} from '../track-stack-layout-contract';

export const BUILTIN_TRACK_TYPES = {
  sequenceComposite: 'sequence-composite',
  primer: 'primer',
  orf: 'orf',
  cutSite: 'cut-site',
  cytoband: 'cytoband',
  importedTranscript: 'imported-transcript',
  genericInterval: 'generic-interval',
  peak: 'peak',
  repeat: 'repeat',
  quantitative: 'quantitative',
  chromatogram: 'chromatogram',
  pileup: 'pileup',
  variant: 'variant',
} as const;

export const SEQUENCE_COMPOSITE_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.sequenceComposite,
  family: 'reference',
  draw: 'sequence-band',
  dataShape: 'sequence',
  defaultSizing: { kind: 'fitContent', minHeight: 40 },
  defaultVisible: true,
  canShareScaleGroup: false,
  label: 'Sequence',
};

export const PRIMER_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.primer,
  family: 'plasmid',
  draw: 'feature-stack',
  dataShape: 'features',
  defaultSizing: { kind: 'fitContent', minHeight: 0 },
  defaultVisible: true,
  canShareScaleGroup: false,
  interactions: { hoverHighlight: true, clickSelects: true },
  label: 'Primers',
};

export const ORF_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.orf,
  family: 'plasmid',
  draw: 'feature-stack',
  dataShape: 'features',
  defaultSizing: { kind: 'fitContent', minHeight: 0 },
  defaultVisible: false,
  canShareScaleGroup: false,
  interactions: { hoverHighlight: true, clickSelects: true },
  label: 'ORFs',
};

export const CUT_SITE_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.cutSite,
  family: 'plasmid',
  draw: 'variant-marker',
  dataShape: 'features',
  defaultSizing: { kind: 'fitContent', minHeight: 0 },
  defaultVisible: false,
  canShareScaleGroup: false,
  interactions: { hoverHighlight: true, clickSelects: true, contextMenu: true },
  label: 'Cut sites',
};

export const CYTOBAND_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.cytoband,
  family: 'reference',
  draw: 'cytoband-strip',
  dataShape: 'features',
  defaultSizing: {
    kind: 'fixed',
    pixels: CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
    minHeight: CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
    maxHeight: 34,
  },
  defaultVisible: true,
  canShareScaleGroup: false,
  interactions: { hoverHighlight: true },
  label: 'Cytoband',
};

export const IMPORTED_TRANSCRIPT_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.importedTranscript,
  family: 'annotation',
  draw: 'transcript-stack',
  dataShape: 'transcripts',
  defaultSizing: {
    kind: 'fitContent',
    minHeight: TRACK_MANAGEMENT_HEADER_MIN_HEIGHT_PX,
    maxHeight: 256,
  },
  defaultVisible: true,
  interactions: { hoverHighlight: true, clickSelects: true, contextMenu: true },
  label: 'Transcript models',
};

export const GENERIC_INTERVAL_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.genericInterval,
  family: 'annotation',
  draw: 'feature-stack',
  dataShape: 'features',
  defaultSizing: {
    kind: 'fitContent',
    minHeight: TRACK_MANAGEMENT_STACKED_CONTROL_MIN_HEIGHT_PX,
    maxHeight: 192,
  },
  defaultVisible: true,
  interactions: { hoverHighlight: true, clickSelects: true, contextMenu: true },
  presentationControls: { colorOverride: true },
  label: 'Intervals',
};

export const PEAK_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.peak,
  family: 'annotation',
  draw: 'peak-stack',
  dataShape: 'peaks',
  defaultSizing: {
    kind: 'fixed',
    pixels: 72,
    minHeight: TRACK_MANAGEMENT_STACKED_CONTROL_MIN_HEIGHT_PX,
    maxHeight: 192,
  },
  defaultVisible: true,
  interactions: { hoverHighlight: true, clickSelects: true, contextMenu: true },
  presentationControls: { colorOverride: true },
  label: 'Peaks',
};

export const REPEAT_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.repeat,
  family: 'annotation',
  draw: 'repeat-stack',
  dataShape: 'repeats',
  defaultSizing: {
    kind: 'fitContent',
    minHeight: TRACK_MANAGEMENT_STACKED_CONTROL_MIN_HEIGHT_PX,
    maxHeight: 192,
  },
  defaultVisible: true,
  interactions: { hoverHighlight: true, clickSelects: true, contextMenu: true },
  presentationControls: { colorOverride: true },
  label: 'Repeats',
};

export const QUANTITATIVE_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.quantitative,
  family: 'quantitative',
  draw: 'histogram',
  dataShape: 'quantitative-bins',
  defaultSizing: { kind: 'fixed', pixels: 96, minHeight: 48, maxHeight: 256 },
  defaultVisible: true,
  canShareScaleGroup: true,
  interactions: { hoverHighlight: true, clickSelects: true },
  presentationControls: { colorOverride: true },
  label: 'Signal',
};

export const CHROMATOGRAM_TYPE = {
  type: BUILTIN_TRACK_TYPES.chromatogram,
  family: 'quantitative',
  draw: 'chromatogram',
  dataShape: 'chromatogram',
  defaultSizing: { kind: 'fixed', pixels: 138 },
  defaultVisible: true,
  canShareScaleGroup: false,
  interactions: { clickSelects: true, contextMenu: true },
  label: 'Chromatogram',
} satisfies TrackTypeDefinition;

export const PILEUP_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.pileup,
  family: 'pileup',
  draw: 'read-pileup',
  dataShape: 'reads',
  defaultSizing: { kind: 'fixed', pixels: 220, minHeight: 72 },
  defaultVisible: true,
  interactions: { hoverHighlight: true, clickSelects: true, contextMenu: true },
  presentationControls: { colorOverride: true },
  label: 'Read pileup',
};

export const VARIANT_TYPE: TrackTypeDefinition = {
  type: BUILTIN_TRACK_TYPES.variant,
  family: 'variant',
  draw: 'variant-marker',
  dataShape: 'variants',
  defaultSizing: {
    kind: 'fixed',
    pixels: TRACK_MANAGEMENT_STACKED_CONTROL_MIN_HEIGHT_PX,
    minHeight: TRACK_MANAGEMENT_STACKED_CONTROL_MIN_HEIGHT_PX,
    maxHeight: 96,
  },
  defaultVisible: true,
  interactions: { hoverHighlight: true, clickSelects: true, contextMenu: true },
  presentationControls: { colorOverride: true },
  label: 'Variants',
};

export const BUILTIN_TRACK_TYPE_DEFINITIONS: readonly TrackTypeDefinition[] = [
  CYTOBAND_TYPE,
  SEQUENCE_COMPOSITE_TYPE,
  PRIMER_TYPE,
  ORF_TYPE,
  CUT_SITE_TYPE,
  IMPORTED_TRANSCRIPT_TYPE,
  GENERIC_INTERVAL_TYPE,
  PEAK_TYPE,
  REPEAT_TYPE,
  QUANTITATIVE_TYPE,
  CHROMATOGRAM_TYPE,
  PILEUP_TYPE,
  VARIANT_TYPE,
];
