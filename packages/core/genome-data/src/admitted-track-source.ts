import type { TrackSource } from './format-handler';
import type { ScientificTrackKind } from './scientific-track-kind';
import type {
  AlignedReadReferenceGenerationV1,
  AlignedReadSourceGenerationV1,
} from './aligned-read-source-generation';
import type { QuantitativeSourceSummaryV1 } from './quantitative-track-presentation';
import {
  directTrackAdmissionRequest,
  parseTrackAdmissionRequestV1,
  type TrackAdmissionRequestV1,
} from './track-admission-request';

export type { ScientificTrackKind } from './scientific-track-kind';

export type TrackReaderKind = 'ucsc-rest' | 'bbi' | 'interval-text' | 'bam' | 'variant';

export type QuantitativeColumnSemantics = 'continuous-signal' | 'native-interval';

export interface ReferenceCompatibilityReceipt {
  readonly assemblyId: string;
  readonly referenceSignature: string;
  readonly sourceSignature: string;
  readonly contigMap: Readonly<Record<string, string>>;
  readonly checkedContigs: number;
  readonly status: 'compatible' | 'incompatible';
  readonly checkedAt: string;
}

export interface TrackSourceProvenance {
  readonly provider?: string;
  readonly catalogId?: string;
  readonly hubUrl?: string;
  readonly remoteUrl?: string;
  readonly track?: string;
  readonly sourceKind?: string;
  readonly ucscGenome?: string;
  readonly label?: string;
  readonly parentPath?: ReadonlyArray<string>;
  readonly devScenarioFixture?: true;
}

export interface AdmittedSourceValidators {
  readonly etag?: string;
  readonly lastModified?: string;
  readonly contentLength?: number;
}

export interface AdmittedTrackSource extends TrackSource {
  readonly admissionVersion: 1 | 2;
  readonly request?: TrackAdmissionRequestV1;
  readonly admittedAt?: string;
  readonly fingerprint: string;
  readonly readerKind: TrackReaderKind;
  readonly scientificKind: ScientificTrackKind;
  readonly quantitativeColumnSemantics?: QuantitativeColumnSemantics;
  readonly quantitativeSummary?: QuantitativeSourceSummaryV1;
  readonly publishedSignalScale?: {
    readonly minimum: number;
    readonly maximum: number;
  };
  readonly assemblyId: string;
  readonly referenceReceipt: ReferenceCompatibilityReceipt;
  readonly provenance: TrackSourceProvenance;
  readonly expectedValidators?: AdmittedSourceValidators;
  readonly indexExpectedValidators?: AdmittedSourceValidators;
  readonly alignedReadGeneration?: AlignedReadSourceGenerationV1;
  readonly alignedReadReferenceGeneration?: AlignedReadReferenceGenerationV1;
  readonly alignedReadIndexState?: 'present' | 'created';
}

export interface CurrentAdmittedTrackSource extends AdmittedTrackSource {
  readonly admissionVersion: 2;
  readonly request: TrackAdmissionRequestV1;
  readonly admittedAt: string;
}

export function requireTrackAdmissionRequest(source: AdmittedTrackSource): TrackAdmissionRequestV1 {
  if (source.admissionVersion === 2) {
    if (!source.request) throw new Error('Current admitted track source is missing its request.');
    const request = parseTrackAdmissionRequestV1(source.request);
    assertRequestMatchesSource(request, source);
    return request;
  }

  if (source.input?.kind === 'path' || source.input?.kind === 'url') {
    return directTrackAdmissionRequest({
      assemblyId: source.assemblyId,
      input: source.input,
      formatId: source.formatId,
      ...(source.index?.kind === 'path' || source.index?.kind === 'url'
        ? { index: source.index }
        : {}),
      ...(source.reference?.kind === 'path' || source.reference?.kind === 'url'
        ? { reference: source.reference }
        : {}),
      scientificKind: source.scientificKind,
      label: provenanceText(source.provenance, 'label'),
      ingress: 'session',
      sessionId: 'legacy-admitted-track',
    });
  }

  if (source.provenance.provider === 'ucsc') {
    const sourceKind = provenanceText(source.provenance, 'sourceKind');
    const genome = provenanceText(source.provenance, 'ucscGenome');
    const track = provenanceText(source.provenance, 'track');
    const hubUrl = provenanceText(source.provenance, 'hubUrl');
    if ((sourceKind === 'ucsc-native' || sourceKind === 'ucsc-hub') && genome && track) {
      return parseTrackAdmissionRequestV1({
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: source.assemblyId,
        source: {
          kind: 'ucsc-track',
          sourceKind,
          genome,
          track,
          ...(hubUrl ? { hubUrl } : {}),
        },
        formatId: source.formatId,
        scientificKind: source.scientificKind,
        ...(provenanceText(source.provenance, 'label')
          ? { label: provenanceText(source.provenance, 'label') }
          : {}),
        ingress: { kind: sourceKind === 'ucsc-hub' ? 'hub' : 'catalog' },
      });
    }
  }

  throw new Error('Legacy admitted track source cannot be reconstructed safely.');
}

export function migrateAdmittedTrackSource(
  source: AdmittedTrackSource
): CurrentAdmittedTrackSource {
  const request = requireTrackAdmissionRequest(source);
  const admittedAt =
    source.admissionVersion === 2 && source.admittedAt
      ? source.admittedAt
      : source.referenceReceipt.checkedAt;
  if (!isIsoInstant(admittedAt)) {
    throw new Error('Admitted track source has no valid admission timestamp.');
  }
  return {
    ...source,
    admissionVersion: 2,
    request,
    admittedAt,
  };
}

export function isCurrentAdmittedTrackSource(
  source: AdmittedTrackSource
): source is CurrentAdmittedTrackSource {
  try {
    if (source.admissionVersion !== 2 || !source.request || !isIsoInstant(source.admittedAt)) {
      return false;
    }
    assertRequestMatchesSource(parseTrackAdmissionRequestV1(source.request), source);
    return true;
  } catch {
    return false;
  }
}

export function sameAdmittedTrackSourceIdentity(
  left: AdmittedTrackSource,
  right: AdmittedTrackSource
): boolean {
  return (
    left.admissionVersion === right.admissionVersion &&
    left.uri === right.uri &&
    left.formatId === right.formatId &&
    left.fingerprint === right.fingerprint &&
    left.readerKind === right.readerKind &&
    left.scientificKind === right.scientificKind &&
    left.quantitativeColumnSemantics === right.quantitativeColumnSemantics &&
    left.assemblyId === right.assemblyId &&
    left.referenceReceipt.referenceSignature === right.referenceReceipt.referenceSignature &&
    left.referenceReceipt.sourceSignature === right.referenceReceipt.sourceSignature &&
    left.referenceReceipt.status === right.referenceReceipt.status
  );
}

function assertRequestMatchesSource(
  request: TrackAdmissionRequestV1,
  source: AdmittedTrackSource
): void {
  if (request.assemblyId !== source.assemblyId) {
    throw new Error(
      `Track admission request assembly ${request.assemblyId} does not match admitted assembly ${source.assemblyId}.`
    );
  }
  if (request.formatId && request.formatId !== source.formatId) {
    throw new Error(
      `Track admission request format ${request.formatId} does not match admitted format ${source.formatId}.`
    );
  }
  if (request.scientificKind && request.scientificKind !== source.scientificKind) {
    throw new Error(
      `Track admission request scientific kind ${request.scientificKind} does not match admitted kind ${source.scientificKind}.`
    );
  }
}

function provenanceText(provenance: TrackSourceProvenance, field: string): string | undefined {
  const value = (provenance as Readonly<Record<string, unknown>>)[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export type TrackLoadResult<T> =
  | { readonly state: 'loading'; readonly requestEpoch: number }
  | {
      readonly state: 'ready';
      readonly requestEpoch: number;
      readonly complete: true;
      readonly data: T;
    }
  | { readonly state: 'empty'; readonly requestEpoch: number; readonly complete: true }
  | { readonly state: 'too-dense'; readonly minimumSpanBp: number }
  | { readonly state: 'range-unsupported' }
  | {
      readonly state: 'source-changed';
      readonly previous: string;
      readonly current: string;
    }
  | { readonly state: 'unsupported'; readonly reason: string }
  | {
      readonly state: 'error';
      readonly code: string;
      readonly retryable: boolean;
      readonly message: string;
    };
