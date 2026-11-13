import { compactRawAnnotationsForTile } from '../../shared/genome-annotation-payload';
export { compactRawAnnotationsForTile } from '../../shared/genome-annotation-payload';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import type {
  GenomeFeature,
  IndexedGenomeManifest,
  ResolvedAnnotation,
} from '@waypoint/genome-data';
import type { GenomeTileRequest, GenomeTileCacheState } from '../../shared/indexed-genome';
import { TRANSCRIPT_RESOLUTION_CONTRACT_TOKEN } from '../../features/sequence/components/spliced-feature-resolver';
import {
  ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN,
  annotationLayerLabel,
  uniqueAnnotationLayerTypes,
} from '../../features/sequence/annotation-layer-identity';
import {
  fingerprintManifestFiles,
  sourceBuildFingerprint,
  type OverviewTileCacheDeps as OverviewTileFingerprintDeps,
} from './genome-overview-cache-fingerprint';

export type { OverviewSourceStat } from './genome-overview-cache-fingerprint';

export interface OverviewTileCacheDeps extends OverviewTileFingerprintDeps {
  rename(fromPath: string, toPath: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

export interface OverviewAnnotationTileResult {
  features: ResolvedAnnotation[];
  featureModel: 'resolved-transcript-v2';
  cacheState: GenomeTileCacheState;
  sourceRecordCount: number;
  sourceRepresentationComplete: true;
  layerTypes: string[];
}

export type OverviewAnnotationTileBuildStatus =
  | Readonly<{ status: 'cached'; result: OverviewAnnotationTileResult }>
  | Readonly<{ status: 'building'; completion: Promise<OverviewAnnotationTileResult> }>;

export type OverviewAnnotationTilePayload = Omit<
  OverviewAnnotationTileResult,
  'cacheState' | 'sourceRepresentationComplete'
>;

interface OverviewCachePayload {
  schemaVersion: 6;
  featureModel: 'resolved-transcript-v2';
  cacheContractToken: string;
  sourceBuildFingerprint: string;
  chrom: string;
  length: number | null;
  sourceFingerprint: string;
  sourceRecordCount: number;
  layerTypes: string[];
  createdAt: number;
  features: ResolvedAnnotation[];
}

const OVERVIEW_CACHE_SCHEMA_VERSION = 6;
export const OVERVIEW_CACHE_CONTRACT_TOKEN = [
  'resolved-transcript-v2-overview-v8-explicit-layer-contract',
  TRANSCRIPT_RESOLUTION_CONTRACT_TOKEN,
  ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN,
].join('|');

const DEFAULT_DEPS: OverviewTileCacheDeps = {
  mkdir,
  realpath,
  stat,
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, content) => writeFile(path, content, 'utf8'),
  rename,
  unlink,
};

const inflightBuilds = new Map<string, Promise<OverviewAnnotationTileResult>>();

export function overviewCachePathForManifest(manifest: IndexedGenomeManifest): string {
  const anchor = manifest.gffPath ?? manifest.fastaPath;
  return join(dirname(anchor), `${manifest.chrom}.annotation-overview.v8.json`);
}

export function isCacheableAnnotationOverviewRequest(
  manifest: IndexedGenomeManifest,
  request: GenomeTileRequest
): boolean {
  if (!manifest.gffPath || !manifest.tbiPath) return false;
  if (request.fidelity !== 'summary' || request.lod !== 0) return false;
  if (request.start > 0) return false;
  const expectedEnd = manifest.length ?? request.end;
  return request.end >= expectedEnd;
}

export async function getOrCreateAnnotationOverviewTile(input: {
  manifest: IndexedGenomeManifest;
  request: GenomeTileRequest;
  loadRawFeatures: () => Promise<GenomeFeature[]>;
  buildOverviewTile?: () => Promise<OverviewAnnotationTilePayload>;
  deps?: OverviewTileCacheDeps;
  now?: () => number;
}): Promise<OverviewAnnotationTileResult> {
  const deps = input.deps ?? DEFAULT_DEPS;
  const lookup = await lookupOverviewCache(input.manifest, deps);
  if (lookup.cached) return resultFromPayload(lookup.cached);

  return startAnnotationOverviewTileBuild({
    cachePath: lookup.cachePath,
    manifest: input.manifest,
    loadRawFeatures: input.loadRawFeatures,
    buildOverviewTile: input.buildOverviewTile,
    deps,
    sourceFingerprint: lookup.sourceFingerprint,
    sourceBuildFingerprint: lookup.sourceBuildFingerprint,
    now: input.now ?? Date.now,
  });
}

export async function getCachedAnnotationOverviewTile(input: {
  manifest: IndexedGenomeManifest;
  deps?: OverviewTileCacheDeps;
}): Promise<OverviewAnnotationTileResult | null> {
  const lookup = await lookupOverviewCache(input.manifest, input.deps ?? DEFAULT_DEPS);
  return lookup.cached ? resultFromPayload(lookup.cached) : null;
}

export async function getCachedOrStartAnnotationOverviewTileBuild(input: {
  manifest: IndexedGenomeManifest;
  loadRawFeatures?: () => Promise<GenomeFeature[]>;
  buildOverviewTile?: () => Promise<OverviewAnnotationTilePayload>;
  deps?: OverviewTileCacheDeps;
  now?: () => number;
}): Promise<OverviewAnnotationTileBuildStatus> {
  const deps = input.deps ?? DEFAULT_DEPS;
  const lookup = await lookupOverviewCache(input.manifest, deps);
  if (lookup.cached) {
    return { status: 'cached', result: resultFromPayload(lookup.cached) };
  }

  const completion = startAnnotationOverviewTileBuild({
    cachePath: lookup.cachePath,
    manifest: input.manifest,
    loadRawFeatures: input.loadRawFeatures,
    buildOverviewTile: input.buildOverviewTile,
    deps,
    sourceFingerprint: lookup.sourceFingerprint,
    sourceBuildFingerprint: lookup.sourceBuildFingerprint,
    now: input.now ?? Date.now,
  });
  void completion.catch(() => undefined);
  return { status: 'building', completion };
}

export function clearOverviewTileCacheLocksForTests(): void {
  inflightBuilds.clear();
}

async function lookupOverviewCache(
  manifest: IndexedGenomeManifest,
  deps: OverviewTileCacheDeps
): Promise<{
  cachePath: string;
  sourceFingerprint: string;
  sourceBuildFingerprint: string;
  cached: OverviewCachePayload | null;
}> {
  const cachePath = overviewCachePathForManifest(manifest);
  const sourceFingerprint = await fingerprintManifestFiles(manifest, deps);
  const buildFingerprint = sourceBuildFingerprint(deps);
  const cached = await readValidCache({
    cachePath,
    chrom: manifest.chrom,
    length: manifest.length ?? null,
    sourceFingerprint,
    sourceBuildFingerprint: buildFingerprint,
    deps,
  });
  return { cachePath, sourceFingerprint, sourceBuildFingerprint: buildFingerprint, cached };
}

function resultFromPayload(payload: OverviewCachePayload): OverviewAnnotationTileResult {
  return {
    features: payload.features,
    featureModel: payload.featureModel,
    cacheState: 'hit',
    sourceRecordCount: payload.sourceRecordCount,
    sourceRepresentationComplete: true,
    layerTypes: [...new Set(payload.layerTypes.map(annotationLayerLabel))],
  };
}

function startAnnotationOverviewTileBuild(input: {
  cachePath: string;
  manifest: IndexedGenomeManifest;
  loadRawFeatures?: () => Promise<GenomeFeature[]>;
  buildOverviewTile?: () => Promise<OverviewAnnotationTilePayload>;
  deps: OverviewTileCacheDeps;
  sourceFingerprint: string;
  sourceBuildFingerprint: string;
  now: () => number;
}): Promise<OverviewAnnotationTileResult> {
  const buildKey = `${input.cachePath}\n${input.sourceFingerprint}\n${input.sourceBuildFingerprint}`;
  const existingBuild = inflightBuilds.get(buildKey);
  if (existingBuild) return existingBuild;

  const build = buildAndWriteCache(input).finally(() => {
    inflightBuilds.delete(buildKey);
  });
  inflightBuilds.set(buildKey, build);
  return build;
}

async function buildAndWriteCache(input: {
  cachePath: string;
  manifest: IndexedGenomeManifest;
  loadRawFeatures?: () => Promise<GenomeFeature[]>;
  buildOverviewTile?: () => Promise<OverviewAnnotationTilePayload>;
  deps: OverviewTileCacheDeps;
  sourceFingerprint: string;
  sourceBuildFingerprint: string;
  now: () => number;
}): Promise<OverviewAnnotationTileResult> {
  const built = input.buildOverviewTile
    ? await input.buildOverviewTile()
    : input.loadRawFeatures
      ? buildOverviewAnnotationTileFromRawFeatures(await input.loadRawFeatures())
      : null;
  if (!built) {
    throw new Error('[genome] Overview tile build requires raw features or a worker payload.');
  }
  const payload: OverviewCachePayload = {
    schemaVersion: OVERVIEW_CACHE_SCHEMA_VERSION,
    featureModel: 'resolved-transcript-v2',
    cacheContractToken: OVERVIEW_CACHE_CONTRACT_TOKEN,
    sourceBuildFingerprint: input.sourceBuildFingerprint,
    chrom: input.manifest.chrom,
    length: input.manifest.length ?? null,
    sourceFingerprint: input.sourceFingerprint,
    sourceRecordCount: built.sourceRecordCount,
    layerTypes: built.layerTypes,
    createdAt: input.now(),
    features: built.features,
  };

  let cacheState: GenomeTileCacheState = 'written';
  try {
    await input.deps.mkdir(dirname(input.cachePath), { recursive: true });
    const serialized = JSON.stringify(payload);
    const temporaryPath = `${input.cachePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;
    let published = false;
    try {
      await input.deps.writeFile(temporaryPath, serialized);
      await input.deps.rename(temporaryPath, input.cachePath);
      published = true;
    } finally {
      if (!published) await input.deps.unlink(temporaryPath).catch(() => undefined);
    }
  } catch {
    cacheState = 'miss';
  }

  return {
    features: built.features,
    featureModel: 'resolved-transcript-v2',
    cacheState,
    sourceRecordCount: built.sourceRecordCount,
    sourceRepresentationComplete: true,
    layerTypes: built.layerTypes,
  };
}

export function buildOverviewAnnotationTileFromRawFeatures(
  rawFeatures: GenomeFeature[]
): OverviewAnnotationTilePayload {
  return {
    features: compactRawAnnotationsForTile(rawFeatures),
    featureModel: 'resolved-transcript-v2',
    sourceRecordCount: rawFeatures.length,
    layerTypes: uniqueAnnotationLayerTypes(rawFeatures),
  };
}

async function readValidCache(input: {
  cachePath: string;
  chrom: string;
  length: number | null;
  sourceFingerprint: string;
  sourceBuildFingerprint: string;
  deps: OverviewTileCacheDeps;
}): Promise<OverviewCachePayload | null> {
  let raw: string;
  try {
    raw = await input.deps.readFile(input.cachePath);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isOverviewCachePayload(parsed)) return null;
  if (parsed.cacheContractToken !== OVERVIEW_CACHE_CONTRACT_TOKEN) return null;
  if (parsed.sourceBuildFingerprint !== input.sourceBuildFingerprint) return null;
  if (parsed.chrom !== input.chrom) return null;
  if (parsed.length !== input.length) return null;
  if (parsed.sourceFingerprint !== input.sourceFingerprint) return null;
  return parsed;
}

function isOverviewCachePayload(value: unknown): value is OverviewCachePayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OverviewCachePayload>;
  return (
    candidate.schemaVersion === OVERVIEW_CACHE_SCHEMA_VERSION &&
    candidate.featureModel === 'resolved-transcript-v2' &&
    typeof candidate.cacheContractToken === 'string' &&
    typeof candidate.sourceBuildFingerprint === 'string' &&
    typeof candidate.chrom === 'string' &&
    (typeof candidate.length === 'number' || candidate.length === null) &&
    typeof candidate.sourceFingerprint === 'string' &&
    typeof candidate.sourceRecordCount === 'number' &&
    Array.isArray(candidate.layerTypes) &&
    candidate.layerTypes.every((layer) => typeof layer === 'string') &&
    Array.isArray(candidate.features)
  );
}
