from __future__ import annotations

import gzip
import threading
from pathlib import Path

import pytest

from src.operations import OperationCanceled
from src.services.fastq_preprocessing import MAX_FASTQ_LINE_BYTES, _fastq_records


def write_record(path: Path, sequence: bytes, quality: bytes):
    path.write_bytes(
        b"@original description\n" + sequence + b"\n+description\n" + quality + b"\n"
    )


def test_single_byte_sequence_domain_and_case_normalization(tmp_path):
    path = tmp_path / "bases.fastq"
    for value in range(256):
        base = bytes([value])
        write_record(path, base, b"I")
        if base in b"ACGTNacgtn":
            assert list(_fastq_records(path, threading.Event())) == [
                (b"@original description", base.upper(), b"+", b"I")
            ]
        else:
            with pytest.raises(ValueError):
                list(_fastq_records(path, threading.Event()))


def test_single_byte_quality_domain_preserves_every_phred_value(tmp_path):
    path = tmp_path / "qualities.fastq"
    for value in range(256):
        quality = bytes([value])
        write_record(path, b"N", quality)
        if 33 <= value <= 126:
            assert list(_fastq_records(path, threading.Event()))[0][3] == quality
        else:
            with pytest.raises(ValueError):
                list(_fastq_records(path, threading.Event()))


def test_mixed_base_and_quality_boundaries_preserve_original_records(tmp_path):
    path = tmp_path / "mixed.fastq"
    quality = bytes(range(33, 127))
    sequence = (b"acgtn" * 19)[: len(quality)]
    path.write_bytes(
        b"@opaque\xff metadata\r\n"
        + sequence
        + b"\r\n+opaque\xff\r\n"
        + quality
        + b"\r\n"
    )
    assert list(_fastq_records(path, threading.Event())) == [
        (b"@opaque\xff metadata", sequence.upper(), b"+", quality)
    ]


def test_concatenated_gzip_members_keep_all_records(tmp_path):
    path = tmp_path / "members.fastq.gz"
    path.write_bytes(
        gzip.compress(b"@one\nac\n+\n!~\n") + gzip.compress(b"@two\nTN\n+\nI#\n")
    )
    assert list(_fastq_records(path, threading.Event())) == [
        (b"@one", b"AC", b"+", b"!~"),
        (b"@two", b"TN", b"+", b"I#"),
    ]


def test_gzip_crc_failure_is_not_accepted_as_complete_input(tmp_path):
    path = tmp_path / "corrupt.fastq.gz"
    content = bytearray(gzip.compress(b"@one\nACGTN\n+\nIIIII\n"))
    content[-8] ^= 1
    path.write_bytes(content)
    with pytest.raises(gzip.BadGzipFile):
        list(_fastq_records(path, threading.Event()))


def test_cancellation_between_records_stops_validation(tmp_path):
    path = tmp_path / "cancel.fastq"
    path.write_bytes(b"@one\nAC\n+\nII\n@two\nGT\n+\nII\n")
    cancel = threading.Event()
    records = _fastq_records(path, cancel)
    assert next(records)[0] == b"@one"
    cancel.set()
    with pytest.raises(OperationCanceled):
        next(records)


@pytest.mark.parametrize("line", range(4))
def test_every_record_line_keeps_the_existing_size_limit(tmp_path, line):
    path = tmp_path / "oversized.fastq"
    lines = [b"@one", b"A", b"+", b"I"]
    lines[line] = b"A" * MAX_FASTQ_LINE_BYTES
    path.write_bytes(b"\n".join(lines) + b"\n")
    with pytest.raises(ValueError, match="supported line length"):
        list(_fastq_records(path, threading.Event()))


def test_sequence_and_quality_at_the_line_limit_are_not_truncated(tmp_path):
    path = tmp_path / "limit.fastq"
    sequence = b"A" * (MAX_FASTQ_LINE_BYTES - 1)
    quality = b"!" * len(sequence)
    write_record(path, sequence, quality)
    assert list(_fastq_records(path, threading.Event()))[0][1:] == (
        sequence,
        b"+",
        quality,
    )
