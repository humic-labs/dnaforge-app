import type { AssemblyAccession, SourceId } from '../ids';
import type { TranscriptionUnitRecord } from '../records';
import type { AnnotationSourceDefinition, GeneModel } from '../sources';

export interface OperonsByDistanceOptions {
  readonly maxGapBp: number;
  readonly minGenes: number;
}

export function predictOperonsByDistance(input: {
  readonly genes: readonly GeneModel[];
  readonly options: OperonsByDistanceOptions;
  readonly idPrefix: string;
}): TranscriptionUnitRecord[] {
  const genes = input.genes
    .filter((gene) => gene.end > gene.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const units: TranscriptionUnitRecord[] = [];
  let run: GeneModel[] = [];

  const flush = () => {
    if (run.length >= input.options.minGenes) {
      const ordered = run[0].strand === '+' ? run : [...run].reverse();
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const locusTags = ordered.flatMap((gene) => (gene.locusTag ? [gene.locusTag] : []));
      units.push({
        id: `${input.idPrefix}:${first.locusTag ?? first.name}-${last.locusTag ?? last.name}`,
        kind: 'transcription_unit',
        strand: first.strand,
        location: {
          shape: 'region',
          start: Math.min(...run.map((g) => g.start)),
          end: Math.max(...run.map((g) => g.end)),
        },
        genes: ordered.map((gene) => gene.name),
        geneLocusTags: locusTags.length === ordered.length ? locusTags : [],
        endEvidence: 'gene-derived',
        name: null,
        score: null,
        conditions: [],
      });
    }
    run = [];
  };

  for (const gene of genes) {
    const previous = run[run.length - 1];
    if (
      previous &&
      (gene.strand !== previous.strand || gene.start - previous.end > input.options.maxGapBp)
    ) {
      flush();
    }
    run.push(gene);
  }
  flush();
  return units;
}

export function operonsByDistanceSource(input: {
  readonly id: SourceId;
  readonly assembly: AssemblyAccession;
  readonly options: OperonsByDistanceOptions;
}): AnnotationSourceDefinition {
  const { maxGapBp, minGenes } = input.options;
  return {
    id: input.id,
    label: `Predicted operons (gap ≤ ${maxGapBp} bp)`,
    kinds: ['transcription_unit'],
    assembly: input.assembly,
    evidence: 'computed',
    derivedFrom: [],
    availability: { status: 'available' },
    provenance: {
      citation:
        'Method: Salgado H, Moreno-Hagelsieb G, Smith TF, Collado-Vides J (2000) Operons in Escherichia coli: genomic analyses and predictions. PNAS 97:6652-6657.',
      url: 'https://doi.org/10.1073/pnas.110147297',
      doi: '10.1073/pnas.110147297',
      datasetVersion: `same-strand neighbours, gap ≤ ${maxGapBp} bp, ≥ ${minGenes} genes, genes from the open document`,
      liftedFrom: null,
      license: {
        spdx: 'LicenseRef-DNAForge-generated',
        attribution: 'Predicted by DNAForge from gene spacing in the open document.',
        evidenceUrl: null,
      },
    },
    load: async (context) =>
      predictOperonsByDistance({
        genes: context.genes,
        options: input.options,
        idPrefix: input.id,
      }),
  };
}
