#  Genome Fixture Size Stack

 genome-data tests use public/reference biological files, plus FASTA
files derived from those references at test time. Generated synthetic fixtures
are not part of the genome-data worker or sidecar indexer coverage.

| Tier   | Fixture                                                     | Format  |           Size | Source                            | Coverage                                                                    |
| ------ | ----------------------------------------------------------- | ------- | -------------: | --------------------------------- | --------------------------------------------------------------------------- |
| XS     | `test-fixtures/sequences/circular/pUC19.gb`                 | GenBank |       2,686 bp | Public pUC19 GenBank fixture      | Circular topology, origin-split features, compound CDS, small random access |
| S      | `test-fixtures/sequences/linear/ecoli-mg1655-region.gb`     | GenBank |      78,345 bp | Public E. coli K-12 MG1655 region | Linear bacterial density, FASTA-only derived indexing, search caps          |
| M      | `test-fixtures/genomes/yeast-chrIV/chrIV.gbff`              | GBFF    |   1,531,933 bp | NCBI `NC_001136.10`               | Eukaryotic chromosome annotations, joined CDS, exact boundary reads         |
| L      | `test-fixtures/sequences/circular/ecoli-mg1655-complete.gb` | GenBank |   4,641,652 bp | E. coli K-12 MG1655 `U00096.3`    | Complete bacterial chromosome, dense features, stress search                |

**Genome scale:** complete-genome behavior is tested on the default hosted
references, as a size ladder: GRCh38 (3.1 Gb), dm6 (144 Mb) and sacCer3
(12 Mb). Standalone single-chromosome fixtures are not used anywhere and are
rejected by `tools/devops/scripts/guard-no-standalone-chr11-tests.mjs`.
