#!/usr/bin/env python3
"""Generate deterministic indexed chrIV VCF and BCF replay fixtures."""

from __future__ import annotations

from pathlib import Path

import pysam
import pysam.bcftools

FIXTURE_DIR = Path(__file__).resolve().parent
CONTIG = "chrIV"
CONTIG_LENGTH = 1_531_933
VARIANT_COUNT = 105


def variant_header() -> pysam.VariantHeader:
    header = pysam.VariantHeader()
    header.add_meta("fileformat", value="VCFv4.3")
    header.add_meta("source", value="DNAForge deterministic remote-variant fixture")
    header.contigs.add(CONTIG, length=CONTIG_LENGTH)
    header.formats.add("GT", 1, "String", "Genotype")
    header.add_sample("tumor")
    return header


def write_variants(path: Path, mode: str) -> None:
    with pysam.VariantFile(str(path), mode, header=variant_header()) as writer:
        for offset in range(VARIANT_COUNT):
            start = 999 + offset * 100
            record = writer.new_record(
                contig=CONTIG,
                start=start,
                stop=start + 1,
                id=f"chrIV-var-{offset + 1:03d}",
                alleles=("A", "T"),
                qual=60,
                filter="PASS",
            )
            record.samples["tumor"]["GT"] = (0, 1)
            writer.write(record)


def main() -> None:
    vcf_path = FIXTURE_DIR / "yeast-chriv-variants.vcf.gz"
    bcf_path = FIXTURE_DIR / "yeast-chriv-variants.bcf"
    for path in (
        vcf_path,
        Path(f"{vcf_path}.tbi"),
        bcf_path,
        Path(f"{bcf_path}.csi"),
    ):
        path.unlink(missing_ok=True)

    write_variants(vcf_path, "wz")
    pysam.tabix_index(str(vcf_path), preset="vcf", force=True)
    write_variants(bcf_path, "wb")
    pysam.bcftools.index("--force", str(bcf_path))


if __name__ == "__main__":
    main()
