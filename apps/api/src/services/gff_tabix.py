""" P2 — tabix-style interval index over a LOSSLESS NCBI GFF3.

The ``sources/ncbi-gff3`` per-chrom GFFs are PLAIN gzip (not bgzip) and have NO
tabix index, and their seqid is the RefSeq accession (``NC_000011.10``), not the
app-level chrom id (``chr11``). This module:

  1. maps the app chrom id -> RefSeq accession (GRCh38.p14 standard table),
  2. lazily builds a bgzip + ``.tbi`` tabix index next to a cache copy (once per
     (file identity)), keyed on (abspath|size|mtime_ns) so a changed GFF reindexes,
  3. region-queries the tabix index for a bp window and parses GFF3 lines into the
     resolver's ``GenomeFeature`` shape (0-based start, attributes dict).

Loud failure: a missing GFF source raises ``AnnotationSourceNotFoundError`` (the
404 contract), never an empty result that the renderer would read as "no genes".
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Optional

import pysam

from .spliced_resolver import GenomeFeature


class AnnotationSourceNotFoundError(Exception):
    """The GFF source / its companion is missing — surfaced as a loud 404."""


_CHROM_TO_ACCESSION: dict[str, str] = {
    "chr1": "NC_000001.11",
    "chr2": "NC_000002.12",
    "chr3": "NC_000003.12",
    "chr4": "NC_000004.12",
    "chr5": "NC_000005.10",
    "chr6": "NC_000006.12",
    "chr7": "NC_000007.14",
    "chr8": "NC_000008.11",
    "chr9": "NC_000009.12",
    "chr10": "NC_000010.11",
    "chr11": "NC_000011.10",
    "chr12": "NC_000012.12",
    "chr13": "NC_000013.11",
    "chr14": "NC_000014.9",
    "chr15": "NC_000015.10",
    "chr16": "NC_000016.10",
    "chr17": "NC_000017.11",
    "chr18": "NC_000018.10",
    "chr19": "NC_000019.10",
    "chr20": "NC_000020.11",
    "chr21": "NC_000021.9",
    "chr22": "NC_000022.11",
    "chrX": "NC_000023.11",
    "chrY": "NC_000024.10",
}

_CACHE_DIR_ENV = "WAYPOINT_ANNOTATION_TABIX_CACHE_DIR"
_DEFAULT_CACHE_SUBDIR = "waypoint-annotation-tabix"


def chrom_to_accession(chrom: str) -> str:
    """App chrom id -> RefSeq accession. Passes an already-accession seqid through
    so callers can give either form."""
    if chrom in _CHROM_TO_ACCESSION:
        return _CHROM_TO_ACCESSION[chrom]
    if chrom.startswith("NC_") or chrom.startswith("NT_") or chrom.startswith("NW_"):
        return chrom
    raise AnnotationSourceNotFoundError(
        f"no RefSeq accession known for chrom {chrom!r}"
    )


def _cache_dir() -> Path:
    override = os.environ.get(_CACHE_DIR_ENV)
    base = (
        Path(override)
        if override
        else Path.home() / ".dnaforge" / _DEFAULT_CACHE_SUBDIR
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def _resolve_gff_path(gff_path: str) -> str:
    """Absolute path passes through; repo-relative resolves against the monorepo
    root (nearest ``pnpm-workspace.yaml`` ancestor), mirroring the pileup path resolver.
    """
    p = Path(gff_path)
    if p.is_absolute():
        return str(p)
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").is_file():
            return str(parent / gff_path)
    return str(p)


def _index_key(abspath: str, size: int, mtime_ns: int) -> str:
    parts = "\x00".join([abspath, str(size), str(mtime_ns)])
    return hashlib.sha1(parts.encode("utf-8")).hexdigest()


def ensure_tabix(gff_path: str) -> str:
    """Return the path to a bgzip'd, tabix-indexed copy of ``gff_path``, building it
    once per file identity. The source ncbi GFFs are plain-gzip with no .tbi, so we
    decompress -> bgzip -> tabix into a cache dir keyed on (abspath|size|mtime_ns)."""
    resolved = _resolve_gff_path(gff_path)
    if not Path(resolved).is_file():
        raise AnnotationSourceNotFoundError(f"GFF source not found: {gff_path}")
    st = os.stat(resolved)
    key = _index_key(os.path.abspath(resolved), st.st_size, st.st_mtime_ns)
    bgz_path = _cache_dir() / f"{key}.gff3.gz"
    tbi_path = Path(str(bgz_path) + ".tbi")
    if bgz_path.is_file() and tbi_path.is_file():
        return str(bgz_path)

    import gzip as _gzip

    tmp_plain = _cache_dir() / f"{key}.plain.gff3"
    try:
        opener = _gzip.open if resolved.endswith(".gz") else open
        header_lines: list[str] = []
        data_rows: list[tuple[str, int, int, str]] = []
        with opener(resolved, "rt", encoding="utf-8", errors="replace") as src:
            for line in src:
                if line.startswith("#"):
                    header_lines.append(line if line.endswith("\n") else line + "\n")
                    continue
                cols = line.rstrip("\n").split("\t")
                if len(cols) < 9:
                    continue
                try:
                    start = int(cols[3])
                    end = int(cols[4])
                except ValueError:
                    continue
                data_rows.append(
                    (cols[0], start, end, line if line.endswith("\n") else line + "\n")
                )
        data_rows.sort(key=lambda r: (r[0], r[1], r[2]))
        with open(tmp_plain, "w", encoding="utf-8") as dst:
            dst.writelines(header_lines)
            for _seqid, _start, _end, raw in data_rows:
                dst.write(raw)
        pysam.tabix_compress(str(tmp_plain), str(bgz_path), force=True)
        pysam.tabix_index(str(bgz_path), preset="gff", force=True)
    finally:
        try:
            os.unlink(tmp_plain)
        except OSError:
            pass
    if not (bgz_path.is_file() and Path(str(bgz_path) + ".tbi").is_file()):
        raise AnnotationSourceNotFoundError(
            f"failed to build tabix index for {gff_path}"
        )
    return str(bgz_path)


def _parse_attributes(field: str) -> dict[str, list[str]]:
    """Parse a GFF3 column-9 attribute string into {key: [values]}.

    Multi-value attributes are comma-separated within one key (e.g. Parent=a,b).
    Values are NOT URL-decoded here (the resolver decodes selectively, matching the
    TS which keeps the raw form except for variant-number extraction).
    """
    out: dict[str, list[str]] = {}
    for pair in field.strip().split(";"):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        k, _, v = pair.partition("=")
        out[k.strip()] = v.split(",")
    return out


def _parse_gff_line(line: str) -> Optional[GenomeFeature]:
    if not line or line.startswith("#"):
        return None
    cols = line.rstrip("\n").split("\t")
    if len(cols) < 9:
        return None
    seqid, source, type_, start_s, end_s, score, strand, phase, attrs = cols[:9]
    try:
        start_1based = int(start_s)
        end = int(end_s)
    except ValueError:
        return None
    return GenomeFeature(
        type=type_,
        start=start_1based - 1,
        end=end,
        chrom=seqid,
        source=source,
        score=None if score == "." else score,
        strand=strand if strand in ("+", "-") else ".",
        phase=None if phase == "." else phase,
        attributes=_parse_attributes(attrs),
        raw=line.rstrip("\n"),
    )


def fetch_features(
    gff_path: str, chrom: str, start: int, end: int
) -> list[GenomeFeature]:
    """GFF features OVERLAPPING ``[start, end)`` (0-based) on ``chrom``.

    Tabix is half-open in pysam's ``fetch(reference, start, end)`` (0-based start,
    end-exclusive) — matching our tile bp convention. Returns features whose own
    interval overlaps the window (tabix already enforces this)."""
    bgz = ensure_tabix(gff_path)
    features: list[GenomeFeature] = []
    with pysam.TabixFile(bgz) as tbx:
        contigs = set(tbx.contigs)
        accession = chrom if chrom in contigs else chrom_to_accession(chrom)
        if accession not in contigs:
            raise AnnotationSourceNotFoundError(
                f"accession {accession} ({chrom}) not in GFF {gff_path}"
            )
        for line in tbx.fetch(accession, max(0, start), end):
            feat = _parse_gff_line(line)
            if feat is not None:
                features.append(feat)
    return features
