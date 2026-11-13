import type { LimsStrainGenomeSummary } from './lims';

export function registryConfidenceLabel(summary: LimsStrainGenomeSummary): string {
  if (summary.verifiedGenome && summary.gap.status === 'mismatch')
    return 'WGS verified with mismatch';
  if (summary.verifiedGenome && summary.gap.status === 'match') return 'WGS verified';
  if (summary.verifiedGenome) return 'WGS linked';
  if (summary.hypothesisGenome) return 'Genome hypothesis supplied';
  if (summary.parentGenome) return 'Parent genome referenced';
  return 'No genome linked';
}
