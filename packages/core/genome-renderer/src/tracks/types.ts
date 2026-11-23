import type {
  QuantitativeSourceSummaryV1,
  QuantitativeTrackPresentationV1,
  TrackSource,
} from '@waypoint/genome-data';

export type TrackType = string;

export type TrackFamily =
  | 'reference'
  | 'annotation'
  | 'quantitative'
  | 'pileup'
  | 'variant'
  | 'interaction'
  | 'plasmid';

export type TrackDrawPolicy =
  | 'sequence-band'
  | 'ruler-band'
  | 'feature-stack'
  | 'transcript-stack'
  | 'peak-stack'
  | 'repeat-stack'
  | 'chromatogram'
  | 'histogram'
  | 'read-pileup'
  | 'variant-marker'
  | 'arc-link'
  | 'cytoband-strip';

export type TrackDataShape =
  | 'sequence'
  | 'features'
  | 'transcripts'
  | 'peaks'
  | 'repeats'
  | 'reads'
  | 'chromatogram'
  | 'quantitative-bins'
  | 'variants'
  | 'interactions';

export type TrackSizingProfile =
  | {
      kind: 'fixed';
      pixels: number;
      minHeight?: number;
      maxHeight?: number;
    }
  | {
      kind: 'fitContent';
      minHeight?: number;
      maxHeight?: number;
    }
  | {
      kind: 'flex';
      share?: number;
      minHeight?: number;
      maxHeight?: number;
    };

export interface TrackPresentationMetadata {
  sizing?: TrackSizingProfile;
  color?: string;
  rowHeightPx?: number;
  maxRows?: number;
  quantitative?: QuantitativeTrackPresentationV1;
  quantitativeSourceSummary?: QuantitativeSourceSummaryV1;
}

export interface TrackPresentationDrag {
  readonly trackId: string;
  readonly topPx: number;
}

export interface Track extends TrackPresentationMetadata {
  id: string;
  type: TrackType;
  order: number;
  visible: boolean;
  assemblyId: string;
  subGroups?: Record<string, string>;
  source?: TrackSource;
  label?: string;
  zone?: 'above-legacy' | 'below-legacy';
}

export type { TrackSource } from '@waypoint/genome-data';

export interface TrackInteractionSpec {
  hoverHighlight?: boolean;
  clickSelects?: boolean;
  contextMenu?: boolean;
}

export interface TrackPresentationControls {
  colorOverride?: boolean;
}

export interface TrackTypeDefinition {
  type: TrackType;
  family: TrackFamily;
  draw: TrackDrawPolicy;
  dataShape: TrackDataShape;
  defaultSizing: TrackSizingProfile;
  defaultColor?: string;
  canShareScaleGroup?: boolean;
  interactions?: TrackInteractionSpec;
  presentationControls?: TrackPresentationControls;
  defaultVisible?: boolean;
  label?: string;
}

export interface TrackTypeRegistry {
  registerTrackType(definition: TrackTypeDefinition): void;
  getTrackTypeDefinition(type: TrackType): TrackTypeDefinition | undefined;
  listTrackTypeDefinitions(): ReadonlyArray<TrackTypeDefinition>;
}

export interface TrackLayoutEntry {
  id: string;
  top: number;
  height: number;
  contentClipped: boolean;
  hidden: boolean;
}

export type TrackLayout = ReadonlyArray<TrackLayoutEntry>;

export type TrackContentHeightResolver = (track: Track) => number;

export interface ComputeTracksLayoutOptions {
  availableHeight: number;
  overflow?: 'shrink' | 'scroll';
}

export class TrackLayoutInputError extends Error {
  public override readonly name = 'TrackLayoutInputError';
  constructor(
    message: string,
    public readonly cause: 'duplicate-id' | 'unknown-track-type'
  ) {
    super(message);
  }
}
