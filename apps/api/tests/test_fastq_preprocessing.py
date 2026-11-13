from __future__ import annotations

import asyncio
import gzip
import hashlib
import os
import random
import shutil
import sys
import threading
from pathlib import Path

import pytest
from dnaforge_annotation.iupac import reverse_complement

from src.fastq_preprocessing_contract import (
    FastqPreprocessingRequest,
    FastqPreprocessingSubmission,
    prepare_fastq_preprocessing,
)
from src.ngs_read_analysis_contract import NgsReadAnalysisSubject
from src.operations import OperationCanceled, OperationExecutionError
from src.services.fastq_preprocessing import (
    _execute,
    _fastq_records,
    _snapshot_pairs,
    execute_fastq_preprocessing,
)

real_fastp = pytest.mark.skipif(
    shutil.which("fastp") is None, reason="Requires actual fastp 1.4.0"
)


def write_reads(path, records):
    content = "".join(
        f"@{name}\n{sequence}\n+\n{quality}\n" for name, sequence, quality in records
    )
    if path.suffix == ".gz":
        with gzip.open(path, "wt") as stream:
            stream.write(content)
    else:
        path.write_text(content)


def request_for(tmp_path, pairs, **settings):
    paths = [tmp_path / "r1.fastq", tmp_path / "r2.fastq"]
    for mate in (1, 2):
        write_reads(
            paths[mate - 1],
            [
                (f"pair-{index}/{mate}", pair[mate - 1], pair[mate + 1])
                for index, pair in enumerate(pairs)
            ],
        )
    submission = FastqPreprocessingSubmission(
        submission_key="scientific-fixture",
        subject=NgsReadAnalysisSubject(scope_id="fixture"),
        input=FastqPreprocessingRequest(
            read1Path=str(paths[0]), read2Path=str(paths[1]), **settings
        ),
    )
    return prepare_fastq_preprocessing(submission).input


def dna(length):
    randomizer = random.Random(3915)
    return "".join(randomizer.choice("ACGT") for _ in range(length))


@pytest.mark.asyncio
@real_fastp
async def test_real_fastp_trims_readthrough_and_preserves_exact_merged_insert(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("DNAFORGE_FASTQ_PREPARATION_CACHE_DIR", str(tmp_path / "cache"))
    fragment = dna(90)
    adapter1, adapter2 = (
        "AGATCGGAAGAGCACACGTCTGAACTCCAGTCA",
        "AGATCGGAAGAGCGTCGTGTAGGGAAAGAGTGT",
    )
    read1, read2 = fragment + adapter1, reverse_complement(fragment) + adapter2
    request = request_for(
        tmp_path,
        [(read1, read2, "I" * len(read1), "I" * len(read2))],
        adapter1=adapter1,
        adapter2=adapter2,
    )
    original = [
        Path(request.read1_path).read_bytes(),
        Path(request.read2_path).read_bytes(),
    ]
    result = await execute_fastq_preprocessing(request, threading.Event())
    assert result.version == "fastp 1.4.0"
    assert result.input_pairs == 1
    assert result.outputs["merged"].reads == 1
    records = list(
        _fastq_records(Path(result.outputs["merged"].path), threading.Event())
    )
    assert records[0][1].decode() == fragment
    assert len(records[0][3]) == len(fragment)
    assert result.outputs["unmerged1"].reads == 0
    assert [
        Path(request.read1_path).read_bytes(),
        Path(request.read2_path).read_bytes(),
    ] == original
    assert result.input_sha256 == [
        hashlib.sha256(value).hexdigest() for value in original
    ]
    assert result.report["summary"]["before_filtering"]["total_reads"] == 2
    assert Path(result.report_path).is_file()


@pytest.mark.asyncio
@real_fastp
async def test_real_fastp_preserves_nonoverlap_and_failed_quality_reads(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("DNAFORGE_FASTQ_PREPARATION_CACHE_DIR", str(tmp_path / "cache"))
    fragment = dna(300)
    pairs = [
        (fragment[:80], reverse_complement(fragment[-80:]), "I" * 80, "I" * 80),
        (fragment[:80], reverse_complement(fragment[-80:]), "!" * 80, "!" * 80),
    ]
    result = await execute_fastq_preprocessing(
        request_for(tmp_path, pairs, overlapMismatches=0, overlapMismatchPercent=0),
        threading.Event(),
    )
    assert result.outputs["merged"].reads == 0
    assert result.outputs["unmerged1"].reads == result.outputs["unmerged2"].reads == 1
    assert result.rejected_reads == 2
    assert result.outputs["original1"].reads == result.outputs["original2"].reads == 2


@pytest.mark.asyncio
@real_fastp
async def test_real_fastp_mismatch_threshold_changes_merge_result(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("DNAFORGE_FASTQ_PREPARATION_CACHE_DIR", str(tmp_path / "cache"))
    fragment = dna(90)
    reverse = reverse_complement(fragment)
    mutated = reverse[:45] + ("C" if reverse[45] != "C" else "A") + reverse[46:]
    pairs = [(fragment, mutated, "I" * 90, "I" * 90)]
    strict = await execute_fastq_preprocessing(
        request_for(tmp_path, pairs, overlapMismatches=0, overlapMismatchPercent=0),
        threading.Event(),
    )
    assert strict.outputs["merged"].reads == 0
    permissive = await execute_fastq_preprocessing(
        request_for(tmp_path, pairs, overlapMismatches=1, overlapMismatchPercent=2),
        threading.Event(),
    )
    assert permissive.outputs["merged"].reads == 1


def test_pair_identity_count_quality_and_input_mutation_are_not_silently_accepted(
    tmp_path,
):
    fragment = dna(90)
    request = request_for(
        tmp_path, [(fragment, reverse_complement(fragment), "I" * 90, "I" * 90)]
    )
    root = tmp_path / "identity"
    root.mkdir()
    write_reads(
        Path(request.read2_path), [("other/2", reverse_complement(fragment), "I" * 90)]
    )
    with pytest.raises(ValueError, match="changed after submission"):
        _snapshot_pairs(request, root, threading.Event())
    request = request_for(
        tmp_path, [(fragment, reverse_complement(fragment), "I" * 90, "I" * 90)]
    )
    Path(request.read2_path).write_text(
        "@other/2\n" + fragment + "\n+\n" + "I" * 90 + "\n"
    )
    submission = FastqPreprocessingSubmission(
        submission_key="mismatch",
        subject=NgsReadAnalysisSubject(scope_id="fixture"),
        input=FastqPreprocessingRequest(
            read1Path=request.read1_path, read2Path=request.read2_path
        ),
    )
    with pytest.raises(ValueError, match="identities differ"):
        _snapshot_pairs(
            prepare_fastq_preprocessing(submission).input, root, threading.Event()
        )


def test_cancelled_snapshot_does_not_start_processing(tmp_path):
    request = request_for(tmp_path, [(dna(90), dna(90), "I" * 90, "I" * 90)])
    root = tmp_path / "cancel"
    root.mkdir()
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(OperationCanceled):
        _snapshot_pairs(request, root, cancel)


@pytest.mark.asyncio
@real_fastp
async def test_real_fastp_preserves_passing_orphan_and_rejects_both_failing_pair(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("DNAFORGE_FASTQ_PREPARATION_CACHE_DIR", str(tmp_path / "cache"))
    fragment = dna(300)
    first, second = fragment[:80], reverse_complement(fragment[-80:])
    result = await execute_fastq_preprocessing(
        request_for(
            tmp_path,
            [(first, second, "I" * 80, "!" * 80), (first, second, "!" * 80, "!" * 80)],
        ),
        threading.Event(),
    )
    assert result.outputs["unpaired1"].reads == 1
    assert result.outputs["unpaired2"].reads == 0
    assert result.outputs["merged"].reads == result.outputs["unmerged1"].reads == 0
    assert result.rejected_reads == 3
    assert result.outputs["original1"].reads == result.outputs["original2"].reads == 2


@pytest.mark.parametrize(
    "content,reason",
    [("@pair-0/2\nACGT\n+\nIII\n", "Invalid FASTQ"), ("", "different record counts")],
)
def test_malformed_quality_and_pair_count_are_rejected(tmp_path, content, reason):
    request = request_for(tmp_path, [(dna(90), dna(90), "I" * 90, "I" * 90)])
    Path(request.read2_path).write_text(content)
    from src.local_file_generation import capture_local_file_generation

    request = request.model_copy(
        update={"read2_generation": capture_local_file_generation(request.read2_path)}
    )
    root = tmp_path / "validation"
    root.mkdir()
    with pytest.raises(ValueError, match=reason):
        _snapshot_pairs(request, root, threading.Event())


def test_gzip_mates_are_validated_and_snapshotted_without_sampling(tmp_path):
    paths = [tmp_path / "r1.fastq.gz", tmp_path / "r2.fastq.gz"]
    for mate, path in enumerate(paths, 1):
        write_reads(
            path, [(f"pair-{index}/{mate}", dna(20), "I" * 20) for index in range(3)]
        )
    request = prepare_fastq_preprocessing(
        FastqPreprocessingSubmission(
            submission_key="gzip",
            subject=NgsReadAnalysisSubject(scope_id="fixture"),
            input=FastqPreprocessingRequest(
                read1Path=str(paths[0]), read2Path=str(paths[1])
            ),
        )
    ).input
    root = tmp_path / "validation"
    root.mkdir()
    snapshots, hashes, count = _snapshot_pairs(request, root, threading.Event())
    assert count == 3
    assert all(
        len(list(_fastq_records(path, threading.Event()))) == 3 for path in snapshots
    )
    assert hashes == [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]


@pytest.mark.asyncio
async def test_cancellation_terminates_only_owned_running_process(tmp_path):
    pid_file = tmp_path / "pid"
    cancel = threading.Event()
    task = asyncio.create_task(
        _execute(
            [
                sys.executable,
                "-c",
                "import os,time,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)",
                str(pid_file),
            ],
            tmp_path,
            cancel,
        )
    )
    try:
        async with asyncio.timeout(5):
            while not pid_file.exists():
                await asyncio.sleep(0.01)
        pid = int(pid_file.read_text())
        cancel.set()
        with pytest.raises(OperationCanceled):
            await asyncio.wait_for(task, timeout=5)
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        cancel.set()
        if not task.done():
            await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_missing_app_owned_runtime_never_falls_back_to_ambient_fastp(
    tmp_path, monkeypatch
):
    request = request_for(tmp_path, [(dna(90), dna(90), "I" * 90, "I" * 90)])
    monkeypatch.setenv("DNAFORGE_HELPERS_DIR", str(tmp_path / "missing-app-helpers"))
    monkeypatch.setenv("WAYPOINT_BINARIES_PATH", str(tmp_path / "missing-app-binaries"))
    monkeypatch.setattr(
        shutil,
        "which",
        lambda _: pytest.fail("App-owned runtime must not fall back to PATH"),
    )
    with pytest.raises(OperationExecutionError, match="requires fastp"):
        await execute_fastq_preprocessing(request, threading.Event())
