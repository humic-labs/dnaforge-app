import {
  parseTrackAdmissionRequestV1,
  type TrackAdmissionRequestV1,
} from './track-admission-request';

export const PORTABLE_GENOME_VIEW_SCHEMA = 'dnaforge.genome-view.v2' as const;
export const MAX_PORTABLE_GENOME_VIEW_BYTES = 1_048_576;

const MAX_TRACKS = 256;
const MAX_ANNOTATION_TRACKS = 1_024;
const MAX_SAMPLES = 1_024;
const MAX_DOCUMENT_DEPTH = 32;
const MAX_TEXT_LENGTH = 256;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_TRACK_HEIGHT_PX = 4_096;
const MAX_LANES = 100_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE_FINGERPRINT = /^[0-9a-f]{24}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;
const COLOR = /^#[0-9a-f]{6}$/;
const EMBEDDED_URI_LOCATOR = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:file|mailto|urn):|data:[^,\s]*,)/i;
const SIGNED_URL_MARKER = /(?:^|[?&])(?:x-amz-signature|x-goog-signature|signature|sig)=/i;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const EMBEDDED_WINDOWS_DRIVE_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._-])[A-Za-z]:[\\/]/;
const EMBEDDED_WINDOWS_UNC_ABSOLUTE_PATH =
  /(?:^|[^A-Za-z0-9._-])(?:\\\\|\/\/)[^\\/\s]+[\\/][^\\/\s]+/;
const EMBEDDED_POSIX_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._-])\/(?!\/)(?=\S)/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'sessiongrant',
  'sessiontoken',
  'signedurl',
  'token',
  'xamzcredential',
  'xamzsecuritytoken',
  'xgoogcredential',
  'xgoogsignature',
]);
const COMMON_CREDENTIAL_VALUES = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/,
];

export interface PortableGenomeViewActor {
  readonly kind: 'user' | 'agent' | 'system';
  readonly id?: string;
}

export interface PortableGenomeViewProvenance {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: PortableGenomeViewActor;
}

export type PortableGenomeViewReference =
  | Readonly<{
      kind: 'hosted-reference';
      catalogId: string;
      assemblyId: string;
      bundleFingerprint: string;
      sourceFingerprint: string;
      inventoryFingerprint: string;
      sequenceIdentity?: string;
      annotationIdentity?: string;
    }>
  | Readonly<{
      kind: 'workspace-reference';
      entityId: string;
      assemblyId: string;
      contentFingerprint: string;
      referenceSignature: string;
      relativePathHint?: string;
    }>;

export type PortableGenomeViewViewport =
  | Readonly<{ kind: 'all' }>
  | Readonly<{ kind: 'chromosome'; chrom: string }>
  | Readonly<{ kind: 'locus'; chrom: string; start0: number; end0: number }>
  | Readonly<{ kind: 'assembly-range'; start0: number; end0: number }>;

export interface PortableGenomeViewAnnotationPolicy {
  readonly isoformMode: 'canonical' | 'expanded';
  readonly laneLimit: number | null;
}

export interface PortableGenomeViewAnnotationState {
  readonly policy: PortableGenomeViewAnnotationPolicy;
  readonly visibilityByTrackId: Readonly<Record<string, boolean>>;
  readonly orderedTrackIds: ReadonlyArray<string>;
}

export type PortableGenomeViewTrackSourceRef =
  | Readonly<{
      kind: 'hosted-track';
      provider: string;
      catalogId: string;
      assemblyId: string;
      contentFingerprint: string;
      referenceSignature: string;
    }>
  | Readonly<{
      kind: 'workspace-track';
      entityId: string;
      assemblyId: string;
      contentFingerprint: string;
      referenceSignature: string;
      relativePathHint?: string;
    }>
  | Readonly<{
      kind: 'admitted-source';
      request: TrackAdmissionRequestV1;
      assemblyId: string;
      contentFingerprint: string;
      referenceSignature: string;
    }>;

export type PortableGenomeViewQuantitativeScale =
  | Readonly<{ kind: 'auto' }>
  | Readonly<{
      kind: 'fixed';
      min: number;
      max: number;
      transform: 'linear' | 'log';
    }>;

export type PortableGenomeViewTrackPresentation =
  | Readonly<{
      kind: 'annotation';
      color: string;
      trackHeightPx: number;
      laneHeightPx: number;
      maxLanes: number;
    }>
  | Readonly<{
      kind: 'quantitative';
      color: string;
      trackHeightPx: number;
      scale: PortableGenomeViewQuantitativeScale;
    }>
  | Readonly<{
      kind: 'aligned-reads';
      coverageCutoffDepth: number;
    }>
  | Readonly<{
      kind: 'variants';
      selectedSamples: ReadonlyArray<string>;
      filteredToPassing: boolean;
    }>;

export interface PortableGenomeViewTrack {
  readonly trackId: string;
  readonly trackType: string;
  readonly label: string;
  readonly order: number;
  readonly visible: boolean;
  readonly source: PortableGenomeViewTrackSourceRef;
  readonly presentation: PortableGenomeViewTrackPresentation;
}

export interface PortableGenomeViewDocument {
  readonly schema: typeof PORTABLE_GENOME_VIEW_SCHEMA;
  readonly kind: 'indexed-genome-view';
  readonly id: string;
  readonly name: string;
  readonly provenance: PortableGenomeViewProvenance;
  readonly reference: PortableGenomeViewReference;
  readonly viewport: PortableGenomeViewViewport;
  readonly annotation: PortableGenomeViewAnnotationState;
  readonly tracks: ReadonlyArray<PortableGenomeViewTrack>;
}

type PortableGenomeViewMigrator = (
  input: Readonly<Record<string, unknown>>
) => Readonly<Record<string, unknown>>;

const MIGRATORS_BY_SCHEMA: ReadonlyMap<string, PortableGenomeViewMigrator> = new Map([
  ['dnaforge.genome-view.v1', (input) => ({ ...input, schema: PORTABLE_GENOME_VIEW_SCHEMA })],
]);

export function migratePortableGenomeViewDocument(input: unknown): PortableGenomeViewDocument {
  rejectUnsafePortableContent(input, '$');
  let candidate = record(input, 'Portable genome view');
  const visitedSchemas = new Set<string>();

  while (candidate.schema !== PORTABLE_GENOME_VIEW_SCHEMA) {
    const schema = requiredText(candidate.schema, 'Portable genome view schema', 100);
    if (visitedSchemas.has(schema)) {
      throw new Error(`Portable genome view migration cycle detected at schema ${schema}.`);
    }
    visitedSchemas.add(schema);
    const migrate = MIGRATORS_BY_SCHEMA.get(schema);
    if (!migrate) throw new Error(`Portable genome view has unsupported schema: ${schema}.`);
    candidate = migrate(candidate);
  }

  return parseV1(candidate);
}

export function parsePortableGenomeViewDocument(content: string): PortableGenomeViewDocument {
  if (utf8ByteLength(content) > MAX_PORTABLE_GENOME_VIEW_BYTES) {
    throw new Error(
      `Portable genome view exceeds the ${MAX_PORTABLE_GENOME_VIEW_BYTES}-byte input limit.`
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    throw new Error('Portable genome view is invalid JSON.');
  }
  return migratePortableGenomeViewDocument(input);
}

export function serializePortableGenomeViewDocument(document: PortableGenomeViewDocument): string {
  const validated = migratePortableGenomeViewDocument(document);
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  if (utf8ByteLength(serialized) > MAX_PORTABLE_GENOME_VIEW_BYTES) {
    throw new Error(
      `Portable genome view exceeds the ${MAX_PORTABLE_GENOME_VIEW_BYTES}-byte output limit.`
    );
  }
  return serialized;
}

function parseV1(input: Readonly<Record<string, unknown>>): PortableGenomeViewDocument {
  exactKeys(
    input,
    ['schema', 'kind', 'id', 'name', 'provenance', 'reference', 'viewport', 'annotation', 'tracks'],
    'Portable genome view'
  );
  if (input.schema !== PORTABLE_GENOME_VIEW_SCHEMA) {
    throw new Error(`Portable genome view has unsupported schema: ${String(input.schema)}.`);
  }
  if (input.kind !== 'indexed-genome-view') {
    throw new Error('Portable genome view kind must be indexed-genome-view.');
  }
  const reference = parseReference(input.reference);
  const provenance = parseProvenance(input.provenance);
  const tracks = array(input.tracks, 'Portable genome view tracks', MAX_TRACKS).map(
    (track, index) => parseTrack(track, index, reference.assemblyId)
  );
  requireUnique(
    tracks.map((track) => track.trackId),
    'Portable genome view has a duplicated track ID'
  );
  requireUnique(
    tracks.map((track) => track.order),
    'Portable genome view has a duplicated track order'
  );
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (track && track.order !== index) {
      throw new Error(
        `Portable genome view track ${track.trackId} order ${track.order} does not match array position ${index}.`
      );
    }
  }

  return {
    schema: PORTABLE_GENOME_VIEW_SCHEMA,
    kind: 'indexed-genome-view',
    id: identifier(input.id, 'Portable genome view ID'),
    name: requiredText(input.name, 'Portable genome view name'),
    provenance,
    reference,
    viewport: parseViewport(input.viewport),
    annotation: parseAnnotation(input.annotation),
    tracks,
  };
}

function parseProvenance(value: unknown): PortableGenomeViewProvenance {
  const input = record(value, 'Portable genome view provenance');
  exactKeys(input, ['createdAt', 'updatedAt', 'createdBy'], 'Portable genome view provenance');
  const createdAt = instant(input.createdAt, 'Portable genome view createdAt');
  const updatedAt = instant(input.updatedAt, 'Portable genome view updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('Portable genome view updatedAt cannot precede createdAt.');
  }
  const actor = record(input.createdBy, 'Portable genome view creator');
  exactKeys(actor, ['kind', 'id'], 'Portable genome view creator');
  if (actor.kind !== 'user' && actor.kind !== 'agent' && actor.kind !== 'system') {
    throw new Error('Portable genome view creator kind is invalid.');
  }
  return {
    createdAt,
    updatedAt,
    createdBy: {
      kind: actor.kind,
      ...(actor.id === undefined
        ? {}
        : { id: identifier(actor.id, 'Portable genome view creator ID') }),
    },
  };
}

function parseReference(value: unknown): PortableGenomeViewReference {
  const input = record(value, 'Portable genome view reference');
  if (input.kind === 'hosted-reference') {
    exactKeys(
      input,
      [
        'kind',
        'catalogId',
        'assemblyId',
        'bundleFingerprint',
        'sourceFingerprint',
        'inventoryFingerprint',
        'sequenceIdentity',
        'annotationIdentity',
      ],
      'Portable hosted reference',
      ['sequenceIdentity', 'annotationIdentity']
    );
    if ((input.sequenceIdentity === undefined) !== (input.annotationIdentity === undefined)) {
      throw new Error(
        'Portable hosted reference requires both sequence and annotation identities.'
      );
    }
    return {
      kind: 'hosted-reference',
      ...(input.sequenceIdentity === undefined
        ? {}
        : {
            sequenceIdentity: sha256Hex(
              input.sequenceIdentity,
              'Portable reference sequence identity'
            ),
            annotationIdentity: sha256Hex(
              input.annotationIdentity,
              'Portable reference annotation identity'
            ),
          }),
      catalogId: identifier(input.catalogId, 'Portable hosted reference catalog ID'),
      assemblyId: identifier(input.assemblyId, 'Portable hosted reference assembly ID'),
      bundleFingerprint: sha256Hex(
        input.bundleFingerprint,
        'Portable hosted reference bundle fingerprint'
      ),
      sourceFingerprint: sourceFingerprint(
        input.sourceFingerprint,
        'Portable hosted reference source fingerprint'
      ),
      inventoryFingerprint: sha256Hex(
        input.inventoryFingerprint,
        'Portable hosted reference inventory fingerprint'
      ),
    };
  }
  if (input.kind === 'workspace-reference') {
    exactKeys(
      input,
      [
        'kind',
        'entityId',
        'assemblyId',
        'contentFingerprint',
        'referenceSignature',
        'relativePathHint',
      ],
      'Portable workspace reference'
    );
    return {
      kind: 'workspace-reference',
      entityId: identifier(input.entityId, 'Portable workspace reference entity ID'),
      assemblyId: identifier(input.assemblyId, 'Portable workspace reference assembly ID'),
      contentFingerprint: prefixedSha256(
        input.contentFingerprint,
        'Portable workspace reference content fingerprint'
      ),
      referenceSignature: prefixedSha256(
        input.referenceSignature,
        'Portable workspace reference signature fingerprint'
      ),
      ...(input.relativePathHint === undefined
        ? {}
        : {
            relativePathHint: portableRelativePath(
              input.relativePathHint,
              'Portable workspace reference relativePathHint'
            ),
          }),
    };
  }
  throw new Error('Portable genome view reference kind is invalid.');
}

export function parsePortableGenomeViewReference(value: unknown): PortableGenomeViewReference {
  rejectUnsafePortableContent(value, '$.reference');
  return parseReference(value);
}

function parseViewport(value: unknown): PortableGenomeViewViewport {
  const input = record(value, 'Portable genome view viewport');
  if (input.kind === 'all') {
    exactKeys(input, ['kind'], 'Portable genome view all viewport');
    return { kind: 'all' };
  }
  if (input.kind === 'chromosome') {
    exactKeys(input, ['kind', 'chrom'], 'Portable genome view chromosome viewport');
    return {
      kind: 'chromosome',
      chrom: identifier(input.chrom, 'Portable genome view viewport chromosome'),
    };
  }
  if (input.kind === 'locus') {
    exactKeys(input, ['kind', 'chrom', 'start0', 'end0'], 'Portable genome view locus viewport');
    const start0 = safeInteger(input.start0, 'Portable genome view viewport start0', 0);
    const end0 = safeInteger(input.end0, 'Portable genome view viewport end0', 1);
    if (end0 <= start0) {
      throw new Error('Portable genome view viewport end0 must be greater than start0.');
    }
    return {
      kind: 'locus',
      chrom: identifier(input.chrom, 'Portable genome view viewport chromosome'),
      start0,
      end0,
    };
  }
  if (input.kind === 'assembly-range') {
    exactKeys(input, ['kind', 'start0', 'end0'], 'Portable genome view assembly-range viewport');
    const start0 = safeInteger(input.start0, 'Portable genome view viewport start0', 0);
    const end0 = safeInteger(input.end0, 'Portable genome view viewport end0', 1);
    if (end0 <= start0) {
      throw new Error('Portable genome view viewport end0 must be greater than start0.');
    }
    return { kind: 'assembly-range', start0, end0 };
  }
  throw new Error('Portable genome view viewport kind is invalid.');
}

function parseAnnotation(value: unknown): PortableGenomeViewAnnotationState {
  const input = record(value, 'Portable genome view annotation state');
  exactKeys(
    input,
    ['policy', 'visibilityByTrackId', 'orderedTrackIds'],
    'Portable genome view annotation state'
  );
  const policy = record(input.policy, 'Portable genome view annotation policy');
  exactKeys(policy, ['isoformMode', 'laneLimit'], 'Portable genome view annotation policy');
  if (policy.isoformMode !== 'canonical' && policy.isoformMode !== 'expanded') {
    throw new Error('Portable genome view annotation isoformMode is invalid.');
  }
  const laneLimit =
    policy.laneLimit === null
      ? null
      : safeInteger(policy.laneLimit, 'Portable genome view annotation laneLimit', 1, MAX_LANES);
  const visibility = record(
    input.visibilityByTrackId,
    'Portable genome view annotation visibility'
  );
  const visibilityEntries = Object.entries(visibility);
  if (visibilityEntries.length > MAX_ANNOTATION_TRACKS) {
    throw new Error(
      `Portable genome view annotation visibility exceeds ${MAX_ANNOTATION_TRACKS} tracks.`
    );
  }
  const validatedVisibilityEntries: Array<[string, boolean]> = visibilityEntries.map(
    ([trackId, visible]) => {
      const validatedId = annotationTrackId(trackId, 'Portable genome view annotation track ID');
      if (typeof visible !== 'boolean') {
        throw new Error(
          `Portable genome view annotation track ${validatedId} visibility is invalid.`
        );
      }
      return [validatedId, visible];
    }
  );
  const orderedTrackIds = array(
    input.orderedTrackIds,
    'Portable genome view annotation track order',
    MAX_ANNOTATION_TRACKS
  ).map((trackId) => annotationTrackId(trackId, 'Portable genome view annotation track order ID'));
  requireUnique(orderedTrackIds, 'Portable genome view annotation track order is duplicated');
  const visibilityTrackIds = new Set(validatedVisibilityEntries.map(([trackId]) => trackId));
  if (
    orderedTrackIds.length !== visibilityTrackIds.size ||
    orderedTrackIds.some((trackId) => !visibilityTrackIds.has(trackId))
  ) {
    throw new Error(
      'Portable genome view annotation visibility and order must name exactly the same tracks.'
    );
  }

  return {
    policy: { isoformMode: policy.isoformMode, laneLimit },
    visibilityByTrackId: Object.fromEntries(validatedVisibilityEntries),
    orderedTrackIds,
  };
}

function parseTrack(value: unknown, index: number, assemblyId: string): PortableGenomeViewTrack {
  const input = record(value, `Portable genome view track ${index + 1}`);
  exactKeys(
    input,
    ['trackId', 'trackType', 'label', 'order', 'visible', 'source', 'presentation'],
    `Portable genome view track ${index + 1}`
  );
  const trackId = identifier(input.trackId, `Portable genome view track ${index + 1} ID`);
  const order = safeInteger(input.order, `Portable genome view track ${trackId} order`, 0);
  if (typeof input.visible !== 'boolean') {
    throw new Error(`Portable genome view track ${trackId} visibility is invalid.`);
  }
  return {
    trackId,
    trackType: identifier(input.trackType, `Portable genome view track ${trackId} type`),
    label: requiredText(input.label, `Portable genome view track ${trackId} label`),
    order,
    visible: input.visible,
    source: parseTrackSource(input.source, trackId, assemblyId),
    presentation: parseTrackPresentation(input.presentation, trackId),
  };
}

function parseTrackSource(
  value: unknown,
  trackId: string,
  expectedAssemblyId: string
): PortableGenomeViewTrackSourceRef {
  const input = record(value, `Portable genome view track ${trackId} source`);
  if (input.kind === 'hosted-track') {
    exactKeys(
      input,
      ['kind', 'provider', 'catalogId', 'assemblyId', 'contentFingerprint', 'referenceSignature'],
      `Portable genome view hosted track ${trackId} source`
    );
    const assemblyId = identifier(
      input.assemblyId,
      `Portable genome view hosted track ${trackId} assembly ID`
    );
    requireAssemblyMatch(trackId, assemblyId, expectedAssemblyId);
    return {
      kind: 'hosted-track',
      provider: identifier(input.provider, `Portable genome view hosted track ${trackId} provider`),
      catalogId: identifier(
        input.catalogId,
        `Portable genome view hosted track ${trackId} catalog ID`
      ),
      assemblyId,
      contentFingerprint: prefixedSha256(
        input.contentFingerprint,
        `Portable genome view hosted track ${trackId} content fingerprint`
      ),
      referenceSignature: prefixedSha256(
        input.referenceSignature,
        `Portable genome view hosted track ${trackId} reference signature fingerprint`
      ),
    };
  }
  if (input.kind === 'workspace-track') {
    exactKeys(
      input,
      [
        'kind',
        'entityId',
        'assemblyId',
        'contentFingerprint',
        'referenceSignature',
        'relativePathHint',
      ],
      `Portable genome view workspace track ${trackId} source`
    );
    const assemblyId = identifier(
      input.assemblyId,
      `Portable genome view workspace track ${trackId} assembly ID`
    );
    requireAssemblyMatch(trackId, assemblyId, expectedAssemblyId);
    return {
      kind: 'workspace-track',
      entityId: identifier(
        input.entityId,
        `Portable genome view workspace track ${trackId} entity ID`
      ),
      assemblyId,
      contentFingerprint: prefixedSha256(
        input.contentFingerprint,
        `Portable genome view workspace track ${trackId} content fingerprint`
      ),
      referenceSignature: prefixedSha256(
        input.referenceSignature,
        `Portable genome view workspace track ${trackId} reference signature fingerprint`
      ),
      ...(input.relativePathHint === undefined
        ? {}
        : {
            relativePathHint: portableRelativePath(
              input.relativePathHint,
              `Portable genome view workspace track ${trackId} relativePathHint`
            ),
          }),
    };
  }
  if (input.kind === 'admitted-source') {
    exactKeys(
      input,
      ['kind', 'request', 'assemblyId', 'contentFingerprint', 'referenceSignature'],
      `Portable genome view admitted track ${trackId} source`
    );
    const assemblyId = identifier(
      input.assemblyId,
      `Portable genome view admitted track ${trackId} assembly ID`
    );
    requireAssemblyMatch(trackId, assemblyId, expectedAssemblyId);
    let request: TrackAdmissionRequestV1;
    try {
      request = parseTrackAdmissionRequestV1(input.request);
    } catch (error) {
      throw new Error(
        `Portable genome view admitted track ${trackId} request is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (request.assemblyId !== assemblyId) {
      throw new Error(
        `Portable genome view admitted track ${trackId} request names assembly ${request.assemblyId}, not ${assemblyId}.`
      );
    }
    return {
      kind: 'admitted-source',
      request,
      assemblyId,
      contentFingerprint: prefixedSha256(
        input.contentFingerprint,
        `Portable genome view admitted track ${trackId} content fingerprint`
      ),
      referenceSignature: prefixedSha256(
        input.referenceSignature,
        `Portable genome view admitted track ${trackId} reference signature fingerprint`
      ),
    };
  }
  throw new Error(`Portable genome view track ${trackId} source kind is invalid.`);
}

function parseTrackPresentation(
  value: unknown,
  trackId: string
): PortableGenomeViewTrackPresentation {
  const input = record(value, `Portable genome view track ${trackId} presentation`);
  if (input.kind === 'annotation') {
    exactKeys(
      input,
      ['kind', 'color', 'trackHeightPx', 'laneHeightPx', 'maxLanes'],
      `Portable genome view annotation track ${trackId} presentation`
    );
    return {
      kind: 'annotation',
      color: color(input.color, `Portable genome view annotation track ${trackId} color`),
      trackHeightPx: safeInteger(
        input.trackHeightPx,
        `Portable genome view annotation track ${trackId} height`,
        1,
        MAX_TRACK_HEIGHT_PX
      ),
      laneHeightPx: safeInteger(
        input.laneHeightPx,
        `Portable genome view annotation track ${trackId} lane height`,
        1,
        MAX_TRACK_HEIGHT_PX
      ),
      maxLanes: safeInteger(
        input.maxLanes,
        `Portable genome view annotation track ${trackId} max lanes`,
        1,
        MAX_LANES
      ),
    };
  }
  if (input.kind === 'quantitative') {
    exactKeys(
      input,
      ['kind', 'color', 'trackHeightPx', 'scale'],
      `Portable genome view quantitative track ${trackId} presentation`
    );
    return {
      kind: 'quantitative',
      color: color(input.color, `Portable genome view quantitative track ${trackId} color`),
      trackHeightPx: safeInteger(
        input.trackHeightPx,
        `Portable genome view quantitative track ${trackId} height`,
        1,
        MAX_TRACK_HEIGHT_PX
      ),
      scale: parseQuantitativeScale(input.scale, trackId),
    };
  }
  if (input.kind === 'aligned-reads') {
    exactKeys(
      input,
      ['kind', 'coverageCutoffDepth'],
      `Portable genome view aligned-read track ${trackId} presentation`
    );
    return {
      kind: 'aligned-reads',
      coverageCutoffDepth: finiteNumber(
        input.coverageCutoffDepth,
        `Portable genome view aligned-read track ${trackId} coverage cutoff`,
        0
      ),
    };
  }
  if (input.kind === 'variants') {
    exactKeys(
      input,
      ['kind', 'selectedSamples', 'filteredToPassing'],
      `Portable genome view variant track ${trackId} presentation`
    );
    const selectedSamples = array(
      input.selectedSamples,
      `Portable genome view variant track ${trackId} selected samples`,
      MAX_SAMPLES
    ).map((sample) => identifier(sample, `Portable genome view variant track ${trackId} sample`));
    requireUnique(
      selectedSamples,
      `Portable genome view variant track ${trackId} selected sample is duplicated`
    );
    if (typeof input.filteredToPassing !== 'boolean') {
      throw new Error(
        `Portable genome view variant track ${trackId} filteredToPassing is invalid.`
      );
    }
    return {
      kind: 'variants',
      selectedSamples,
      filteredToPassing: input.filteredToPassing,
    };
  }
  throw new Error(`Portable genome view track ${trackId} presentation kind is invalid.`);
}

function parseQuantitativeScale(
  value: unknown,
  trackId: string
): PortableGenomeViewQuantitativeScale {
  const input = record(value, `Portable genome view quantitative track ${trackId} scale`);
  if (input.kind === 'auto') {
    exactKeys(input, ['kind'], `Portable genome view quantitative track ${trackId} auto scale`);
    return { kind: 'auto' };
  }
  if (input.kind === 'fixed') {
    exactKeys(
      input,
      ['kind', 'min', 'max', 'transform'],
      `Portable genome view quantitative track ${trackId} fixed scale`
    );
    const min = finiteNumber(
      input.min,
      `Portable genome view quantitative track ${trackId} scale minimum`
    );
    const max = finiteNumber(
      input.max,
      `Portable genome view quantitative track ${trackId} scale maximum`
    );
    if (max <= min) {
      throw new Error(
        `Portable genome view quantitative track ${trackId} scale maximum must exceed minimum.`
      );
    }
    if (input.transform !== 'linear' && input.transform !== 'log') {
      throw new Error(
        `Portable genome view quantitative track ${trackId} scale transform is invalid.`
      );
    }
    if (input.transform === 'log' && min <= 0) {
      throw new Error(
        `Portable genome view quantitative track ${trackId} log scale minimum must be positive.`
      );
    }
    return { kind: 'fixed', min, max, transform: input.transform };
  }
  throw new Error(`Portable genome view quantitative track ${trackId} scale kind is invalid.`);
}

function rejectUnsafePortableContent(value: unknown, path: string): void {
  const pending: Array<{ value: unknown; path: string; depth: number; locators: boolean }> = [
    { value, path, depth: 0, locators: false },
  ];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.depth > MAX_DOCUMENT_DEPTH) {
      throw new Error(`Portable genome view exceeds the ${MAX_DOCUMENT_DEPTH}-level depth limit.`);
    }
    if (typeof current.value === 'string') {
      rejectUnsafePortableString(current.value, current.path, current.locators);
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        pending.push({
          value: current.value[index],
          path: `${current.path}[${index}]`,
          depth: current.depth + 1,
          locators: current.locators,
        });
      }
      continue;
    }
    const record = current.value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      rejectUnsafePortableString(key, `${current.path} key`, false);
      const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (FORBIDDEN_CREDENTIAL_KEYS.has(normalizedKey)) {
        throw new Error(
          `Portable genome view cannot contain credential field ${current.path}.${key}.`
        );
      }
      pending.push({
        value: child,
        path: `${current.path}.${key}`,
        depth: current.depth + 1,
        locators: current.locators || (record.kind === 'admitted-source' && key === 'request'),
      });
    }
  }
}

function rejectUnsafePortableString(value: string, path: string, locatorsAllowed: boolean): void {
  if (!locatorsAllowed && EMBEDDED_URI_LOCATOR.test(value)) {
    throw new Error(`Portable genome view cannot contain a URL locator at ${path}.`);
  }
  if (
    !locatorsAllowed &&
    (EMBEDDED_WINDOWS_DRIVE_ABSOLUTE_PATH.test(value) ||
      EMBEDDED_WINDOWS_UNC_ABSOLUTE_PATH.test(value) ||
      EMBEDDED_POSIX_ABSOLUTE_PATH.test(value))
  ) {
    throw new Error(`Portable genome view cannot contain an absolute path at ${path}.`);
  }
  if (SIGNED_URL_MARKER.test(value)) {
    throw new Error(`Portable genome view cannot contain a signed URL at ${path}.`);
  }
  if (/^(?:Bearer|Basic)\s/i.test(value)) {
    throw new Error(`Portable genome view cannot contain a credential at ${path}.`);
  }
  if (COMMON_CREDENTIAL_VALUES.some((pattern) => pattern.test(value))) {
    throw new Error(`Portable genome view cannot contain a credential value at ${path}.`);
  }
}

function exactKeys(
  input: Readonly<Record<string, unknown>>,
  allowed: ReadonlyArray<string>,
  context: string,
  optional: readonly string[] = []
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) throw new Error(`${context} has unsupported field: ${key}.`);
  }
  for (const key of allowed) {
    if (!(key in input) && !key.endsWith('Hint') && key !== 'id' && !optional.includes(key)) {
      throw new Error(`${context} is missing required field: ${key}.`);
    }
  }
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return Object.fromEntries(Object.entries(value));
}

function array(value: unknown, field: string, maximum: number): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length > maximum) throw new Error(`${field} exceeds the ${maximum}-item limit.`);
  return value;
}

function requiredText(value: unknown, field: string, maximum = MAX_TEXT_LENGTH): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  if (value !== value.trim()) throw new Error(`${field} cannot have surrounding whitespace.`);
  if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} characters.`);
  if (/\p{Cc}/u.test(value)) throw new Error(`${field} cannot contain control characters.`);
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = requiredText(value, field, MAX_IDENTIFIER_LENGTH);
  if (!IDENTIFIER.test(result)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
  return result;
}

function annotationTrackId(value: unknown, field: string): string {
  return requiredText(value, field, MAX_IDENTIFIER_LENGTH);
}

function sha256Hex(value: unknown, field: string): string {
  const result = requiredText(value, field, 64);
  if (!SHA256_HEX.test(result)) throw new Error(`${field} is an invalid SHA-256 fingerprint.`);
  return result;
}

function sourceFingerprint(value: unknown, field: string): string {
  const result = requiredText(value, field, 24);
  if (!SOURCE_FINGERPRINT.test(result)) throw new Error(`${field} is an invalid fingerprint.`);
  return result;
}

function prefixedSha256(value: unknown, field: string): string {
  const result = requiredText(value, field, 71);
  if (!result.startsWith('sha256:') || !SHA256_HEX.test(result.slice('sha256:'.length))) {
    throw new Error(`${field} is an invalid SHA-256 fingerprint.`);
  }
  return result;
}

function instant(value: unknown, field: string): string {
  const result = requiredText(value, field, 24);
  const epoch = Date.parse(result);
  if (
    !ISO_INSTANT.test(result) ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString() !== result
  ) {
    throw new Error(`${field} must be a canonical UTC timestamp.`);
  }
  return result;
}

function portableRelativePath(value: unknown, field: string): string {
  const result = requiredText(value, field, 1_024);
  if (result.startsWith('/') || result.startsWith('\\') || WINDOWS_ABSOLUTE_PATH.test(result)) {
    throw new Error(`${field} cannot be an absolute path.`);
  }
  if (result.includes('\\')) throw new Error(`${field} must use portable forward slashes.`);
  const segments = result.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`${field} cannot contain path traversal.`);
  }
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`${field} cannot contain empty path segments.`);
  }
  return result;
}

function safeInteger(value: unknown, field: string, minimum: number, maximum?: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new Error(
      `${field} must be a safe integer between ${minimum} and ${maximum ?? Number.MAX_SAFE_INTEGER}.`
    );
  }
  return value;
}

function finiteNumber(value: unknown, field: string, minimum?: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (minimum !== undefined && value < minimum)
  ) {
    throw new Error(
      `${field} must be a finite number${minimum === undefined ? '' : ` of at least ${minimum}`}.`
    );
  }
  return value;
}

function color(value: unknown, field: string): string {
  const result = requiredText(value, field, 7);
  if (!COLOR.test(result)) throw new Error(`${field} must be a lowercase six-digit hex color.`);
  return result;
}

function requireUnique<T>(values: ReadonlyArray<T>, message: string): void {
  const seen = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${message}: ${String(value)}.`);
    seen.add(value);
  }
}

function requireAssemblyMatch(
  trackId: string,
  assemblyId: string,
  expectedAssemblyId: string
): void {
  if (assemblyId !== expectedAssemblyId) {
    throw new Error(
      `Portable genome view track ${trackId} belongs to assembly ${assemblyId}, not ${expectedAssemblyId}.`
    );
  }
}

function utf8ByteLength(value: string): number {
  if (value.length > MAX_PORTABLE_GENOME_VIEW_BYTES) return value.length;
  return new TextEncoder().encode(value).byteLength;
}
