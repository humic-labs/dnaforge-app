export interface TrackViewSourceInput {
  source: { kind: 'path'; path: string } | { kind: 'url'; url: string };
  format: 'bigwig' | 'bigbed';
  label?: string;
  color?: string;
  heightPx?: number;
  visible?: boolean;
  range?: { min: number; max: number };
}

export type TrackViewCommand =
  | { operation: 'references' }
  | { operation: 'inspect'; project: string; path: string }
  | {
      operation: 'create';
      project: string;
      referenceId: string;
      requestId: string;
      name: string;
      path: string;
      viewport?: { chrom: string; start0: number; end0: number };
      tracks: TrackViewSourceInput[];
    };

export type TrackViewCommandResult =
  | {
      ok: true;
      operation: 'references';
      references: Array<{
        id: string;
        name: string;
        organism: string;
        chromosomes: Array<{ chrom: string; length: number }>;
        sequenceDataLayerTargets?: Array<{ chrom: string; targetDocumentId: string }>;
      }>;
    }
  | {
      ok: true;
      operation: 'create' | 'inspect';
      documentId: string;
      name: string;
      path: string;
      revision: string;
      referenceId: string;
      viewport: { start0: number; end0: number };
      tracks: Array<{
        trackId: string;
        label: string;
        visible: boolean;
        color: string;
        heightPx: number;
      }>;
      warning?: string;
    };
