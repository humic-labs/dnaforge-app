"""Deterministic generator for synthetic-mini-indexed.gbff.

DNA-G1 / . Produces a ~50 kb GenBank fixture with a handful of
features at well-defined positions. Output is byte-stable across runs
(seeded RNG, BioPython's deterministic GenBank writer).

Run:
    uv run python test-fixtures/genomes/synthetic-mini-indexed/generate.py

The committed source.gbff is the source of truth; this script exists so
the fixture is reproducible.
"""

from __future__ import annotations

import random
from pathlib import Path

from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqFeature import FeatureLocation, SeqFeature
from Bio.SeqRecord import SeqRecord

SEED = 20260504
LENGTH = 50_000
ALPHABET = "ACGT"


def build_record() -> SeqRecord:
    rng = random.Random(SEED)
    seq = "".join(rng.choices(ALPHABET, k=LENGTH))
    record = SeqRecord(
        Seq(seq),
        id="chrI",
        name="chrI",
        description="DNA-G1 synthetic-mini-indexed fixture",
        annotations={
            "molecule_type": "DNA",
            "topology": "linear",
            "organism": "synthetic.deterministic",
            "source": "synthetic.deterministic",
            "taxonomy": [],
            "date": "04-MAY-2026",
        },
    )
    cds_specs = [
        ("geneA", 1_000, 4_000, +1),
        ("geneB", 8_000, 11_000, -1),
        ("geneC", 15_500, 18_200, +1),
        ("geneD", 25_000, 28_000, -1),
        ("geneE", 40_000, 44_500, +1),
    ]
    for gene, start, end, strand in cds_specs:
        location = FeatureLocation(start, end, strand=strand)
        record.features.append(
            SeqFeature(
                location=location,
                type="gene",
                qualifiers={"gene": [gene], "locus_tag": [gene]},
            )
        )
        record.features.append(
            SeqFeature(
                location=location,
                type="CDS",
                qualifiers={
                    "gene": [gene],
                    "locus_tag": [gene],
                    "product": [f"hypothetical {gene}"],
                    "translation": [str(Seq(seq[start:end]).translate())],
                },
            )
        )
    return record


def main() -> None:
    out = Path(__file__).parent / "source.gbff"
    record = build_record()
    with out.open("w") as fh:
        SeqIO.write([record], fh, "genbank")
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
