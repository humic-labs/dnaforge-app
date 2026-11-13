import type { ChromosomeMorphologyV1, GenomeAssembly } from '@waypoint/genome-data';
import { buildAssembly, type Assembly, type Chromosome } from '@waypoint/genome-renderer';

import { chromosomeForChrom } from '../tracks/cytobands';

export function projectGenomeAssemblyToRendererAssembly(assembly: GenomeAssembly): Assembly {
  const chromosomes: Chromosome[] = assembly.chromosomes.map((sequence) => {
    const registered = sequence.cytobandId ? chromosomeForChrom(sequence.cytobandId) : null;
    const registeredMatches = registered?.length === sequence.length;
    return {
      id: sequence.chrom,
      displayName: sequence.displayName,
      length: sequence.length,
      cytobands: registeredMatches ? registered.cytobands : [],
      morphology: rendererMorphology(sequence),
    };
  });
  return buildAssembly(assembly.assemblyId, assembly.displayName, chromosomes);
}

function rendererMorphology(
  sequence: GenomeAssembly['chromosomes'][number]
): ChromosomeMorphologyV1 {
  if (
    (sequence.role !== undefined && sequence.role !== 'assembled-molecule') ||
    sequence.circular === true
  ) {
    return { kind: 'generic-contig', reason: 'ineligible-member' };
  }
  const morphology = sequence.morphology;
  if (!morphology) return { kind: 'generic-contig', reason: 'missing-semantics' };
  if (morphology.kind === 'localized-boundary') {
    const { positionBp, topology } = morphology;
    if (
      !Number.isSafeInteger(positionBp) ||
      positionBp < 0 ||
      positionBp > sequence.length ||
      (topology === 'internal' && (positionBp === 0 || positionBp === sequence.length)) ||
      (topology === 'terminal-start' && positionBp !== 0) ||
      (topology === 'terminal-end' && positionBp !== sequence.length)
    ) {
      return { kind: 'generic-contig', reason: 'ambiguous-evidence' };
    }
    return morphology;
  }
  if (morphology.kind !== 'localized') return morphology;
  const { startBp, endBp } = morphology.interval;
  if (
    !Number.isSafeInteger(startBp) ||
    !Number.isSafeInteger(endBp) ||
    startBp < 0 ||
    endBp <= startBp ||
    endBp > sequence.length
  ) {
    return { kind: 'generic-contig', reason: 'ambiguous-evidence' };
  }
  return morphology;
}

export function resolveRendererAssembly(
  assemblyChromIds: ReadonlyArray<string> | undefined,
  assemblyDefinition: GenomeAssembly | undefined
): Assembly | null {
  if (!assemblyChromIds || assemblyChromIds.length < 1) return null;

  if (assemblyDefinition) {
    const definitionChromIds = assemblyDefinition.chromosomes.map((sequence) => sequence.chrom);
    if (
      definitionChromIds.length !== assemblyChromIds.length ||
      definitionChromIds.some((id, index) => id !== assemblyChromIds[index])
    ) {
      return null;
    }
    return projectGenomeAssemblyToRendererAssembly(assemblyDefinition);
  }

  const registered = assemblyChromIds
    .map((id) => chromosomeForChrom(id))
    .filter((chromosome): chromosome is Chromosome => chromosome != null);
  if (registered.length !== assemblyChromIds.length) return null;
  return buildAssembly(assemblyChromIds.join('+'), assemblyChromIds.join(', '), registered);
}
