"""On-demand read-pileup region query  pileup).

Returns the alignment reads overlapping a region from an indexed BAM (htslib via
pysam). This is the professional / IGV-JBrowse model: the renderer requests reads
for the *visible window* on pan/zoom, never all reads at once. Genome-wide depth
is carried by the separate coverage band; here we stream exact in-view reads.

Critical invariant: indexed-genome detail mode must pass ``max_reads=None`` and
must not render sampled reads as if they were actual reads. If a caller opts into
``max_reads`` it is asking for a degraded spread sample, suitable only when paired
with an overflow/coverage representation that makes the loss explicit.

Stateless compute; no DB (sidecar pattern — see apps/api/CLAUDE.local.md).
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import zlib
from pathlib import Path
from typing import Literal, Mapping, Optional, TypedDict

import numpy as np
import pysam

from ..aligned_read_file_generation import (
    AlignedReadFileGeneration,
    capture_aligned_read_file_generation,
)
from .alignment_index_lock import alignment_index_target_lock


class PileupError(Exception):
    """Base for pileup query failures."""


class BamNotFoundError(PileupError):
    """The requested BAM path does not exist or is not a file."""


class IndexNotFoundError(PileupError):
    """An explicit local index path was given but does not exist.

    Fails loudly (rather than silently falling back to a slow remote-index fetch)
    so a stale localization-manifest entry surfaces immediately.
    """


class AlignmentIndexError(PileupError):
    """A local BAM/CRAM does not have a usable random-access index."""


class _IndexPlacementError(OSError):
    """An index could not be staged or published at a specific destination."""


class ReferenceNotFoundError(PileupError):
    """A CRAM needs a reference FASTA, but the given one is missing/unusable.

    CRAM stores read sequence as a delta against a reference genome, so htslib
    MUST have the reference to decode a slice — even position/flag-only reads
    (htslib decodes the whole slice before yielding the first record; empirically
    verified). Raised loudly because htslib's own failure for a referenceless CRAM
    is the misleading ``OSError("truncated file")``.
    """


class SourceGenerationChangedError(PileupError):
    """One member of an admitted BAM/CRAM bundle changed on disk."""


def require_aligned_read_source_generation(
    bam_path: str,
    index_path: Optional[str],
    reference_fasta: Optional[str],
    expected: Mapping[str, object],
) -> None:
    """Fail closed when any local source member differs from its admission receipt."""

    members: list[tuple[str, Optional[str], object]] = [
        ("alignment", bam_path, expected.get("alignment")),
        ("index", index_path, expected.get("index")),
    ]
    expected_reference = expected.get("reference")
    expected_reference_index = expected.get("referenceIndex")
    if expected_reference is not None or expected_reference_index is not None:
        members.extend(
            [
                ("reference", reference_fasta, expected_reference),
                (
                    "referenceIndex",
                    f"{reference_fasta}.fai" if reference_fasta else None,
                    expected_reference_index,
                ),
            ]
        )

    for label, path, receipt in members:
        if not path or not isinstance(receipt, Mapping):
            raise SourceGenerationChangedError(
                "The aligned-read source bundle changed after admission. Repair the track."
            )
        try:
            canonical = str(Path(path).resolve(strict=True))
            stat = os.stat(canonical)
        except OSError as exc:
            raise SourceGenerationChangedError(
                "The aligned-read source bundle changed after admission. Repair the track."
            ) from exc

        expected_values = {
            "canonicalPath": canonical,
            "size": stat.st_size,
            "mtimeNs": str(stat.st_mtime_ns),
            "ctimeNs": str(stat.st_ctime_ns),
            "device": str(stat.st_dev),
            "inode": str(stat.st_ino),
        }
        for field, current in expected_values.items():
            admitted = receipt.get(field)
            if field in ("device", "inode") and admitted is None:
                continue
            if admitted != current:
                raise SourceGenerationChangedError(
                    f"The aligned-read {label} changed after admission. Repair the track."
                )


class PileupRead(TypedDict):
    start: int
    end: int
    strand: str
    mapq: int
    readId: str
    paired: bool


class PileupRegionResult(TypedDict):
    reads: list[PileupRead]
    count: int
    truncated: bool


class PileupColumns(TypedDict):
    start: list[int]
    end: list[int]
    strand: list[str]
    mapq: list[int]
    readId: list[str]
    paired: list[bool]


class PileupRegionColumnsResult(TypedDict):
    format: Literal["columns-v1"]
    columns: PileupColumns
    count: int
    truncated: bool


class CoverageRegionResult(TypedDict):
    """Binned read-DEPTH over a region — decoupled from the exact-read overlay.

    ``bins[i]`` is the depth representative of ``[start + i*binSize, …)`` in the
    requested region's local coordinates. ``maxDepth`` is the max across the
    returned bins (the renderer maps depth → band height; deeper bins clamp).
    ``binSize`` is the actual bp width of each bin (>= the requested ``bin_size``
    after clamping to the bin budget).
    """

    chrom: str
    start: int
    end: int
    binSize: int
    bins: list[float]
    maxDepth: float


_REMOTE_SCHEMES = ("http://", "https://", "s3://", "gs://", "ftp://")


def _is_remote_bam(bam_path: str) -> bool:
    return bam_path.startswith(_REMOTE_SCHEMES)


def _resolve_bam_path(bam_path: str) -> str:
    """Resolve a BAM reference to a path or URL pysam can open.

    REMOTE URLs (http/https/s3/gs/ftp) pass straight through to pysam, which
    region-queries them over the network without downloading the whole file —
    this is how the assembly pileup pressure-tests large public datasets (GIAB,
    ENCODE, 1000G) that are far too big to fetch in full.

    LOCAL absolute paths pass through unchanged. RELATIVE paths resolve against
    the repo root (nearest ancestor with ``pnpm-workspace.yaml``) so committed dev scenarios
    carry portable repo-relative fixture paths. Falls back to the given path
    (cwd-relative) if no repo root is found — a missing local file then surfaces
    as ``BamNotFoundError`` downstream.
    """
    if _is_remote_bam(bam_path):
        return bam_path
    p = Path(bam_path)
    if p.is_absolute():
        return str(p)
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").is_file():
            return str(parent / bam_path)
    return str(p)


def _resolve_index_path(index_path: Optional[str]) -> Optional[str]:
    """Resolve an OPTIONAL explicit index (.bai/.crai) to a path/URL for pysam.

    The remote-BAM win: pass a LOCAL index for a REMOTE BAM so htslib does not
    re-fetch the (multi-MB) index over the network on every open. A whole-genome
    .bai is ~9 MB; downloading it per cold region query is the dominant latency on
    first access (measured 5.8 s remote-index vs 1.5 s local-index for the same
    50 kb window). Localizing the 9 MB index — not the 121 GB BAM — buys most of
    the speed-up for ~0.007% of the bytes.

    Resolution mirrors ``_resolve_bam_path``: remote URLs and absolute paths pass
    through; a repo-relative path resolves against the repo root. A LOCAL index
    that does not exist raises ``IndexNotFoundError`` (loud, not a silent fallback
    to the slow remote-index path). ``None`` means "let htslib find the co-located
    index" — the unchanged default.
    """
    if index_path is None:
        return None
    if _is_remote_bam(index_path):
        return index_path
    p = Path(index_path)
    if not p.is_absolute():
        for parent in Path(__file__).resolve().parents:
            if (parent / "pnpm-workspace.yaml").is_file():
                p = parent / index_path
                break
    if not p.is_file():
        raise IndexNotFoundError(f"index not found: {index_path}")
    return str(p)


def _resolve_reference_path(reference_path: Optional[str]) -> Optional[str]:
    """Resolve an OPTIONAL reference FASTA for decoding a CRAM.

    CRAM is reference-compressed, so htslib MUST have the reference to decode any
    record in a slice — even the position/flag-only reads this service reads (the
    whole slice is decoded before the first record is yielded; empirically
    verified against NA12718.final.cram). A BAM ignores this entirely
    (``reference_filename`` is a no-op), so threading it does not affect BAM
    callers.

    The reference must be a LOCAL FASTA with a sibling ``.fai``: htslib reads only
    the per-region slice via faidx random access, so even a REMOTE CRAM pulls just
    the local reference slice (never the network). pysam cannot use a remote FASTA
    URL. Repo-relative paths resolve against the repo root, mirroring
    ``_resolve_index_path``. ``None`` (a BAM, or a CRAM relying on a configured
    cache) passes through. A missing FASTA / missing ``.fai`` / remote URL raises
    ``ReferenceNotFoundError`` — loud, because htslib's own error for a
    referenceless CRAM is a misleading ``"truncated file"``.
    """
    if reference_path is None:
        return None
    if _is_remote_bam(reference_path):
        raise ReferenceNotFoundError(
            f"reference must be a LOCAL FASTA path, not a remote URL: {reference_path}"
        )
    p = Path(reference_path)
    if not p.is_absolute():
        for parent in Path(__file__).resolve().parents:
            if (parent / "pnpm-workspace.yaml").is_file():
                p = parent / reference_path
                break
    if not p.is_file():
        raise ReferenceNotFoundError(f"reference FASTA not found: {reference_path}")
    if not Path(str(p) + ".fai").is_file():
        raise ReferenceNotFoundError(
            f"reference FASTA index (.fai) missing for {reference_path} — "
            f"run `samtools faidx` on it (htslib needs faidx slice reads for CRAM)"
        )
    return str(p)


def _open_alignment(
    resolved_bam: str,
    resolved_index: Optional[str],
    resolved_reference: Optional[str] = None,
):
    """Open an indexed BAM/CRAM, honoring an explicit local index/reference.

    Mode stays ``"rb"``: htslib sniffs CRAM magic bytes and ignores the format
    letter on read, so no separate ``"rc"`` branch is needed.
    ``reference_filename`` is a no-op for BAM and mandatory for CRAM.
    """
    kwargs: dict = {}
    if resolved_index is not None:
        kwargs["index_filename"] = resolved_index
    if resolved_reference is not None:
        kwargs["reference_filename"] = resolved_reference
    return pysam.AlignmentFile(resolved_bam, "rb", **kwargs)


def _infer_index_state(resolved_bam: str) -> str:
    """Best-effort co-located BAM/CRAM index detection for import validation."""
    if _is_remote_bam(resolved_bam):
        return "unknown"
    lower = resolved_bam.lower()
    if lower.endswith(".bam"):
        stem = resolved_bam[:-4]
        candidates = (resolved_bam + ".bai", resolved_bam + ".csi", stem + ".bai")
    elif lower.endswith(".cram"):
        stem = resolved_bam[:-5]
        candidates = (resolved_bam + ".crai", resolved_bam + ".csi", stem + ".crai")
    else:
        candidates = (
            resolved_bam + ".bai",
            resolved_bam + ".crai",
            resolved_bam + ".csi",
        )
    return (
        "present"
        if any(Path(candidate).is_file() for candidate in candidates)
        else "missing"
    )


def _local_index_candidates(resolved_bam: str) -> tuple[Path, ...]:
    lower = resolved_bam.lower()
    if lower.endswith(".bam"):
        stem = resolved_bam[:-4]
        return (
            Path(resolved_bam + ".bai"),
            Path(resolved_bam + ".csi"),
            Path(stem + ".bai"),
            Path(stem + ".csi"),
        )
    if lower.endswith(".cram"):
        stem = resolved_bam[:-5]
        return (
            Path(resolved_bam + ".crai"),
            Path(resolved_bam + ".csi"),
            Path(stem + ".crai"),
        )
    return (
        Path(resolved_bam + ".bai"),
        Path(resolved_bam + ".crai"),
        Path(resolved_bam + ".csi"),
    )


_ALIGNMENT_INDEX_DIR_ENV = "WAYPOINT_ALIGNMENT_INDEX_DIR"
_DEFAULT_ALIGNMENT_INDEX_DIR = Path(".dnaforge") / "waypoint-alignment-index"


def _index_is_readable(resolved_bam: str, candidate: Path) -> bool:
    if not candidate.is_file():
        return False
    verbosity = pysam.set_verbosity(0)
    try:
        alignment = _open_alignment(resolved_bam, str(candidate), None)
        try:
            alignment.check_index()
            return True
        finally:
            alignment.close()
    except (OSError, ValueError, pysam.SamtoolsError):
        return False
    finally:
        pysam.set_verbosity(verbosity)


def _readable_local_index(resolved_bam: str) -> Path | None:
    return next(
        (
            candidate
            for candidate in _local_index_candidates(resolved_bam)
            if _index_is_readable(resolved_bam, candidate)
        ),
        None,
    )


def _require_alignment_file_generation(
    source: Path,
    expected: AlignedReadFileGeneration,
) -> None:
    try:
        current = capture_aligned_read_file_generation(source)
    except (OSError, ValueError) as exc:
        raise SourceGenerationChangedError(
            "The aligned-read source changed after index preparation was admitted."
        ) from exc
    if current != expected:
        raise SourceGenerationChangedError(
            "The aligned-read source changed after index preparation was admitted."
        )


def _managed_index_target(
    source: Path,
    generation: AlignedReadFileGeneration | None = None,
) -> Path:
    """Return the cache path bound to this exact local BAM generation."""

    generation = generation or capture_aligned_read_file_generation(source)
    identity = json.dumps(
        generation.model_dump(mode="json", by_alias=True, exclude_none=False),
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    override = os.environ.get(_ALIGNMENT_INDEX_DIR_ENV)
    root = (
        Path(override).expanduser()
        if override
        else Path.home() / _DEFAULT_ALIGNMENT_INDEX_DIR
    )
    return root.resolve() / f"{digest}.bam.bai"


def _build_index_atomically(
    resolved_bam: str,
    target: Path,
    *,
    source_generation: AlignedReadFileGeneration,
) -> bool:
    """Publish a verified BAI at ``target``; return false if already reusable."""

    source = Path(resolved_bam)
    _require_alignment_file_generation(source, source_generation)
    if _index_is_readable(resolved_bam, target):
        _require_alignment_file_generation(source, source_generation)
        return False

    staged: Path | None = None
    try:
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            descriptor, staged_name = tempfile.mkstemp(
                prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent)
            )
            os.close(descriptor)
            staged = Path(staged_name)

            staged.unlink()
        except OSError as exc:
            raise _IndexPlacementError(
                f"cannot stage an index in {target.parent}"
            ) from exc

        try:
            _require_alignment_file_generation(source, source_generation)
            pysam.index("-o", str(staged), resolved_bam)
        except (OSError, pysam.SamtoolsError) as exc:
            raise AlignmentIndexError(
                f"Could not index this BAM. It must be coordinate-sorted and readable. {exc}"
            ) from exc

        _require_alignment_file_generation(source, source_generation)
        if not _index_is_readable(resolved_bam, staged):
            raise AlignmentIndexError(
                "BAM indexing completed without producing a readable random-access index."
            )
        try:
            _require_alignment_file_generation(source, source_generation)
            os.replace(staged, target)
        except OSError as exc:
            raise _IndexPlacementError(f"cannot publish an index at {target}") from exc
        staged = None
        try:
            _require_alignment_file_generation(source, source_generation)
        except SourceGenerationChangedError:
            target.unlink(missing_ok=True)
            raise
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)

    try:
        published_is_readable = _index_is_readable(resolved_bam, target)
        _require_alignment_file_generation(source, source_generation)
    except SourceGenerationChangedError:
        target.unlink(missing_ok=True)
        raise
    if not published_is_readable:
        target.unlink(missing_ok=True)
        raise AlignmentIndexError(
            "The published BAM index could not be reopened for random access."
        )
    return True


def ensure_alignment_index(
    bam_path: str,
    *,
    source_generation: AlignedReadFileGeneration | Mapping[str, object] | None = None,
) -> dict:
    """Return a readable local BAM/CRAM index.

    A user-selected BAM should become a random-access track without requiring a
    separate command-line workflow. CRAM admission is deliberately narrower:
    it reuses an existing readable CRAI/CSI and leaves creation to the tool that
    produced the reference-compressed file. Indexing is local-only. A newly
    generated BAM index goes to the app-owned cache keyed by the complete file
    generation, so import never mutates the user's source directory.
    """

    resolved_bam = _resolve_bam_path(bam_path)
    if _is_remote_bam(resolved_bam):
        raise AlignmentIndexError(
            "Automatic indexing is available only for local BAM files; "
            "provide a co-located remote .bai or .csi index."
        )
    source = Path(resolved_bam)
    if not source.is_file():
        raise BamNotFoundError(f"alignment not found: {bam_path}")
    suffix = source.suffix.lower()
    if suffix not in (".bam", ".cram"):
        raise AlignmentIndexError("Choose a BAM or CRAM read-alignment file.")

    admitted_generation = (
        AlignedReadFileGeneration.model_validate(source_generation)
        if source_generation is not None
        else capture_aligned_read_file_generation(source)
    )
    _require_alignment_file_generation(source, admitted_generation)

    existing = _readable_local_index(resolved_bam)
    if existing is not None:
        _require_alignment_file_generation(source, admitted_generation)
        return {
            "format": "cram" if suffix == ".cram" else "bam",
            "state": "present",
            "indexPath": str(existing),
        }

    if suffix == ".cram":
        raise AlignmentIndexError(
            "This CRAM needs a matching .crai or .csi index beside it before it can be added."
        )

    managed_target = _managed_index_target(source, admitted_generation)
    try:
        with alignment_index_target_lock(managed_target):
            _require_alignment_file_generation(source, admitted_generation)
            created = _build_index_atomically(
                resolved_bam,
                managed_target,
                source_generation=admitted_generation,
            )
    except _IndexPlacementError as managed_error:
        raise AlignmentIndexError(
            f"Could not place a BAM index in the managed index cache. {managed_error}."
        ) from managed_error
    return {
        "format": "bam",
        "state": "created" if created else "present",
        "indexPath": str(managed_target),
    }


def read_alignment_header(
    bam_path: str,
    index_path: Optional[str] = None,
    *,
    reference_fasta: Optional[str] = None,
) -> dict:
    """Read alignment identity and, for CRAM, prove the selected reference."""
    resolved_bam = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved_bam) and not Path(resolved_bam).is_file():
        raise BamNotFoundError(f"alignment not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    verbosity = pysam.set_verbosity(0)
    try:
        alignment = _open_alignment(resolved_bam, resolved_index, resolved_reference)
        try:
            header = alignment.header.to_dict()
            is_cram = bool(getattr(alignment, "is_cram", False))
            try:
                has_index = bool(alignment.has_index())
            except (ValueError, AttributeError):
                has_index = False
            if is_cram and resolved_reference is not None:
                try:
                    _decode_one_record_per_indexed_reference(
                        alignment,
                        _fasta_reference_names(resolved_reference),
                    )
                except (OSError, ValueError) as exc:
                    raise ReferenceNotFoundError(
                        "The selected reference FASTA could not decode this CRAM. "
                        "Choose the exact reference used to create it."
                    ) from exc
        finally:
            alignment.close()
    finally:
        pysam.set_verbosity(verbosity)

    references: list[dict] = []
    for sequence in header.get("SQ", []) or []:
        name = sequence.get("SN")
        if not name:
            continue
        md5 = sequence.get("M5")
        references.append(
            {
                "name": name,
                "length": int(sequence["LN"]) if sequence.get("LN") is not None else 0,
                "md5": md5.lower() if isinstance(md5, str) and md5 else None,
            }
        )

    return {
        "format": "cram" if is_cram else "bam",
        "isCram": is_cram,
        "referenceRequired": is_cram,
        "references": references,
        "index": {
            "state": "present" if has_index else _infer_index_state(resolved_bam)
        },
    }


def _fasta_reference_names(reference_path: str) -> set[str]:
    """Names listed in the FASTA index. A per-chromosome file only names itself."""
    names: set[str] = set()
    with open(reference_path + ".fai", encoding="ascii") as handle:
        for line in handle:
            name = line.split("\t", 1)[0].strip()
            if name:
                names.add(name)
    return names


def _decode_one_record_per_indexed_reference(
    alignment,
    covered_names: set[str],
) -> None:
    """Prove the FASTA against every contig it actually contains.

    CRAM reference validation happens while a slice is decoded. A FASTA that
    names every contig is proved on each one, so a later wrong sequence cannot
    hide behind a matching first contig. A per-chromosome FASTA is proved only
    on the chromosomes it contains. The other chromosomes are decoded later
    with their own files. Walking them here would ask htslib for sequences this
    FASTA does not have.
    """

    decoded_references = 0
    for reference_name in alignment.references:
        if reference_name not in covered_names:
            continue
        iterator = alignment.fetch(reference_name)
        try:
            next(iterator)
            decoded_references += 1
        except StopIteration:
            continue
    if decoded_references == 0:
        covers_every_contig = all(
            name in covered_names for name in alignment.references
        )
        if covers_every_contig:
            raise ReferenceNotFoundError(
                "This CRAM contains no indexed records, so the selected reference FASTA "
                "could not be verified."
            )
        raise ReferenceNotFoundError(
            "The selected reference FASTA does not cover any contig that has reads "
            "in this CRAM."
        )


def read_pileup_region(
    bam_path: str,
    chrom: str,
    start: int,
    end: int,
    max_reads: Optional[int] = None,
    *,
    index_path: Optional[str] = None,
    reference_fasta: Optional[str] = None,
    wire_format: Literal["objects", "columns-v1"] = "objects",
) -> PileupRegionResult | PileupRegionColumnsResult:
    """Reads overlapping ``[start, end)`` on ``chrom`` from an indexed BAM.

    Primary, mapped reads only (secondary/supplementary/unmapped skipped).

     — optional SPREAD-sampling (not left-truncation). Exact detail callers
    pass ``max_reads=None`` and get every primary overlapping read. When an
    explicit cap is supplied and the window's read count exceeds it, this function
    returns an EVEN SPATIAL sample that COVERS the whole window instead of the
    first ``max_reads`` reads (which clustered against the LEFT edge — the old
    bug). The sample is DETERMINISTIC and WINDOW-INDEPENDENT: a read is kept iff
    ``crc32(QNAME)`` lands in a ``1/stride`` residue class, so overlapping windows
    agree on which reads are shown.

    The coverage band still carries TRUE, uncapped depth; only the individual-read
    overlay is sampled at zoom-out (the IGV/CLC alignment-downsampling model).
    ``truncated`` now means "spread-sampled" (a representative subset was returned).
    """
    resolved = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved) and not Path(resolved).is_file():
        raise BamNotFoundError(f"BAM not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    reads: list[PileupRead] = []
    columns: PileupColumns | None = (
        {"start": [], "end": [], "strand": [], "mapq": [], "readId": [], "paired": []}
        if wire_format == "columns-v1"
        else None
    )
    stride = 1
    sampled = False
    with _open_alignment(resolved, resolved_index, resolved_reference) as bam:

        if max_reads is not None and max_reads > 0:
            n_est = bam.count(chrom, start, end)
            if n_est > max_reads:
                stride = max(2, math.ceil(n_est / max_reads))
                sampled = True
        for r in bam.fetch(chrom, start, end):
            if (
                r.is_unmapped
                or r.is_secondary
                or r.is_supplementary
                or r.reference_end is None
            ):
                continue
            if stride > 1 and (
                zlib.crc32(r.query_name.encode("ascii", "ignore")) % stride
            ):
                continue
            read_start = int(r.reference_start)
            read_end = int(r.reference_end)
            strand = "-" if r.is_reverse else "+"
            mapq = int(r.mapping_quality)
            read_id = r.query_name
            paired = bool(r.is_paired)
            if columns is not None:
                columns["start"].append(read_start)
                columns["end"].append(read_end)
                columns["strand"].append(strand)
                columns["mapq"].append(mapq)
                columns["readId"].append(read_id)
                columns["paired"].append(paired)
            else:
                reads.append(
                    {
                        "start": read_start,
                        "end": read_end,
                        "strand": strand,
                        "mapq": mapq,
                        "readId": read_id,
                        "paired": paired,
                    }
                )

    if columns is not None:
        return {
            "format": "columns-v1",
            "columns": columns,
            "count": len(columns["start"]),
            "truncated": sampled,
        }
    return {"reads": reads, "count": len(reads), "truncated": sampled}


_COVERAGE_MAX_BINS = 4096


_COVERAGE_MIN_BIN_BP = 1


def _resolve_coverage_bin_size(span: int, requested_bin_size: Optional[int]) -> int:
    """Pick the actual bin width (bp) for a coverage region.

    Honors ``requested_bin_size`` when given, but always clamps so the region
    yields at most ``_COVERAGE_MAX_BINS`` bins (a whole chromosome stays a small
    array). A request with no bin size auto-sizes to the bin budget. The result
    is never below ``_COVERAGE_MIN_BIN_BP``.
    """
    if span <= 0:
        return _COVERAGE_MIN_BIN_BP
    budget_bin = math.ceil(span / _COVERAGE_MAX_BINS)
    base = (
        requested_bin_size
        if (requested_bin_size and requested_bin_size > 0)
        else budget_bin
    )
    return max(_COVERAGE_MIN_BIN_BP, base, budget_bin)


def accumulate_alignment_depth(
    delta: np.ndarray,
    read: pysam.AlignedSegment,
    start: int,
    end: int,
) -> None:
    for block_start, block_end in read.get_blocks():
        left = max(int(block_start), start) - start
        right = min(int(block_end), end) - start
        if right > left:
            delta[left] += 1
            delta[right] -= 1


def coverage_region(
    bam_path: str,
    chrom: str,
    start: int,
    end: int,
    bin_size: Optional[int] = None,
    *,
    index_path: Optional[str] = None,
    reference_fasta: Optional[str] = None,
) -> CoverageRegionResult:
    """Binned read DEPTH over ``[start, end)`` on ``chrom`` from an indexed BAM.

    This is the always-present coverage/depth signal — the IGV/JBrowse coverage
    track. It is computed from the index/alignments INDEPENDENTLY of the exact
    in-view read overlay, so the depth histogram is present at all zooms and does
    NOT vanish when the exact-read window is still streaming : the
    assembly pileup band looked empty because its only depth signal was derived
    from the streamed reads). Full, uncapped depth — never downsampled.

    Primary, mapped reads only (matches ``read_pileup_region``'s filter), so the
    depth here is consistent with the reads the overlay paints. Each bin is the
    PEAK (maximum) per-base read depth anywhere within that bin. Peak — not the
    mean — is what matches the renderer: the coverage mip-pyramid max-pools and
    the read-derived pileup field reports peak depth, so a mean here would sit
    *below* the read-derived curve and the band would drop at the hand-off
    . Peak makes the precomputed and read-derived curves the same curve.
    This still avoids the common lie of reporting "number of reads that touched a
    700 kb bin" as depth (which can be hundreds of thousands for an 80x WGS BAM):
    the value is a true per-base depth, never a per-bin read count.
    """
    if end <= start:
        raise PileupError("end must be greater than start")
    resolved = _resolve_bam_path(bam_path)
    if not _is_remote_bam(resolved) and not Path(resolved).is_file():
        raise BamNotFoundError(f"BAM not found: {bam_path}")
    resolved_index = _resolve_index_path(index_path)
    resolved_reference = _resolve_reference_path(reference_fasta)

    span = end - start
    actual_bin = _resolve_coverage_bin_size(span, bin_size)

    delta = np.zeros(span + 1, dtype=np.int32)

    with _open_alignment(resolved, resolved_index, resolved_reference) as bam:
        for r in bam.fetch(chrom, start, end):
            if (
                r.is_unmapped
                or r.is_secondary
                or r.is_supplementary
                or r.reference_end is None
            ):
                continue

            accumulate_alignment_depth(delta, r, start, end)

    bins: list[float] = []
    if span > 0:
        per_base = np.cumsum(delta[:span])
        n_full = (span // actual_bin) * actual_bin
        if n_full > 0:
            full_peaks = per_base[:n_full].reshape(-1, actual_bin).max(axis=1)
            bins.extend(float(v) for v in full_peaks)
        if n_full < span:

            bins.append(float(per_base[n_full:].max()))

    return {
        "chrom": chrom,
        "start": start,
        "end": end,
        "binSize": actual_bin,
        "bins": bins,
        "maxDepth": max(bins) if bins else 0.0,
    }
