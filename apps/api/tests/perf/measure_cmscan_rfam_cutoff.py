""" — cmscan --rfam sensitivity-cutoff measurement (reproducible).

Runs cmscan WITH and WITHOUT --rfam over the shipped full Rfam.cm across a size
ladder built from committed fixtures, recording wall-clock and the --rfam DELTA
vs size. Sequential (no CPU contention) so timings are trustworthy. Mirrors the
production invocation in src/annotation/annotate.py:_build_cmscan_args.

This is the harness behind the pinned RFAM_FULL_SENSITIVITY_MAX_LEN constant, and
the tool the plan's Phase B contract requires to RE-PIN the cutoff if Rfam is
bumped to 15.1 (more CMs → slower → the 50 kb cutoff may need to move down).

Run:  cd apps/api && uv run python tests/perf/measure_cmscan_rfam_cutoff.py
Requires the provisioned DB + cmscan binary (dev: ./apps/desktop/scripts/
download-binaries.sh + the sidecar's ensure_databases()). Skips with a clear
message if either is missing.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from src.annotation.setup import get_annotation_data_dir  # noqa: E402
from src.services.plannotate import find_binaries_dir, get_binary_path  # noqa: E402

REPO = Path(__file__).resolve().parents[4]
FIX = REPO / "test-fixtures" / "sequences"
DB = get_annotation_data_dir() / "BLAST_dbs"
CM = DB / "Rfam.cm"
CLANIN = DB / "Rfam.clanin"
OUT = Path(__file__).with_name("rfam-sensitivity-cmscan-rfam-measurements.json")


def _load(gb: Path) -> str:
    return str(next(SeqIO.parse(str(gb), "genbank")).seq)


def _fasta(seq: str, name: str, out_dir: Path) -> Path:
    p = out_dir / f"query_{name}.fasta"
    SeqIO.write(SeqRecord(Seq(seq), id=name, description=""), str(p), "fasta")
    return p


def _run(
    cmscan: str, query: Path, drop_rfam: bool, out_dir: Path, timeout_s: int
) -> dict:
    tbl = out_dir / f"tbl_{query.stem}_{'norfam' if drop_rfam else 'rfam'}.txt"
    args = [cmscan, "--cut_ga"]
    if not drop_rfam:
        args.append("--rfam")
    args += [
        "--noali",
        "--nohmmonly",
        "--fmt",
        "2",
        "--cpu",
        "1",
        "--tblout",
        str(tbl),
        "--clanin",
        str(CLANIN),
        str(CM),
        str(query),
    ]
    t0 = time.monotonic()
    status = "ok"
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout_s)
        if proc.returncode != 0:
            status = f"rc={proc.returncode}:{(proc.stderr or '')[:200]}"
    except subprocess.TimeoutExpired:
        status = f"TIMEOUT>{timeout_s}s"
    dt = round(time.monotonic() - t0, 1)
    hits = 0
    if tbl.exists():
        hits = sum(
            1 for ln in tbl.read_text().splitlines() if ln and not ln.startswith("#")
        )
    return {"seconds": dt, "status": status, "hits": hits}


def main() -> int:
    cmscan = get_binary_path("cmscan", find_binaries_dir())
    if not cmscan or not CM.exists():
        print(f"[skip] need cmscan ({cmscan}) and Rfam.cm ({CM}); provision first.")
        return 0

    import tempfile

    puc19 = _load(FIX / "circular" / "pUC19.gb")
    region = _load(FIX / "linear" / "ecoli-mg1655-region.gb")
    mg = _load(FIX / "circular" / "ecoli-mg1655-complete.gb")
    ladder = [
        (f"puc19_{len(puc19)}", puc19, 300),
        (f"region_{len(region)}", region, 600),
        ("mg1655_250k", mg[:250_000], 900),
        ("mg1655_500k", mg[:500_000], 1200),
        ("mg1655_1M", mg[:1_000_000], 1800),
        (f"mg1655_full_{len(mg)}", mg, 2400),
    ]

    with tempfile.TemporaryDirectory() as td:
        out_dir = Path(td)
        results = []
        for label, seq, timeout_s in ladder:
            q = _fasta(seq, label, out_dir)
            row = {"label": label, "length": len(seq)}
            print(f"[measure] {label} len={len(seq)} no-rfam ...", flush=True)
            row["no_rfam"] = _run(cmscan, q, True, out_dir, timeout_s)
            print(f"[measure] {label} rfam ...", flush=True)
            row["rfam"] = _run(cmscan, q, False, out_dir, timeout_s)
            row["delta_s"] = round(
                row["no_rfam"]["seconds"] - row["rfam"]["seconds"], 1
            )
            results.append(row)
            OUT.write_text(json.dumps(results, indent=2))
            print(
                f"           {row['no_rfam']} | {row['rfam']} | delta={row['delta_s']}s",
                flush=True,
            )
    print(f"Saved: {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
