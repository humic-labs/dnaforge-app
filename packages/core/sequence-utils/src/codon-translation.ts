import { expandDegenerateSequence, IUPAC_EXPANSION } from './iupac';
import {
  resolveGeneticCode,
  STANDARD_GENETIC_CODE_ID,
  type GeneticCode,
  type GeneticCodeInput,
} from './genetic-codes';

const DEGENERATE_CODON_CACHES = new WeakMap<GeneticCode, Map<string, string>>();

function degenerateCacheFor(geneticCode: GeneticCode): Map<string, string> {
  let cache = DEGENERATE_CODON_CACHES.get(geneticCode);
  if (!cache) {
    cache = new Map<string, string>();
    DEGENERATE_CODON_CACHES.set(geneticCode, cache);
  }
  return cache;
}

function isCacheableCodon(upper: string): boolean {
  if (upper.length !== 3) return false;
  for (const ch of upper) {
    if (!IUPAC_EXPANSION[ch]) return false;
  }
  return true;
}

export function translateCodon(codon: string, geneticCode?: GeneticCodeInput): string {
  const code = resolveGeneticCode(geneticCode);
  const upper = codon.toUpperCase();

  const direct = code.codonTable[upper];
  if (direct) return direct;

  const cacheable = isCacheableCodon(upper);
  const cache = cacheable ? degenerateCacheFor(code) : undefined;
  if (cache) {
    const cached = cache.get(upper);
    if (cached !== undefined) return cached;
  }

  const resolved = resolveDegenerateCodon(upper, code);
  if (cache) cache.set(upper, resolved);
  return resolved;
}

function resolveDegenerateCodon(upper: string, code: GeneticCode): string {
  const expansions = expandDegenerateSequence(upper, { maxCombinations: 64 });
  if (!expansions || expansions.length === 0) return 'X';

  if (expansions[0].length !== 3) return 'X';

  const first = code.codonTable[expansions[0]];
  if (!first) return 'X';
  for (const concrete of expansions) {
    if (code.codonTable[concrete] !== first) return 'X';
  }
  return first;
}

export function degenerateCodonCacheSizeForTest(
  geneticCode: GeneticCodeInput = STANDARD_GENETIC_CODE_ID
): number {
  return DEGENERATE_CODON_CACHES.get(resolveGeneticCode(geneticCode))?.size ?? 0;
}
