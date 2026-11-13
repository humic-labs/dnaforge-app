# Sources for the  yeast heat-recovery standard

```text
versioned NCBI plasmids + target windows + existing reference chromosomes
                                |
                       SHA-256 source manifest
                       /                    \
            ordinary project import      independent molecular replay
                       |                    |
             scientific actor inputs    reviewer-only witnesses
                       |                    |
                saved designs          review / grading
                       |
             planned, never observed, strains

missing / modified source -> stop source validation; do not invent DNA
ambiguous deposited base  -> preserve ambiguity; do not resolve it by guess
```

The [manifest](manifest.json) pins the exact GenBank bytes, normalized base
sequences, topology, and source locations. The three plasmids and two target
windows were retrieved from NCBI for this task. Source coordinates are one-based
inclusive; computational slices and proposed primer placements are zero-based
half-open.

| Source | Frozen record              | Role                                                |
| ------ | -------------------------- | --------------------------------------------------- |
| pUG6   | AF298793.1, 4,009 bp       | loxP-kanMX-loxP deletion template                   |
| pSH47  | AF298782.1, 6,979 bp       | inducible Cre / URA3 marker-recycling plasmid       |
| pRS416 | U03450.1, 4,898 bp         | centromeric URA3 rescue and empty-vector control    |
| HSP104 | NC_001144.5:86623–93349    | 6,727 bp window containing the full gene and flanks |
| HSP42  | NC_001136.10:804621–809748 | 5,128 bp window containing the full gene and flanks |

pSH47 contains one deposited `N`, at one-based position 2382. It remains `N`.
pRS416's deposited record contains only a source feature. Its functional vector
context comes separately from [ATCC 87521](https://www.atcc.org/products/87521);
do not represent those descriptions as deposited GenBank annotations or mix in a
different vendor's pRS416 sequence.

The manifest also pins all 16 existing nuclear chromosome fixtures. Fifteen are
the repository's LIMS starter exports, whose files do not assert a versioned
accession; chromosome IV is the existing NC_001136.10 fixture. Both target
windows were checked base-for-base against their corresponding full chromosomes.
Mitochondrial DNA and the physical BY4741 stock sequence are not supplied.
Whole-nuclear-reference specificity is a planning check, not proof of
specificity in an experimental stock.

Mount these sources through the normal product project/import paths. Do not
preseed accepted assemblies, strain descendants, primers, calculated evidence,
or reviewer answers. The default project label and relative source layout must
be identical in both comparison arms. The existing large reference files are
referenced, not duplicated.

The [review packet](../../../docs/reviews//flagship-standard.md) defines
the proposed scientific goal, accepted outcome families, independent checks, and
paired comparison. The actor receives only the actor prompt, source data, source
provenance, and ordinary app/tool documentation. It does not receive the review
packet, grading implementation, tests, or molecular witness.
