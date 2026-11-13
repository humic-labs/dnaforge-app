import type {
  AnnotationRecord,
  PeakRecord,
  QuantitativeBin,
  RepeatRecord,
  TranscriptRecord,
  VariantRecord,
} from '@waypoint/genome-data';
import type { TileSource } from '@waypoint/genome-renderer';

export type UcscRenderableRecord =
  | AnnotationRecord
  | TranscriptRecord
  | PeakRecord
  | RepeatRecord
  | QuantitativeBin
  | VariantRecord;

export interface UcscTilePayload {
  readonly records: ReadonlyArray<UcscRenderableRecord>;
}

export interface UcscTileSource extends TileSource {
  readonly trackId: string;
  readonly source: import('@waypoint/genome-data').AdmittedTrackSource;
  readonly dispose?: () => void | Promise<void>;
}
