import { isHomologyAssemblyMethod } from '../design/public/restriction-digest';
import type { SequenceDesign } from '../design/public/types';

export type AssemblyOptimizeSurface =
  | { kind: 'none' }
  | { kind: 'homology-one-click'; label: 'Auto optimize' }
  | { kind: 'goldengate-ranked'; label: 'Optimize overhangs' };

export function assemblyOptimizeSurface(design: SequenceDesign): AssemblyOptimizeSurface {
  if (design.regions.length < 2) return { kind: 'none' };

  if (design.assemblyMethod === 'goldengate') {
    if ((design.goldenGateJunctions?.length ?? 0) === 0) return { kind: 'none' };
    return { kind: 'goldengate-ranked', label: 'Optimize overhangs' };
  }

  if (isHomologyAssemblyMethod(design.assemblyMethod)) {
    if (design.homologyRegions.length === 0) return { kind: 'none' };
    return { kind: 'homology-one-click', label: 'Auto optimize' };
  }

  return { kind: 'none' };
}
