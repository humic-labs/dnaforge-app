import { annotationCanonicalIdentityV2 } from './geometry/annotation-canonical-identity-v2';
import type {
  AnnotationPresentationPage,
  AnnotationResidentPagePublication,
  Feature,
} from './types';

const DEFAULT_MAX_RESIDENT_PAGES = 256;
const DEFAULT_MAX_RESIDENT_BYTES = 128 * 1024 * 1024;
const MAX_ACTIVE_POLICY_STREAMS = 2;
const PAGE_FIXED_BYTES = 8 * 8;
const FEATURE_FIXED_BYTES = 96;
const SPAN_FIXED_BYTES = 16;

export type AnnotationResidentPageStoreRejectionReason =
  | 'invalid-snapshot'
  | 'source-mismatch'
  | 'length-mismatch'
  | 'stale-generation'
  | 'generation-collision'
  | 'invalid-page'
  | 'duplicate-page-key'
  | 'page-key-collision'
  | 'content-revision-collision'
  | 'overlapping-owner-ranges'
  | 'duplicate-feature-ownership';

export interface AnnotationResidentPageIdentity {
  readonly sourceIdentity: string;
  readonly policyKey: string;
  readonly pageKey: string;
  readonly contentRevision: string;
}

export interface AnnotationResidentPageRecord extends AnnotationResidentPageIdentity {
  readonly identityKey: string;
  readonly logicalKey: string;
  readonly byteSize: number;
  readonly page: AnnotationPresentationPage;
  readonly canonicalFeatureIdentities: ReadonlyArray<string>;
}

export type AnnotationResidentPageStoreApplyResult =
  | {
      readonly status: 'applied';
      readonly sourceIdentity: string;
      readonly policyKey: string;
      readonly generation: number;
      readonly built: number;
      readonly reused: number;
      readonly evicted: number;
    }
  | {
      readonly status: 'noop';
      readonly sourceIdentity: string;
      readonly policyKey: string;
      readonly generation: number;
      readonly reused: number;
      readonly evicted: number;
    }
  | {
      readonly status: 'rejected';
      readonly reason: AnnotationResidentPageStoreRejectionReason;
    };

export interface AnnotationResidentPageSelection {
  readonly status: 'ready' | 'incomplete' | 'rejected';
  readonly reason: 'source-mismatch' | 'policy-mismatch' | null;
  readonly sourceIdentity: string;
  readonly policyKey: string;
  readonly viewStartBp: number;
  readonly viewEndBp: number;
  readonly expectedPageIdentities: ReadonlyArray<string>;
  readonly records: ReadonlyArray<AnnotationResidentPageRecord>;
  readonly missingPageIdentities: ReadonlyArray<string>;
  readonly coverageComplete: boolean;
  readonly producerCoverageComplete: boolean;
}

export type AnnotationResidentPageStoreTelemetryEvent = Readonly<{
  type: 'build' | 'reuse' | 'eviction' | 'reject' | 'select';
  cause: string;
  sourceIdentity: string | null;
  policyKey: string | null;
  pageKey: string | null;
  contentRevision: string | null;
  identityKey: string | null;
  byteSize: number;
  durationMs: number;
  residentPageCount: number;
  residentByteCount: number;
}>;

export interface AnnotationResidentPageStoreOptions {
  readonly sourceIdentity: string;
  readonly genomeLengthBp: number;
  readonly maxResidentPages?: number;
  readonly maxResidentBytes?: number;
  readonly telemetryLimit?: number;
  readonly now?: () => number;
}

interface StreamState {
  generation: number;
  snapshot: AnnotationResidentPagePublication;
  requestedLayerTypes: readonly string[];
  exactCoverage: readonly Readonly<{ startBp: number; endBp: number }>[];
  activePages: Map<string, ActivePageReference>;
}

interface ActivePageReference extends AnnotationResidentPageIdentity {
  identityKey: string;
  logicalKey: string;
  chromosomeId: string;
  trackId: string;
  trackOrder: number;
  laneCapacity: number;
  ownerStartBp: number;
  ownerEndBp: number;
  maxFeatureEndBp: number;
  canonicalFeatureIdentities: ReadonlyArray<string>;
}

interface ResidentState {
  record: AnnotationResidentPageRecord;
  lastUsed: number;
}

interface ValidatedPage {
  record: AnnotationResidentPageRecord;
  reference: ActivePageReference;
  stageDurationMs: number;
}

type StagedPageData = Omit<ValidatedPage, 'stageDurationMs'>;

export class AnnotationResidentPageStore {
  readonly sourceIdentity: string;
  readonly genomeLengthBp: number;
  readonly maxResidentPages: number;
  readonly maxResidentBytes: number;

  private readonly now: () => number;
  private readonly telemetryLimit: number;
  private readonly streams = new Map<string, StreamState>();
  private readonly residents = new Map<string, ResidentState>();
  private readonly logicalMetadata = new Map<
    string,
    Readonly<{
      chromosomeId: string;
      trackId: string;
      trackOrder: number;
      laneCapacity: number;
      ownerStartBp: number;
      ownerEndBp: number;
    }>
  >();
  private readonly visiblePins = new Set<string>();
  private readonly selectedPins = new Set<string>();
  private readonly telemetry: AnnotationResidentPageStoreTelemetryEvent[] = [];
  private residentBytes = 0;
  private clock = 0;

  constructor(options: AnnotationResidentPageStoreOptions) {
    if (typeof options.sourceIdentity !== 'string' || options.sourceIdentity.trim().length === 0) {
      throw new Error('annotation resident page store requires a source identity');
    }
    if (!Number.isSafeInteger(options.genomeLengthBp) || options.genomeLengthBp <= 0) {
      throw new Error('annotation resident page store requires a positive safe genome length');
    }
    const maxPages = options.maxResidentPages ?? DEFAULT_MAX_RESIDENT_PAGES;
    const maxBytes = options.maxResidentBytes ?? DEFAULT_MAX_RESIDENT_BYTES;
    const telemetryLimit = options.telemetryLimit ?? 512;
    if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
      throw new Error('annotation resident page store requires a positive page budget');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('annotation resident page store requires a positive byte budget');
    }
    if (!Number.isSafeInteger(telemetryLimit) || telemetryLimit < 0) {
      throw new Error(
        'annotation resident page store telemetry limit must be a non-negative integer'
      );
    }
    this.sourceIdentity = options.sourceIdentity;
    this.genomeLengthBp = options.genomeLengthBp;
    this.maxResidentPages = maxPages;
    this.maxResidentBytes = maxBytes;
    this.telemetryLimit = telemetryLimit;
    this.now =
      options.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
  }

  get residentPageCount(): number {
    return this.residents.size;
  }

  get residentByteCount(): number {
    return this.residentBytes;
  }

  getTelemetry(): ReadonlyArray<AnnotationResidentPageStoreTelemetryEvent> {
    return [...this.telemetry];
  }

  clearTelemetry(): void {
    this.telemetry.length = 0;
  }

  static identityKey(identity: AnnotationResidentPageIdentity): string {
    return framedKey([
      identity.sourceIdentity,
      identity.policyKey,
      identity.pageKey,
      identity.contentRevision,
    ]);
  }

  static logicalKey(identity: Omit<AnnotationResidentPageIdentity, 'contentRevision'>): string {
    return framedKey([identity.sourceIdentity, identity.policyKey, identity.pageKey]);
  }

  applyPublication(
    publication: AnnotationResidentPagePublication
  ): AnnotationResidentPageStoreApplyResult {
    return this.applyPagePublication(publication);
  }

  private applyPagePublication(
    snapshot: AnnotationResidentPagePublication
  ): AnnotationResidentPageStoreApplyResult {
    const startedAt = this.now();
    const reject = (
      reason: AnnotationResidentPageStoreRejectionReason,
      page?: Partial<AnnotationPresentationPage>
    ): AnnotationResidentPageStoreApplyResult => {
      this.recordTelemetry({
        type: 'reject',
        cause: reason,
        sourceIdentity:
          isRecord(snapshot) && typeof snapshot.sourceIdentity === 'string'
            ? snapshot.sourceIdentity
            : null,
        policyKey:
          isRecord(snapshot) && typeof snapshot.policyKey === 'string' ? snapshot.policyKey : null,
        pageKey: typeof page?.pageKey === 'string' ? page.pageKey : null,
        contentRevision: typeof page?.contentRevision === 'string' ? page.contentRevision : null,
        identityKey: null,
        byteSize: 0,
        durationMs: this.now() - startedAt,
      });
      return { status: 'rejected', reason };
    };

    if (!validSnapshotEnvelope(snapshot)) return reject('invalid-snapshot');
    if (snapshot.sourceIdentity !== this.sourceIdentity) return reject('source-mismatch');
    if (snapshot.genomeLengthBp !== this.genomeLengthBp) return reject('length-mismatch');

    const stream = this.streams.get(snapshot.policyKey);
    if (stream) {
      if (snapshot.generation < stream.generation) return reject('stale-generation');
      if (snapshot.generation === stream.generation && snapshot !== stream.snapshot) {
        return reject('generation-collision');
      }
    }

    const seenPageKeys = new Set<string>();
    const requestedTrackIds = new Set(snapshot.requestedLayerTypes);
    if (
      snapshot.contract === 'annotation-codon-carrier-page-publication.v1' &&
      requestedTrackIds.size !== snapshot.requestedLayerTypes.length
    ) {
      return reject('invalid-snapshot');
    }
    const staged: ValidatedPage[] = [];
    for (const page of snapshot.pages) {
      const pageStartedAt = this.now();
      if (!validPageEnvelope(page, this.genomeLengthBp)) return reject('invalid-page', page);
      if (
        snapshot.contract === 'annotation-codon-carrier-page-publication.v1' &&
        !requestedTrackIds.has(page.trackId)
      ) {
        return reject('invalid-page', page);
      }
      if (seenPageKeys.has(page.pageKey)) return reject('duplicate-page-key', page);
      seenPageKeys.add(page.pageKey);
      const validated = this.stagePage(snapshot, page);
      if ('reason' in validated) return reject(validated.reason, page);
      staged.push({ ...validated, stageDurationMs: this.now() - pageStartedAt });
    }

    const nextActive = new Map(stream?.activePages ?? []);
    for (const { reference } of staged) nextActive.set(reference.pageKey, reference);
    const crossPageError = validateActivePageSet(nextActive);
    if (crossPageError) return reject(crossPageError);

    let built = 0;
    let reused = 0;
    for (const { record, reference, stageDurationMs } of staged) {
      const existing = this.residents.get(record.identityKey);
      if (existing) {
        existing.lastUsed = ++this.clock;
        reused += 1;
        this.recordPageTelemetry('reuse', 'snapshot-upsert', existing.record, 0);
      } else {
        this.residents.set(record.identityKey, { record, lastUsed: ++this.clock });
        this.residentBytes += record.byteSize;
        built += 1;
        this.recordPageTelemetry('build', 'snapshot-upsert', record, stageDurationMs);
      }
      this.logicalMetadata.set(reference.logicalKey, {
        chromosomeId: reference.chromosomeId,
        trackId: reference.trackId,
        trackOrder: reference.trackOrder,
        laneCapacity: reference.laneCapacity,
        ownerStartBp: reference.ownerStartBp,
        ownerEndBp: reference.ownerEndBp,
      });
    }

    const nextStream: StreamState = {
      generation: snapshot.generation,
      snapshot,
      requestedLayerTypes: Object.freeze([...snapshot.requestedLayerTypes]),
      exactCoverage: Object.freeze(
        snapshot.exactCoverage.map((range) => Object.freeze({ ...range }))
      ),
      activePages: nextActive,
    };
    this.streams.set(snapshot.policyKey, nextStream);
    while (this.streams.size > MAX_ACTIVE_POLICY_STREAMS) {
      const obsolete = [...this.streams.keys()].find((key) => key !== snapshot.policyKey);
      if (obsolete === undefined) break;
      this.streams.delete(obsolete);
    }
    const evicted = this.enforceBudget('snapshot-upsert');
    if (stream && snapshot === stream.snapshot && built === 0) {
      return {
        status: 'noop',
        sourceIdentity: snapshot.sourceIdentity,
        policyKey: snapshot.policyKey,
        generation: snapshot.generation,
        reused,
        evicted,
      };
    }
    return {
      status: 'applied',
      sourceIdentity: snapshot.sourceIdentity,
      policyKey: snapshot.policyKey,
      generation: snapshot.generation,
      built,
      reused,
      evicted,
    };
  }

  getRecord(identityKey: string): AnnotationResidentPageRecord | null {
    const state = this.residents.get(identityKey);
    if (!state) return null;
    state.lastUsed = ++this.clock;
    return state.record;
  }

  getActiveRecord(policyKey: string, pageKey: string): AnnotationResidentPageRecord | null {
    const ref = this.streams.get(policyKey)?.activePages.get(pageKey);
    return ref ? this.getRecord(ref.identityKey) : null;
  }

  setPinnedPageIdentities(input: {
    readonly visible?: Iterable<string>;
    readonly selected?: Iterable<string>;
  }): number {
    replaceSet(this.visiblePins, input.visible ?? []);
    replaceSet(this.selectedPins, input.selected ?? []);
    return this.enforceBudget('pin-update');
  }

  selectVisible(input: {
    sourceIdentity: string;
    policyKey: string;
    viewStartBp: number;
    viewEndBp: number;
    pin?: boolean;
  }): AnnotationResidentPageSelection {
    const startedAt = this.now();
    const rejected = (
      reason: 'source-mismatch' | 'policy-mismatch'
    ): AnnotationResidentPageSelection => ({
      status: 'rejected',
      reason,
      sourceIdentity: input.sourceIdentity,
      policyKey: input.policyKey,
      viewStartBp: input.viewStartBp,
      viewEndBp: input.viewEndBp,
      expectedPageIdentities: [],
      records: [],
      missingPageIdentities: [],
      coverageComplete: false,
      producerCoverageComplete: false,
    });
    if (input.sourceIdentity !== this.sourceIdentity) return rejected('source-mismatch');
    const stream = this.streams.get(input.policyKey);
    if (!stream) return rejected('policy-mismatch');
    const start = Math.max(0, Math.floor(Math.min(input.viewStartBp, input.viewEndBp)));
    const end = Math.min(
      this.genomeLengthBp,
      Math.ceil(Math.max(input.viewStartBp, input.viewEndBp))
    );
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return {
        ...rejected('policy-mismatch'),
        status: 'incomplete',
        reason: null,
        viewStartBp: start,
        viewEndBp: end,
      };
    }

    const requestedTracks =
      stream.snapshot.contract === 'annotation-codon-carrier-page-publication.v1' ||
      stream.requestedLayerTypes.length > 0
        ? stream.requestedLayerTypes
        : [...new Set([...stream.activePages.values()].map(({ trackId }) => trackId))];
    const requestedTrackSet = new Set(requestedTracks);
    const expected = [...stream.activePages.values()]
      .filter(
        (page) =>
          requestedTrackSet.has(page.trackId) &&
          ((page.ownerStartBp < end && page.ownerEndBp > start) ||
            (page.ownerStartBp < start && page.maxFeatureEndBp > start))
      )
      .sort(comparePageReferences);
    const expectedPageIdentities = expected.map(({ identityKey }) => identityKey);
    const records: AnnotationResidentPageRecord[] = [];
    const missingPageIdentities: string[] = [];
    for (const page of expected) {
      const resident = this.residents.get(page.identityKey);
      if (!resident) {
        missingPageIdentities.push(page.identityKey);
        continue;
      }
      resident.lastUsed = ++this.clock;
      records.push(resident.record);
    }

    const pageCoverageComplete =
      requestedTracks.length > 0 &&
      requestedTracks.every((trackId) =>
        rangesCover(
          expected
            .filter((page) => page.trackId === trackId)
            .map((page) => ({ startBp: page.ownerStartBp, endBp: page.ownerEndBp })),
          start,
          end
        )
      );
    const producerCoverageComplete = rangesCover(stream.exactCoverage, start, end);
    const coverageComplete = producerCoverageComplete || pageCoverageComplete;
    if (input.pin !== false) replaceSet(this.visiblePins, expectedPageIdentities);
    const status = coverageComplete && missingPageIdentities.length === 0 ? 'ready' : 'incomplete';
    this.recordTelemetry({
      type: 'select',
      cause: status,
      sourceIdentity: input.sourceIdentity,
      policyKey: input.policyKey,
      pageKey: null,
      contentRevision: null,
      identityKey: null,
      byteSize: records.reduce((sum, record) => sum + record.byteSize, 0),
      durationMs: this.now() - startedAt,
    });
    return {
      status,
      reason: null,
      sourceIdentity: input.sourceIdentity,
      policyKey: input.policyKey,
      viewStartBp: start,
      viewEndBp: end,
      expectedPageIdentities,
      records,
      missingPageIdentities,
      coverageComplete,
      producerCoverageComplete,
    };
  }

  private stagePage(
    snapshot: AnnotationResidentPagePublication,
    page: AnnotationPresentationPage
  ):
    | StagedPageData
    | {
        reason: Extract<
          AnnotationResidentPageStoreRejectionReason,
          'page-key-collision' | 'content-revision-collision'
        >;
      } {
    const identity: AnnotationResidentPageIdentity = {
      sourceIdentity: snapshot.sourceIdentity,
      policyKey: snapshot.policyKey,
      pageKey: page.pageKey,
      contentRevision: page.contentRevision,
    };
    const identityKey = AnnotationResidentPageStore.identityKey(identity);
    const logicalKey = AnnotationResidentPageStore.logicalKey(identity);
    const metadata = this.logicalMetadata.get(logicalKey);
    if (
      metadata &&
      (metadata.chromosomeId !== page.chromosomeId ||
        metadata.trackId !== page.trackId ||
        metadata.trackOrder !== page.trackOrder ||
        metadata.laneCapacity !== page.laneCapacity ||
        metadata.ownerStartBp !== page.ownerStartBp ||
        metadata.ownerEndBp !== page.ownerEndBp)
    ) {
      return { reason: 'page-key-collision' };
    }
    const existing = this.residents.get(identityKey)?.record;
    if (existing) {
      if (!deepEqual(existing.page, page)) return { reason: 'content-revision-collision' };
      return { record: existing, reference: referenceForRecord(existing) };
    }

    const immutablePage = cloneImmutablePage(page);
    const canonicalFeatureIdentities = Object.freeze(
      immutablePage.features.map((feature) =>
        canonicalFeatureIdentity(snapshot, immutablePage, feature)
      )
    );
    const record = Object.freeze({
      ...identity,
      identityKey,
      logicalKey,
      byteSize: estimateAnnotationPresentationPageBytes(immutablePage),
      page: immutablePage,
      canonicalFeatureIdentities,
    }) satisfies AnnotationResidentPageRecord;
    return { record, reference: referenceForRecord(record) };
  }

  private enforceBudget(cause: string): number {
    let evicted = 0;
    while (
      this.residents.size > this.maxResidentPages ||
      this.residentBytes > this.maxResidentBytes
    ) {
      const candidate = [...this.residents.values()]
        .filter(
          ({ record }) =>
            !this.visiblePins.has(record.identityKey) && !this.selectedPins.has(record.identityKey)
        )
        .sort(
          (left, right) =>
            left.lastUsed - right.lastUsed ||
            left.record.identityKey.localeCompare(right.record.identityKey)
        )[0];
      if (!candidate) break;
      this.residents.delete(candidate.record.identityKey);
      this.residentBytes -= candidate.record.byteSize;
      evicted += 1;
      this.recordPageTelemetry('eviction', cause, candidate.record, 0);
    }
    return evicted;
  }

  private recordPageTelemetry(
    type: 'build' | 'reuse' | 'eviction',
    cause: string,
    record: AnnotationResidentPageRecord,
    durationMs: number
  ): void {
    this.recordTelemetry({
      type,
      cause,
      sourceIdentity: record.sourceIdentity,
      policyKey: record.policyKey,
      pageKey: record.pageKey,
      contentRevision: record.contentRevision,
      identityKey: record.identityKey,
      byteSize: record.byteSize,
      durationMs,
    });
  }

  private recordTelemetry(
    event: Omit<
      AnnotationResidentPageStoreTelemetryEvent,
      'residentPageCount' | 'residentByteCount'
    >
  ): void {
    if (this.telemetryLimit === 0) return;
    this.telemetry.push(
      Object.freeze({
        ...event,
        durationMs: Math.max(0, event.durationMs),
        residentPageCount: this.residents.size,
        residentByteCount: this.residentBytes,
      })
    );
    if (this.telemetry.length > this.telemetryLimit) {
      this.telemetry.splice(0, this.telemetry.length - this.telemetryLimit);
    }
  }
}

export function estimateAnnotationPresentationPageBytes(page: AnnotationPresentationPage): number {
  let bytes =
    PAGE_FIXED_BYTES +
    stringBytes(page.pageKey, page.chromosomeId, page.trackId, page.contentRevision);
  for (const feature of page.features) {
    bytes += FEATURE_FIXED_BYTES;
    bytes += stringBytes(
      feature.type,
      feature.annotationTrackId,
      feature.direction,
      feature.displayName,
      feature.transcriptId,
      feature.sourceId,
      feature.canonicalIdentity
    );
    bytes += (feature.segments?.length ?? 0) * SPAN_FIXED_BYTES;
    bytes += (feature.exons?.length ?? 0) * SPAN_FIXED_BYTES;
    bytes += (feature.cds?.length ?? 0) * SPAN_FIXED_BYTES;
    for (const [key, value] of Object.entries(feature.qualifiers ?? {})) {
      bytes += stringBytes(key, value);
    }
  }
  return Math.max(1, bytes);
}

function validSnapshotEnvelope(value: unknown): value is AnnotationResidentPagePublication {
  if (!isRecord(value)) return false;
  return (
    (value.contract === 'annotation-resident-page-publication.v1' ||
      value.contract === 'annotation-codon-carrier-page-publication.v1') &&
    typeof value.sourceIdentity === 'string' &&
    value.sourceIdentity.trim().length > 0 &&
    typeof value.policyKey === 'string' &&
    value.policyKey.trim().length > 0 &&
    Number.isSafeInteger(value.genomeLengthBp) &&
    (value.genomeLengthBp as number) > 0 &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 0 &&
    Array.isArray(value.requestedLayerTypes) &&
    value.requestedLayerTypes.every(
      (track) => typeof track === 'string' && track.trim().length > 0
    ) &&
    Array.isArray(value.exactCoverage) &&
    value.exactCoverage.every(
      (range) =>
        isRecord(range) &&
        Number.isSafeInteger(range.startBp) &&
        Number.isSafeInteger(range.endBp) &&
        (range.startBp as number) >= 0 &&
        (range.endBp as number) > (range.startBp as number) &&
        (range.endBp as number) <= (value.genomeLengthBp as number)
    ) &&
    Array.isArray(value.pages)
  );
}

function validPageEnvelope(
  page: unknown,
  genomeLengthBp: number
): page is AnnotationPresentationPage {
  if (!isRecord(page)) return false;
  if (
    page.contract !== 'annotation-presentation-page.v1' ||
    !nonEmptyString(page.pageKey) ||
    !nonEmptyString(page.chromosomeId) ||
    !nonEmptyString(page.trackId) ||
    !Number.isSafeInteger(page.trackOrder) ||
    (page.trackOrder as number) < 0 ||
    !Number.isSafeInteger(page.laneCapacity) ||
    (page.laneCapacity as number) <= 0 ||
    !nonEmptyString(page.contentRevision) ||
    !safeCoordinate(page.ownerStartBp, 0, genomeLengthBp - 1) ||
    !safeCoordinate(page.ownerEndBp, 1, genomeLengthBp) ||
    (page.ownerEndBp as number) <= (page.ownerStartBp as number) ||
    !safeCoordinate(page.maxFeatureEndBp, 1, genomeLengthBp) ||
    !Array.isArray(page.features)
  ) {
    return false;
  }
  const trackId = page.trackId as string;
  let maxFeatureEndBp = page.ownerEndBp as number;
  for (const feature of page.features) {
    if (!validFeature(feature, genomeLengthBp)) return false;
    if (
      feature.start < (page.ownerStartBp as number) ||
      feature.start >= (page.ownerEndBp as number)
    ) {
      return false;
    }
    if ((feature.annotationTrackId ?? feature.type) !== trackId) return false;
    if (
      feature.annotationTrackLane !== undefined &&
      feature.annotationTrackLane >= (page.laneCapacity as number)
    ) {
      return false;
    }
    maxFeatureEndBp = Math.max(maxFeatureEndBp, feature.end);
  }
  return page.maxFeatureEndBp === maxFeatureEndBp;
}

function validFeature(value: unknown, genomeLengthBp: number): value is Feature {
  if (!isRecord(value)) return false;
  if (
    !Number.isSafeInteger(value.id) ||
    !nonEmptyString(value.type) ||
    !safeCoordinate(value.start, 0, genomeLengthBp - 1) ||
    !safeCoordinate(value.end, 1, genomeLengthBp) ||
    (value.end as number) <= (value.start as number) ||
    (value.direction !== 'forward' &&
      value.direction !== 'reverse' &&
      value.direction !== 'none') ||
    typeof value.displayName !== 'string' ||
    !Number.isFinite(value.color) ||
    !Number.isSafeInteger(value.lane) ||
    (value.lane as number) < 0 ||
    (value.annotationTrackLane !== undefined &&
      (!Number.isSafeInteger(value.annotationTrackLane) ||
        (value.annotationTrackLane as number) < 0))
  ) {
    return false;
  }
  return [value.segments, value.exons, value.cds].every(
    (spans) =>
      spans === undefined ||
      (Array.isArray(spans) &&
        spans.every(
          (span) =>
            isRecord(span) &&
            Number.isSafeInteger(span.start) &&
            Number.isSafeInteger(span.end) &&
            (span.start as number) >= 1 &&
            (span.end as number) >= (span.start as number) &&
            (span.end as number) <= genomeLengthBp
        ))
  );
}

function validateActivePageSet(
  activePages: ReadonlyMap<string, ActivePageReference>
): Extract<
  AnnotationResidentPageStoreRejectionReason,
  'overlapping-owner-ranges' | 'duplicate-feature-ownership'
> | null {
  const byTrack = new Map<string, ActivePageReference[]>();
  const canonicalOwners = new Map<string, string>();
  for (const page of activePages.values()) {
    const groupKey = framedKey([page.chromosomeId, page.trackId]);
    const group = byTrack.get(groupKey) ?? [];
    group.push(page);
    byTrack.set(groupKey, group);
  }
  for (const pages of byTrack.values()) {
    pages.sort(comparePageReferences);
    for (let index = 1; index < pages.length; index += 1) {
      if (pages[index].ownerStartBp < pages[index - 1].ownerEndBp) {
        return 'overlapping-owner-ranges';
      }
    }
  }
  for (const page of activePages.values()) {
    for (const canonicalIdentity of page.canonicalFeatureIdentities) {
      const priorOwner = canonicalOwners.get(canonicalIdentity);
      if (priorOwner && priorOwner !== page.pageKey) return 'duplicate-feature-ownership';
      canonicalOwners.set(canonicalIdentity, page.pageKey);
    }
  }
  return null;
}

function referenceForRecord(record: AnnotationResidentPageRecord): ActivePageReference {
  return {
    sourceIdentity: record.sourceIdentity,
    policyKey: record.policyKey,
    pageKey: record.pageKey,
    contentRevision: record.contentRevision,
    identityKey: record.identityKey,
    logicalKey: record.logicalKey,
    chromosomeId: record.page.chromosomeId,
    trackId: record.page.trackId,
    trackOrder: record.page.trackOrder,
    laneCapacity: record.page.laneCapacity,
    ownerStartBp: record.page.ownerStartBp,
    ownerEndBp: record.page.ownerEndBp,
    maxFeatureEndBp: record.page.maxFeatureEndBp,
    canonicalFeatureIdentities: record.canonicalFeatureIdentities,
  };
}

function canonicalFeatureIdentity(
  snapshot: AnnotationResidentPagePublication,
  page: AnnotationPresentationPage,
  feature: Feature
): string {
  if (nonEmptyString(feature.canonicalIdentity)) return feature.canonicalIdentity;
  return annotationCanonicalIdentityV2({
    genomeIdentity: snapshot.sourceIdentity,
    sourceId:
      feature.sourceId ??
      feature.qualifiers?.ID ??
      feature.transcriptId ??
      `renderer-feature-${feature.id}`,
    transcriptId: feature.transcriptId ?? null,
    trackId: feature.annotationTrackId ?? page.trackId,
    type: feature.type,
    startBp: feature.start,
    endBp: feature.end,
    direction: feature.direction,
  });
}

function cloneImmutablePage(page: AnnotationPresentationPage): AnnotationPresentationPage {
  const features = Object.freeze(page.features.map(cloneImmutableFeature));
  return Object.freeze({ ...page, features });
}

function cloneImmutableFeature(feature: Feature): Feature {
  const clone: Feature = {
    ...feature,
    segments: feature.segments
      ? (Object.freeze(feature.segments.map((span) => Object.freeze({ ...span }))) as Array<{
          start: number;
          end: number;
        }>)
      : undefined,
    exons: feature.exons
      ? Object.freeze(feature.exons.map((span) => Object.freeze({ ...span })))
      : undefined,
    cds: feature.cds
      ? Object.freeze(feature.cds.map((span) => Object.freeze({ ...span })))
      : undefined,
    qualifiers: feature.qualifiers ? Object.freeze({ ...feature.qualifiers }) : undefined,
  };
  return Object.freeze(clone);
}

function rangesCover(
  ranges: ReadonlyArray<Readonly<{ startBp: number; endBp: number }>>,
  startBp: number,
  endBp: number
): boolean {
  if (endBp <= startBp) return false;
  const ordered = [...ranges].sort(
    (left, right) => left.startBp - right.startBp || left.endBp - right.endBp
  );
  let cursor = startBp;
  for (const range of ordered) {
    if (range.endBp <= cursor) continue;
    if (range.startBp > cursor) return false;
    cursor = Math.max(cursor, range.endBp);
    if (cursor >= endBp) return true;
  }
  return false;
}

function comparePageReferences(left: ActivePageReference, right: ActivePageReference): number {
  return (
    left.ownerStartBp - right.ownerStartBp ||
    left.ownerEndBp - right.ownerEndBp ||
    left.trackOrder - right.trackOrder ||
    left.trackId.localeCompare(right.trackId) ||
    left.pageKey.localeCompare(right.pageKey)
  );
}

function framedKey(parts: ReadonlyArray<string>): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function stringBytes(...values: ReadonlyArray<string | null | undefined>): number {
  let bytes = 0;
  for (const value of values) if (value) bytes += value.length * 2;
  return bytes;
}

function replaceSet(target: Set<string>, values: Iterable<string>): void {
  target.clear();
  for (const value of values) target.add(value);
}

function safeCoordinate(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (!deepEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}
