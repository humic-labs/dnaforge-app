import type { AssemblyMethod, DesignRegion } from './types';

type RdFragmentType = DesignRegion['ggType'];

export function rdFragmentAssemblyBlockReason(
  assemblyMethod: AssemblyMethod,
  ggType: RdFragmentType
): string | null {
  if (assemblyMethod !== 'goldengate' || ggType === 'insert') {
    return null;
  }

  return `Cannot add ${ggType ?? 'non-insert'} fragment to assembly - only insert fragments are supported`;
}

export function canUseRdFragmentInAssembly(
  assemblyMethod: AssemblyMethod,
  ggType: RdFragmentType
): boolean {
  return rdFragmentAssemblyBlockReason(assemblyMethod, ggType) === null;
}
