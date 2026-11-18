# Native genome data examples

`MG1655-NC_000913.3.fasta` contains the complete E. coli K-12 MG1655 reference,
NC_000913.3, with 4,641,652 bases. Its GFF retains the normalized RefSeq gene,
CDS and RNA annotations from the prepared GCF_000005845.2 reference. The GFF
header records the indexer format used for normalization.

`MG1655-rut-locus.gb` contains reference interval [1067000, 1084000). Its local
coordinates start at zero in renderer data and at one in the GenBank file.
`PRECISE1K-subset.json` retains 48 published measurements across 18 selected
samples, source URLs, source hashes, units, processing and limitations. Seven
measured genes occur in this 17 kb extraction. The ordinary example uses the
native registered-sequence import, project reconciliation and saved-layer owner;
its mapping report retains the 41 genes outside the extraction.

`native-tracks/precise1k.json` pins the 18 BigWig sample files and their common
measurement source. These use the same published log2 TPM values as the ordinary
example. Only the overlapping portions of gene intervals are averaged, and each
such portion and contributing gene is recorded. Unmeasured regions remain
missing. BigWig stores native float32 values. The initial native display range
is 0–16 with smoothing off.

`MG1655-Shigella2457T-gapped.paf` retains 261 minimap2 alignment blocks with
CIGAR operations between NC_000913.3 and Shigella flexneri 2457T NC_004741.1
(4,599,354 bases). The native comparison uses exact base/gap coordinates inside
blocks and explicit compressed joins between blocks. Its display columns are
not a whole-genome coordinate system. Query nucleotide and annotation loading
remain separate from this retained alignment source.

`U00096.2-contacts/` contains the distinct U00096.2 reference and measured
GSM2870426 contact matrix. Its README retains the original source, aggregation
and hashes. Do not substitute NC_000913.3 for that reference.
