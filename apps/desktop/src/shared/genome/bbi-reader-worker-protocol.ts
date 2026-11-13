export interface BbiRangeGrant {
  readonly baseUrl: string;
  readonly sourceUri: string;
  readonly sourceToken: string;
  readonly canonicalUrlHash: string;
  readonly byteLength: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly provenanceId: string;
  readonly expiresAtMs: number;
  readonly directRangeUrl?: string;
  readonly maxRangeBytes?: number;
}

export interface BbiReferenceInfo {
  readonly name: string;
  readonly length: number;
}

export interface BbiHeaderSummary {
  readonly fileType: 'bigwig' | 'bigbed';
  readonly references: ReadonlyArray<BbiReferenceInfo>;
  readonly zoomReductionLevels: ReadonlyArray<number>;
  readonly autoSql?: string;
  readonly fieldCount?: number;
  readonly totalSummary?: {
    readonly basesCovered: number;
    readonly scoreMin: number;
    readonly scoreMax: number;
  };
}

export interface BbiQueryRegion {
  readonly refName: string;
  readonly start: number;
  readonly end: number;
}

export interface BbiQuantitativeRegion {
  readonly starts: Int32Array;
  readonly ends: Int32Array;
  readonly values: Float32Array;
}

export interface BbiIntervalFeature {
  readonly start: number;
  readonly end: number;
  readonly score?: number;
  readonly rest?: string;
  readonly uniqueId?: string;
}

export type BbiReaderWorkerRequest =
  | {
      readonly id: number;
      readonly type: 'open';
      readonly sourceKey: string;
      readonly format: 'bigwig' | 'bigbed';
      readonly grant: BbiRangeGrant;
    }
  | {
      readonly id: number;
      readonly type: 'query-quantitative';
      readonly sourceKey: string;
      readonly regions: ReadonlyArray<BbiQueryRegion>;
      readonly basesPerSpan: number;
    }
  | {
      readonly id: number;
      readonly type: 'query-intervals';
      readonly sourceKey: string;
      readonly regions: ReadonlyArray<BbiQueryRegion>;
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

export type BbiReaderWorkerResponse =
  | {
      readonly id: number;
      readonly type: 'result';
      readonly result:
        | BbiHeaderSummary
        | ReadonlyArray<BbiQuantitativeRegion>
        | ReadonlyArray<ReadonlyArray<BbiIntervalFeature>>
        | true;
    }
  | {
      readonly id: number;
      readonly type: 'error';
      readonly error: { readonly name: string; readonly message: string };
    };

export interface BbiReaderWorkerLike {
  postMessage(message: BbiReaderWorkerRequest): void;
  addEventListener(
    type: 'message',
    listener: (event: Readonly<{ data: BbiReaderWorkerResponse }>) => void
  ): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(
    type: 'message',
    listener: (event: Readonly<{ data: BbiReaderWorkerResponse }>) => void
  ): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate?(): void;
}
