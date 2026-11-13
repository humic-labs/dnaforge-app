# Structure Resolver Fixtures

Fixtures in this directory that exercise the structure drawer and structure
lookup flows:

For complex-aware structure UX, prefer the real MG1655 `atpG` fixture catalog in
`test-fixtures/structure-complexes/mg1655-atpg-complexes.json`. The legacy
`thrL` fixture below remains for old xref parser and drawer smoke coverage, but
it is synthetic and monomer-only, so it should not be used for new complex
browser coverage.

| Fixture                                        | Use                                                                                                                       | Expected result                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `mg1655-atpG-reference.gb`                     | Real MG1655 `atpG` CDS slice with Swiss-Prot `P0ABA6`; used for  residue-selection and ATP synthase structure workflows without full-genome WebGL fallback. | The 2D CDS translation rendering exposes selectable residues for the ATP synthase gamma subunit. |
| `mg1655-atpD-reference.gb`                     | Real MG1655 `atpD` CDS slice with Swiss-Prot `P0ABB4`; used for  6OQR beta-chain multimer register regression where auth chains D/E start at residue 0 and auth chain F starts at residue 2. | Command-clicking translated CDS residues selects the same ATPD residue numbers across all resolved beta protomers and does not invent unresolved chain-F residues 0/1. |
| `mg1655-thrL-multi-xref-synthetic.gb`          | Well-behaved sequence-attached lookup with a Swiss-Prot xref (`P0AD86`).                                                  | Drawer resolves through UniProt xref and shows one AlphaFold hit.                                   |
| `structure-synechococcus-a0a0h3jza8-trembl.gb` | Problematic live regression: valid 10-character TrEMBL accession (`A0A0H3JZA8`) with a model-versioned AlphaFold CIF URL. | Drawer resolves through exact protein-sequence lookup and fetches `model_v6`, not stale `model_v4`. |
| `structure-mg1655-mioc-ape-label.gb`           | Problematic user-file shape: label-only CDS, no `/translation`, no CDS-level `/db_xref`.                                  | Resolver should not silently pretend it has a structure hit without a derived translation.          |
| `structure-s288c-seo1-ape-label.gb`            | Same label-only/no-translation surface on a yeast reference slice.                                                        | Resolver should fail visibly or use a real coordinate-derived translation path when that exists.    |

## Live Problem Confirmation

Verified on 2026-05-14:

```bash
curl -sS --fail https://rest.uniprot.org/uniprotkb/A0A0H3JZA8.fasta
curl -sS https://alphafold.ebi.ac.uk/api/prediction/A0A0H3JZA8
curl -sS -o /dev/null -w 'v4 %{http_code}\n' https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v4.cif
curl -sS -o /dev/null -w 'v6 %{http_code}\n' https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif
```

Observed facts:

- UniProt returns a real TrEMBL entry for `A0A0H3JZA8`.
- AlphaFold API returns `latestVersion: 6` and
  `cifUrl: https://alphafold.ebi.ac.uk/files/AF-A0A0H3JZA8-F1-model_v6.cif`.
- `AF-A0A0H3JZA8-F1-model_v4.cif` returns HTTP 404.
- `AF-A0A0H3JZA8-F1-model_v6.cif` returns HTTP 200.

That is the exact class of problem the structure-byte proxy must catch: valid
accession, valid prediction, stale file URL fails.
