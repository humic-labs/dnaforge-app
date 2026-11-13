# @waypoint/genome-data

Indexed genome data layer for .

Bounded reference-interval actions  live in
`src/reference-interval-action.ts`. That kernel is renderer-independent: exact
window reads, reverse complement, six-frame translation, spliced CDS
translation, and IUPAC search all go through `GenomeDataSource` plus
`@waypoint/sequence-utils`. MCP and a future UI command must call it rather than
reimplementing the biology.

This package reads sidecar-generated genome indexes:

- FASTA sequence: `.fa` + `.fa.fai`
- GenBank / GBFF annotations converted to bgzipped GFF3: `.gff3.gz` + `.tbi`

The default test target covers real public/reference data across the easy and
medium matrix. No generated synthetic fixtures are used by this package.

- GenBank flat file: `test-fixtures/sequences/circular/pUC19.gb`
- GenBank flat file: `test-fixtures/sequences/linear/ecoli-mg1655-region.gb`
- GBFF: `test-fixtures/genomes/yeast-chrIV/chrIV.gbff`
- FASTA-only: derived at test time from the real MG1655 region fixture
- Boundary ranges, unknown chromosomes, featureless FASTA, LRU eviction, mtime
  cache invalidation, worker request/response flow, streaming search caps and
  cancellation.

The stress target covers larger real fixtures:

- GBFF: `test-fixtures/genomes/yeast-chrIV/chrIV.gbff` (1.5 Mb chromosome)
- GenBank flat file: `test-fixtures/sequences/circular/ecoli-mg1655-complete.gb`
  (4.6 Mb circular genome, ~10k features)

Human indexed-assembly behavior is covered by the Electron complete-GRCh38
acceptance gates. Package-level chromosome slices are not accepted as
full-assembly evidence.

Commands:

```bash
pnpm --filter @waypoint/genome-data test
pnpm --filter @waypoint/genome-data test:stress
pnpm --filter @waypoint/genome-data typecheck
```

See `test-fixtures/genomes/SIZE_STACK.md` for the full fixture ladder.
