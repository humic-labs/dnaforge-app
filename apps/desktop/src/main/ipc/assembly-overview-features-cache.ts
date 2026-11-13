import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import type { AssemblyOverviewChromInput } from '../../shared/indexed-genome';
import { joinPath } from '../../features/sequence/indexed-genome-paths';
import {
  ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN,
  computeAssemblyTextureFingerprint,
  type AssemblyTextureCacheDeps,
} from './assembly-overview-texture-cache';

export const ASSEMBLY_FEATURES_CACHE_VERSION = 2;

export type CachedOverviewFeaturesByChrom = Record<string, readonly unknown[]>;

export interface AssemblyFeaturesManifest {
  version: number;
  assemblyId: string;
  fingerprint: string;
  cacheContractToken: string;
  mode: string;
  featureCount: number;
}

export interface AssemblyFeaturesReadResult {
  rawFileJson: string;
  manifest: AssemblyFeaturesManifest;
}

export type AssemblyFeaturesCacheDeps = AssemblyTextureCacheDeps;

const defaultRead: NonNullable<AssemblyFeaturesCacheDeps['readFileImpl']> = (p) => readFile(p);
const defaultWrite: NonNullable<AssemblyFeaturesCacheDeps['writeFileImpl']> = async (p, d) => {
  const temporary = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, d);
    await rename(temporary, p);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};
const defaultMkdir: NonNullable<AssemblyFeaturesCacheDeps['mkdirImpl']> = async (d) => {
  await mkdir(d, { recursive: true });
};

function featuresCacheDir(workspaceRoot: string): string {
  return joinPath(workspaceRoot, '.waypoint', 'genome-index', 'assembly-overview');
}

function safeMode(mode: string): string {
  return mode.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'canonical';
}

function featuresPath(
  workspaceRoot: string,
  assemblyId: string,
  fingerprint: string,
  mode: string
): string {
  return joinPath(
    featuresCacheDir(workspaceRoot),
    `${assemblyId}-${fingerprint}-${safeMode(mode)}.features.json`
  );
}

function cacheContractToken(deps: Pick<AssemblyFeaturesCacheDeps, 'cacheContractToken'>): string {
  const token = deps.cacheContractToken?.trim();
  return token && token.length > 0 ? token : ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN;
}

const EXTENT_HEAVY_KEYS = new Set([
  'exons',
  'cds',
  '_resolvedExons',
  '_resolvedCds',
  'subFeatures',
  'children',
]);
function stripToExtents(byChrom: CachedOverviewFeaturesByChrom): CachedOverviewFeaturesByChrom {
  const out: Record<string, unknown[]> = {};
  for (const [chrom, list] of Object.entries(byChrom)) {
    if (!Array.isArray(list)) {
      out[chrom] = [];
      continue;
    }
    out[chrom] = list.map((feature) => {
      if (!feature || typeof feature !== 'object') return feature;
      const lite: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(feature as Record<string, unknown>)) {
        if (!EXTENT_HEAVY_KEYS.has(k)) lite[k] = v;
      }
      return lite;
    });
  }
  return out;
}

export async function readAssemblyOverviewFeaturesCache(
  input: {
    assemblyId: string;
    chromosomes: readonly AssemblyOverviewChromInput[];
    workspaceRoot: string;
    mode: string;
    overviewExtentsOnly?: boolean;
  },
  deps: AssemblyFeaturesCacheDeps
): Promise<AssemblyFeaturesReadResult | null> {
  try {
    if (!input?.assemblyId || !input?.workspaceRoot) return null;
    const fingerprint = await computeAssemblyTextureFingerprint(input.chromosomes, deps);
    if (!fingerprint) return null;
    const contractToken = cacheContractToken(deps);
    const readFn = deps.readFileImpl ?? defaultRead;
    const raw = await readFn(
      featuresPath(input.workspaceRoot, input.assemblyId, fingerprint, input.mode)
    );
    const rawFileJson = raw.toString('utf-8');
    const manifest = parseLeadingFeaturesManifest(rawFileJson);
    if (
      !manifest ||
      manifest.fingerprint !== fingerprint ||
      manifest.version !== ASSEMBLY_FEATURES_CACHE_VERSION ||
      manifest.cacheContractToken !== contractToken ||
      manifest.mode !== safeMode(input.mode) ||
      !hasByChromEnvelope(rawFileJson)
    ) {
      return null;
    }
    void stripToExtents;
    return { rawFileJson, manifest };
  } catch {
    return null;
  }
}

function parseLeadingFeaturesManifest(rawFileJson: string): AssemblyFeaturesManifest | null {
  const prefix = '{"manifest":';
  if (!rawFileJson.startsWith(prefix) || rawFileJson[prefix.length] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = prefix.length; index < rawFileJson.length; index += 1) {
    const char = rawFileJson[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(
            rawFileJson.slice(prefix.length, index + 1)
          ) as AssemblyFeaturesManifest;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function hasByChromEnvelope(rawFileJson: string): boolean {
  const marker = '},"byChrom":{';
  const markerIndex = rawFileJson.indexOf(marker, 12);
  return markerIndex > 0 && rawFileJson.endsWith('}}');
}

export async function writeAssemblyOverviewFeaturesCacheFromFragmentsV1(
  input: {
    assemblyId: string;
    chromosomes: readonly AssemblyOverviewChromInput[];
    workspaceRoot: string;
    mode: string;
    fragments: ReadonlyArray<readonly [string, string]>;
    featureCount: number;
  },
  deps: AssemblyFeaturesCacheDeps
): Promise<{ fingerprint: string; path: string; featureCount: number } | null> {
  try {
    if (!input?.assemblyId || !input?.workspaceRoot || !Array.isArray(input.fragments)) return null;
    const byChrom = new Map(input.fragments);
    if (byChrom.size !== input.fragments.length) return null;
    const fingerprint = await computeAssemblyTextureFingerprint(input.chromosomes, deps);
    if (!fingerprint) return null;
    const contractToken = cacheContractToken(deps);
    await (deps.mkdirImpl ?? defaultMkdir)(featuresCacheDir(input.workspaceRoot));
    const manifest: AssemblyFeaturesManifest = {
      version: ASSEMBLY_FEATURES_CACHE_VERSION,
      assemblyId: input.assemblyId,
      fingerprint,
      cacheContractToken: contractToken,
      mode: safeMode(input.mode),
      featureCount: input.featureCount,
    };
    const keyOrder = Object.keys(Object.fromEntries(input.fragments.map(([chrom]) => [chrom, 0])));
    const entries = keyOrder.map((chrom) => `${JSON.stringify(chrom)}:${byChrom.get(chrom)}`);
    const path = featuresPath(input.workspaceRoot, input.assemblyId, fingerprint, input.mode);
    await (deps.writeFileImpl ?? defaultWrite)(
      path,
      `{"manifest":${JSON.stringify(manifest)},"byChrom":{${entries.join(',')}}}`
    );
    return { fingerprint, path, featureCount: input.featureCount };
  } catch {
    return null;
  }
}

export async function writeAssemblyOverviewFeaturesCache(
  input: {
    assemblyId: string;
    chromosomes: readonly AssemblyOverviewChromInput[];
    workspaceRoot: string;
    mode: string;
    byChrom: CachedOverviewFeaturesByChrom;
  },
  deps: AssemblyFeaturesCacheDeps
): Promise<{ fingerprint: string; path: string; featureCount: number } | null> {
  try {
    if (!input?.assemblyId || !input?.workspaceRoot || !input?.byChrom) return null;
    const fingerprint = await computeAssemblyTextureFingerprint(input.chromosomes, deps);
    if (!fingerprint) return null;
    const contractToken = cacheContractToken(deps);
    await (deps.mkdirImpl ?? defaultMkdir)(featuresCacheDir(input.workspaceRoot));
    const featureCount = Object.values(input.byChrom).reduce(
      (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
      0
    );
    const manifest: AssemblyFeaturesManifest = {
      version: ASSEMBLY_FEATURES_CACHE_VERSION,
      assemblyId: input.assemblyId,
      fingerprint,
      cacheContractToken: contractToken,
      mode: safeMode(input.mode),
      featureCount,
    };
    const path = featuresPath(input.workspaceRoot, input.assemblyId, fingerprint, input.mode);
    await (deps.writeFileImpl ?? defaultWrite)(
      path,
      JSON.stringify({ manifest, byChrom: input.byChrom })
    );
    return { fingerprint, path, featureCount };
  } catch {
    return null;
  }
}
