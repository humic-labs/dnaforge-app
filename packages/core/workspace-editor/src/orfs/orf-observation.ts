export type OrfComputeSource = 'cache' | 'worker' | 'fallback';

export type OrfFailure = 'detector_error' | 'worker_error';

export type OrfRetirement =
  | 'superseded'
  | 'retry'
  | 'view_hidden'
  | 'detector_cancelled'
  | 'unmounted';

export type OrfQualifiedPaint = Readonly<{
  kind: 'empty_model' | 'orf_drawn';
  surface: 'sequence_canvas' | 'sequence_tracks' | 'plasmid_map';
}>;

export interface OrfPresentation {
  presented(fact: OrfQualifiedPaint): void;
  retire(reason: OrfRetirement): void;
}

export function reportOrfPaint(
  presented: OrfPresentation['presented'] | undefined,
  emptyModel: boolean,
  orfsDrawn: boolean,
  surface: OrfQualifiedPaint['surface']
): void {
  if (!presented || (!emptyModel && !orfsDrawn)) return;
  try {
    presented({ kind: emptyModel ? 'empty_model' : 'orf_drawn', surface });
  } catch {}
}

export interface OrfDetectionObservation {
  detected(resultCount: number): OrfPresentation | void;
  failed(reason: OrfFailure): void;
  retire(reason: OrfRetirement): void;
}

export type ObserveOrfDetection = (
  input: Readonly<{
    source: OrfComputeSource;
    sequenceLength: number;
  }>
) => OrfDetectionObservation | undefined;

export interface OrfObservationOptions {
  observeDetection?: ObserveOrfDetection;
  observationVisible: boolean;
}
