""" pileup — on-demand region read query (apps/api/src/services/pileup.py).

L0: builds a tiny indexed BAM in-process (pysam) and asserts region overlap,
strand, missing-file handling, exact default behavior, and the optional
max-reads degraded-mode cap.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pysam
import pytest

from src.services.pileup import (
    AlignmentIndexError,
    BamNotFoundError,
    IndexNotFoundError,
    PileupError,
    ReferenceNotFoundError,
    _resolve_bam_path,
    _resolve_coverage_bin_size,
    _resolve_index_path,
    _resolve_reference_path,
    coverage_region,
    ensure_alignment_index,
    read_alignment_header,
    read_pileup_region,
)
from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


def test_legacy_pileup_routes_are_not_registered():
    from src.main import app

    client = TestClient(app)
    assert client.post("/pileup/reads", json={}).status_code == 404
    assert client.post("/pileup/coverage", json={}).status_code == 404


def _make_bam(tmp_path) -> str:
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chr11", "LN": 1000}],
    }
    path = tmp_path / "t.bam"
    with pysam.AlignmentFile(str(path), "wb", header=header) as out:
        for i, start in enumerate([100, 120, 300]):
            a = pysam.AlignedSegment()
            a.query_name = f"r{i}"
            a.reference_id = 0
            a.reference_start = start
            a.query_sequence = "A" * 50
            a.cigartuples = [(0, 50)]
            a.mapping_quality = 60
            if i == 0:
                a.flag = 99
                a.next_reference_id = 0
                a.next_reference_start = 220
                a.template_length = 170
            else:
                a.flag = 16 if i == 1 else 0
            out.write(a)
    pysam.index(str(path))
    return str(path)


def test_region_query_returns_overlapping_reads(tmp_path):
    bam = _make_bam(tmp_path)
    res = read_pileup_region(bam, "chr11", 90, 200)
    assert res["count"] == 2
    assert sorted(r["start"] for r in res["reads"]) == [100, 120]
    assert res["truncated"] is False
    rev = next(r for r in res["reads"] if r["start"] == 120)
    assert rev["strand"] == "-"
    assert rev["end"] == 170
    assert rev["readId"] == "r1"
    assert rev["paired"] is False
    paired = next(r for r in res["reads"] if r["start"] == 100)
    assert paired["paired"] is True


def test_missing_bam_raises(tmp_path):
    with pytest.raises(BamNotFoundError):
        read_pileup_region(str(tmp_path / "nope.bam"), "chr11", 0, 100)


def test_max_reads_is_explicit_degraded_sampling_and_flags_truncated(tmp_path):
    bam = _make_bam(tmp_path)
    res = read_pileup_region(bam, "chr11", 0, 1000, max_reads=1)
    assert res["count"] == 1
    assert res["truncated"] is True


def test_columnar_wire_format_returns_exact_reads_without_per_read_objects(tmp_path):
    bam = _make_bam(tmp_path)
    res = read_pileup_region(bam, "chr11", 90, 200, wire_format="columns-v1")
    assert res["format"] == "columns-v1"
    assert res["count"] == 2
    assert res["truncated"] is False
    assert res["columns"]["start"] == [100, 120]
    assert res["columns"]["end"] == [150, 170]
    assert res["columns"]["strand"] == ["+", "-"]
    assert res["columns"]["mapq"] == [60, 60]
    assert res["columns"]["readId"] == ["r0", "r1"]
    assert res["columns"]["paired"] == [True, False]


def test_absolute_bam_path_passes_through():
    abs_path = "/some/absolute/path/reads.bam"
    assert _resolve_bam_path(abs_path) == str(Path(abs_path))


def test_relative_bam_path_resolves_against_repo_root():
    rel = "test-fixtures/alignments/full-genome/sample.bam"
    resolved = _resolve_bam_path(rel)
    assert Path(resolved).is_absolute()
    assert resolved.endswith(rel)
    root = resolved[: -len(rel)].rstrip("/")
    assert (Path(root) / "pnpm-workspace.yaml").is_file()


def test_explicit_local_index_is_used_for_region_query(tmp_path):
    bam = _make_bam(tmp_path)
    bai = bam + ".bai"
    noidx = tmp_path / "noidx"
    noidx.mkdir()
    bam_only = str(noidx / "reads.bam")
    shutil.copy(bam, bam_only)

    with pytest.raises(ValueError):
        read_pileup_region(bam_only, "chr11", 90, 200)

    res = read_pileup_region(bam_only, "chr11", 90, 200, index_path=bai)
    assert res["count"] == 2
    assert sorted(r["start"] for r in res["reads"]) == [100, 120]


def test_coverage_region_honors_explicit_local_index(tmp_path):
    bam = _make_bam(tmp_path)
    bai = bam + ".bai"
    noidx = tmp_path / "noidx-cov"
    noidx.mkdir()
    bam_only = str(noidx / "reads.bam")
    shutil.copy(bam, bam_only)
    res = coverage_region(bam_only, "chr11", 100, 350, bin_size=50, index_path=bai)
    assert res["bins"] == [2, 1, 0, 0, 1]


def test_explicit_missing_local_index_raises(tmp_path):
    bam = _make_bam(tmp_path)
    with pytest.raises(IndexNotFoundError):
        read_pileup_region(bam, "chr11", 90, 200, index_path=str(tmp_path / "nope.bai"))


def test_resolve_index_path_none_is_passthrough():
    assert _resolve_index_path(None) is None


def test_resolve_index_path_remote_passes_through():
    url = "https://ftp-trace.ncbi.nlm.nih.gov/x/HG002.bam.bai"
    assert _resolve_index_path(url) == url


def test_remote_bam_url_passes_through_unchanged():
    for url in [
        "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/x/NA12878.cram",
        "s3://giab/HG002.bam",
        "gs://genomics-public-data/x.bam",
    ]:
        assert _resolve_bam_path(url) == url


def test_coverage_region_bins_interval_depth(tmp_path):
    bam = _make_bam(tmp_path)
    res = coverage_region(bam, "chr11", 100, 350, bin_size=50)
    assert res["binSize"] == 50
    assert res["bins"] == [2, 1, 0, 0, 1]
    assert res["maxDepth"] == 2
    assert res["chrom"] == "chr11"
    assert res["start"] == 100
    assert res["end"] == 350


def test_coverage_region_clips_reads_to_requested_window(tmp_path):
    bam = _make_bam(tmp_path)
    res = coverage_region(bam, "chr11", 130, 160, bin_size=1000)
    assert res["bins"] == [2]
    assert res["binSize"] == 1000
    assert res["maxDepth"] == 2


def test_coverage_region_empty_window_is_zero_not_missing(tmp_path):
    bam = _make_bam(tmp_path)
    res = coverage_region(bam, "chr11", 200, 300, bin_size=50)
    assert res["bins"] == [0, 0]
    assert res["maxDepth"] == 0


def test_coverage_region_bin_budget_clamps_whole_chromosome(tmp_path):
    bam = _make_bam(tmp_path)
    res = coverage_region(bam, "chr11", 0, 1_000_000, bin_size=1)
    assert len(res["bins"]) <= 4096
    assert res["binSize"] >= 1
    assert sum(1 for d in res["bins"] if d > 0) >= 1


def test_coverage_region_missing_bam_raises(tmp_path):
    with pytest.raises(BamNotFoundError):
        coverage_region(str(tmp_path / "nope.bam"), "chr11", 0, 100)


def test_coverage_region_rejects_empty_window(tmp_path):
    bam = _make_bam(tmp_path)
    with pytest.raises(PileupError):
        coverage_region(bam, "chr11", 100, 100)


def test_resolve_coverage_bin_size_honors_and_clamps():
    assert _resolve_coverage_bin_size(10_000, 100) == 100
    assert _resolve_coverage_bin_size(8192, None) == 2
    big = _resolve_coverage_bin_size(100_000_000, 1)
    assert 100_000_000 / big <= 4096


def _make_cram(tmp_path) -> tuple[str, str]:
    """Build a tiny indexed CRAM + its reference FASTA. Returns (cram, ref_fa)."""
    ref_fa = tmp_path / "ref.fa"
    ref_fa.write_text(">chr11\n" + ("ACGT" * 250) + "\n")
    pysam.faidx(str(ref_fa))
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chr11", "LN": 1000}],
    }
    cram_path = tmp_path / "t.cram"
    with pysam.AlignmentFile(
        str(cram_path), "wc", header=header, reference_filename=str(ref_fa)
    ) as out:
        for i, start in enumerate([100, 120, 300]):
            a = pysam.AlignedSegment()
            a.query_name = f"r{i}"
            a.reference_id = 0
            a.reference_start = start
            a.query_sequence = "ACGTACGTAC" * 5
            a.cigartuples = [(0, 50)]
            a.mapping_quality = 60
            a.flag = 16 if i == 1 else 0
            out.write(a)
    pysam.index(str(cram_path))
    return str(cram_path), str(ref_fa)


def test_cram_region_query_decodes_with_reference(tmp_path):
    cram, ref = _make_cram(tmp_path)
    res = read_pileup_region(cram, "chr11", 90, 200, reference_fasta=ref)
    assert res["count"] == 2
    assert sorted(r["start"] for r in res["reads"]) == [100, 120]
    rev = next(r for r in res["reads"] if r["start"] == 120)
    assert rev["strand"] == "-"


def test_cram_coverage_decodes_with_reference(tmp_path):
    cram, ref = _make_cram(tmp_path)
    res = coverage_region(cram, "chr11", 100, 350, bin_size=50, reference_fasta=ref)
    assert res["bins"] == [2, 1, 0, 0, 1]


def test_ensure_alignment_index_returns_readable_cram_index(tmp_path):
    cram, _ = _make_cram(tmp_path)
    result = ensure_alignment_index(cram)

    assert result == {
        "format": "cram",
        "state": "present",
        "indexPath": f"{cram}.crai",
    }


def test_ensure_alignment_index_rejects_cram_without_index(tmp_path):
    cram, _ = _make_cram(tmp_path)
    Path(f"{cram}.crai").unlink()

    with pytest.raises(AlignmentIndexError, match="matching .crai or .csi"):
        ensure_alignment_index(cram)


def test_cram_header_validates_the_selected_reference_across_indexed_contigs(tmp_path):
    cram, ref = _make_cram(tmp_path)

    result = read_alignment_header(
        cram,
        f"{cram}.crai",
        reference_fasta=ref,
    )

    assert result["format"] == "cram"
    assert result["index"] == {"state": "present"}


def test_cram_header_rejects_a_reference_that_only_matches_the_first_contig(tmp_path):
    source_ref = tmp_path / "multi-ref.fa"
    source_ref.write_text(
        ">chr1\n" + ("ACGT" * 250) + "\n>chr2\n" + ("TGCA" * 250) + "\n"
    )
    pysam.faidx(str(source_ref))
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [
            {"SN": "chr1", "LN": 1000},
            {"SN": "chr2", "LN": 1000},
        ],
    }
    cram = tmp_path / "multi-ref.cram"
    with pysam.AlignmentFile(
        str(cram), "wc", header=header, reference_filename=str(source_ref)
    ) as out:
        for reference_id, sequence in [
            (0, "ACGT" * 12 + "AC"),
            (1, "TGCA" * 12 + "TG"),
        ]:
            read = pysam.AlignedSegment()
            read.query_name = f"read-{reference_id}"
            read.reference_id = reference_id
            read.reference_start = 100
            read.query_sequence = sequence
            read.cigartuples = [(0, 50)]
            read.mapping_quality = 60
            out.write(read)
    pysam.index(str(cram))

    partly_wrong_ref = tmp_path / "partly-wrong.fa"
    partly_wrong_ref.write_text(
        ">chr1\n" + ("ACGT" * 250) + "\n>chr2\n" + ("AAAA" * 250) + "\n"
    )
    pysam.faidx(str(partly_wrong_ref))

    with pytest.raises(ReferenceNotFoundError, match="exact reference used to create"):
        read_alignment_header(
            str(cram),
            f"{cram}.crai",
            reference_fasta=str(partly_wrong_ref),
        )


def test_cram_header_accepts_a_per_chromosome_fasta_without_fetching_the_others(
    tmp_path,
):
    source_ref = tmp_path / "multi-ref.fa"
    source_ref.write_text(
        ">chr1\n" + ("ACGT" * 250) + "\n>chr2\n" + ("TGCA" * 250) + "\n"
    )
    pysam.faidx(str(source_ref))
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [
            {"SN": "chr1", "LN": 1000},
            {"SN": "chr2", "LN": 1000},
        ],
    }
    cram = tmp_path / "multi-ref.cram"
    with pysam.AlignmentFile(
        str(cram), "wc", header=header, reference_filename=str(source_ref)
    ) as out:
        for reference_id, sequence in [
            (0, "ACGT" * 12 + "AC"),
            (1, "TGCA" * 12 + "TG"),
        ]:
            read = pysam.AlignedSegment()
            read.query_name = f"read-{reference_id}"
            read.reference_id = reference_id
            read.reference_start = 100
            read.query_sequence = sequence
            read.cigartuples = [(0, 50)]
            read.mapping_quality = 60
            out.write(read)
    pysam.index(str(cram))
    chromosome_one = tmp_path / "chr1.fa"
    chromosome_one.write_text(">chr1\n" + ("ACGT" * 250) + "\n")
    pysam.faidx(str(chromosome_one))

    result = read_alignment_header(
        str(cram),
        f"{cram}.crai",
        reference_fasta=str(chromosome_one),
    )

    assert result["isCram"] is True
    assert {item["name"] for item in result["references"]} == {"chr1", "chr2"}


def test_cram_header_rejects_a_reference_that_cannot_decode_the_file(tmp_path):
    cram, _ = _make_cram(tmp_path)
    wrong_ref = tmp_path / "wrong.fa"
    wrong_ref.write_text(">chr11\n" + ("TGCA" * 250) + "\n")
    pysam.faidx(str(wrong_ref))

    with pytest.raises(ReferenceNotFoundError, match="exact reference used to create"):
        read_alignment_header(
            cram,
            f"{cram}.crai",
            reference_fasta=str(wrong_ref),
        )


def test_cram_header_does_not_claim_reference_validation_without_a_decoded_record(
    tmp_path,
):
    reference = tmp_path / "empty-reference.fa"
    reference.write_text(">chr11\n" + ("ACGT" * 250) + "\n")
    pysam.faidx(str(reference))
    cram = tmp_path / "empty.cram"
    header = {
        "HD": {"VN": "1.6", "SO": "coordinate"},
        "SQ": [{"SN": "chr11", "LN": 1000}],
    }
    with pysam.AlignmentFile(
        str(cram), "wc", header=header, reference_filename=str(reference)
    ):
        pass
    pysam.index(str(cram))

    with pytest.raises(ReferenceNotFoundError, match="contains no indexed records"):
        read_alignment_header(
            str(cram),
            f"{cram}.crai",
            reference_fasta=str(reference),
        )


def test_cram_missing_reference_fails_loud(tmp_path):
    cram, _ = _make_cram(tmp_path)
    with pytest.raises(ReferenceNotFoundError):
        read_pileup_region(
            cram, "chr11", 90, 200, reference_fasta=str(tmp_path / "nope.fa")
        )


def test_reference_filename_is_noop_for_bam(tmp_path):
    bam = _make_bam(tmp_path)
    ref_fa = tmp_path / "ref.fa"
    ref_fa.write_text(">chr11\n" + ("ACGT" * 250) + "\n")
    pysam.faidx(str(ref_fa))
    res = read_pileup_region(bam, "chr11", 90, 200, reference_fasta=str(ref_fa))
    assert res["count"] == 2


def test_resolve_reference_path_none_is_passthrough():
    assert _resolve_reference_path(None) is None


def test_resolve_reference_path_remote_url_raises():
    with pytest.raises(ReferenceNotFoundError):
        _resolve_reference_path("https://host/GRCh38.fa")


def test_resolve_reference_path_missing_fasta_raises(tmp_path):
    with pytest.raises(ReferenceNotFoundError):
        _resolve_reference_path(str(tmp_path / "absent.fa"))


def test_resolve_reference_path_missing_fai_raises(tmp_path):
    fa = tmp_path / "ref.fa"
    fa.write_text(">chr11\nACGT\n")
    with pytest.raises(ReferenceNotFoundError):
        _resolve_reference_path(str(fa))


def test_resolve_reference_path_accepts_fasta_with_fai(tmp_path):
    fa = tmp_path / "ref.fa"
    fa.write_text(">chr11\n" + ("ACGT" * 250) + "\n")
    pysam.faidx(str(fa))
    assert _resolve_reference_path(str(fa)) == str(fa)


_REAL_CRAM = os.path.expanduser("~/projects/wp-assets/bam-cache/NA12718.final.cram")
_REAL_REF = os.path.expanduser(
    "~/projects/wp-assets/reference/GRCh38_full_analysis_set_plus_decoy_hla.fa"
)
_HAVE_REAL_CRAM = os.path.isfile(_REAL_CRAM) and os.path.isfile(_REAL_REF)


@pytest.mark.skipif(
    not _HAVE_REAL_CRAM,
    reason="real NA12718 CRAM + GRCh38 reference not present (wp-assets)",
)
def test_real_cram_green_with_reference_red_without():
    res = read_pileup_region(
        _REAL_CRAM, "chr11", 5226000, 5227000, reference_fasta=_REAL_REF
    )
    assert res["count"] > 0
    for r in res["reads"][:20]:
        assert r["end"] > r["start"]
        assert r["strand"] in ("+", "-")
    with pytest.raises(OSError):
        read_pileup_region(_REAL_CRAM, "chr11", 5226000, 5227000)
