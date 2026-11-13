import { SCIENTIFIC_TRACK_KINDS, type ScientificTrackKind } from './scientific-track-kind';
import type { FormatInput } from './format-handler';

export const TRACK_ADMISSION_REQUEST_V1 = 'dnaforge.track-admission-request.v1' as const;

const CREDENTIAL_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'credential',
  'key',
  'password',
  'secret',
  'session',
  'session_token',
  'sig',
  'signature',
  'token',
]);
const CREDENTIAL_QUERY_PREFIXES = ['x-amz-', 'x-goog-'];
const AUTH_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

export interface LocalFileTrackSourceV1 {
  readonly kind: 'local-file';
  readonly path: string;
  readonly relativePathHint?: string;
}

export interface HttpTrackSourceV1 {
  readonly kind: 'http';
  readonly url: string;
  readonly authRef?: string;
}

export interface S3TrackSourceV1 {
  readonly kind: 's3';
  readonly bucket: string;
  readonly key: string;
  readonly region?: string;
  readonly requesterPays?: boolean;
  readonly authRef?: string;
}

export interface GcsTrackSourceV1 {
  readonly kind: 'gcs';
  readonly bucket: string;
  readonly object: string;
  readonly billingProject?: string;
  readonly authRef?: string;
}

export interface HtsgetTrackSourceV1 {
  readonly kind: 'htsget';
  readonly endpoint: string;
  readonly resourceId: string;
  readonly dataClass: 'reads' | 'variants';
  readonly format?: 'BAM' | 'CRAM' | 'VCF' | 'BCF';
  readonly authRef?: string;
}

export interface UcscTrackAddressV1 {
  readonly kind: 'ucsc-track';
  readonly sourceKind: 'ucsc-native' | 'ucsc-hub';
  readonly genome: string;
  readonly track: string;
  readonly hubUrl?: string;
}

export type TrackAssetLocatorV1 =
  | LocalFileTrackSourceV1
  | HttpTrackSourceV1
  | S3TrackSourceV1
  | GcsTrackSourceV1
  | HtsgetTrackSourceV1;

export type TrackSourceAddressV1 = TrackAssetLocatorV1 | UcscTrackAddressV1;

export type TrackAdmissionIngressV1 =
  | Readonly<{ kind: 'file-picker' }>
  | Readonly<{ kind: 'url' }>
  | Readonly<{ kind: 'cloud' }>
  | Readonly<{ kind: 'manifest'; manifestId: string }>
  | Readonly<{ kind: 'catalog' }>
  | Readonly<{ kind: 'hub' }>
  | Readonly<{ kind: 'session'; sessionId: string }>
  | Readonly<{ kind: 'automation' }>;

export interface TrackAdmissionRequestV1 {
  readonly contract: typeof TRACK_ADMISSION_REQUEST_V1;
  readonly assemblyId: string;
  readonly source: TrackSourceAddressV1;
  readonly formatId?: string;
  readonly index?: TrackAssetLocatorV1;
  readonly reference?: TrackAssetLocatorV1;
  readonly scientificKind?: ScientificTrackKind;
  readonly label?: string;
  readonly ingress: TrackAdmissionIngressV1;
}

type DurableFormatInput = Extract<FormatInput, { kind: 'path' | 'url' }>;

export function directTrackAdmissionRequest(input: {
  readonly assemblyId: string;
  readonly input: DurableFormatInput;
  readonly formatId?: string;
  readonly index?: DurableFormatInput;
  readonly reference?: DurableFormatInput;
  readonly scientificKind?: ScientificTrackKind;
  readonly label?: string;
  readonly ingress: Extract<
    TrackAdmissionIngressV1['kind'],
    'file-picker' | 'url' | 'manifest' | 'session' | 'automation'
  >;
  readonly manifestId?: string;
  readonly sessionId?: string;
}): TrackAdmissionRequestV1 {
  const ingress =
    input.ingress === 'manifest'
      ? { kind: 'manifest' as const, manifestId: requiredText(input.manifestId, 'manifestId') }
      : input.ingress === 'session'
        ? { kind: 'session' as const, sessionId: requiredText(input.sessionId, 'sessionId') }
        : { kind: input.ingress };
  return parseTrackAdmissionRequestV1({
    contract: TRACK_ADMISSION_REQUEST_V1,
    assemblyId: input.assemblyId,
    source: assetLocatorFromFormatInput(input.input),
    ...(input.formatId ? { formatId: input.formatId } : {}),
    ...(input.index ? { index: assetLocatorFromFormatInput(input.index) } : {}),
    ...(input.reference ? { reference: assetLocatorFromFormatInput(input.reference) } : {}),
    ...(input.scientificKind ? { scientificKind: input.scientificKind } : {}),
    ...(input.label ? { label: input.label } : {}),
    ingress,
  });
}

export function parseTrackAdmissionRequestV1(value: unknown): TrackAdmissionRequestV1 {
  const request = exactRecord(
    value,
    new Set([
      'contract',
      'assemblyId',
      'source',
      'formatId',
      'index',
      'reference',
      'scientificKind',
      'label',
      'ingress',
    ]),
    'Track admission request'
  );
  if (request.contract !== TRACK_ADMISSION_REQUEST_V1) {
    throw new Error(`Track admission request contract must be ${TRACK_ADMISSION_REQUEST_V1}.`);
  }
  const assemblyId = boundedText(request.assemblyId, 'assemblyId', 1, 512);
  const source = parseSourceAddress(request.source, 'source');
  const formatId = optionalBoundedText(request.formatId, 'formatId', 64);
  const index = request.index === undefined ? undefined : parseAssetLocator(request.index, 'index');
  const reference =
    request.reference === undefined ? undefined : parseAssetLocator(request.reference, 'reference');
  const scientificKind = parseScientificKind(request.scientificKind);
  const label = optionalBoundedText(request.label, 'label', 200);
  const ingress = parseIngress(request.ingress);

  return {
    contract: TRACK_ADMISSION_REQUEST_V1,
    assemblyId,
    source,
    ...(formatId ? { formatId } : {}),
    ...(index ? { index } : {}),
    ...(reference ? { reference } : {}),
    ...(scientificKind ? { scientificKind } : {}),
    ...(label ? { label } : {}),
    ingress,
  };
}

export function formatInputFromTrackAdmissionRequest(
  request: TrackAdmissionRequestV1
): DurableFormatInput {
  switch (request.source.kind) {
    case 'local-file':
      return { kind: 'path', path: request.source.path };
    case 'http':
      return { kind: 'url', url: request.source.url };
    case 's3':
    case 'gcs':
    case 'htsget':
    case 'ucsc-track':
      throw new Error(
        `Track source ${request.source.kind} must be resolved by its source adapter before format detection.`
      );
  }
}

export function trackAdmissionRequestIdentity(request: TrackAdmissionRequestV1): string {
  return JSON.stringify({
    contract: request.contract,
    assemblyId: request.assemblyId,
    source: locatorIdentity(request.source),
    formatId: request.formatId ?? null,
    index: request.index ? locatorIdentity(request.index) : null,
    reference: request.reference ? locatorIdentity(request.reference) : null,
    scientificKind: request.scientificKind ?? null,
  });
}

export function trackAdmissionRequestLabel(request: TrackAdmissionRequestV1): string {
  if (request.label) return request.label;
  return trackSourceAddressLabel(request.source);
}

function trackSourceAddressLabel(source: TrackSourceAddressV1): string {
  switch (source.kind) {
    case 'local-file':
      return basename(source.path) || 'Local data';
    case 'http':
      return urlBasename(source.url) || 'Linked data';
    case 's3':
      return basename(source.key) || source.bucket;
    case 'gcs':
      return basename(source.object) || source.bucket;
    case 'htsget':
      return source.resourceId;
    case 'ucsc-track':
      return source.track;
  }
}

export function createTrackAdmissionRequestId(request: TrackAdmissionRequestV1): string {
  const label = trackSourceAddressLabel(request.source);
  const readable = label
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72);
  if (request.source.kind === 'local-file' || request.source.kind === 'http') {
    const legacyKind = request.source.kind === 'local-file' ? 'path' : 'url';
    const locator = request.source.kind === 'local-file' ? request.source.path : request.source.url;
    return `data:${readable || 'indexed-data'}-${fnv1a32(
      `${request.assemblyId}\u0000${legacyKind}\u0000${locator}`
    )}`;
  }
  return `data:${readable || 'indexed-data'}-${fnv1a32(trackAdmissionRequestIdentity(request))}`;
}

function assetLocatorFromFormatInput(input: DurableFormatInput): TrackAssetLocatorV1 {
  return input.kind === 'path'
    ? { kind: 'local-file', path: input.path }
    : { kind: 'http', url: input.url };
}

function parseSourceAddress(value: unknown, field: string): TrackSourceAddressV1 {
  const candidate = record(value, field);
  return candidate.kind === 'ucsc-track'
    ? parseUcscTrackAddress(candidate, field)
    : parseAssetLocator(candidate, field);
}

function parseAssetLocator(value: unknown, field: string): TrackAssetLocatorV1 {
  const candidate = record(value, field);
  switch (candidate.kind) {
    case 'local-file': {
      const exact = exactRecord(candidate, new Set(['kind', 'path', 'relativePathHint']), field);
      const path = boundedText(exact.path, `${field} path`, 1, 8192);
      if (!isAbsolutePath(path)) {
        throw new Error(`${field} path must be an absolute path returned by a native authority.`);
      }
      const relativePathHint = optionalBoundedText(
        exact.relativePathHint,
        `${field} relativePathHint`,
        2048
      );
      if (relativePathHint && isAbsolutePath(relativePathHint)) {
        throw new Error(`${field} relativePathHint must be relative.`);
      }
      return {
        kind: 'local-file',
        path,
        ...(relativePathHint ? { relativePathHint } : {}),
      };
    }
    case 'http': {
      const exact = exactRecord(candidate, new Set(['kind', 'url', 'authRef']), field);
      return {
        kind: 'http',
        url: durableHttpUrl(exact.url, `${field} URL`),
        ...authRefField(exact.authRef, field),
      };
    }
    case 's3': {
      const exact = exactRecord(
        candidate,
        new Set(['kind', 'bucket', 'key', 'region', 'requesterPays', 'authRef']),
        field
      );
      const key = objectKey(exact.key, `${field} object key`);
      const requesterPays = optionalBoolean(exact.requesterPays, `${field} requesterPays`);
      return {
        kind: 's3',
        bucket: bucketName(exact.bucket, `${field} bucket`),
        key,
        ...optionalTextField(exact.region, 'region', `${field} region`, 128),
        ...(requesterPays === undefined ? {} : { requesterPays }),
        ...authRefField(exact.authRef, field),
      };
    }
    case 'gcs': {
      const exact = exactRecord(
        candidate,
        new Set(['kind', 'bucket', 'object', 'billingProject', 'authRef']),
        field
      );
      return {
        kind: 'gcs',
        bucket: bucketName(exact.bucket, `${field} bucket`),
        object: objectKey(exact.object, `${field} object key`),
        ...optionalTextField(
          exact.billingProject,
          'billingProject',
          `${field} billingProject`,
          256
        ),
        ...authRefField(exact.authRef, field),
      };
    }
    case 'htsget': {
      const exact = exactRecord(
        candidate,
        new Set(['kind', 'endpoint', 'resourceId', 'dataClass', 'format', 'authRef']),
        field
      );
      const dataClass = exact.dataClass;
      if (dataClass !== 'reads' && dataClass !== 'variants') {
        throw new Error(`${field} dataClass must be reads or variants.`);
      }
      const format = exact.format;
      if (
        format !== undefined &&
        format !== 'BAM' &&
        format !== 'CRAM' &&
        format !== 'VCF' &&
        format !== 'BCF'
      ) {
        throw new Error(`${field} format must be BAM, CRAM, VCF, or BCF.`);
      }
      if (dataClass === 'reads' && (format === 'VCF' || format === 'BCF')) {
        throw new Error(`${field} reads cannot request ${format}.`);
      }
      if (dataClass === 'variants' && (format === 'BAM' || format === 'CRAM')) {
        throw new Error(`${field} variants cannot request ${format}.`);
      }
      return {
        kind: 'htsget',
        endpoint: durableHttpUrl(exact.endpoint, `${field} endpoint`).replace(/\/$/u, ''),
        resourceId: boundedText(exact.resourceId, `${field} resourceId`, 1, 2048),
        dataClass,
        ...(format ? { format } : {}),
        ...authRefField(exact.authRef, field),
      };
    }
    default:
      throw new Error(`${field} has unsupported source kind ${String(candidate.kind)}.`);
  }
}

function parseUcscTrackAddress(value: Record<string, unknown>, field: string): UcscTrackAddressV1 {
  const exact = exactRecord(
    value,
    new Set(['kind', 'sourceKind', 'genome', 'track', 'hubUrl']),
    field
  );
  const sourceKind = exact.sourceKind;
  if (sourceKind !== 'ucsc-native' && sourceKind !== 'ucsc-hub') {
    throw new Error(`${field} sourceKind must be ucsc-native or ucsc-hub.`);
  }
  const hubUrl =
    exact.hubUrl === undefined ? undefined : durableHttpUrl(exact.hubUrl, `${field} hubUrl`);
  if (sourceKind === 'ucsc-hub' && !hubUrl) {
    throw new Error(`${field} hubUrl is required for a UCSC hub track.`);
  }
  if (sourceKind === 'ucsc-native' && hubUrl) {
    throw new Error(`${field} hubUrl is only valid for a UCSC hub track.`);
  }
  return {
    kind: 'ucsc-track',
    sourceKind,
    genome: boundedText(exact.genome, `${field} genome`, 1, 256),
    track: boundedText(exact.track, `${field} track`, 1, 512),
    ...(hubUrl ? { hubUrl } : {}),
  };
}

function parseIngress(value: unknown): TrackAdmissionIngressV1 {
  const candidate = record(value, 'ingress');
  switch (candidate.kind) {
    case 'file-picker':
    case 'url':
    case 'cloud':
    case 'catalog':
    case 'hub':
    case 'automation':
      exactRecord(candidate, new Set(['kind']), 'ingress');
      return { kind: candidate.kind };
    case 'manifest': {
      const exact = exactRecord(candidate, new Set(['kind', 'manifestId']), 'ingress');
      return {
        kind: 'manifest',
        manifestId: boundedText(exact.manifestId, 'ingress manifestId', 1, 512),
      };
    }
    case 'session': {
      const exact = exactRecord(candidate, new Set(['kind', 'sessionId']), 'ingress');
      return {
        kind: 'session',
        sessionId: boundedText(exact.sessionId, 'ingress sessionId', 1, 512),
      };
    }
    default:
      throw new Error(`Track admission ingress kind ${String(candidate.kind)} is unsupported.`);
  }
}

function parseScientificKind(value: unknown): ScientificTrackKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SCIENTIFIC_TRACK_KINDS.has(value as ScientificTrackKind)) {
    throw new Error(`scientificKind is unsupported.`);
  }
  return value as ScientificTrackKind;
}

function locatorIdentity(locator: TrackSourceAddressV1): Readonly<Record<string, unknown>> {
  switch (locator.kind) {
    case 'local-file':
      return { kind: locator.kind, path: locator.path };
    case 'http':
      return { kind: locator.kind, url: locator.url };
    case 's3':
      return {
        kind: locator.kind,
        bucket: locator.bucket,
        key: locator.key,
        region: locator.region ?? null,
        requesterPays: locator.requesterPays ?? false,
      };
    case 'gcs':
      return {
        kind: locator.kind,
        bucket: locator.bucket,
        object: locator.object,
        billingProject: locator.billingProject ?? null,
      };
    case 'htsget':
      return {
        kind: locator.kind,
        endpoint: locator.endpoint,
        resourceId: locator.resourceId,
        dataClass: locator.dataClass,
        format: locator.format ?? null,
      };
    case 'ucsc-track':
      return {
        kind: locator.kind,
        sourceKind: locator.sourceKind,
        genome: locator.genome,
        track: locator.track,
        hubUrl: locator.hubUrl ?? null,
      };
  }
}

function durableHttpUrl(value: unknown, field: string): string {
  const raw = boundedText(value, field, 1, 8192);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${field} is invalid.`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new Error(`${field} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} may not contain embedded credentials.`);
  }
  if (parsed.hash) throw new Error(`${field} may not contain a fragment.`);
  for (const key of parsed.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (
      CREDENTIAL_QUERY_KEYS.has(normalized) ||
      CREDENTIAL_QUERY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      throw new Error(`${field} may not contain credential parameters.`);
    }
  }
  return parsed.toString();
}

function authRefField(value: unknown, field: string): { readonly authRef?: string } {
  if (value === undefined) return {};
  const authRef = boundedText(value, `${field} authRef`, 1, 256);
  if (!AUTH_REF.test(authRef)) {
    throw new Error(`${field} authRef is not a valid opaque credential reference.`);
  }
  return { authRef };
}

function bucketName(value: unknown, field: string): string {
  const bucket = boundedText(value, field, 3, 222);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/u.test(bucket)) {
    throw new Error(`${field} is invalid.`);
  }
  return bucket;
}

function objectKey(value: unknown, field: string): string {
  const key = boundedText(value, field, 1, 4096);
  if (key.replace(/\\/gu, '/').split('/').includes('..')) {
    throw new Error(`${field} may not traverse with '..'.`);
  }
  return key;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || WINDOWS_ABSOLUTE_PATH.test(path);
}

function urlBasename(rawUrl: string): string {
  try {
    const pathname = new URL(rawUrl).pathname;
    return decodeURIComponentSafe(basename(pathname));
  } catch {
    return '';
  }
}

function basename(path: string): string {
  const segments = path.split(/[\\/]/u).filter(Boolean);
  return decodeURIComponentSafe(segments[segments.length - 1] ?? '');
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function requiredText(value: unknown, field: string): string {
  return boundedText(value, field, 1, 512);
}

function optionalTextField(
  value: unknown,
  key: string,
  field: string,
  max: number
): Readonly<Record<string, string>> {
  const parsed = optionalBoundedText(value, field, max);
  return parsed ? { [key]: parsed } : {};
}

function optionalBoundedText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, field, 1, max);
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const clean = value.trim();
  if (clean.length < min) throw new Error(`${field} is required.`);
  if (clean.length > max) throw new Error(`${field} exceeds ${max} characters.`);
  return clean;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean.`);
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  field: string
): Record<string, unknown> {
  const candidate = record(value, field);
  const unknown = Object.keys(candidate).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${field} contains unsupported field ${unknown}.`);
  return candidate;
}
