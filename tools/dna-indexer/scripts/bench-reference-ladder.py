#!/usr/bin/env python3
"""Time reference preparation on the default hosted references .

Genome-scale performance is measured on complete default references, as a
size ladder: GRCh38 (3.1 Gb), dm6 (144 Mb) and sacCer3 (12 Mb). Standalone
single-chromosome fixtures are never used.

Each run times the same command the app and the hosted-reference build use,
`dna-indexer ingest-gff3-assembly`, over a whole-assembly FASTA + GFF3 with a
contig map. Inputs come from the references already prepared on this machine
(`<app data>/DNAForge/reference-assets/<id>/`): each member's prepared FASTA
and GFF3 are joined back into one assembly source, so no download is needed.

With two or more `--indexer LABEL=PATH` binaries, every output file is compared
by SHA-256 across binaries, so a speedup that changes bytes is reported.

    python3 tools/dna-indexer/scripts/bench-reference-ladder.py \\
      --indexer before=/tmp/old/dna-indexer --indexer now=target/release/dna-indexer \\
      --json out.json
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

LADDER = ["grch38", "dm6", "sacCer3"]


def reference_asset_root() -> Path:
    override = os.environ.get("DNAFORGE_REFERENCE_ASSET_ROOT", "").strip()
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return (
            Path.home()
            / "Library"
            / "Application Support"
            / "DNAForge"
            / "reference-assets"
        )
    return Path.home() / ".config" / "DNAForge" / "reference-assets"


def current_generation(assembly: str) -> Path:
    root = reference_asset_root() / assembly
    pointer = json.loads((root / "current-reference-assets.v1.json").read_text())
    return root / "generations" / pointer["publicationId"]


def definition(generation: Path) -> dict:
    return json.loads(
        (generation / "prepared-reference-definition.v1.json").read_text()
    )


def build_prepared_source(assembly: str, work: Path) -> tuple[Path, Path, Path]:
    """Join a prepared reference's members into one FASTA + GFF3 + contig map."""
    out = work / f"{assembly}-source"
    fasta, gff, contig_map = (
        out / "assembly.fa",
        out / "assembly.gff3",
        out / "contigs.json",
    )
    if contig_map.exists():
        return fasta, gff, contig_map
    out.mkdir(parents=True, exist_ok=True)
    generation = current_generation(assembly)
    members = definition(generation)["members"]
    contigs = []
    with fasta.open("wb") as fa, gff.open("w") as gf:
        gf.write("##gff-version 3\n")
        for member in members:
            chrom = member["chrom"]
            manifest = member["manifest"]
            with (generation / manifest["fastaPath"]).open("rb") as src:
                shutil.copyfileobj(src, fa)
            gff_path = manifest.get("gffPath")
            if gff_path:
                with gzip.open(generation / gff_path, "rt") as src:
                    for line in src:
                        if not line.startswith("#"):
                            gf.write(line)
            contigs.append(
                {
                    "sourceSeqId": chrom,
                    "name": chrom,
                    "expectedLengthBp": member["lengthBp"],
                    "circular": bool(member.get("circular", False)),
                }
            )
    contig_map.write_text(
        json.dumps(
            {"contract": "dna-indexer-ingest-gff3-assembly.v1", "contigs": contigs}
        )
        + "\n"
    )
    return fasta, gff, contig_map


def peak_bytes(rusage) -> int:
    return rusage.ru_maxrss if sys.platform == "darwin" else rusage.ru_maxrss * 1024


def run_once(binary: Path, source: tuple[Path, Path, Path], out_dir: Path) -> dict:
    fasta, gff, contig_map = source
    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    cmd = [
        str(binary),
        "ingest-gff3-assembly",
        "--in",
        str(gff),
        "--in-fasta",
        str(fasta),
        "--contig-map",
        str(contig_map),
        "--out-dir",
        str(out_dir),
    ]
    started = time.perf_counter()
    child = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    stdout = child.stdout.read()
    _, status, rusage = os.wait4(child.pid, 0)
    elapsed = time.perf_counter() - started
    if status != 0:
        tail = stdout.decode(errors="replace").strip().splitlines()[-1:]
        raise RuntimeError(f"{binary} failed: {tail}")
    return {"seconds": elapsed, "peak_bytes": peak_bytes(rusage)}


def digest_tree(root: Path) -> dict[str, str]:
    digests = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            digests[str(path.relative_to(root))] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
    return digests


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--indexer", action="append", required=True, help="LABEL=PATH")
    parser.add_argument("--assemblies", nargs="*", default=LADDER)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--work", type=Path, default=Path("/tmp/dna-indexer-ladder"))
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()

    indexers = [
        (label, Path(path)) for label, path in (i.split("=", 1) for i in args.indexer)
    ]
    cases = [
        (a, lambda a=a: build_prepared_source(a, args.work)) for a in args.assemblies
    ]

    results = []
    print(
        f"{'case':<13}{'indexer':<9}{'median s':>10}{'min s':>9}{'peak MB':>9}  bytes"
    )
    for case, build in cases:
        source = build()
        digests = {}
        for label, binary in indexers:
            runs = []
            for _ in range(args.repeat):
                out_dir = args.work / f"{case}-{label}-out"
                runs.append(run_once(binary, source, out_dir))
            digests[label] = digest_tree(out_dir)
            seconds = [run["seconds"] for run in runs]
            row = {
                "case": case,
                "indexer": label,
                "median_seconds": statistics.median(seconds),
                "min_seconds": min(seconds),
                "peak_mb": max(run["peak_bytes"] for run in runs) / 1_048_576,
                "runs": len(runs),
                "output_files": len(digests[label]),
            }
            first = indexers[0][0]
            row["identical_to_" + first] = digests[label] == digests[first]
            results.append(row)
            same = "identical" if row["identical_to_" + first] else "DIFFERENT"
            print(
                f"{case:<13}{label:<9}{row['median_seconds']:>10.2f}{row['min_seconds']:>9.2f}"
                f"{row['peak_mb']:>9.0f}  {same} ({row['output_files']} files)"
            )
            shutil.rmtree(out_dir, ignore_errors=True)
    if args.json:
        args.json.write_text(json.dumps(results, indent=2) + "\n")
    return 0 if all(r["identical_to_" + indexers[0][0]] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
