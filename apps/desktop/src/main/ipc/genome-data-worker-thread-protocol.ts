import type {
  FeatureDetails,
  FeatureDetailsRequest,
  GenomeFeature,
  IndexedGenomeManifest,
  LocalIndexedGenomeDataSourceOptions,
  SearchHit,
  SearchOpts,
  ZoomLevel,
} from '@waypoint/genome-data';
import type { OverviewAnnotationTilePayload } from './genome-overview-tile-cache';
import type { ViewportAnnotationTilePayload } from './genome-viewport-tile-builder';

export type GenomeDataThreadSearchOpts = Omit<SearchOpts, 'signal'>;

export type GenomeDataThreadRequest =
  | {
      id: number;
      type: 'init';
      manifest: IndexedGenomeManifest;
      options?: LocalIndexedGenomeDataSourceOptions;
    }
  | { id: number; type: 'getChromosomeLength'; chrom: string }
  | { id: number; type: 'getSequence'; chrom: string; start: number; end: number }
  | {
      id: number;
      type: 'getFeatures';
      chrom: string;
      start: number;
      end: number;
      zoomLevel: ZoomLevel;
    }
  | {
      id: number;
      type: 'buildAnnotationOverview';
      chrom: string;
      start: number;
      end: number;
      zoomLevel: ZoomLevel;
    }
  | {
      id: number;
      type: 'buildAnnotationViewportTile';
      chrom: string;
      start: number;
      end: number;
      zoomLevel: ZoomLevel;
      rescuedParentIds?: ReadonlyArray<string>;
    }
  | {
      id: number;
      type: 'getFeatureDetails';
      request: FeatureDetailsRequest;
    }
  | {
      id: number;
      type: 'searchSequence';
      chrom: string;
      motif: string;
      opts?: GenomeDataThreadSearchOpts;
    }
  | { id: number; type: 'cancel'; targetId: number };

export type GenomeDataThreadResponse =
  | { id: number; type: 'result'; result: unknown }
  | { id: number; type: 'searchHit'; hit: SearchHit }
  | { id: number; type: 'error'; error: { name: string; message: string } };

export interface GenomeDataThreadResults {
  getChromosomeLength: number;
  getSequence: string;
  getFeatures: GenomeFeature[];
  buildAnnotationOverview: OverviewAnnotationTilePayload;
  buildAnnotationViewportTile: ViewportAnnotationTilePayload;
  getFeatureDetails: FeatureDetails;
  searchSequence: SearchHit[];
}
