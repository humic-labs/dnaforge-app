import { stat } from 'fs/promises';
import type {
  AssemblyOverviewChromInput,
  AssemblyOverviewChromResult,
  AssemblyOverviewResult,
  IndexedGenomeManifest,
} from '../../shared/indexed-genome';
import { buildIndexedGenomePaths } from '../../features/sequence/indexed-genome-paths';
import { getCachedAnnotationOverviewTile } from './genome-overview-tile-cache';

export type { AssemblyOverviewChromInput } from '../../shared/indexed-genome';

const ASSEMBLY_OVERVIEW_READ_CONCURRENCY = 4;

interface CachedOverviewPayload {
  features: AssemblyOverviewChromResult['features'];
  layerTypes: string[];
}

export interface AssemblyOverviewDeps {
  assertSafePath: (filePath: string) => Promise<void>;
  statSource?: (filePath: string) => Promise<{ size: number; mtimeMs: number; ctimeMs?: number }>;
  readCachedOverview?: (manifest: IndexedGenomeManifest) => Promise<CachedOverviewPayload | null>;
}

const defaultStatSource: NonNullable<AssemblyOverviewDeps['statSource']> = (filePath) =>
  stat(filePath);

const defaultReadCachedOverview: NonNullable<AssemblyOverviewDeps['readCachedOverview']> = async (
  manifest
) => {
  const tile = await getCachedAnnotationOverviewTile({ manifest });
  return tile ? { features: tile.features, layerTypes: tile.layerTypes } : null;
};

const missResult = (chrom: string): AssemblyOverviewChromResult => ({
  chrom,
  features: [],
  layerTypes: [],
  cacheState: 'miss',
});

export function allMissResult(
  chromosomes: readonly AssemblyOverviewChromInput[]
): AssemblyOverviewResult {
  const byChrom: Record<string, AssemblyOverviewChromResult> = {};
  for (const c of chromosomes) byChrom[c.chrom] = missResult(c.chrom);
  return { byChrom, hits: 0, misses: chromosomes.length };
}

async function readOneChromOverview(
  c: AssemblyOverviewChromInput,
  workspaceRoot: string,
  deps: AssemblyOverviewDeps
): Promise<AssemblyOverviewChromResult> {
  try {
    const sourcePath = c.sourcePath;
    if (!sourcePath) return missResult(c.chrom);
    await deps.assertSafePath(sourcePath);
    let full: IndexedGenomeManifest;
    if (c.manifest) {
      if (
        c.manifest.chrom !== c.chrom ||
        (c.manifest.length != null && c.manifest.length !== c.length) ||
        !c.manifest.gffPath ||
        !c.manifest.tbiPath
      ) {
        return missResult(c.chrom);
      }
      for (const path of [
        c.manifest.fastaPath,
        c.manifest.faiPath,
        c.manifest.gffPath,
        c.manifest.tbiPath,
      ]) {
        await deps.assertSafePath(path);
      }
      full = { ...c.manifest, length: c.length };
    } else {
      const st = await (deps.statSource ?? defaultStatSource)(sourcePath);
      const { manifest } = buildIndexedGenomePaths({
        sourcePath,
        workspaceRoot,
        sizeBytes: st.size,
        sourceMtimeMs: st.mtimeMs,
        sourceCtimeMs: st.ctimeMs,
      });
      full = { ...manifest, length: c.length };
    }
    const tile = await (deps.readCachedOverview ?? defaultReadCachedOverview)(full);
    if (tile) {
      return {
        chrom: c.chrom,
        features: tile.features,
        layerTypes: tile.layerTypes,
        cacheState: 'hit',
      };
    }
  } catch {}
  return missResult(c.chrom);
}

export async function readAssemblyOverviewCaches(
  input: { chromosomes: readonly AssemblyOverviewChromInput[]; workspaceRoot: string },
  deps: AssemblyOverviewDeps
): Promise<AssemblyOverviewResult> {
  if (!Array.isArray(input?.chromosomes)) return { byChrom: {}, hits: 0, misses: 0 };

  const queue = [...input.chromosomes];
  const collected: AssemblyOverviewChromResult[] = [];
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      collected.push(await readOneChromOverview(c, input.workspaceRoot, deps));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(ASSEMBLY_OVERVIEW_READ_CONCURRENCY, queue.length) }, worker)
  );

  const byChrom: Record<string, AssemblyOverviewChromResult> = {};
  let hits = 0;
  let misses = 0;
  for (const e of collected) {
    byChrom[e.chrom] = e;
    if (e.cacheState === 'hit') hits += 1;
    else misses += 1;
  }
  return { byChrom, hits, misses };
}
