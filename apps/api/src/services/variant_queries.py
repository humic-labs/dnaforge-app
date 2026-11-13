"""Indexed, bounded VCF/BCF queries for the genome mutation navigator.

The source VCF is canonical and is never rewritten. Plain VCF and ordinary-gzip
VCF inputs are converted once into a stat-keyed bgzip + tabix cache. Page
queries open the indexed source and return only a bounded summary payload; the
desktop never loads or counts the whole call set.
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Iterable, Literal

import pysam

from ..local_file_generation import (
    LocalFileGeneration,
    capture_local_file_generation,
)
from ..variant_source_operation_contract import (
    VariantFileGeneration,
    VariantReferenceIdentity,
    capture_variant_file_generation,
    variant_assembly_revision,
)
from .file_target_lock import file_target_lock

_CACHE_DIR_ENV = "DNAFORGE_VARIANT_INDEX_CACHE_DIR"
_DEFAULT_CACHE_SUBDIR = "variant-indexes"
_MAX_PAGE_SIZE = 200
_MAX_REGION_SIZE = 10_000
_MAX_REGION_BP = 5_000_000
_CURSOR_VERSION = 2
_CACHE_RECEIPT_SCHEMA = "dnaforge.variant-index-cache.v1"
_MAX_CACHE_RECEIPT_BYTES = 64 * 1024


class VariantQueryError(Exception):
    """Base class for source preparation and page-query failures."""


class VariantSourceNotFoundError(VariantQueryError):
    """The selected call file no longer exists."""


class VariantIndexError(VariantQueryError):
    """The call file cannot be queried through a valid htslib index."""


class VariantAssemblyMismatchError(VariantQueryError):
    """The call file and open reference do not share an exact coordinate system."""


class VariantSourceGenerationChangedError(VariantQueryError):
    """A prepared source or one of its query artifacts changed before use."""


def _resolve_source_path(source_path: str) -> Path:
    path = Path(source_path).expanduser()
    if not path.is_absolute():
        for parent in Path(__file__).resolve().parents:
            if (parent / "pnpm-workspace.yaml").is_file():
                path = parent / path
                break
    resolved = path.resolve()
    if not resolved.is_file():
        raise VariantSourceNotFoundError(f"Variant source not found: {source_path}")
    return resolved


def _source_format(path: Path) -> str:
    lower = path.name.lower()
    if lower.endswith(".bcf"):
        return "bcf"
    if (
        lower.endswith(".vcf")
        or lower.endswith(".vcf.gz")
        or lower.endswith(".vcf.bgz")
    ):
        return "vcf"
    raise VariantQueryError(
        f"Unsupported variant file {path.name}. Choose a .vcf, .vcf.gz, .vcf.bgz, or .bcf file."
    )


def _cache_dir() -> Path:
    override = os.environ.get(_CACHE_DIR_ENV)
    base = (
        Path(override).expanduser()
        if override
        else Path.home() / ".dnaforge" / _DEFAULT_CACHE_SUBDIR
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def _source_identity(path: Path) -> tuple[str, LocalFileGeneration]:
    generation = capture_local_file_generation(
        path,
        non_file_message="The selected variant source is not a file.",
    )
    return _generation_identity(generation), generation


def _generation_identity(generation: LocalFileGeneration) -> str:
    raw = json.dumps(
        generation.model_dump(mode="json", by_alias=True, exclude_none=False),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _expected_generation(
    value: VariantFileGeneration | Mapping[str, object],
) -> VariantFileGeneration:
    return VariantFileGeneration.model_validate(value)


def _require_generation(
    path: str | Path,
    expected: VariantFileGeneration | Mapping[str, object],
    *,
    label: str,
) -> VariantFileGeneration:
    required = _expected_generation(expected)
    try:
        actual = capture_variant_file_generation(str(path))
    except FileNotFoundError as exc:
        raise VariantSourceNotFoundError(f"{label} is no longer available.") from exc
    if actual != required:
        raise VariantSourceGenerationChangedError(
            f"{label} changed after variant preparation was admitted."
        )
    return actual


def _find_index(path: Path) -> Path | None:
    candidates = [
        Path(f"{path}.csi"),
        Path(f"{path}.tbi"),
        path.with_suffix(".csi"),
        path.with_suffix(".tbi"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def _variant_locator_label(path: str | Path) -> str:
    if isinstance(path, Path):
        return path.name
    return path.rsplit("/", 1)[-1] or "remote variant source"


def _open_variant(path: str | Path, index_path: Path) -> pysam.VariantFile:
    try:
        return pysam.VariantFile(str(path), index_filename=str(index_path))
    except (OSError, ValueError) as exc:
        raise VariantIndexError(
            f"Could not open indexed variant source {_variant_locator_label(path)}: {exc}"
        ) from exc


def _validate_index(path: str | Path, index_path: Path) -> None:
    try:
        with _open_variant(path, index_path) as variants:
            first_contig = next(iter(variants.header.contigs), None)
            if first_contig is not None:
                iterator = variants.fetch(first_contig, 0, 1)
                next(iterator, None)
    except VariantQueryError:
        raise
    except (OSError, ValueError) as exc:
        raise VariantIndexError(
            "Variant index is missing, stale, or unreadable for "
            f"{_variant_locator_label(path)}: {exc}"
        ) from exc


def _generation_payload(generation: VariantFileGeneration) -> dict[str, object]:
    return generation.model_dump(mode="json", by_alias=True, exclude_none=False)


def _remove_cache_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path, ignore_errors=True)


def _read_cache_receipt(
    receipt_path: Path,
    *,
    source_generation: VariantFileGeneration,
    query_path: Path,
    index_path: Path,
) -> tuple[VariantFileGeneration, VariantFileGeneration] | None:
    if receipt_path.is_symlink():
        return None
    try:
        descriptor = os.open(receipt_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    try:
        with os.fdopen(descriptor, "r", encoding="utf-8") as receipt:
            metadata = os.fstat(receipt.fileno())
            if (
                not stat.S_ISREG(metadata.st_mode)
                or metadata.st_size > _MAX_CACHE_RECEIPT_BYTES
            ):
                return None
            payload = json.load(receipt)
    except (OSError, ValueError, UnicodeError):
        return None
    if not isinstance(payload, dict) or payload.get("schema") != _CACHE_RECEIPT_SCHEMA:
        return None
    try:
        recorded_source = VariantFileGeneration.model_validate(
            payload.get("sourceGeneration")
        )
        recorded_query = VariantFileGeneration.model_validate(
            payload.get("queryGeneration")
        )
        recorded_index = VariantFileGeneration.model_validate(
            payload.get("indexGeneration")
        )
        actual_query = capture_variant_file_generation(str(query_path))
        actual_index = capture_variant_file_generation(str(index_path))
    except (FileNotFoundError, ValueError):
        return None
    if (
        recorded_source != source_generation
        or recorded_query != actual_query
        or recorded_index != actual_index
    ):
        return None
    try:
        _validate_index(query_path, index_path)
    except VariantIndexError:
        return None
    return actual_query, actual_index


def _write_cache_receipt(
    receipt_path: Path,
    *,
    source_generation: VariantFileGeneration,
    query_generation: VariantFileGeneration,
    index_generation: VariantFileGeneration,
) -> None:
    payload = {
        "schema": _CACHE_RECEIPT_SCHEMA,
        "sourceGeneration": _generation_payload(source_generation),
        "queryGeneration": _generation_payload(query_generation),
        "indexGeneration": _generation_payload(index_generation),
    }
    encoded = (
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    if len(encoded) > _MAX_CACHE_RECEIPT_BYTES:
        raise VariantIndexError("The variant cache receipt exceeds its storage bound.")
    temporary = receipt_path.with_name(f".{receipt_path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as target:
            target.write(encoded)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, receipt_path)
    finally:
        temporary.unlink(missing_ok=True)


def _cached_vcf(
    source: Path,
    key: str,
    source_generation: VariantFileGeneration,
) -> tuple[Path, Path]:
    cache_dir = _cache_dir()
    final_dir = cache_dir / key
    final_vcf = final_dir / "calls.vcf.gz"
    final_index = Path(f"{final_vcf}.tbi")
    receipt_path = final_dir / "receipt.json"

    with file_target_lock(final_dir):
        _require_generation(source, source_generation, label="The variant source")
        cached = _read_cache_receipt(
            receipt_path,
            source_generation=source_generation,
            query_path=final_vcf,
            index_path=final_index,
        )
        if cached is not None:
            return final_vcf, final_index

        staging = cache_dir / f".{key}.{uuid.uuid4().hex}.tmp"
        stale: Path | None = None
        published = False
        staging.mkdir(parents=False, exist_ok=False)
        staged_plain = staging / "calls.vcf"
        staged_vcf = staging / "calls.vcf.gz"
        try:
            _require_generation(source, source_generation, label="The variant source")
            opener = (
                gzip.open if source.name.lower().endswith((".gz", ".bgz")) else open
            )
            with (
                opener(source, "rb") as source_file,
                open(staged_plain, "wb") as plain_file,
            ):
                shutil.copyfileobj(source_file, plain_file, length=1024 * 1024)
            _require_generation(source, source_generation, label="The variant source")
            pysam.tabix_compress(str(staged_plain), str(staged_vcf), force=True)
            pysam.tabix_index(str(staged_vcf), preset="vcf", force=True)
            staged_index = Path(f"{staged_vcf}.tbi")
            _validate_index(staged_vcf, staged_index)
            staged_plain.unlink(missing_ok=True)
            _require_generation(source, source_generation, label="The variant source")

            if final_dir.exists() or final_dir.is_symlink():
                stale = cache_dir / f".{key}.{uuid.uuid4().hex}.stale"
                os.replace(final_dir, stale)
            os.replace(staging, final_dir)
            published = True

            query_generation = capture_variant_file_generation(str(final_vcf))
            index_generation = capture_variant_file_generation(str(final_index))
            _write_cache_receipt(
                receipt_path,
                source_generation=source_generation,
                query_generation=query_generation,
                index_generation=index_generation,
            )
            _validate_index(final_vcf, final_index)
            _require_generation(source, source_generation, label="The variant source")
            if stale is not None:
                _remove_cache_path(stale)
                stale = None
            return final_vcf, final_index
        except VariantQueryError:
            if published:
                _remove_cache_path(final_dir)
            raise
        except (OSError, ValueError, pysam.SamtoolsError) as exc:
            if published:
                _remove_cache_path(final_dir)
            raise VariantIndexError(
                f"Could not prepare an indexed copy of {source.name}: {exc}"
            ) from exc
        finally:
            _remove_cache_path(staging)
            if stale is not None:
                _remove_cache_path(stale)


def _normalize_reference_name(value: str) -> str:
    return value.removeprefix("chr").lower()


def _validate_assembly(
    variants: pysam.VariantFile, expected_references: Iterable[dict[str, object]]
) -> list[str]:
    expected: list[tuple[str, int]] = []
    for raw in expected_references:
        name = raw.get("name")
        length = raw.get("length")
        if not isinstance(name, str) or not name.strip():
            raise VariantAssemblyMismatchError(
                "The open reference has an invalid chromosome name."
            )
        if not isinstance(length, int) or isinstance(length, bool) or length <= 0:
            raise VariantAssemblyMismatchError(
                f'The open reference has an invalid length for chromosome "{name}".'
            )
        expected.append((name, length))
    if not expected:
        raise VariantAssemblyMismatchError(
            "Cannot validate the call file because the open reference has no chromosomes."
        )

    contigs = variants.header.contigs
    exact = [(name, length) for name, length in expected if name in contigs]
    if not exact:
        expected_by_normalized = {
            _normalize_reference_name(name): name for name, _ in expected
        }
        alias = next(
            (
                (contig, expected_by_normalized[_normalize_reference_name(contig)])
                for contig in contigs
                if _normalize_reference_name(contig) in expected_by_normalized
            ),
            None,
        )
        alias_detail = (
            f' Found alias-like chromosome "{alias[0]}" for "{alias[1]}", but aliases are not remapped.'
            if alias
            else ""
        )
        raise VariantAssemblyMismatchError(
            "The call file has no exact chromosome names in common with the open reference."
            + alias_detail
        )

    mismatches: list[str] = []
    for name, expected_length in exact:
        actual_length = contigs[name].length
        if actual_length is not None and actual_length != expected_length:
            mismatches.append(
                f'"{name}" has length {actual_length:,} in the call file and '
                f"{expected_length:,} in the reference"
            )
    if mismatches:
        raise VariantAssemblyMismatchError(
            "The call file does not match the open reference: "
            + "; ".join(mismatches)
            + "."
        )
    return [name for name, _ in exact]


def prepare_variant_source(
    variant_path: str,
    expected_references: Iterable[dict[str, object]],
    *,
    source_generation: VariantFileGeneration | Mapping[str, object] | None = None,
) -> dict[str, Any]:
    """Return a validated local indexed source without modifying the input file."""

    source = _resolve_source_path(variant_path)
    references = [
        VariantReferenceIdentity.model_validate(reference)
        for reference in expected_references
    ]
    source_format = _source_format(source)
    key, generation = _source_identity(source)
    admitted_generation = VariantFileGeneration.model_validate(
        generation.model_dump(mode="json", by_alias=True, exclude_none=False)
    )
    if source_generation is not None:
        admitted_generation = _require_generation(
            source, source_generation, label="The variant source"
        )
    query_path = source
    index_path = _find_index(source)

    if source_format == "bcf":
        if index_path is None:
            raise VariantIndexError(
                f"{source.name} needs a matching .csi or .tbi index before it can be opened."
            )
        _validate_index(query_path, index_path)
    elif index_path is not None:
        try:
            _validate_index(query_path, index_path)
        except VariantIndexError:
            query_path, index_path = _cached_vcf(source, key, admitted_generation)
    else:
        query_path, index_path = _cached_vcf(source, key, admitted_generation)

    if index_path is None:
        raise VariantIndexError(f"No queryable index was prepared for {source.name}.")
    query_generation = capture_variant_file_generation(str(query_path))
    index_generation = capture_variant_file_generation(str(index_path))
    with _open_variant(query_path, index_path) as variants:
        matched_references = _validate_assembly(
            variants, [reference.model_dump(mode="json") for reference in references]
        )
        samples = list(variants.header.samples)
    _require_generation(source, admitted_generation, label="The variant source")
    _require_generation(
        query_path, query_generation, label="The prepared variant query"
    )
    _require_generation(
        index_path, index_generation, label="The prepared variant index"
    )

    return {
        "sourcePath": str(source),
        "queryPath": str(query_path),
        "indexPath": str(index_path),
        "format": source_format,
        "label": source.name,
        "sourceSizeBytes": admitted_generation.size,
        "sourceMtimeNs": admitted_generation.mtime_ns,
        "sourceIdentity": key,
        "sourceGeneration": admitted_generation.model_dump(
            mode="json", by_alias=True, exclude_none=False
        ),
        "queryGeneration": query_generation.model_dump(
            mode="json", by_alias=True, exclude_none=False
        ),
        "indexGeneration": index_generation.model_dump(
            mode="json", by_alias=True, exclude_none=False
        ),
        "assemblyRevision": variant_assembly_revision(references),
        "matchedReferences": matched_references,
        "samples": samples,
    }


def prepare_remote_variant_source(
    query_url: str,
    index_path: str,
    expected_references: Iterable[dict[str, object]],
    *,
    source_format: Literal["vcf", "bcf"],
    source_identity: str,
) -> dict[str, Any]:
    """Validate one already-admitted remote source without downloading it.

    The caller owns URL admission and supplies only a loopback range-proxy URL.
    The index is a service-owned immutable snapshot. This function therefore
    performs format/index/header/reference validation through htslib but never
    accepts an arbitrary network destination.
    """

    if source_format not in {"vcf", "bcf"}:
        raise VariantQueryError("Remote variant format must be VCF or BCF.")
    if not isinstance(source_identity, str) or not re.fullmatch(
        r"[0-9a-f]{64}", source_identity
    ):
        raise VariantQueryError("Remote variant source identity is invalid.")
    references = [
        VariantReferenceIdentity.model_validate(reference)
        for reference in expected_references
    ]
    index = _resolve_source_path(index_path)
    index_generation = capture_variant_file_generation(str(index))
    _validate_index(query_url, index)
    with _open_variant(query_url, index) as variants:
        matched_references = _validate_assembly(
            variants, [reference.model_dump(mode="json") for reference in references]
        )
        samples = list(variants.header.samples)
    _require_generation(
        index, index_generation, label="The prepared remote variant index"
    )
    return {
        "format": source_format,
        "sourceIdentity": source_identity,
        "assemblyRevision": variant_assembly_revision(references),
        "matchedReferences": matched_references,
        "samples": samples,
    }


def _encode_cursor(
    chrom_index: int,
    start: int,
    position_offset: int,
    *,
    source_identity: str,
    assembly_revision: str,
) -> str:
    payload = json.dumps(
        {
            "v": _CURSOR_VERSION,
            "chromIndex": chrom_index,
            "start": start,
            "positionOffset": position_offset,
            "sourceIdentity": source_identity,
            "assemblyRevision": assembly_revision,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_cursor(
    cursor: str | None,
    *,
    source_identity: str,
    assembly_revision: str,
) -> tuple[int, int, int]:
    if cursor is None:
        return 0, 0, 0
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        values = (raw["chromIndex"], raw["start"], raw["positionOffset"])
        if (
            raw.get("v") != _CURSOR_VERSION
            or raw.get("sourceIdentity") != source_identity
            or raw.get("assemblyRevision") != assembly_revision
            or not all(
                isinstance(value, int) and not isinstance(value, bool) and value >= 0
                for value in values
            )
        ):
            raise ValueError
        return values
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise VariantQueryError(
            "The variant page cursor is invalid or expired."
        ) from exc


def _visible_alts(record: pysam.VariantRecord) -> list[str]:
    return [
        alt for alt in (record.alts or ()) if alt not in {"", ".", "<NON_REF>", "<*>"}
    ]


def _variant_class(ref: str, alts: list[str]) -> str:
    if any(alt.startswith("<") or "[" in alt or "]" in alt for alt in alts):
        return "structural"
    classes = set()
    for alt in alts:
        if len(ref) == len(alt) == 1:
            classes.add("substitution")
        elif len(ref) < len(alt):
            classes.add("insertion")
        elif len(ref) > len(alt):
            classes.add("deletion")
        else:
            classes.add("replacement")
    return next(iter(classes)) if len(classes) == 1 else "mixed"


def _genotypes(record: pysam.VariantRecord) -> dict[str, str]:
    summaries: dict[str, str] = {}
    for sample_name in list(record.samples)[:8]:
        call = record.samples[sample_name]
        genotype = call.get("GT")
        if genotype is None:
            continue
        separator = "|" if call.phased else "/"
        summaries[sample_name] = separator.join(
            "." if allele is None else str(allele) for allele in genotype
        )
    return summaries


def _sample_evidence(record: pysam.VariantRecord, sample: str) -> dict[str, Any]:
    if sample not in record.samples:
        raise VariantQueryError(
            "The selected sample is absent from the variant source."
        )
    call = record.samples[sample]
    raw_depths = call.get("AD")
    valid_depths = (
        raw_depths is not None
        and len(raw_depths) == len(record.alleles or ())
        and all(isinstance(n, int) and n >= 0 for n in raw_depths)
    )
    gt = call.get("GT")
    return {
        "alleles": list(record.alleles or ()),
        "depths": list(raw_depths) if valid_depths else None,
        "genotype": (
            ("|" if call.phased else "/").join("." if n is None else str(n) for n in gt)
            if gt is not None
            else None
        ),
    }


def _record_summary(
    record: pysam.VariantRecord,
    alts: list[str],
    position_offset: int,
    query_identity: str,
    sample: str | None = None,
) -> dict[str, Any]:
    start = max(0, int(record.start))
    ref = record.ref or ""
    end = max(start + 1, int(record.stop or (start + max(1, len(ref)))))
    raw_id = "\x00".join(
        [
            query_identity,
            record.contig,
            str(start),
            str(position_offset),
            ref,
            ",".join(alts),
            record.id or "",
        ]
    )
    return {
        "id": hashlib.sha1(raw_id.encode("utf-8")).hexdigest(),
        "recordId": record.id,
        "chrom": record.contig,
        "start": start,
        "end": end,
        "position": start + 1,
        "ref": ref,
        "alts": alts,
        "quality": None if record.qual is None else float(record.qual),
        "filters": list(record.filter.keys()),
        "variantClass": _variant_class(ref, alts),
        "genotypes": _genotypes(record),
        **(
            {"sampleEvidence": _sample_evidence(record, sample)}
            if sample is not None
            else {}
        ),
    }


def query_variant_page(
    query_path: str,
    index_path: str,
    references: list[str],
    *,
    source_generation: VariantFileGeneration | Mapping[str, object],
    query_generation: VariantFileGeneration | Mapping[str, object],
    index_generation: VariantFileGeneration | Mapping[str, object],
    assembly_revision: str,
    cursor: str | None,
    limit: int,
) -> dict[str, Any]:
    """Return one bounded page in the caller-supplied reference order."""

    expected_source = _expected_generation(source_generation)
    expected_query = _expected_generation(query_generation)
    expected_index = _expected_generation(index_generation)
    source_identity = _generation_identity(expected_source)
    _require_generation(
        expected_source.canonical_path,
        expected_source,
        label="The variant source",
    )
    query = _resolve_source_path(query_path)
    index = _resolve_source_path(index_path)
    _require_generation(query, expected_query, label="The prepared variant query")
    _require_generation(index, expected_index, label="The prepared variant index")
    result = _query_variant_page_core(
        query,
        index,
        references,
        source_identity=source_identity,
        assembly_revision=assembly_revision,
        cursor=cursor,
        limit=limit,
    )
    _require_generation(
        expected_source.canonical_path,
        expected_source,
        label="The variant source",
    )
    _require_generation(query, expected_query, label="The prepared variant query")
    _require_generation(index, expected_index, label="The prepared variant index")
    return result


def query_remote_variant_page(
    query_url: str,
    index_path: str,
    references: list[str],
    *,
    source_identity: str,
    assembly_revision: str,
    cursor: str | None,
    limit: int,
) -> dict[str, Any]:
    """Query one admitted loopback source plus immutable managed index."""

    if not isinstance(source_identity, str) or not re.fullmatch(
        r"[0-9a-f]{64}", source_identity
    ):
        raise VariantQueryError("Remote variant source identity is invalid.")
    index = _resolve_source_path(index_path)
    index_generation = capture_variant_file_generation(str(index))
    result = _query_variant_page_core(
        query_url,
        index,
        references,
        source_identity=source_identity,
        assembly_revision=assembly_revision,
        cursor=cursor,
        limit=limit,
    )
    _require_generation(
        index, index_generation, label="The prepared remote variant index"
    )
    return result


def query_variant_region(
    query_path: str,
    index_path: str,
    *,
    source_generation: VariantFileGeneration | Mapping[str, object],
    query_generation: VariantFileGeneration | Mapping[str, object],
    index_generation: VariantFileGeneration | Mapping[str, object],
    chrom: str,
    start: int,
    end: int,
    limit: int,
    sample: str | None = None,
) -> dict[str, Any]:
    """Return one bounded regional snapshot from a prepared local source."""

    expected_source = _expected_generation(source_generation)
    expected_query = _expected_generation(query_generation)
    expected_index = _expected_generation(index_generation)
    source_identity = _generation_identity(expected_source)
    _require_generation(
        expected_source.canonical_path,
        expected_source,
        label="The variant source",
    )
    query = _resolve_source_path(query_path)
    index = _resolve_source_path(index_path)
    _require_generation(query, expected_query, label="The prepared variant query")
    _require_generation(index, expected_index, label="The prepared variant index")
    result = _query_variant_region_core(
        query,
        index,
        chrom=chrom,
        start=start,
        end=end,
        limit=limit,
        source_identity=source_identity,
        sample=sample,
    )
    _require_generation(
        expected_source.canonical_path,
        expected_source,
        label="The variant source",
    )
    _require_generation(query, expected_query, label="The prepared variant query")
    _require_generation(index, expected_index, label="The prepared variant index")
    return result


def query_remote_variant_region(
    query_url: str,
    index_path: str,
    *,
    source_identity: str,
    chrom: str,
    start: int,
    end: int,
    limit: int,
) -> dict[str, Any]:
    """Return one bounded regional snapshot from an admitted remote source."""

    if not isinstance(source_identity, str) or not re.fullmatch(
        r"[0-9a-f]{64}", source_identity
    ):
        raise VariantQueryError("Remote variant source identity is invalid.")
    index = _resolve_source_path(index_path)
    index_generation = capture_variant_file_generation(str(index))
    result = _query_variant_region_core(
        query_url,
        index,
        chrom=chrom,
        start=start,
        end=end,
        limit=limit,
        source_identity=source_identity,
    )
    _require_generation(
        index, index_generation, label="The prepared remote variant index"
    )
    return result


def _query_variant_region_core(
    query: str | Path,
    index: Path,
    *,
    chrom: str,
    start: int,
    end: int,
    limit: int,
    source_identity: str,
    sample: str | None = None,
) -> dict[str, Any]:
    _validate_variant_region(chrom=chrom, start=start, end=end, limit=limit)
    summaries: list[dict[str, Any]] = []
    current_start: int | None = None
    visible_at_position = 0
    try:
        with _open_variant(query, index) as variants:
            if chrom not in variants.header.contigs:
                return {"variants": [], "truncated": False}
            for record in variants.fetch(chrom, start, end):
                record_start = max(0, int(record.start))
                record_end = max(record_start + 1, int(record.stop or record_start + 1))
                if record_start >= end or record_end <= start:
                    continue
                alts = _visible_alts(record)
                if not alts:
                    continue
                if current_start != record_start:
                    current_start = record_start
                    visible_at_position = 0
                visible_at_position += 1
                summaries.append(
                    _record_summary(
                        record,
                        alts,
                        visible_at_position,
                        source_identity,
                        sample,
                    )
                )
                if len(summaries) > limit:
                    break
    except VariantQueryError:
        raise
    except (OSError, ValueError) as exc:
        raise VariantIndexError(
            f"Could not query {chrom} from {_variant_locator_label(query)}: {exc}"
        ) from exc
    return {
        "variants": summaries[:limit],
        "truncated": len(summaries) > limit,
    }


def _validate_variant_region(*, chrom: str, start: int, end: int, limit: int) -> None:
    if not isinstance(chrom, str) or not chrom or any(char.isspace() for char in chrom):
        raise VariantQueryError(
            "Variant region requires a chromosome name without whitespace."
        )
    if (
        not isinstance(start, int)
        or isinstance(start, bool)
        or not isinstance(end, int)
        or isinstance(end, bool)
        or start < 0
        or end <= start
    ):
        raise VariantQueryError("Variant region must satisfy 0 <= start < end.")
    if end - start > _MAX_REGION_BP:
        raise VariantQueryError(
            f"Variant region exceeds the {_MAX_REGION_BP:,}-base viewport limit."
        )
    if (
        not isinstance(limit, int)
        or isinstance(limit, bool)
        or not 1 <= limit <= _MAX_REGION_SIZE
    ):
        raise VariantQueryError(
            f"Variant region limit must be between 1 and {_MAX_REGION_SIZE}."
        )


def _query_variant_page_core(
    query: str | Path,
    index: Path,
    references: list[str],
    *,
    source_identity: str,
    assembly_revision: str,
    cursor: str | None,
    limit: int,
) -> dict[str, Any]:
    if (
        not isinstance(limit, int)
        or isinstance(limit, bool)
        or not 1 <= limit <= _MAX_PAGE_SIZE
    ):
        raise VariantQueryError(
            f"Variant page limit must be between 1 and {_MAX_PAGE_SIZE}."
        )
    if not references or any(
        not isinstance(chrom, str) or not chrom for chrom in references
    ):
        raise VariantQueryError("Variant page query requires at least one chromosome.")
    start_chrom_index, start_bp, start_offset = _decode_cursor(
        cursor,
        source_identity=source_identity,
        assembly_revision=assembly_revision,
    )
    if start_chrom_index >= len(references):
        raise VariantQueryError("The variant page cursor is outside this reference.")

    summaries: list[dict[str, Any]] = []
    cursors_after: list[str] = []

    with _open_variant(query, index) as variants:
        header_contigs = set(variants.header.contigs)
        stop = False
        for chrom_index in range(start_chrom_index, len(references)):
            chrom = references[chrom_index]
            if chrom not in header_contigs:
                continue
            fetch_start = start_bp if chrom_index == start_chrom_index else 0
            skip_at_start = start_offset if chrom_index == start_chrom_index else 0
            current_start: int | None = None
            visible_at_position = 0
            try:
                records = variants.fetch(chrom, fetch_start)
                for record in records:
                    record_start = max(0, int(record.start))
                    if record_start < fetch_start:
                        continue
                    alts = _visible_alts(record)
                    if not alts:
                        continue
                    if current_start != record_start:
                        current_start = record_start
                        visible_at_position = 0
                    visible_at_position += 1
                    if (
                        record_start == fetch_start
                        and visible_at_position <= skip_at_start
                    ):
                        continue
                    summaries.append(
                        _record_summary(
                            record,
                            alts,
                            visible_at_position,
                            source_identity,
                        )
                    )
                    cursors_after.append(
                        _encode_cursor(
                            chrom_index,
                            record_start,
                            visible_at_position,
                            source_identity=source_identity,
                            assembly_revision=assembly_revision,
                        )
                    )
                    if len(summaries) > limit:
                        stop = True
                        break
            except (OSError, ValueError) as exc:
                raise VariantIndexError(
                    f"Could not query {chrom} from {_variant_locator_label(query)}: {exc}"
                ) from exc
            if stop:
                break

    has_more = len(summaries) > limit
    return {
        "variants": summaries[:limit],
        "nextCursor": cursors_after[limit - 1] if has_more else None,
    }
