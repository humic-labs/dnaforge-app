import type { ComparisonSourceDescriptor } from '../../shared/comparison-source';

export const NATIVE_COMPARISON_FIXTURE: ComparisonSourceDescriptor = {
  schema: 'dnaforge.comparison-source.v1',
  path: 'genome-view-prototypes/MG1655-Shigella2457T-gapped.paf',
  sha256: '87a00a4f29828486d242fdc9abc89ffb2309b08654f99b8c75e042500aabc211',
  targetReference: {
    id: 'NC_000913.3',
    chrom: 'NC_000913.3',
    length: 4_641_652,
    label: 'E. coli MG1655 · NC_000913.3',
  },
  queryReference: {
    id: 'NC_004741.1',
    chrom: 'NC_004741.1',
    length: 4_599_354,
    label: 'Shigella flexneri 2457T · NC_004741.1',
  },
};
