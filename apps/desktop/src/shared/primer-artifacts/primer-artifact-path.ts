import type { Primer } from './types';
export function primerArtifactRelativePath(primer: Primer): string | null {
  if (
    primer.originDetails?.authority !== 'primer_artifact' ||
    typeof primer.originDetails.artifactPath !== 'string'
  ) {
    return null;
  }
  return primer.originDetails.artifactPath;
}
