# External binary replay fixtures

These files exercise the real sidecar byte-range service and the real browser
BBI worker without making deterministic Electron tests depend on the network.

- `grch38-sparse-gc.bw` is a nonnegative, five-base signal around
  `chr1:924000-926000`, plus sparse values on every other primary chromosome.
- `grch38-sparse-signed-signal.bw` has the same coordinate shape and includes
  both negative and positive values for the public-hub signal test.

Both are valid BigWig files with the exact lengths of all 24 GRCh38 primary
chromosomes. They were generated from deterministic bedGraph input with UCSC's
official `bedGraphToBigWig` utility. Their small size is for functional replay
only. The live acceptance and performance gates use UCSC's complete
`hg38/bbi/gc5BaseBw/gc5Base.bw` file.

`grch38-sparse-transcripts.bb` is a sparse BigBed transcript fixture for GRCh38
chromosome 1. It is copied unchanged from `test/data/transcripts.bb` at commit
`bc54a25f2d25e576e8f6d9911f6559532b9b9d94` of
[GMOD/bbi-js](https://github.com/GMOD/bbi-js). The upstream project is MIT
licensed, copyright 2019 Colin Diesh. Its SHA-256 is
`1f42d2d59c82f7d5b3d2fbbe15dac1207315e22cc3398aaa48219c97fa3798e6`.

`yeast-chriv-reads.cram` and `yeast-chriv-reads.cram.crai` are byte-identical
copies of the deterministic 12-read S. cerevisiae chromosome-IV fixtures in
`test-fixtures/alignments/yeast-chriv-cram/`. They are duplicated here because
the replay transport deliberately forbids a response body from escaping the
external-fixture root. Their SHA-256 digests are, respectively,
`2acf8128a119305ca007e5a035e03179965d60784b1c2bc88857ece201a4a009` and
`6969ca9002f4a763f49fcc01e0603cfff83c6350b7f925084eeee4a649131c00`.

`yeast-chriv-variants.vcf.gz`/`.tbi` and
`yeast-chriv-variants.bcf`/`.csi` contain the same 105 deterministic calls on
S. cerevisiae chromosome IV. They exercise native remote VCF/BCF indexing,
bounded pagination, and reload re-admission. Regenerate them with
`generate_remote_variants.py`. Their SHA-256 digests are, in that order,
`eb7bb97bea5557336c8d33f521a20b92ee81f17d1078786f9ef6f5d9d3a6f59e`,
`9aeaf8d7f4296f11006f7c2493d248053cac52a2d3f98f1bc901f61dc98138e7`,
`9975d9b2375b4ea690aec6e7dfa3b4687a7f6e74fe0f50cff5e97e5f29f9d9e5`, and
`2149ddf49399144bc9f07263971635fc48d0d34f46b17a60a11ea4d85d9a2c32`.
