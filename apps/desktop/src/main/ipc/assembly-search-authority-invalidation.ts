import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';
import { assemblyAnnotationSearchAuthority } from './assembly-annotation-search-authority';
import { assemblyProteinSearchAuthority } from './assembly-protein-search-authority';

export function invalidateResidentAssemblySearchAuthorities(
  source: AssemblyAnnotationSceneReadRequest
): void {
  assemblyAnnotationSearchAuthority.invalidate(source);
  assemblyProteinSearchAuthority.invalidate(source);
}
