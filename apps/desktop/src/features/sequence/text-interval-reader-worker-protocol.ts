import type {
  TextIntervalQueryOptions,
  TextIntervalQueryRegion,
  TextIntervalReferenceExtent,
  TextIntervalRegionQueryResult,
  TextIntervalScientificKind,
  TextIntervalTrackFormatId,
} from '@waypoint/genome-data';

export interface TextIntervalHeaderSummary {
  readonly formatId: TextIntervalTrackFormatId;
  readonly scientificKind: TextIntervalScientificKind;
  readonly referenceExtents: ReadonlyArray<TextIntervalReferenceExtent>;
  readonly recordCount: number;
  readonly sourceByteLength: number;
  readonly decodedByteLength: number;
  readonly contentSha256: string;
}

export type TextIntervalReaderWorkerRequest =
  | {
      readonly id: number;
      readonly type: 'open';
      readonly sourceKey: string;
      readonly formatId: TextIntervalTrackFormatId;
      readonly scientificKind?: TextIntervalScientificKind;
      readonly bytes: Uint8Array;
    }
  | {
      readonly id: number;
      readonly type: 'query';
      readonly sourceKey: string;
      readonly regions: ReadonlyArray<TextIntervalQueryRegion>;
      readonly options: TextIntervalQueryOptions;
    }
  | {
      readonly id: number;
      readonly type: 'close';
      readonly sourceKey: string;
    }
  | {
      readonly id: number;
      readonly type: 'cancel';
      readonly targetId: number;
    };

export type TextIntervalReaderWorkerResponse =
  | {
      readonly id: number;
      readonly type: 'result';
      readonly result:
        | TextIntervalHeaderSummary
        | ReadonlyArray<TextIntervalRegionQueryResult>
        | true;
    }
  | {
      readonly id: number;
      readonly type: 'error';
      readonly error: { readonly name: string; readonly message: string };
    };

export interface TextIntervalReaderWorkerLike {
  postMessage(
    message: TextIntervalReaderWorkerRequest,
    transfer?: ReadonlyArray<Transferable>
  ): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<TextIntervalReaderWorkerResponse>) => void
  ): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<TextIntervalReaderWorkerResponse>) => void
  ): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate?(): void;
}
