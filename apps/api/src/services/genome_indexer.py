"""Genome indexer (DNA-G1 / .

Converts `.gb` / `.gbff` / `.gbk`, `.fa` / `.fasta` / `.fna`, and GFF3 +
companion FASTA into the indexed files the renderer's range-query layer reads:

  * `<name>.fa.gz`        — BGZF FASTA copy of the sequence(s)
  * `<name>.fa.gz.fai`    — htslib FASTA index (uncompressed layout offsets)
  * `<name>.fa.gz.gzi`    — gzip index for random-access BGZF FASTA
  * `<name>.gff3.gz`      — bgzipped GFF3 (only when source has features)
  * `<name>.gff3.gz.tbi`  — tabix index of the bgzipped GFF3

Every format is converted by the Rust `dna-indexer` helper, run as a child
process of the sidecar, so the renderer never sees a sequence-parsing freeze.

Plan: tools/devops/plans/2026-05-03-indexed-genome-backend.md.

The output directory is one immutable source/schema generation. The indexer
builds the complete quartet plus a content-hashed receipt in a sibling staging
directory, then publishes it with one directory rename. Concurrent writers can
only race at that rename; the loser validates and reuses the committed bundle.
The desktop includes its index schema in the output-directory identity, so an
upgrade never rewrites files beneath an already-open reader.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


class GenomeIndexerError(Exception):
    """Base class for indexer errors."""


class GenomeIndexCancelledError(GenomeIndexerError):
    """Raised when the last caller releases an in-progress index build."""


def _raise_if_cancelled(cancel_check: Optional[Callable[[], bool]]) -> None:
    if cancel_check is not None and cancel_check():
        raise GenomeIndexCancelledError("genome indexing was cancelled")


def _raise_if_shellout_cancelled(code: str, message: str, cause: Exception) -> None:
    if code == "CANCELLED":
        raise GenomeIndexCancelledError(message) from cause


class WorkspaceContainmentError(GenomeIndexerError):
    """Raised when a requested path resolves outside the workspace root."""


class UnsupportedFormatError(GenomeIndexerError):
    """Raised when the input file extension isn't one we index."""


class NameValidationError(GenomeIndexerError):
    """Raised when the caller-provided ``name`` fails the basename regex.

    Distinct from the generic ``GenomeIndexerError`` so the route layer
    can map it to 400 rather than a 500 fallthrough — a malformed
    ``name`` is user input, not a server error.
    """


class MissingInputError(GenomeIndexerError, FileNotFoundError):
    """Raised when the input file does not exist."""


_BUNDLE_RECEIPT_MAX_BYTES = 64 * 1024


@dataclass(frozen=True)
class GenomeMetadata:
    length: int
    circular: bool
    feature_count: int


@dataclass(frozen=True)
class IndexerResult:
    fasta_path: Path
    fai_path: Path
    gff_path: Optional[Path]
    tbi_path: Optional[Path]
    metadata: GenomeMetadata


def _run_rust_indexer(
    *,
    input_resolved: Path,
    staging_dir: Path,
    fasta_stage: Path,
    fai_stage: Path,
    name: str,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> Optional[tuple[int, bool, int]]:
    """Run `dna-indexer index` on a GenBank or FASTA input into `staging_dir`.

    GenBank writes the sequence triple plus GFF3/tabix; FASTA writes only the
    sequence triple. Both rename the record to `name`, reject multi-record
    input, and raise `GenomeIndexerError` on any failure. Returns
    `(length, circular, annotation_rows)` from the binary's terminal status,
    or None when the binary did not report a row count.
    """
    from .dna_indexer_shellout import DnaIndexerError, run_index

    try:
        result = run_index(
            input_path=input_resolved,
            out_dir=staging_dir,
            name=name,
            timeout_sec=300.0,
            cancel_check=cancel_check,
        )
    except DnaIndexerError as e:
        _raise_if_shellout_cancelled(e.code, e.message, e)
        if e.code in {"GENBANK_PARSE_FAILED", "UNSUPPORTED_INPUT_FORMAT"}:
            raise GenomeIndexerError(f"{e.code}: {e.message}") from e
        raise GenomeIndexerError(f"dna-indexer ({e.code}): {e.message}") from e

    gzi_stage = Path(str(fasta_stage) + ".gzi")
    for staged_path in (fasta_stage, fai_stage, gzi_stage):
        if not staged_path.exists():
            raise GenomeIndexerError(
                f"dna-indexer reported success but {staged_path.name} is missing"
            )
    return _reported_metadata(result)


def _reported_metadata(result) -> Optional[tuple[int, bool, int]]:
    if result is None or result.annotation_rows is None:
        return None
    return result.length, result.topology == "circular", result.annotation_rows


def _rust_stage_metadata(
    fasta_stage: Path, gff_gz_stage: Path
) -> tuple[int, bool, int]:
    """Read length / circular / feature_count from the Rust-staged files.

    We don't have access to the Rust binary's terminal status JSON at
    this point (it was consumed during run_index). Re-read the metadata
    from the staged files themselves:
      - length: from the FASTA index (column 2 of .fa.fai)
      - feature_count: count of non-pragma rows in the BGZF GFF3
      - circular: parsed from the `##dna-indexer-topology` pragma in the
        GFF3 header. The Rust binary writes `linear` or `circular` based
        on the GenBank LOCUS line's topology field. FASTA writes no GFF3
        and is always linear.
    """
    import gzip

    fai_path = Path(str(fasta_stage) + ".fai")
    fai_line = fai_path.read_text().strip().splitlines()[0]
    length = int(fai_line.split("\t")[1])

    feature_count = 0
    circular = False
    if not gff_gz_stage.exists():
        return length, circular, feature_count
    with gzip.open(gff_gz_stage, "rt") as f:
        for line in f:
            if line.startswith("##dna-indexer-topology"):
                circular = line.strip().split(maxsplit=1)[1].lower() == "circular"
                continue
            if line.startswith("##") or not line.strip():
                continue
            feature_count += 1

    return length, circular, feature_count


GENBANK_EXTS = frozenset({".gb", ".gbff", ".gbk", ".genbank"})
FASTA_EXTS = frozenset({".fa", ".fasta", ".fna"})
GFF3_EXTS = frozenset({".gff", ".gff3"})
SUPPORTED_EXTS = GENBANK_EXTS | FASTA_EXTS | GFF3_EXTS
_BUNDLE_RECEIPT_SCHEMA_VERSION = 1


def _extract_schema_pragma(gff_gz_path: Path) -> Optional[int]:
    """Read the `##dna-indexer-schema <N>` pragma from a cached
    indexed-genome GFF3. Returns the integer schema version, or None
    if the file isn't a DNAForge-produced index (no pragma → either
    a foreign GFF3 we ingested, or pre-schema-pragma legacy).
    """
    import gzip

    try:
        with gzip.open(gff_gz_path, "rt") as f:
            for line in f:
                if line.startswith("##dna-indexer-schema"):
                    parts = line.strip().split()
                    if len(parts) >= 2:
                        try:
                            return int(parts[1])
                        except ValueError:
                            return None
                if not line.startswith("##"):
                    return None
    except (OSError, EOFError):
        return None
    return None


def is_index_stale(gff_gz_path: Path, current_schema: int) -> bool:
    """True when the cached index was produced under an older schema
    than the current binary supports — i.e., the index needs regen.

    `None` from `_extract_schema_pragma` is treated as stale (legacy
    pre-pragma index or foreign GFF3). The auto-regen path catches both
    cases without needing to differentiate.
    """
    cached = _extract_schema_pragma(gff_gz_path)
    if cached is None:
        return True
    return cached < current_schema


_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _validate_name(name: str) -> str:
    if not isinstance(name, str) or not _SAFE_NAME.match(name):
        raise NameValidationError(
            f"invalid output name {name!r}: must match {_SAFE_NAME.pattern}"
        )
    return name


def _resolve_inside(p: Path, root: Path, *, must_exist: bool) -> Path:
    """Resolve ``p`` and assert it lives inside ``root``.

    Containment is enforced *before* existence so that `..`-traversal and
    symlink-escape attempts surface as ``WorkspaceContainmentError`` rather
    than ``MissingInputError`` (which would leak whether a path outside the
    workspace exists).

    ``root`` must already be resolved.
    """
    resolved = p.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise WorkspaceContainmentError(
            f"path {p} resolves to {resolved}, outside workspace {root}"
        ) from exc
    if must_exist and not resolved.exists():
        raise MissingInputError(f"input not found: {p}")
    return resolved


def _is_inside(resolved: Path, root: Path) -> bool:
    """True iff already-resolved ``resolved`` lives inside already-resolved ``root``."""
    try:
        resolved.relative_to(root)
        return True
    except ValueError:
        return False


def _trusted_input_roots() -> "list[Path]":
    """Extra roots — beyond the workspace — the indexer may read INPUT from.

    Set by the desktop main process via ``WAYPOINT_TRUSTED_FIXTURE_ROOTS`` (an
    ``os.pathsep``-separated list of absolute paths) so SHARED genome fixtures
    kept in ``wp-assets`` and symlinked into a worktree's ``test-fixtures`` are
    indexable without weakening the workspace sandbox that governs OUTPUT. Only
    existing directories are honored; an unset/empty var preserves the original
    strict workspace-only behavior. This mirrors how the pileup reader already
    accepts ``wp-assets`` BAM/CRAM absolute paths.
    """
    raw = os.environ.get("WAYPOINT_TRUSTED_FIXTURE_ROOTS", "")
    roots: "list[Path]" = []
    for part in raw.split(os.pathsep):
        part = part.strip()
        if not part:
            continue
        try:
            resolved = Path(part).resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if resolved.is_dir():
            roots.append(resolved)
    return roots


def _resolve_inside_any(p: Path, roots: "list[Path]", *, must_exist: bool) -> Path:
    """Resolve ``p`` and assert it lives inside AT LEAST ONE of ``roots``.

    Containment is enforced before existence (same rationale as
    :func:`_resolve_inside`). All ``roots`` must already be resolved; ``roots[0]``
    is the workspace and is named first in the error for the common case.
    """
    resolved = p.resolve(strict=False)
    if not any(_is_inside(resolved, root) for root in roots):
        extra = " or trusted fixture roots" if len(roots) > 1 else ""
        raise WorkspaceContainmentError(
            f"path {p} resolves to {resolved}, outside workspace {roots[0]}{extra}"
        )
    if must_exist and not resolved.exists():
        raise MissingInputError(f"input not found: {p}")
    return resolved


def _source_identity(path: Path) -> dict[str, int | str]:
    try:
        metadata = path.stat()
    except OSError as exc:
        raise GenomeIndexerError(f"could not stat genome source {path}: {exc}") from exc
    return {
        "path": str(path),
        "size": metadata.st_size,
        "mtimeNs": metadata.st_mtime_ns,
        "ctimeNs": metadata.st_ctime_ns,
        "device": str(metadata.st_dev),
        "inode": str(metadata.st_ino),
    }


def _bundle_receipt_path(bundle_dir: Path, name: str) -> Path:
    return bundle_dir / f"{name}.waypoint-bundle.json"


def _member_receipt(
    path: Path, cancel_check: Optional[Callable[[], bool]]
) -> dict[str, int | str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            _raise_if_cancelled(cancel_check)
            digest.update(chunk)
            size += len(chunk)
        os.fsync(handle.fileno())
    return {"file": path.name, "size": size, "sha256": digest.hexdigest()}


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _write_bundle_receipt(
    *,
    staging_dir: Path,
    name: str,
    source_identity: dict[str, int | str],
    metadata: GenomeMetadata,
    cancel_check: Optional[Callable[[], bool]],
) -> None:
    members: dict[str, dict[str, int | str] | None] = {
        "fasta": _member_receipt(staging_dir / f"{name}.fa.gz", cancel_check),
        "fai": _member_receipt(staging_dir / f"{name}.fa.gz.fai", cancel_check),
        "gzi": _member_receipt(staging_dir / f"{name}.fa.gz.gzi", cancel_check),
        "gff": None,
        "tbi": None,
    }
    if metadata.feature_count > 0:
        members["gff"] = _member_receipt(staging_dir / f"{name}.gff3.gz", cancel_check)
        members["tbi"] = _member_receipt(
            staging_dir / f"{name}.gff3.gz.tbi", cancel_check
        )
    receipt: dict[str, object] = {
        "schemaVersion": _BUNDLE_RECEIPT_SCHEMA_VERSION,
        "name": name,
        "source": source_identity,
        "members": members,
        "metadata": {
            "length": metadata.length,
            "circular": metadata.circular,
            "featureCount": metadata.feature_count,
        },
    }
    canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":"))
    receipt["generationId"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    receipt_path = _bundle_receipt_path(staging_dir, name)
    with receipt_path.open("x", encoding="utf-8") as handle:
        json.dump(receipt, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    _fsync_directory(staging_dir)


def _read_committed_bundle(
    *,
    output_dir: Path,
    name: str,
    source_identity: dict[str, int | str],
    cancel_check: Optional[Callable[[], bool]],
) -> IndexerResult:
    receipt_path = _bundle_receipt_path(output_dir, name)
    try:
        receipt_bytes = _read_bounded_regular_file(receipt_path)
        receipt = json.loads(receipt_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GenomeIndexerError(
            f"genome index destination has an unreadable receipt: {receipt_path}"
        ) from exc
    expected_receipt_keys = {
        "schemaVersion",
        "generationId",
        "name",
        "source",
        "members",
        "metadata",
    }
    if (
        not isinstance(receipt, dict)
        or set(receipt) != expected_receipt_keys
        or receipt.get("schemaVersion") != _BUNDLE_RECEIPT_SCHEMA_VERSION
        or receipt.get("name") != name
        or receipt.get("source") != source_identity
    ):
        raise GenomeIndexerError(
            f"genome index destination belongs to a different source or schema: {output_dir}"
        )
    generation_id = receipt.get("generationId")
    unsigned_receipt = dict(receipt)
    del unsigned_receipt["generationId"]
    expected_generation_id = hashlib.sha256(
        json.dumps(unsigned_receipt, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()
    if generation_id != expected_generation_id:
        raise GenomeIndexerError(
            f"genome index receipt generation identifier is invalid: {receipt_path}"
        )
    metadata_raw = receipt.get("metadata")
    members_raw = receipt.get("members")
    if (
        not isinstance(metadata_raw, dict)
        or set(metadata_raw) != {"length", "circular", "featureCount"}
        or not isinstance(members_raw, dict)
        or set(members_raw) != {"fasta", "fai", "gzi", "gff", "tbi"}
    ):
        raise GenomeIndexerError(f"genome index receipt is incomplete: {receipt_path}")
    length = metadata_raw.get("length")
    circular = metadata_raw.get("circular")
    feature_count = metadata_raw.get("featureCount")
    if (
        not isinstance(length, int)
        or isinstance(length, bool)
        or length < 0
        or not isinstance(circular, bool)
        or not isinstance(feature_count, int)
        or isinstance(feature_count, bool)
        or feature_count < 0
    ):
        raise GenomeIndexerError(
            f"genome index receipt metadata is invalid: {receipt_path}"
        )

    expected_names = {
        "fasta": f"{name}.fa.gz",
        "fai": f"{name}.fa.gz.fai",
        "gzi": f"{name}.fa.gz.gzi",
        "gff": f"{name}.gff3.gz" if feature_count > 0 else None,
        "tbi": f"{name}.gff3.gz.tbi" if feature_count > 0 else None,
    }
    committed_paths: dict[str, Path | None] = {}
    for key, expected_name in expected_names.items():
        member = members_raw.get(key)
        if expected_name is None:
            if member is not None:
                raise GenomeIndexerError(
                    f"genome index receipt unexpectedly includes {key}: {receipt_path}"
                )
            committed_paths[key] = None
            continue
        if not isinstance(member, dict) or member.get("file") != expected_name:
            raise GenomeIndexerError(
                f"genome index receipt has an invalid {key} member: {receipt_path}"
            )
        member_path = output_dir / expected_name
        if member_path.is_symlink() or not member_path.is_file():
            raise GenomeIndexerError(
                f"genome index committed member is missing or not regular: {member_path}"
            )
        actual = _member_receipt(member_path, cancel_check)
        if actual != member:
            raise GenomeIndexerError(
                f"genome index committed member does not match its receipt: {member_path}"
            )
        committed_paths[key] = member_path

    fasta_path = committed_paths["fasta"]
    fai_path = committed_paths["fai"]
    gzi_path = committed_paths["gzi"]
    if fasta_path is None or fai_path is None or gzi_path is None:
        raise GenomeIndexerError(
            f"genome index receipt lacks required members: {receipt_path}"
        )
    return IndexerResult(
        fasta_path=fasta_path,
        fai_path=fai_path,
        gff_path=committed_paths["gff"],
        tbi_path=committed_paths["tbi"],
        metadata=GenomeMetadata(
            length=length, circular=circular, feature_count=feature_count
        ),
    )


def _read_bounded_regular_file(path: Path) -> bytes:
    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW

    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise OSError(f"receipt is not a regular file: {path}")
        if opened.st_size > _BUNDLE_RECEIPT_MAX_BYTES:
            raise OSError(f"receipt exceeds {_BUNDLE_RECEIPT_MAX_BYTES} bytes: {path}")

        chunks: list[bytes] = []
        remaining = _BUNDLE_RECEIPT_MAX_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(8192, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        if len(payload) > _BUNDLE_RECEIPT_MAX_BYTES:
            raise OSError(f"receipt exceeds {_BUNDLE_RECEIPT_MAX_BYTES} bytes: {path}")

        current = os.stat(path, follow_symlinks=False)
        if (
            not stat.S_ISREG(current.st_mode)
            or current.st_dev != opened.st_dev
            or current.st_ino != opened.st_ino
        ):
            raise OSError(f"receipt changed while it was being read: {path}")
        return payload
    finally:
        os.close(descriptor)


def _publish_staged_bundle(
    *,
    staging_dir: Path,
    output_dir: Path,
    input_path: Path,
    source_identity: dict[str, int | str],
    name: str,
    metadata: GenomeMetadata,
    cancel_check: Optional[Callable[[], bool]],
) -> IndexerResult:
    _raise_if_cancelled(cancel_check)
    if _source_identity(input_path) != source_identity:
        raise GenomeIndexerError(
            f"genome source changed while it was being indexed: {input_path}"
        )
    _write_bundle_receipt(
        staging_dir=staging_dir,
        name=name,
        source_identity=source_identity,
        metadata=metadata,
        cancel_check=cancel_check,
    )
    _raise_if_cancelled(cancel_check)
    if _source_identity(input_path) != source_identity:
        raise GenomeIndexerError(
            f"genome source changed while it was being indexed: {input_path}"
        )
    try:
        os.rename(staging_dir, output_dir)
    except OSError as exc:
        if output_dir.exists():
            try:
                committed = _read_committed_bundle(
                    output_dir=output_dir,
                    name=name,
                    source_identity=source_identity,
                    cancel_check=cancel_check,
                )
            except GenomeIndexerError as receipt_error:
                raise GenomeIndexerError(
                    f"refusing to replace non-atomic genome index destination {output_dir}: "
                    f"{receipt_error}"
                ) from exc
            shutil.rmtree(staging_dir, ignore_errors=True)
            return committed
        raise GenomeIndexerError(
            f"could not atomically publish genome index directory {output_dir}: {exc}"
        ) from exc
    _fsync_directory(output_dir.parent)
    return IndexerResult(
        fasta_path=output_dir / f"{name}.fa.gz",
        fai_path=output_dir / f"{name}.fa.gz.fai",
        gff_path=output_dir / f"{name}.gff3.gz" if metadata.feature_count > 0 else None,
        tbi_path=(
            output_dir / f"{name}.gff3.gz.tbi" if metadata.feature_count > 0 else None
        ),
        metadata=metadata,
    )


def index_genome(
    *,
    input_path: Path,
    output_dir: Path,
    name: str,
    workspace_root: Path,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> IndexerResult:
    """Produce indexed FASTA + GFF3 for one chromosome / assembly file.

    All four arguments must resolve inside ``workspace_root``. The route layer
    translates exceptions to HTTP status codes; callers in tests can catch
    the typed errors directly.
    """
    _raise_if_cancelled(cancel_check)
    name = _validate_name(name)

    if not workspace_root.exists():
        raise WorkspaceContainmentError(
            f"workspace_root {workspace_root} does not exist"
        )
    ws = workspace_root.resolve(strict=True)

    input_resolved = _resolve_inside_any(
        input_path, [ws, *_trusted_input_roots()], must_exist=True
    )
    source_identity = _source_identity(input_resolved)
    ext = input_resolved.suffix.lower()
    if ext == ".gz":
        ext = input_resolved.with_suffix("").suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise UnsupportedFormatError(
            f"unsupported extension {input_resolved.suffix.lower()!r}; expected one of "
            f"{sorted(SUPPORTED_EXTS)} (compound `.gz` variants also accepted)"
        )

    output_resolved = _resolve_inside(output_dir, ws, must_exist=False)
    output_resolved.parent.mkdir(parents=True, exist_ok=True)
    _raise_if_cancelled(cancel_check)

    staging_dir = Path(
        tempfile.mkdtemp(
            prefix=f".{output_resolved.name}.{name}.indexing.",
            dir=output_resolved.parent,
        )
    )
    fasta_stage = staging_dir / f"{name}.fa.gz"
    fai_stage = staging_dir / f"{name}.fa.gz.fai"
    gzi_stage = staging_dir / f"{name}.fa.gz.gzi"
    gff_gz_stage = staging_dir / f"{name}.gff3.gz"
    tbi_stage = staging_dir / f"{name}.gff3.gz.tbi"

    try:
        feature_count = 0
        if ext in GFF3_EXTS:
            from .dna_indexer_shellout import (
                DnaIndexerError as ShelloutError,
            )
            from .dna_indexer_shellout import (
                find_companion_fasta,
            )
            from .dna_indexer_shellout import (
                run_index as shellout_run_index,
            )

            companion_fasta = find_companion_fasta(input_resolved)
            if companion_fasta is None:
                raise UnsupportedFormatError(
                    f"GFF3 input {input_resolved.name} has no companion FASTA. "
                    f"Place a `{input_resolved.stem}.fa` / `.fasta` / `.fna` "
                    f"file next to the GFF3 (with or without `.gz`)."
                )
            try:
                gff3_result = shellout_run_index(
                    input_path=input_resolved,
                    out_dir=staging_dir,
                    name=name,
                    companion_fasta=companion_fasta,
                    cancel_check=cancel_check,
                )
            except ShelloutError as exc:
                _raise_if_shellout_cancelled(exc.code, exc.message, exc)
                raise GenomeIndexerError(
                    f"dna-indexer ingest-gff3 failed: {exc}"
                ) from exc

            _raise_if_cancelled(cancel_check)
            expected_stage_files = (
                fasta_stage,
                fai_stage,
                gzi_stage,
                gff_gz_stage,
                tbi_stage,
            )
            missing_stage_files = [
                path.name for path in expected_stage_files if not path.is_file()
            ]
            if missing_stage_files:
                raise GenomeIndexerError(
                    "dna-indexer ingest-gff3 produced an incomplete index: "
                    + ", ".join(missing_stage_files)
                )

            length, circular, feature_count = _reported_metadata(
                gff3_result
            ) or _rust_stage_metadata(fasta_stage, gff_gz_stage)
            metadata = GenomeMetadata(
                length=length,
                circular=circular,
                feature_count=feature_count,
            )
            return _publish_staged_bundle(
                staging_dir=staging_dir,
                output_dir=output_resolved,
                input_path=input_resolved,
                source_identity=source_identity,
                name=name,
                metadata=metadata,
                cancel_check=cancel_check,
            )

        reported = _run_rust_indexer(
            input_resolved=input_resolved,
            staging_dir=staging_dir,
            fasta_stage=fasta_stage,
            fai_stage=fai_stage,
            name=name,
            cancel_check=cancel_check,
        )
        _raise_if_cancelled(cancel_check)
        length, circular, feature_count = reported or _rust_stage_metadata(
            fasta_stage, gff_gz_stage
        )
        if feature_count == 0:
            gff_gz_stage.unlink(missing_ok=True)
            tbi_stage.unlink(missing_ok=True)
        metadata = GenomeMetadata(
            length=length,
            circular=circular,
            feature_count=feature_count,
        )
        return _publish_staged_bundle(
            staging_dir=staging_dir,
            output_dir=output_resolved,
            input_path=input_resolved,
            source_identity=source_identity,
            name=name,
            metadata=metadata,
            cancel_check=cancel_check,
        )
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)
