import type { Chromosome } from './chromosome';
import type { Assembly, AssemblyChromosomePlacement, AssemblyLocus } from './assembly';

export function buildAssembly(
  id: string,
  displayName: string,
  chromosomes: ReadonlyArray<Chromosome>
): Assembly {
  const placements: AssemblyChromosomePlacement[] = [];
  let cursor = 0;
  for (let order = 0; order < chromosomes.length; order++) {
    const chromosome = chromosomes[order];
    const globalStartBp = cursor;
    const globalEndBp = cursor + chromosome.length;
    placements.push({ chromosome, globalStartBp, globalEndBp, order });
    cursor = globalEndBp;
  }
  return {
    id,
    displayName,
    chromosomes: placements,
    totalLengthBp: cursor,
  };
}

export function globalBpToChrom(assembly: Assembly, globalBp: number): AssemblyLocus | null {
  if (!Number.isFinite(globalBp) || globalBp < 0 || globalBp >= assembly.totalLengthBp) {
    return null;
  }
  const ps = assembly.chromosomes;
  let lo = 0;
  let hi = ps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const p = ps[mid];
    if (globalBp < p.globalStartBp) {
      hi = mid - 1;
    } else if (globalBp >= p.globalEndBp) {
      lo = mid + 1;
    } else {
      return { chrom: p.chromosome.id, localBp: globalBp - p.globalStartBp, placement: p };
    }
  }
  return null;
}

export function chromLocalBpToGlobal(
  assembly: Assembly,
  chrom: string,
  localBp: number
): number | null {
  const p = placementForChrom(assembly, chrom);
  if (!p) return null;
  if (!Number.isFinite(localBp) || localBp < 0 || localBp > p.chromosome.length) {
    return null;
  }
  return p.globalStartBp + localBp;
}

export function placementForChrom(
  assembly: Assembly,
  chrom: string
): AssemblyChromosomePlacement | null {
  for (const p of assembly.chromosomes) {
    if (p.chromosome.id === chrom) return p;
  }
  return null;
}

export function placementsInGlobalRange(
  assembly: Assembly,
  startBp: number,
  endBp: number
): AssemblyChromosomePlacement[] {
  if (endBp <= startBp) return [];
  const out: AssemblyChromosomePlacement[] = [];
  for (const p of assembly.chromosomes) {
    if (p.globalStartBp < endBp && p.globalEndBp > startBp) out.push(p);
  }
  return out;
}

export interface AssemblySegment {
  chrom: string;
  localStart: number;
  localEnd: number;
  globalStart: number;
  placement: AssemblyChromosomePlacement;
}

export function globalRangeToSegments(
  assembly: Assembly,
  startBp: number,
  endBp: number
): AssemblySegment[] {
  if (!Number.isFinite(startBp) || !Number.isFinite(endBp) || endBp <= startBp) return [];
  const out: AssemblySegment[] = [];
  for (const p of assembly.chromosomes) {
    if (p.globalStartBp >= endBp || p.globalEndBp <= startBp) continue;
    const localStart = Math.max(0, startBp - p.globalStartBp);
    const localEnd = Math.min(p.chromosome.length, endBp - p.globalStartBp);
    if (localEnd <= localStart) continue;
    out.push({
      chrom: p.chromosome.id,
      localStart,
      localEnd,
      globalStart: p.globalStartBp,
      placement: p,
    });
  }
  return out;
}
