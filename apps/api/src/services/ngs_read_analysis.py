"""Real minimap2 → sorted BAM → bcftools pileup evidence, owned by managed jobs.

Circular references use two single-copy origins. Each canonical position belongs
only to the central half of one run, so repeated reference copies never create
artificial mapping ambiguity and evidence from origins is never added together.
Alleles are read-support candidates, not a consensus or a phased genotype.
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import os
import shutil
import subprocess
import threading
from pathlib import Path

from ..local_file_generation import capture_local_file_generation
from ..ngs_read_analysis_contract import (
    NgsAlignmentArtifact,
    NgsReadAnalysisInput,
    NgsReadAnalysisResult,
    ngs_input_revision,
)
from ..operations import OperationCanceled, OperationExecutionError
from ..sequence_variant_contract import SequenceVariantCall
from ..tools.alignment import _terminate_owned_process
from .scientific_workspace import run_scientific_workspace

MAX_READS = 100_000
MAX_BASES = 500_000_000


def _check(cancel: threading.Event):
    if cancel.is_set():
        raise OperationCanceled("Raw-read analysis was canceled.")


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _normalize_fastq(source: Path, target: Path, cancel: threading.Event):
    total = 0
    bases = 0
    with source.open("rb") as check:
        compressed = check.read(2) == b"\x1f\x8b"
    opener = gzip.open if compressed else open
    with (
        opener(source, "rt", encoding="ascii") as stream,
        target.open("w", encoding="ascii") as output,
    ):
        while True:
            _check(cancel)
            header = stream.readline()
            if not header:
                break
            sequence = stream.readline().rstrip("\r\n").upper()
            plus = stream.readline()
            quality = stream.readline().rstrip("\r\n")
            if (
                not header.startswith("@")
                or not plus.startswith("+")
                or not sequence
                or len(sequence) != len(quality)
                or set(sequence) - set("ACGTN")
                or any(ord(char) < 33 or ord(char) > 126 for char in quality)
            ):
                raise ValueError(
                    f"Invalid four-line FASTQ or quality string at read {total + 1}. No partial analysis was imported."
                )
            total += 1
            bases += len(sequence)
            if total > MAX_READS or bases > MAX_BASES:
                raise ValueError(
                    "This small-reference workflow accepts at most 100,000 reads and 500 million bases. Split the analysis explicitly; reads are never silently sampled."
                )
            output.write(f"@dnaforge-read-{total}\n{sequence}\n+\n{quality}\n")
    if not total:
        raise ValueError("The FASTQ contains no reads.")
    return total, bases


async def _run(
    args: list[str],
    cancel: threading.Event,
    deadline: float,
    stdout: Path | None = None,
) -> str:
    _check(cancel)
    options = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    output = stdout.open("wb") if stdout else None
    proc = None
    communication = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=output or asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **options,
        )
        communication = asyncio.create_task(proc.communicate())
        while not communication.done():
            if cancel.is_set():
                await _terminate_owned_process(proc, communication)
                raise OperationCanceled("Raw-read analysis was canceled.")
            if asyncio.get_running_loop().time() >= deadline:
                await _terminate_owned_process(proc, communication)
                raise OperationExecutionError(
                    "NGS_TIMEOUT", "Raw-read analysis exceeded its 10-minute bound."
                )
            await asyncio.wait({communication}, timeout=0.05)
        out, err = await communication
        if proc.returncode:
            raise OperationExecutionError(
                "NGS_TOOL_FAILED",
                f"{Path(args[0]).name} failed: {err.decode(errors='replace')[-700:]}",
            )
        return (out or b"").decode(errors="replace").strip()
    except asyncio.CancelledError:
        if proc and communication:
            await _terminate_owned_process(proc, communication)
        raise
    finally:
        if output:
            output.close()


def _sam_stats(
    path: Path,
    total: int,
    min_mapq: int,
    mapped: set[int],
    qualified: set[int],
    cancel: threading.Event,
) -> int:
    seen = set()
    records = 0
    with path.open() as stream:
        for line in stream:
            if line.startswith("@"):
                continue
            _check(cancel)
            fields = line.split("\t")
            index = int(fields[0].removeprefix("dnaforge-read-"))
            if index < 1 or index > total:
                raise ValueError("Aligner returned an unknown read identity.")
            seen.add(index)
            records += 1
            flag = int(fields[1])
            if not flag & 4:
                mapped.add(index)
                if int(fields[4]) >= min_mapq and not flag & 256:
                    qualified.add(index)
    if len(seen) != total:
        raise ValueError(
            "Aligner omitted input reads. Partial mapping is not accepted."
        )
    return records


def _read_pileup(
    path: Path,
    request: NgsReadAnalysisInput,
    offset: int,
    coverage: list[int],
    calls: list[SequenceVariantCall],
    cancel: threading.Event,
) -> int:
    import pysam

    length = len(request.reference_sequence)
    excluded = 0
    with pysam.VariantFile(str(path)) as source:
        for record in source:
            _check(cancel)
            position = (record.pos - 1 + offset) % length
            central = length // 4 <= position < length // 4 + (length + 1) // 2
            if request.is_circular and ((offset == 0) != central):
                continue
            sample = next(iter(record.samples.values()))
            depths = sample.get("AD")
            if not depths or any(value is None or value < 0 for value in depths):
                continue
            total = sum(depths)
            coverage[position] = max(coverage[position], total)
            for allele_index, alternate in enumerate(record.alts or (), start=1):
                if alternate == "<*>":
                    continue
                count = depths[allele_index] if allele_index < len(depths) else None
                if (
                    count is None
                    or total < request.min_depth
                    or count < request.min_alternate_count
                    or count / total < request.min_allele_fraction
                ):
                    excluded += 1
                    continue
                reference = record.ref.upper()
                alternate = alternate.upper()
                wrapped = position + len(reference) > length
                expected = (
                    request.reference_sequence * 2
                    if request.is_circular
                    else request.reference_sequence
                )[position : position + len(reference)]
                if reference != expected:
                    raise ValueError(
                        "Pileup reference allele does not match canonical DNA."
                    )
                unsupported = (
                    "This allele spans the circular origin; a wrapped protein projection is required."
                    if wrapped
                    else None
                )
                calls.append(
                    SequenceVariantCall(
                        id=f"read-allele-{position + 1}-{reference}-{alternate}",
                        position=position + 1,
                        reference=reference,
                        alternate=alternate,
                        allele_index=allele_index,
                        quality=None,
                        filters=["PASS"],
                        genotype=None,
                        reference_count=depths[0],
                        alternate_count=count,
                        total_allele_count=total,
                        allele_fraction=count / total,
                        unsupported_reason=unsupported,
                    )
                )
                if len(calls) > 5000:
                    raise ValueError(
                        "More than 5,000 alleles meet these thresholds. Tighten the declared filters; evidence is never silently truncated."
                    )
    return excluded


async def execute_ngs_read_analysis(
    request: NgsReadAnalysisInput,
    cancel: threading.Event,
    *,
    cache_dir: Path | None = None,
) -> NgsReadAnalysisResult:
    _check(cancel)
    source = Path(request.read_path)
    if capture_local_file_generation(source) != request.source_generation:
        raise ValueError("The FASTQ changed after this analysis was submitted.")
    tools = {name: shutil.which(name) for name in ("minimap2", "samtools", "bcftools")}
    missing = [name for name, path in tools.items() if not path]
    if missing:
        raise OperationExecutionError(
            "NGS_RUNTIME_UNAVAILABLE",
            "Raw-read analysis needs these installed tools: " + ", ".join(missing),
        )
    cache = (
        cache_dir
        if cache_dir is not None
        else Path(
            os.environ.get(
                "DNAFORGE_NGS_ANALYSIS_CACHE_DIR",
                str(Path.home() / ".dnaforge" / "ngs-analysis"),
            )
        )
    )

    async def analyze(root: Path) -> NgsReadAnalysisResult:
        reads = root / "reads.fastq"
        temporary_paths = [reads]
        total, bases = await asyncio.to_thread(_normalize_fastq, source, reads, cancel)
        source_hash = await asyncio.to_thread(_hash, source)
        if capture_local_file_generation(source) != request.source_generation:
            raise ValueError("The FASTQ changed while it was read.")
        deadline = asyncio.get_running_loop().time() + 600
        versions = {
            name: (await _run([path, "--version"], cancel, deadline)).splitlines()[0]
            for name, path in tools.items()
        }
        mapped: set[int] = set()
        qualified: set[int] = set()
        calls = []
        commands = []
        artifacts = []
        excluded = 0
        length = len(request.reference_sequence)
        coverage = [0] * length
        for offset in [0, length // 2] if request.is_circular else [0]:
            _check(cancel)
            reference = root / f"reference-{offset}.fa"
            sam = root / f"alignment-{offset}.sam"
            temporary_paths.append(sam)
            bam = root / f"alignment-{offset}.bam"
            vcf = root / f"pileup-{offset}.vcf"
            reference.write_text(
                ">reference\n"
                + request.reference_sequence[offset:]
                + request.reference_sequence[:offset]
                + "\n"
            )
            alignment = [
                tools["minimap2"],
                "-a",
                "-x",
                request.preset,
                "-t",
                str(request.threads),
                str(reference),
                str(reads),
            ]
            commands.append(alignment)
            await _run(alignment, cancel, deadline, sam)
            records = await asyncio.to_thread(
                _sam_stats,
                sam,
                total,
                request.min_mapping_quality,
                mapped,
                qualified,
                cancel,
            )
            for args in (
                [
                    tools["samtools"],
                    "sort",
                    "-@",
                    str(request.threads),
                    "-o",
                    str(bam),
                    str(sam),
                ],
                [tools["samtools"], "index", str(bam)],
                [tools["samtools"], "faidx", str(reference)],
            ):
                commands.append(args)
                await _run(args, cancel, deadline)
            pileup = [
                tools["bcftools"],
                "mpileup",
                "-Ov",
                "-o",
                str(vcf),
                "-f",
                str(reference),
                "-a",
                "FORMAT/AD,FORMAT/DP",
                "-Q",
                str(request.min_base_quality),
                "-q",
                str(request.min_mapping_quality),
                "-d",
                str(max(records, 1) + 1),
                "-L",
                str(max(records, 1) + 1),
                str(bam),
            ]
            commands.append(pileup)
            await _run(pileup, cancel, deadline)
            excluded += await asyncio.to_thread(
                _read_pileup, vcf, request, offset, coverage, calls, cancel
            )
            artifacts.append(
                NgsAlignmentArtifact(
                    originOffset=offset,
                    alignmentPath=str(bam),
                    referencePath=str(reference),
                    pileupPath=str(vcf),
                    alignmentSha256=await asyncio.to_thread(_hash, bam),
                    pileupSha256=await asyncio.to_thread(_hash, vcf),
                )
            )
        _check(cancel)
        if capture_local_file_generation(source) != request.source_generation:
            raise ValueError("The FASTQ changed before analysis completed.")
        result = NgsReadAnalysisResult(
            documentId=request.document_id,
            inputRevision=ngs_input_revision(request),
            sourceLabel=source.name,
            sourceSha256=source_hash,
            referenceSha256=request.reference_sha256,
            totalReads=total,
            totalBases=bases,
            mappedReads=len(mapped),
            unmappedReads=total - len(mapped),
            mappingQualityReads=len(qualified),
            coverage=coverage,
            circularMethod=(
                "two-origins-central-half" if request.is_circular else "linear"
            ),
            settings=request.model_dump(
                exclude={"source_generation", "reference_sha256"}
            ),
            versions=versions,
            commands=commands,
            artifacts=artifacts,
            calls=sorted(
                calls, key=lambda row: (row.position, row.reference, row.alternate)
            ),
            excludedAlleles=excluded,
        )
        (root / "result.json").write_text(result.model_dump_json(by_alias=True))
        for temporary in temporary_paths:
            temporary.unlink(missing_ok=True)
        return result

    return await run_scientific_workspace(cache, "analysis-", cancel, analyze)
