import { isCustomGeneticCodeSpec, type GeneticCodeSpec } from '@waypoint/sequence-utils';

export function geneticCodeChangeSubject(geneticCode: GeneticCodeSpec | null): string {
  if (geneticCode === null) return 'genetic code (cleared; back to what the file declares)';
  if (isCustomGeneticCodeSpec(geneticCode)) {
    return `genetic code (${geneticCode.name}, revision ${geneticCode.revision})`;
  }
  return `genetic code (${geneticCode})`;
}
