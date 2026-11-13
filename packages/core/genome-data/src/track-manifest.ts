import { SCIENTIFIC_TRACK_KINDS, type ScientificTrackKind } from './scientific-track-kind';
import { requireGenomicViewBinding } from './genomic-view-types';

export const TRACK_MANIFEST_V1 = 'dnaforge.track-manifest.v1' as const;
export const TRACK_MANIFEST_V2 = 'dnaforge.track-manifest.v2' as const;
export const TRACK_MANIFEST_MAX_BYTES = 1024 * 1024;
export const TRACK_MANIFEST_MAX_ARTIFACTS = 256;
export const TRACK_MANIFEST_MAX_VIEWS = 256;
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
  'sig',
  'signature',
  'token',
]);
const CREDENTIAL_QUERY_PREFIXES = ['x-amz-', 'x-goog-'];

export interface TrackManifestArtifactV1 {
  readonly path?: string;
  readonly url?: string;
}

export interface TrackManifestV1 {
  readonly contract: typeof TRACK_MANIFEST_V1;
  readonly assemblyId: string;
  readonly artifacts: ReadonlyArray<TrackManifestArtifactV1>;
}

export interface TrackManifestArtifactV2 {
  readonly id: string;
  readonly formatId: string;
  readonly scientificKind: ScientificTrackKind;
  readonly path?: string;
  readonly url?: string;
  readonly indexPath?: string;
  readonly indexUrl?: string;
  readonly referencePath?: string;
  readonly referenceUrl?: string;
  readonly label?: string;
}

export interface SignalReadPileupManifestViewV2 {
  readonly id: string;
  readonly kind: 'signal-read-pileup';
  readonly reads: string;
  readonly signal: string;
  readonly label?: string;
  readonly showSourceTracks?: boolean;
  readonly presentation?: {
    readonly color?: number;
    readonly heightPx?: number;
    readonly rowHeightPx?: number;
    readonly maxRows?: number;
    readonly coverageCutoffDepth?: number;
    readonly loadingAnimation?: 'diagonal-scan';
  };
}

export interface TrackManifestV2 {
  readonly contract: typeof TRACK_MANIFEST_V2;
  readonly assemblyId: string;
  readonly artifacts: ReadonlyArray<TrackManifestArtifactV2>;
  readonly views: ReadonlyArray<SignalReadPileupManifestViewV2>;
}

export type TrackManifest = TrackManifestV1 | TrackManifestV2;

export function decodeTrackManifest(text: string, expectedAssemblyId: string): TrackManifest {
  const value = parseTrackManifestValue(text);
  if (!isRecord(value)) throw new Error('The DNAForge track manifest must be an object.');
  if (value.contract === TRACK_MANIFEST_V1) {
    return decodeTrackManifestV1Value(value, expectedAssemblyId);
  }
  if (value.contract === TRACK_MANIFEST_V2) {
    return decodeTrackManifestV2Value(value, expectedAssemblyId);
  }
  throw new Error(`The file is not a ${TRACK_MANIFEST_V1} or ${TRACK_MANIFEST_V2} manifest.`);
}

export function decodeTrackManifestV1(text: string, expectedAssemblyId: string): TrackManifestV1 {
  const value = parseTrackManifestValue(text);
  return decodeTrackManifestV1Value(value, expectedAssemblyId);
}

function decodeTrackManifestV1Value(value: unknown, expectedAssemblyId: string): TrackManifestV1 {
  if (!isRecord(value) || value.contract !== TRACK_MANIFEST_V1) {
    throw new Error(`The file is not a ${TRACK_MANIFEST_V1} manifest.`);
  }
  rejectUnknownKeys(value, new Set(['contract', 'assemblyId', 'artifacts']), 'Track manifest');
  const assemblyId = requiredString(value.assemblyId, 'assemblyId');
  if (assemblyId !== expectedAssemblyId) {
    throw new Error(
      `This track manifest declares assembly ${assemblyId}, but the open reference is ${expectedAssemblyId}.`
    );
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > TRACK_MANIFEST_MAX_ARTIFACTS
  ) {
    throw new Error(
      `A track manifest must contain between 1 and ${TRACK_MANIFEST_MAX_ARTIFACTS} artifacts.`
    );
  }

  const identities = new Set<string>();
  const artifacts = value.artifacts.map((artifact, index) => {
    if (!isRecord(artifact)) throw new Error(`Artifact ${index + 1} must be an object.`);
    rejectUnknownKeys(artifact, new Set(['path', 'url']), `Artifact ${index + 1}`);
    const path = optionalString(artifact.path, `artifacts[${index}].path`);
    const url = optionalString(artifact.url, `artifacts[${index}].url`);
    if (Boolean(path) === Boolean(url)) {
      throw new Error(`Artifact ${index + 1} must provide exactly one path or URL.`);
    }
    if (path && isAbsolutePathLike(path)) {
      throw new Error(`Artifact ${index + 1} path must be relative to the manifest.`);
    }
    if (path && path.replace(/\\/g, '/').split('/').includes('..')) {
      throw new Error(`Artifact ${index + 1} may not traverse outside the manifest directory.`);
    }
    if (url) validatePublicArtifactUrl(url, index);
    const identity = path ? `path\u0000${path}` : `url\u0000${url}`;
    if (identities.has(identity)) throw new Error(`Track manifest contains a duplicate artifact.`);
    identities.add(identity);
    return path ? { path } : { url: url as string };
  });

  return { contract: TRACK_MANIFEST_V1, assemblyId, artifacts };
}

function decodeTrackManifestV2Value(
  value: Record<string, unknown>,
  expectedAssemblyId: string
): TrackManifestV2 {
  rejectUnknownKeys(
    value,
    new Set(['contract', 'assemblyId', 'artifacts', 'views']),
    'Track manifest'
  );
  const assemblyId = requiredString(value.assemblyId, 'assemblyId');
  if (assemblyId !== expectedAssemblyId) {
    throw new Error(
      `This track manifest declares assembly ${assemblyId}, but the open reference is ${expectedAssemblyId}.`
    );
  }
  if (
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > TRACK_MANIFEST_MAX_ARTIFACTS
  ) {
    throw new Error(
      `A track manifest must contain between 1 and ${TRACK_MANIFEST_MAX_ARTIFACTS} artifacts.`
    );
  }
  if (!Array.isArray(value.views) || value.views.length > TRACK_MANIFEST_MAX_VIEWS) {
    throw new Error(`A track manifest may contain at most ${TRACK_MANIFEST_MAX_VIEWS} views.`);
  }

  const sourceIdentities = new Set<string>();
  const artifactIds = new Set<string>();
  const artifacts = value.artifacts.map((artifact, index): TrackManifestArtifactV2 => {
    if (!isRecord(artifact)) throw new Error(`Artifact ${index + 1} must be an object.`);
    rejectUnknownKeys(
      artifact,
      new Set([
        'id',
        'formatId',
        'scientificKind',
        'path',
        'url',
        'indexPath',
        'indexUrl',
        'referencePath',
        'referenceUrl',
        'label',
      ]),
      `Artifact ${index + 1}`
    );
    const id = contractId(artifact.id, `artifacts[${index}].id`);
    if (artifactIds.has(id))
      throw new Error(`Track manifest contains duplicate artifact id ${id}.`);
    artifactIds.add(id);
    const formatId = contractId(artifact.formatId, `artifacts[${index}].formatId`);
    if (formatId !== formatId.toLowerCase()) {
      throw new Error(`artifacts[${index}].formatId must be lowercase.`);
    }
    const scientificKind = requiredScientificKind(
      artifact.scientificKind,
      `artifacts[${index}].scientificKind`
    );
    const path = optionalString(artifact.path, `artifacts[${index}].path`);
    const url = optionalString(artifact.url, `artifacts[${index}].url`);
    const indexPath = optionalString(artifact.indexPath, `artifacts[${index}].indexPath`);
    const indexUrl = optionalString(artifact.indexUrl, `artifacts[${index}].indexUrl`);
    const referencePath = optionalString(
      artifact.referencePath,
      `artifacts[${index}].referencePath`
    );
    const referenceUrl = optionalString(artifact.referenceUrl, `artifacts[${index}].referenceUrl`);
    const label = optionalLabel(artifact.label, `artifacts[${index}].label`);
    if (Boolean(path) === Boolean(url)) {
      throw new Error(`Artifact ${index + 1} must provide exactly one path or URL.`);
    }
    if (path) validateRelativePath(path, index, 'path');
    if (url) validatePublicArtifactUrl(url, index);
    if (indexPath && indexUrl) {
      throw new Error(`Artifact ${index + 1} must not provide both indexPath and indexUrl.`);
    }
    if (path && indexUrl) {
      throw new Error(`Artifact ${index + 1} with a local path requires a local indexPath.`);
    }
    if (url && indexPath) {
      throw new Error(`Artifact ${index + 1} with a URL requires an indexUrl.`);
    }
    if (referencePath && referenceUrl) {
      throw new Error(
        `Artifact ${index + 1} must not provide both referencePath and referenceUrl.`
      );
    }
    if (path && referenceUrl) {
      throw new Error(`Artifact ${index + 1} with a local path requires a local referencePath.`);
    }
    if (url && referencePath) {
      throw new Error(`Artifact ${index + 1} with a URL requires a referenceUrl.`);
    }
    if (indexPath) validateRelativePath(indexPath, index, 'index path');
    if (indexUrl) validatePublicArtifactUrl(indexUrl, index, 'index URL');
    if (referencePath) validateRelativePath(referencePath, index, 'reference path');
    if (referenceUrl) validatePublicArtifactUrl(referenceUrl, index, 'reference URL');
    if (scientificKind === 'reads' && !indexPath && !indexUrl) {
      throw new Error(`Artifact ${id} declares reads but has no explicit index.`);
    }
    const identity = path ? `path\u0000${path}` : `url\u0000${url}`;
    if (sourceIdentities.has(identity))
      throw new Error('Track manifest contains a duplicate artifact.');
    sourceIdentities.add(identity);
    return {
      id,
      formatId,
      scientificKind,
      ...(path ? { path } : { url: url as string }),
      ...(indexPath ? { indexPath } : {}),
      ...(indexUrl ? { indexUrl } : {}),
      ...(referencePath ? { referencePath } : {}),
      ...(referenceUrl ? { referenceUrl } : {}),
      ...(label ? { label } : {}),
    };
  });
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact] as const));

  const viewIds = new Set<string>();
  const viewSourcePairs = new Set<string>();
  const views = value.views.map((view, index): SignalReadPileupManifestViewV2 => {
    if (!isRecord(view)) throw new Error(`View ${index + 1} must be an object.`);
    rejectUnknownKeys(
      view,
      new Set(['id', 'kind', 'reads', 'signal', 'label', 'showSourceTracks', 'presentation']),
      `View ${index + 1}`
    );
    const id = contractId(view.id, `views[${index}].id`);
    if (viewIds.has(id)) throw new Error(`Track manifest contains duplicate view id ${id}.`);
    viewIds.add(id);
    if (view.kind !== 'signal-read-pileup') {
      throw new Error(`View ${id} has unsupported kind ${String(view.kind)}.`);
    }
    const reads = contractId(view.reads, `views[${index}].reads`);
    const signal = contractId(view.signal, `views[${index}].signal`);
    const readsArtifact = artifactsById.get(reads);
    if (!readsArtifact) throw new Error(`View ${id} names unknown reads artifact ${reads}.`);
    const signalArtifact = artifactsById.get(signal);
    if (!signalArtifact) {
      throw new Error(`View ${id} names unknown signal artifact ${signal}.`);
    }
    if (reads === signal)
      throw new Error(`View ${id} must use different reads and signal artifacts.`);
    const sourcePair = `${reads}\u0000${signal}`;
    if (viewSourcePairs.has(sourcePair)) {
      throw new Error('Track manifest contains a duplicate signal-to-reads source pair.');
    }
    viewSourcePairs.add(sourcePair);
    if (
      readsArtifact.scientificKind !== 'reads' ||
      !['bam', 'cram'].includes(readsArtifact.formatId)
    ) {
      throw new Error(`View ${id} reads artifact ${reads} must be BAM or CRAM reads.`);
    }
    if (signalArtifact.scientificKind !== 'quantitative' || signalArtifact.formatId !== 'bigwig') {
      throw new Error(`View ${id} signal artifact ${signal} must be quantitative BigWig.`);
    }
    requireGenomicViewBinding('signal-read-pileup-v1', {
      signal: {
        id: signalArtifact.id,
        assemblyId,
        scientificKind: signalArtifact.scientificKind,
        formatId: signalArtifact.formatId,
        regionalAccess: 'internal-index',
        quantitativeMeaning: 'unknown',
      },
      reads: {
        id: readsArtifact.id,
        assemblyId,
        scientificKind: readsArtifact.scientificKind,
        formatId: readsArtifact.formatId,
        regionalAccess:
          readsArtifact.indexPath || readsArtifact.indexUrl ? 'companion-index' : 'none',
      },
    });
    const label = optionalLabel(view.label, `views[${index}].label`);
    if (view.showSourceTracks !== undefined && typeof view.showSourceTracks !== 'boolean') {
      throw new Error(`views[${index}].showSourceTracks must be a boolean.`);
    }
    const presentation = decodeSignalReadPresentation(view.presentation, index);
    return {
      id,
      kind: 'signal-read-pileup',
      reads,
      signal,
      ...(label ? { label } : {}),
      ...(view.showSourceTracks !== undefined ? { showSourceTracks: view.showSourceTracks } : {}),
      ...(presentation ? { presentation } : {}),
    };
  });

  return { contract: TRACK_MANIFEST_V2, assemblyId, artifacts, views };
}

function parseTrackManifestValue(text: string): unknown {
  if (new TextEncoder().encode(text).length > TRACK_MANIFEST_MAX_BYTES) {
    throw new Error('The DNAForge track manifest is larger than 1 MiB.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('The DNAForge track manifest is not valid JSON.');
  }
}

function decodeSignalReadPresentation(
  value: unknown,
  viewIndex: number
): SignalReadPileupManifestViewV2['presentation'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`views[${viewIndex}].presentation must be an object.`);
  rejectUnknownKeys(
    value,
    new Set([
      'color',
      'heightPx',
      'rowHeightPx',
      'maxRows',
      'coverageCutoffDepth',
      'loadingAnimation',
    ]),
    `View ${viewIndex + 1} presentation`
  );
  const result: NonNullable<SignalReadPileupManifestViewV2['presentation']> = {
    ...(value.color !== undefined
      ? {
          color: boundedInteger(
            value.color,
            0,
            0xff_ffff,
            `views[${viewIndex}].presentation.color`
          ),
        }
      : {}),
    ...(value.heightPx !== undefined
      ? {
          heightPx: boundedInteger(
            value.heightPx,
            32,
            2_048,
            `views[${viewIndex}].presentation.heightPx`
          ),
        }
      : {}),
    ...(value.rowHeightPx !== undefined
      ? {
          rowHeightPx: boundedInteger(
            value.rowHeightPx,
            1,
            128,
            `views[${viewIndex}].presentation.rowHeightPx`
          ),
        }
      : {}),
    ...(value.maxRows !== undefined
      ? {
          maxRows: boundedInteger(
            value.maxRows,
            1,
            1_000,
            `views[${viewIndex}].presentation.maxRows`
          ),
        }
      : {}),
    ...(value.coverageCutoffDepth !== undefined
      ? {
          coverageCutoffDepth: boundedInteger(
            value.coverageCutoffDepth,
            1,
            1_000_000_000,
            `views[${viewIndex}].presentation.coverageCutoffDepth`
          ),
        }
      : {}),
  };
  if (value.loadingAnimation !== undefined) {
    if (value.loadingAnimation !== 'diagonal-scan') {
      throw new Error(`views[${viewIndex}].presentation.loadingAnimation is unsupported.`);
    }
    return { ...result, loadingAnimation: 'diagonal-scan' };
  }
  return result;
}

function validateRelativePath(path: string, index: number, subject: string): void {
  if (isAbsolutePathLike(path)) {
    throw new Error(`Artifact ${index + 1} ${subject} must be relative to the manifest.`);
  }
  if (path.replace(/\\/g, '/').split('/').includes('..')) {
    throw new Error(
      `Artifact ${index + 1} ${subject} may not traverse outside the manifest directory.`
    );
  }
}

function validatePublicArtifactUrl(rawUrl: string, index: number, subject = 'URL'): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Artifact ${index + 1} ${subject} is invalid.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`Artifact ${index + 1} ${subject} must use HTTP or HTTPS.`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`Artifact ${index + 1} ${subject} may not contain credentials or a fragment.`);
  }
  for (const key of parsed.searchParams.keys()) {
    const normalized = key.toLowerCase();
    if (
      CREDENTIAL_QUERY_KEYS.has(normalized) ||
      CREDENTIAL_QUERY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    ) {
      throw new Error(`Artifact ${index + 1} ${subject} may not contain credential parameters.`);
    }
  }
}

function isAbsolutePathLike(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  subject: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${subject} contains unsupported field ${unknown}.`);
}

function requiredString(value: unknown, field: string): string {
  const clean = optionalString(value, field);
  if (!clean) throw new Error(`${field} is required.`);
  return clean;
}

function contractId(value: unknown, field: string): string {
  const id = requiredString(value, field);
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new Error(`${field} must be a stable identifier of at most 128 characters.`);
  }
  return id;
}

function optionalLabel(value: unknown, field: string): string | undefined {
  const label = optionalString(value, field);
  if (label && label.length > 200) throw new Error(`${field} must be at most 200 characters.`);
  return label;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  const clean = value.trim();
  if (!clean) throw new Error(`${field} may not be empty.`);
  return clean;
}

function requiredScientificKind(value: unknown, field: string): ScientificTrackKind {
  if (typeof value !== 'string' || !SCIENTIFIC_TRACK_KINDS.has(value as ScientificTrackKind)) {
    throw new Error(`${field} is unsupported.`);
  }
  return value as ScientificTrackKind;
}
