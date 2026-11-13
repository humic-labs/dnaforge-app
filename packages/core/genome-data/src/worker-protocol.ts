import type {
  FeatureDetails,
  FeatureDetailsRequest,
  GenomeFeature,
  IndexedGenomeManifest,
  LocalIndexedGenomeDataSourceOptions,
  SearchHit,
  SearchOpts,
  ZoomLevel,
} from './types';

export type SerializableSearchOpts = Omit<SearchOpts, 'signal'>;

export type GenomeDataWorkerRequest =
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
      type: 'getFeatureDetails';
      request: FeatureDetailsRequest;
    }
  | {
      id: number;
      type: 'searchSequence';
      chrom: string;
      motif: string;
      opts?: SerializableSearchOpts;
    }
  | { id: number; type: 'cancel'; targetId: number };

export type GenomeDataWorkerResponse =
  | { id: number; type: 'result'; result: unknown }
  | { id: number; type: 'searchHit'; hit: SearchHit }
  | { id: number; type: 'error'; error: { name: string; message: string } };

export interface GenomeDataWorkerResults {
  getChromosomeLength: number;
  getSequence: string;
  getFeatures: GenomeFeature[];
  getFeatureDetails: FeatureDetails;
  searchSequence: SearchHit[];
}
