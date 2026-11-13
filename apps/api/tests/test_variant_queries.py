from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pysam
import pytest

from src.services import variant_queries as variant_service
from src.services.file_target_lock import file_target_lock
from src.services.variant_queries import (
    VariantAssemblyMismatchError,
    VariantIndexError,
    VariantSourceGenerationChangedError,
    prepare_variant_source,
    query_variant_page,
    query_variant_region,
)
from src.variant_source_operation_contract import (
    VariantSourceResult,
    capture_variant_file_generation,
)

VCF_TEXT = """##fileformat=VCFv4.2
##contig=<ID=chr1,length=248956422>
##contig=<ID=chr7,length=159345973>
##FORMAT=<ID=GT,Number=1,Type=String,Description="Genotype">
#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tHG002
chr1\t104312461\trs-sub\tT\tA\t60\tPASS\t.\tGT\t0/1
chr1\t104312461\trs-second\tT\tG\t50\tPASS\t.\tGT\t1|0
chr1\t104312462\tgvcf-block\tA\t<NON_REF>\t.\tPASS\tEND=104312500\tGT\t0/0
chr7\t108833385\trs-seven\tC\tT\t99\tPASS\t.\tGT\t1/1
"""


@pytest.fixture()
def plain_vcf(tmp_path: Path) -> Path:
    path = tmp_path / "HG002.GRCh38.vcf"
    path.write_text(VCF_TEXT, encoding="utf-8")
    return path


@pytest.fixture()
def expected_references() -> list[dict[str, object]]:
    return [
        {"name": "chr1", "length": 248_956_422},
        {"name": "chr7", "length": 159_345_973},
    ]


def query_prepared(
    prepared: dict[str, object],
    references: list[str],
    *,
    cursor: str | None,
    limit: int,
) -> dict[str, object]:
    return query_variant_page(
        str(prepared["queryPath"]),
        str(prepared["indexPath"]),
        references,
        source_generation=prepared["sourceGeneration"],
        query_generation=prepared["queryGeneration"],
        index_generation=prepared["indexGeneration"],
        assembly_revision=str(prepared["assemblyRevision"]),
        cursor=cursor,
        limit=limit,
    )


def test_prepare_plain_vcf_builds_a_queryable_cached_copy_without_modifying_source(
    plain_vcf: Path,
    expected_references: list[dict[str, object]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(tmp_path / "cache"))
    source_bytes = plain_vcf.read_bytes()

    prepared = prepare_variant_source(str(plain_vcf), expected_references)

    assert plain_vcf.read_bytes() == source_bytes
    assert prepared["sourcePath"] == str(plain_vcf)
    assert prepared["queryPath"].endswith(".vcf.gz")
    assert Path(prepared["queryPath"]).is_file()
    assert Path(prepared["indexPath"]).is_file()
    assert prepared["format"] == "vcf"
    assert prepared["matchedReferences"] == ["chr1", "chr7"]
    assert prepared["samples"] == ["HG002"]
    receipt = json.loads(
        (Path(prepared["queryPath"]).parent / "receipt.json").read_text(
            encoding="utf-8"
        )
    )
    assert receipt == {
        "schema": "dnaforge.variant-index-cache.v1",
        "sourceGeneration": prepared["sourceGeneration"],
        "queryGeneration": prepared["queryGeneration"],
        "indexGeneration": prepared["indexGeneration"],
    }

    reused = prepare_variant_source(str(plain_vcf), expected_references)
    assert reused["queryPath"] == prepared["queryPath"]
    assert reused["indexPath"] == prepared["indexPath"]


def test_prepared_result_carries_source_artifact_and_assembly_generations(
    plain_vcf: Path,
    expected_references: list[dict[str, object]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(tmp_path / "cache"))

    result = VariantSourceResult.model_validate(
        prepare_variant_source(str(plain_vcf), expected_references)
    )

    assert result.source_generation.canonical_path == str(plain_vcf.resolve())
    assert result.query_generation.canonical_path == result.query_path
    assert result.index_generation.canonical_path == result.index_path
    assert result.assembly_revision.startswith("variant-assembly-v1:sha256:")


def test_prepare_rejects_an_index_generation_change_during_assembly_validation(
    plain_vcf: Path,
    expected_references: list[dict[str, object]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "cache"
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(cache))
    original_validate = variant_service._validate_assembly
    changed = False

    def validate_then_touch_index(variants, expected):
        nonlocal changed
        matched = original_validate(variants, expected)
        index = next(cache.rglob("calls.vcf.gz.tbi"))
        metadata = index.stat()
        os.utime(
            index,
            ns=(metadata.st_atime_ns, metadata.st_mtime_ns + 1_000_000_000),
        )
        changed = True
        return matched

    monkeypatch.setattr(
        variant_service, "_validate_assembly", validate_then_touch_index
    )

    with pytest.raises(VariantSourceGenerationChangedError, match="changed"):
        prepare_variant_source(str(plain_vcf), expected_references)

    assert changed


def test_two_processes_prepare_one_cache_target_without_duplicate_publication(
    plain_vcf: Path,
    expected_references: list[dict[str, object]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "cache"
    cache.mkdir()
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(cache))
    key, _generation = variant_service._source_identity(plain_vcf)
    target = cache / key
    child_source = """
import json
import sys
from pathlib import Path

from src.services.variant_queries import prepare_variant_source

source = sys.argv[1]
references = json.loads(sys.argv[2])
ready = Path(sys.argv[3])
ready.write_text("ready", encoding="utf-8")
print(json.dumps(prepare_variant_source(source, references), sort_keys=True), flush=True)
"""
    environment = {
        **os.environ,
        "DNAFORGE_VARIANT_INDEX_CACHE_DIR": str(cache),
        "PYTHONPATH": str(Path(__file__).parents[1]),
    }
    children: list[subprocess.Popen[str]] = []
    ready_paths = [tmp_path / "ready-1", tmp_path / "ready-2"]

    try:
        with file_target_lock(target):
            for ready in ready_paths:
                children.append(
                    subprocess.Popen(
                        [
                            sys.executable,
                            "-c",
                            child_source,
                            str(plain_vcf),
                            json.dumps(expected_references),
                            str(ready),
                        ],
                        cwd=Path(__file__).parents[1],
                        env=environment,
                        text=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                    )
                )
            deadline = time.monotonic() + 10
            while not all(path.exists() for path in ready_paths):
                if time.monotonic() >= deadline:
                    raise AssertionError(
                        "Both preparation processes did not reach the lock."
                    )
                assert all(child.poll() is None for child in children)
                time.sleep(0.01)
            assert all(child.poll() is None for child in children)

        results: list[dict[str, object]] = []
        for child in children:
            stdout, stderr = child.communicate(timeout=30)
            assert child.returncode == 0, stderr
            results.append(json.loads(stdout))

        assert results[0]["queryPath"] == results[1]["queryPath"]
        assert results[0]["indexPath"] == results[1]["indexPath"]
        assert results[0]["queryGeneration"] == results[1]["queryGeneration"]
        assert results[0]["indexGeneration"] == results[1]["indexGeneration"]
        assert [path.name for path in cache.iterdir() if path.is_dir()] == [key]
        assert not [
            path for path in cache.iterdir() if path.name.endswith((".tmp", ".stale"))
        ]
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
                child.communicate()


def test_query_pages_across_same_position_records_and_omits_gvcf_reference_blocks(
    plain_vcf: Path,
    expected_references: list[dict[str, object]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(tmp_path / "cache"))
    prepared = prepare_variant_source(str(plain_vcf), expected_references)

    first = query_prepared(
        prepared,
        ["chr1", "chr7"],
        cursor=None,
        limit=1,
    )
    assert [
        (row["chrom"], row["position"], row["ref"], row["alts"])
        for row in first["variants"]
    ] == [("chr1", 104_312_461, "T", ["A"])]
    assert first["nextCursor"]

    second = query_prepared(
        prepared,
        ["chr1", "chr7"],
        cursor=first["nextCursor"],
        limit=1,
    )
    assert [
        (row["chrom"], row["position"], row["ref"], row["alts"])
        for row in second["variants"]
    ] == [("chr1", 104_312_461, "T", ["G"])]
    assert second["variants"][0]["genotypes"] == {"HG002": "1|0"}
    assert second["nextCursor"]

    third = query_prepared(
        prepared,
        ["chr1", "chr7"],
        cursor=second["nextCursor"],
        limit=10,
    )
    assert [
        (row["chrom"], row["position"], row["ref"], row["alts"])
        for row in third["variants"]
    ] == [("chr7", 108_833_385, "C", ["T"])]
    assert third["nextCursor"] is None


def test_query_region_is_bounded_reports_truncation_and_omits_reference_blocks(
    plain_vcf: Path,
    expected_references: list[dict[str, object]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(tmp_path / "cache"))
    prepared = prepare_variant_source(str(plain_vcf), expected_references)

    region = query_variant_region(
        str(prepared["queryPath"]),
        str(prepared["indexPath"]),
        source_generation=prepared["sourceGeneration"],
        query_generation=prepared["queryGeneration"],
        index_generation=prepared["indexGeneration"],
        chrom="chr1",
        start=104_312_450,
        end=104_312_500,
        limit=1,
    )

    assert [row["recordId"] for row in region["variants"]] == ["rs-sub"]
    assert region["truncated"] is True
    empty = query_variant_region(
        str(prepared["queryPath"]),
        str(prepared["indexPath"]),
        source_generation=prepared["sourceGeneration"],
        query_generation=prepared["queryGeneration"],
        index_generation=prepared["indexGeneration"],
        chrom="chr1",
        start=0,
        end=100,
        limit=10,
    )
    assert empty == {"variants": [], "truncated": False}


def test_prepare_rejects_alias_only_or_wrong_length_contigs(
    plain_vcf: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(tmp_path / "cache"))

    with pytest.raises(VariantAssemblyMismatchError, match="exact chromosome"):
        prepare_variant_source(
            str(plain_vcf),
            [{"name": "1", "length": 248_956_422}],
        )

    with pytest.raises(VariantAssemblyMismatchError, match="length"):
        prepare_variant_source(
            str(plain_vcf),
            [{"name": "chr1", "length": 248_956_421}],
        )


def test_prepare_rejects_bcf_without_an_index(
    tmp_path: Path,
    expected_references: list[dict[str, object]],
) -> None:
    source = tmp_path / "HG002.GRCh38.bcf"
    source.write_bytes(b"BCF")

    with pytest.raises(VariantIndexError, match="needs a matching"):
        prepare_variant_source(str(source), expected_references)


def test_prepare_rejects_an_empty_vcf(
    tmp_path: Path,
    expected_references: list[dict[str, object]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "empty.vcf"
    source.write_bytes(b"")
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(tmp_path / "cache"))

    with pytest.raises(VariantIndexError, match="Could not (open|prepare)"):
        prepare_variant_source(str(source), expected_references)


def test_same_path_size_and_mtime_replacement_gets_a_new_cache_generation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "calls.vcf"
    replacement = tmp_path / "replacement.vcf"

    def write_call(path: Path, position: int) -> None:
        path.write_text(
            "##fileformat=VCFv4.2\n"
            "##contig=<ID=chr1,length=1000>\n"
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n"
            f"chr1\t{position}\t.\tA\tG\t60\tPASS\t.\n",
            encoding="utf-8",
        )

    cache = tmp_path / "cache"
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(cache))
    references = [{"name": "chr1", "length": 1_000}]
    write_call(source, 101)
    first_stat = source.stat()
    first = prepare_variant_source(str(source), references)

    write_call(replacement, 201)
    assert replacement.stat().st_size == first_stat.st_size
    os.replace(replacement, source)
    os.utime(source, ns=(source.stat().st_atime_ns, first_stat.st_mtime_ns))
    second_stat = source.stat()
    assert second_stat.st_size == first_stat.st_size
    assert second_stat.st_mtime_ns == first_stat.st_mtime_ns
    assert second_stat.st_ctime_ns != first_stat.st_ctime_ns
    assert second_stat.st_ino != first_stat.st_ino

    second = prepare_variant_source(str(source), references)
    page = query_prepared(
        second,
        second["matchedReferences"],
        cursor=None,
        limit=10,
    )

    assert second["sourceIdentity"] != first["sourceIdentity"]
    assert second["queryPath"] != first["queryPath"]
    assert [row["position"] for row in page["variants"]] == [201]


def test_direct_indexed_page_rejects_a_replaced_source_generation(
    tmp_path: Path,
) -> None:
    def write_indexed_call(base: Path, position: int) -> tuple[Path, Path]:
        plain = base.with_suffix(".vcf")
        plain.write_text(
            "##fileformat=VCFv4.2\n"
            "##contig=<ID=chr1,length=1000>\n"
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n"
            f"chr1\t{position}\t.\tA\tG\t60\tPASS\t.\n"
            f"chr1\t{position + 200}\t.\tA\tG\t60\tPASS\t.\n",
            encoding="utf-8",
        )
        compressed = Path(f"{plain}.gz")
        pysam.tabix_compress(str(plain), str(compressed), force=True)
        pysam.tabix_index(str(compressed), preset="vcf", force=True)
        return compressed, Path(f"{compressed}.tbi")

    source, index = write_indexed_call(tmp_path / "first", 101)
    prepared = prepare_variant_source(str(source), [{"name": "chr1", "length": 1_000}])
    first_page = query_variant_page(
        prepared["queryPath"],
        prepared["indexPath"],
        prepared["matchedReferences"],
        source_generation=prepared["sourceGeneration"],
        query_generation=prepared["queryGeneration"],
        index_generation=prepared["indexGeneration"],
        assembly_revision=prepared["assemblyRevision"],
        cursor=None,
        limit=1,
    )
    assert [row["position"] for row in first_page["variants"]] == [101]
    assert first_page["nextCursor"]

    replacement, replacement_index = write_indexed_call(tmp_path / "second", 201)
    first_stat = source.stat()
    assert replacement.stat().st_size == first_stat.st_size
    os.replace(replacement, source)
    os.replace(replacement_index, index)
    os.utime(source, ns=(source.stat().st_atime_ns, first_stat.st_mtime_ns))

    with pytest.raises(VariantSourceGenerationChangedError, match="changed"):
        query_variant_page(
            prepared["queryPath"],
            prepared["indexPath"],
            prepared["matchedReferences"],
            source_generation=prepared["sourceGeneration"],
            query_generation=prepared["queryGeneration"],
            index_generation=prepared["indexGeneration"],
            assembly_revision=prepared["assemblyRevision"],
            cursor=first_page["nextCursor"],
            limit=1,
        )


def test_source_change_after_copy_publishes_no_cache_entry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "calls.vcf"
    replacement = tmp_path / "replacement.vcf"

    def write_call(path: Path, position: int) -> None:
        path.write_text(
            "##fileformat=VCFv4.2\n"
            "##contig=<ID=chr1,length=1000>\n"
            "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n"
            f"chr1\t{position}\t.\tA\tG\t60\tPASS\t.\n",
            encoding="utf-8",
        )

    cache = tmp_path / "cache"
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(cache))
    write_call(source, 101)
    write_call(replacement, 201)
    admitted = capture_variant_file_generation(str(source))
    first_stat = source.stat()
    original_copy = shutil.copyfileobj
    replaced = False

    def copy_then_replace(*args, **kwargs) -> None:
        nonlocal replaced
        original_copy(*args, **kwargs)
        if replaced:
            return
        replaced = True
        os.replace(replacement, source)
        os.utime(source, ns=(source.stat().st_atime_ns, first_stat.st_mtime_ns))

    monkeypatch.setattr(shutil, "copyfileobj", copy_then_replace)

    with pytest.raises(VariantSourceGenerationChangedError, match="changed"):
        prepare_variant_source(
            str(source),
            [{"name": "chr1", "length": 1_000}],
            source_generation=admitted,
        )

    assert replaced
    assert not [path for path in cache.iterdir() if path.is_dir()]


def test_malformed_cache_receipt_forces_a_validated_rebuild(
    plain_vcf: Path,
    expected_references: list[dict[str, object]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "cache"
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(cache))
    first = prepare_variant_source(str(plain_vcf), expected_references)
    receipt_path = Path(first["queryPath"]).parent / "receipt.json"
    receipt_path.write_text("{broken", encoding="utf-8")
    original_compress = pysam.tabix_compress
    compressions = 0

    def record_compression(*args, **kwargs):
        nonlocal compressions
        compressions += 1
        return original_compress(*args, **kwargs)

    monkeypatch.setattr(pysam, "tabix_compress", record_compression)

    rebuilt = prepare_variant_source(str(plain_vcf), expected_references)

    assert compressions == 1
    assert rebuilt["queryPath"] == first["queryPath"]
    assert json.loads(receipt_path.read_text(encoding="utf-8"))["schema"] == (
        "dnaforge.variant-index-cache.v1"
    )
    query_prepared(
        rebuilt,
        rebuilt["matchedReferences"],
        cursor=None,
        limit=10,
    )


def test_source_change_between_validation_and_publication_removes_the_new_cache(
    plain_vcf: Path,
    expected_references: list[dict[str, object]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "cache"
    replacement = tmp_path / "replacement.vcf"
    replacement.write_text(
        plain_vcf.read_text(encoding="utf-8").replace("104312461", "104312462", 1),
        encoding="utf-8",
    )
    admitted = capture_variant_file_generation(str(plain_vcf))
    original_stat = plain_vcf.stat()
    original_replace = os.replace
    replaced = False
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(cache))

    def replace_after_last_prepublication_check(source, destination):
        nonlocal replaced
        selected_source = Path(source)
        selected_destination = Path(destination)
        if (
            not replaced
            and selected_source.is_dir()
            and selected_source.name.endswith(".tmp")
            and selected_destination.parent == cache
        ):
            original_replace(replacement, plain_vcf)
            os.utime(
                plain_vcf,
                ns=(plain_vcf.stat().st_atime_ns, original_stat.st_mtime_ns),
            )
            replaced = True
        original_replace(source, destination)

    monkeypatch.setattr(
        variant_service.os, "replace", replace_after_last_prepublication_check
    )

    with pytest.raises(VariantSourceGenerationChangedError, match="changed"):
        prepare_variant_source(
            str(plain_vcf),
            expected_references,
            source_generation=admitted,
        )

    assert replaced
    assert not [path for path in cache.iterdir() if path.is_dir()]


def test_source_change_after_receipt_publication_removes_the_new_cache(
    plain_vcf: Path,
    expected_references: list[dict[str, object]],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cache = tmp_path / "cache"
    replacement = tmp_path / "replacement.vcf"
    replacement.write_text(
        plain_vcf.read_text(encoding="utf-8").replace("104312461", "104312462", 1),
        encoding="utf-8",
    )
    admitted = capture_variant_file_generation(str(plain_vcf))
    original_stat = plain_vcf.stat()
    original_receipt_write = variant_service._write_cache_receipt
    replaced = False
    monkeypatch.setenv("DNAFORGE_VARIANT_INDEX_CACHE_DIR", str(cache))

    def write_receipt_then_replace(*args, **kwargs):
        nonlocal replaced
        original_receipt_write(*args, **kwargs)
        os.replace(replacement, plain_vcf)
        os.utime(
            plain_vcf,
            ns=(plain_vcf.stat().st_atime_ns, original_stat.st_mtime_ns),
        )
        replaced = True

    monkeypatch.setattr(
        variant_service, "_write_cache_receipt", write_receipt_then_replace
    )

    with pytest.raises(VariantSourceGenerationChangedError, match="changed"):
        prepare_variant_source(
            str(plain_vcf),
            expected_references,
            source_generation=admitted,
        )

    assert replaced
    assert not [path for path in cache.iterdir() if path.is_dir()]
