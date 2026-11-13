"""File-kind admission happens before a raw-read managed job exists."""

import gzip

import pytest

from src.ngs_read_analysis_contract import (
    NgsReadAnalysisRequest,
    prepare_ngs_read_input,
)


def request(path):
    return NgsReadAnalysisRequest(
        documentId="reference",
        readPath=str(path),
        referenceSequence="ACGT" * 30,
        preset="sr",
    )


@pytest.mark.parametrize("compressed", [False, True])
@pytest.mark.parametrize(
    "contents",
    [
        b"##fileformat=VCFv4.2\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n",
        b"BCF\x02\x02\x00\x00\x00\x00",
    ],
)
def test_variant_bytes_are_rejected_before_read_job_admission(
    tmp_path, compressed, contents
):
    source = tmp_path / "sample_reads.fastq.gz_withfiltering.vcf"
    source.write_bytes(gzip.compress(contents) if compressed else contents)
    before = source.read_bytes()
    with pytest.raises(ValueError, match="start_variant_calls.*import_variant_calls"):
        prepare_ngs_read_input(request(source))
    assert source.read_bytes() == before


@pytest.mark.parametrize("compressed", [False, True])
def test_fastq_is_recognized_by_bytes_with_an_arbitrary_filename(tmp_path, compressed):
    source = tmp_path / "notebook-output.bin"
    contents = b"@read-1\r\nACGT\r\n+\r\nIIII\r\n"
    source.write_bytes(gzip.compress(contents) if compressed else contents)
    result = prepare_ngs_read_input(request(source))
    assert result.read_path == str(source.resolve())
    assert result.source_generation.size == source.stat().st_size


@pytest.mark.parametrize("contents", [b"", b">consensus\nACGT\n", b"not a read\n"])
def test_empty_or_non_fastq_input_is_not_admitted(tmp_path, contents):
    source = tmp_path / "sample.fastq"
    source.write_bytes(contents)
    with pytest.raises(ValueError, match="FASTQ"):
        prepare_ngs_read_input(request(source))
