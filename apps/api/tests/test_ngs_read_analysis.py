"""Real aligner/pileup acceptance for raw-read analysis; no mocked bases."""

import asyncio
import gzip
import os
import random
import shutil
import sys
import threading
from pathlib import Path

import pytest

from src.ngs_read_analysis_contract import (
    NgsReadAnalysisRequest,
    prepare_ngs_read_input,
)
from src.services.ngs_read_analysis import _run, execute_ngs_read_analysis


@pytest.fixture(autouse=True)
def isolated_artifacts(tmp_path, monkeypatch):
    monkeypatch.setenv("DNAFORGE_NGS_ANALYSIS_CACHE_DIR", str(tmp_path / "analysis"))


@pytest.mark.asyncio
async def test_cancellation_terminates_the_owned_running_process(tmp_path):
    pid_file = tmp_path / "pid"
    cancel = threading.Event()
    task = asyncio.create_task(
        _run(
            [
                sys.executable,
                "-c",
                "import os,time,pathlib,sys; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)",
                str(pid_file),
            ],
            cancel,
            asyncio.get_running_loop().time() + 10,
        )
    )
    try:
        async with asyncio.timeout(5):
            while not pid_file.exists():
                await asyncio.sleep(0.01)
        pid = int(pid_file.read_text())
        cancel.set()
        with pytest.raises(Exception, match="cancel"):
            await asyncio.wait_for(task, timeout=5)
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
    finally:
        cancel.set()
        if not task.done():
            await asyncio.gather(task, return_exceptions=True)


pytestmark = pytest.mark.skipif(
    any(shutil.which(name) is None for name in ("minimap2", "samtools", "bcftools")),
    reason="Requires the actual local NGS executables",
)


def reads_file(path: Path, reads: list[str]) -> Path:
    with gzip.open(path, "wt") as stream:
        for index, sequence in enumerate(reads):
            stream.write(f"@read-{index}\n{sequence}\n+\n" + "I" * len(sequence) + "\n")
    return path


@pytest.mark.asyncio
async def test_actual_raw_reads_cross_circular_origin_without_doubled_depth(tmp_path):
    reference = "".join(random.Random(3191).choices("ACGT", k=1200))
    alt = next(base for base in "ACGT" if base != reference[5])
    changed = reference[:5] + alt + reference[6:]
    read = changed[-150:] + changed[:150]
    source = reads_file(tmp_path / "origin.fastq.gz", [read] * 5 + ["N" * 300])
    request = prepare_ngs_read_input(
        NgsReadAnalysisRequest(
            documentId="test",
            readPath=str(source),
            referenceSequence=reference,
            isCircular=True,
            preset="sr",
            minMappingQuality=0,
            minBaseQuality=20,
            minDepth=3,
            minAlternateCount=3,
            minAlleleFraction=0.5,
        )
    )
    result = await execute_ngs_read_analysis(request, threading.Event())
    assert result.total_reads == 6
    assert result.mapped_reads + result.unmapped_reads == 6
    assert result.unmapped_reads == 1
    assert result.coverage[5] == 5
    assert result.coverage[-5] == 5
    assert result.coverage[600] == 0
    call = next(call for call in result.calls if call.position == 6)
    assert (call.reference, call.alternate) == (reference[5], alt)
    assert call.alternate_count == 5
    assert call.total_allele_count == 5
    assert result.circular_method == "two-origins-central-half"
    assert result.source_sha256 and result.reference_sha256
    assert all(call.genotype is None for call in result.calls)


@pytest.mark.asyncio
async def test_changed_or_malformed_fastq_never_becomes_completed_evidence(tmp_path):
    source = reads_file(tmp_path / "reads.fastq.gz", ["ACGT" * 100])
    request = prepare_ngs_read_input(
        NgsReadAnalysisRequest(
            documentId="test",
            readPath=str(source),
            referenceSequence="ACGT" * 300,
            preset="sr",
        )
    )
    source.write_bytes(b"changed")
    with pytest.raises(Exception, match="changed"):
        await execute_ngs_read_analysis(request, threading.Event())
    bad = tmp_path / "bad.fastq"
    bad.write_text("@read\nACGT\n+\nII\n")
    request = prepare_ngs_read_input(
        NgsReadAnalysisRequest(
            documentId="test",
            readPath=str(bad),
            referenceSequence="ACGT" * 300,
            preset="sr",
        )
    )
    with pytest.raises(Exception, match="quality|FASTQ"):
        await execute_ngs_read_analysis(request, threading.Event())


@pytest.mark.asyncio
async def test_cancel_before_start_is_not_success(tmp_path):
    source = reads_file(tmp_path / "reads.fastq.gz", ["ACGT" * 100])
    request = prepare_ngs_read_input(
        NgsReadAnalysisRequest(
            documentId="test",
            readPath=str(source),
            referenceSequence="ACGT" * 300,
            preset="sr",
        )
    )
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Exception, match="cancel"):
        await execute_ngs_read_analysis(request, cancel)


@pytest.mark.asyncio
async def test_high_depth_deletion_is_not_silently_skipped_by_pileup_default(tmp_path):
    reference = "".join(random.Random(91).choices("ACGT", k=1200))
    mutated = reference[:500] + reference[502:]
    source = reads_file(tmp_path / "deletion.fastq.gz", [mutated[350:650]] * 270)
    request = prepare_ngs_read_input(
        NgsReadAnalysisRequest(
            documentId="test",
            readPath=str(source),
            referenceSequence=reference,
            preset="sr",
            minMappingQuality=0,
            minBaseQuality=0,
            minDepth=3,
            minAlternateCount=3,
            minAlleleFraction=0.5,
        )
    )
    result = await execute_ngs_read_analysis(request, threading.Event())
    deletion = [
        row for row in result.calls if len(row.reference) - len(row.alternate) == 2
    ]
    assert len(deletion) == 1
    assert deletion[0].alternate_count == 270
    assert deletion[0].total_allele_count == 270
