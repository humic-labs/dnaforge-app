from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import threading
from itertools import zip_longest
from pathlib import Path

from ..fastq_preprocessing_contract import (
    FastqPreprocessingInput,
    FastqPreprocessingRequest,
    FastqPreprocessingResult,
    PreparedFastqArtifact,
    PreparedFastqReport,
    fastq_preprocessing_revision,
)
from ..local_file_generation import capture_local_file_generation
from ..operations import OperationCanceled, OperationExecutionError
from ..toolbox.executable_paths import get_platform_suffix
from ..tools.alignment import _terminate_owned_process
from .scientific_workspace import run_scientific_workspace

MAX_FASTQ_LINE_BYTES = 1_000_000
MAX_REPORT_BYTES = 2 * 1024 * 1024
FASTQ_BASE_BYTES = b"ACGTN"
FASTQ_QUALITY_BYTES = bytes(range(33, 127))


def _check(cancel: threading.Event):
    if cancel.is_set():
        raise OperationCanceled("Paired-read preparation was canceled.")


def _sha256(path: Path, cancel: threading.Event) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            _check(cancel)
            digest.update(block)
    return digest.hexdigest()


def _fastq_records(path: Path, cancel: threading.Event):
    with path.open("rb") as magic:
        compressed = magic.read(2) == b"\x1f\x8b"
    with gzip.open(path, "rb") if compressed else path.open("rb") as stream:
        record = 0
        while True:
            _check(cancel)
            header = stream.readline(MAX_FASTQ_LINE_BYTES + 1)
            if not header:
                return
            lines = [
                header,
                *(stream.readline(MAX_FASTQ_LINE_BYTES + 1) for _ in range(3)),
            ]
            record += 1
            if any(len(line) > MAX_FASTQ_LINE_BYTES for line in lines):
                raise ValueError(
                    f"FASTQ record {record} exceeds the supported line length."
                )
            header, sequence, plus, quality = [line.rstrip(b"\r\n") for line in lines]
            sequence = sequence.upper()
            if (
                not header.startswith(b"@")
                or not plus.startswith(b"+")
                or not sequence
                or len(sequence) != len(quality)
                or sequence.translate(None, FASTQ_BASE_BYTES)
                or quality.translate(None, FASTQ_QUALITY_BYTES)
            ):
                raise ValueError(
                    f"Invalid FASTQ sequence or quality at record {record} in {path.name}."
                )
            yield header, sequence, b"+", quality


def _mate_identity(header: bytes, mate: int) -> bytes:
    fields = header[1:].split()
    if not fields:
        raise ValueError("FASTQ headers need a read identity.")
    identity = fields[0]
    if identity.endswith((b"/1", b"/2")):
        if not identity.endswith(f"/{mate}".encode()):
            raise ValueError("R1/R2 file order disagrees with the FASTQ mate suffix.")
        identity = identity[:-2]
    if (
        len(fields) > 1
        and fields[1].startswith((b"1:", b"2:"))
        and not fields[1].startswith(f"{mate}:".encode())
    ):
        raise ValueError("R1/R2 file order disagrees with the Illumina mate field.")
    return identity


def _snapshot_pairs(
    request: FastqPreprocessingInput, root: Path, cancel: threading.Event
):
    paths = [Path(request.read1_path), Path(request.read2_path)]
    generations = [request.read1_generation, request.read2_generation]
    for path, generation in zip(paths, generations, strict=True):
        if capture_local_file_generation(path) != generation:
            raise ValueError("A paired FASTQ changed after submission.")
    hashes = [_sha256(path, cancel) for path in paths]
    targets = [root / "input-r1.fastq.gz", root / "input-r2.fastq.gz"]
    count = 0
    with (
        gzip.open(targets[0], "xb", compresslevel=1) as out1,
        gzip.open(targets[1], "xb", compresslevel=1) as out2,
    ):
        for record1, record2 in zip_longest(
            _fastq_records(paths[0], cancel), _fastq_records(paths[1], cancel)
        ):
            if record1 is None or record2 is None:
                raise ValueError(
                    "R1 and R2 contain different record counts. No reads were merged."
                )
            if _mate_identity(record1[0], 1) != _mate_identity(record2[0], 2):
                raise ValueError(
                    f"R1/R2 identities differ at pair {count + 1}. No reads were merged."
                )
            count += 1
            for output, record in ((out1, record1), (out2, record2)):
                output.write(b"\n".join(record) + b"\n")
    if not count:
        raise ValueError("The paired FASTQ inputs contain no reads.")
    for path, generation, digest in zip(paths, generations, hashes, strict=True):
        if (
            capture_local_file_generation(path) != generation
            or _sha256(path, cancel) != digest
        ):
            raise ValueError(
                "A paired FASTQ changed during validation. No reads were merged."
            )
    return targets, hashes, count


async def _execute(command: list[str], root: Path, cancel: threading.Event):
    _check(cancel)
    options = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    with (root / "fastp.log").open("ab") as log:
        proc = await asyncio.create_subprocess_exec(
            *command, stdout=log, stderr=log, **options
        )
        wait = asyncio.create_task(proc.communicate())
        deadline = asyncio.get_running_loop().time() + 3600
        try:
            while not wait.done():
                _check(cancel)
                if asyncio.get_running_loop().time() >= deadline:
                    raise OperationExecutionError(
                        "FASTQ_PREPARATION_TIMEOUT",
                        "Paired-read preparation exceeded one hour. Outputs were not admitted.",
                    )
                await asyncio.wait({wait}, timeout=0.1)
            _check(cancel)
            await wait
            if proc.returncode != 0:
                raise OperationExecutionError(
                    "FASTQ_PREPARATION_FAILED",
                    "fastp failed. Original reads are unchanged; the managed job retains its failure state.",
                )
        finally:
            if proc.returncode is None:
                await _terminate_owned_process(proc, wait)
            if not wait.done():
                await wait


def _artifact(path: Path, cancel: threading.Event) -> PreparedFastqArtifact:
    reads = bases = 0
    for record in _fastq_records(path, cancel):
        reads += 1
        bases += len(record[1])
    return PreparedFastqArtifact(
        path=str(path), sha256=_sha256(path, cancel), reads=reads, bases=bases
    )


async def execute_fastq_preprocessing(
    request: FastqPreprocessingInput, cancel: threading.Event
) -> FastqPreprocessingResult:
    bundled = os.environ.get("DNAFORGE_HELPERS_DIR")
    executable = (
        str(Path(bundled) / f"fastp-{get_platform_suffix()}") if bundled else None
    )
    if not bundled and not os.environ.get("WAYPOINT_BINARIES_PATH"):
        executable = shutil.which("fastp")
    if not executable or not Path(executable).is_file():
        raise OperationExecutionError(
            "FASTP_UNAVAILABLE",
            "Paired-read preparation requires fastp 1.4.0 on this execution host. No input was changed or processed.",
        )
    executable = str(Path(executable).resolve(strict=True))
    version = await asyncio.to_thread(
        subprocess.run,
        [executable, "--version"],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    version_text = (version.stdout + version.stderr).strip()
    if version_text != "fastp 1.4.0":
        raise OperationExecutionError(
            "FASTP_VERSION_UNQUALIFIED",
            f"Expected fastp 1.4.0; found {version_text[:100]}. No reads were processed.",
        )
    executable_hash = await asyncio.to_thread(_sha256, Path(executable), cancel)
    cache = Path(
        os.environ.get(
            "DNAFORGE_FASTQ_PREPARATION_CACHE_DIR",
            str(Path.home() / ".dnaforge" / "fastq-preparation"),
        )
    )

    async def prepare(root: Path) -> FastqPreprocessingResult:
        inputs, hashes, count = await asyncio.to_thread(
            _snapshot_pairs, request, root, cancel
        )
        outputs = {
            name: root / f"{name}.fastq.gz"
            for name in (
                "merged",
                "unmerged1",
                "unmerged2",
                "unpaired1",
                "unpaired2",
                "failed",
            )
        }
        report_path = root / "fastp.json"
        trimmed = [root / "trimmed-r1.fastq.gz", root / "trimmed-r2.fastq.gz"]
        common = [
            "--compression",
            "1",
            "--thread",
            str(request.threads),
            "--overlap_len_require",
            str(request.overlap_length),
            "--overlap_diff_limit",
            str(request.overlap_mismatches),
            "--overlap_diff_percent_limit",
            str(request.overlap_mismatch_percent),
            "--disable_trim_poly_g",
            "--dont_eval_duplication",
            "--dont_overwrite",
        ]
        command = [
            executable,
            "--in1",
            str(inputs[0]),
            "--in2",
            str(inputs[1]),
            "--out1",
            str(trimmed[0]),
            "--out2",
            str(trimmed[1]),
            "--unpaired1",
            str(outputs["unpaired1"]),
            "--unpaired2",
            str(outputs["unpaired2"]),
            "--failed_out",
            str(outputs["failed"]),
            "--json",
            str(report_path),
            "--html",
            str(root / "fastp.html"),
            "--qualified_quality_phred",
            str(request.qualified_quality),
            "--unqualified_percent_limit",
            str(request.unqualified_percent),
            "--length_required",
            str(request.minimum_length),
            "--n_base_limit",
            str(request.maximum_n_bases),
            *common,
        ]
        if request.adapter1:
            command.extend(
                [
                    "--adapter_sequence",
                    request.adapter1,
                    "--adapter_sequence_r2",
                    request.adapter2,
                ]
            )
        commands = [command]
        await _execute(command, root, cancel)
        if next(_fastq_records(trimmed[0], cancel), None) is not None:
            merge = [
                executable,
                "--in1",
                str(trimmed[0]),
                "--in2",
                str(trimmed[1]),
                "--merge",
                "--merged_out",
                str(outputs["merged"]),
                "--out1",
                str(outputs["unmerged1"]),
                "--out2",
                str(outputs["unmerged2"]),
                "--json",
                str(root / "merge.json"),
                "--html",
                str(root / "merge.html"),
                "--disable_adapter_trimming",
                "--disable_quality_filtering",
                "--disable_length_filtering",
                *common,
            ]
            commands.append(merge)
            await _execute(merge, root, cancel)
        else:
            for name in ("merged", "unmerged1", "unmerged2"):
                with gzip.open(outputs[name], "xb", compresslevel=1):
                    pass
        artifacts = {}
        for name, path in outputs.items():
            artifacts[name] = await asyncio.to_thread(_artifact, path, cancel)
        if artifacts["unmerged1"].reads != artifacts["unmerged2"].reads:
            raise ValueError(
                "fastp returned unmatched counts in its unmerged pair outputs."
            )
        accepted = artifacts["merged"].reads * 2 + sum(
            artifacts[name].reads
            for name in ("unmerged1", "unmerged2", "unpaired1", "unpaired2")
        )
        rejected = count * 2 - accepted
        if rejected < 0 or artifacts["failed"].reads > rejected:
            raise ValueError(
                "fastp output record counts exceed the validated input count."
            )
        if report_path.stat().st_size > MAX_REPORT_BYTES:
            raise ValueError(
                "fastp report exceeds the supported size. Results were not admitted."
            )
        report = json.loads(report_path.read_bytes())
        if (
            not isinstance(report, dict)
            or report.get("summary", {}).get("before_filtering", {}).get("total_reads")
            != count * 2
        ):
            raise ValueError(
                "fastp report does not match the validated original read count."
            )
        filtering = report.get("filtering_result", {})
        rejected_pair_reads = sum(
            filtering.get(key, 0)
            for key in (
                "low_quality_reads",
                "too_many_N_reads",
                "too_short_reads",
                "too_long_reads",
                "adapter_dimer_reads",
            )
        )
        if (
            rejected_pair_reads
            != rejected + artifacts["unpaired1"].reads + artifacts["unpaired2"].reads
        ):
            raise ValueError(
                "fastp filtering counts do not account for all accepted and rejected reads."
            )
        for mate, path in enumerate(inputs, 1):
            artifacts[f"original{mate}"] = await asyncio.to_thread(
                _artifact, path, cancel
            )
        for path, generation, digest in zip(
            (Path(request.read1_path), Path(request.read2_path)),
            (request.read1_generation, request.read2_generation),
            hashes,
            strict=True,
        ):
            if (
                capture_local_file_generation(path) != generation
                or await asyncio.to_thread(_sha256, path, cancel) != digest
            ):
                raise ValueError(
                    "An original FASTQ changed before completion. Outputs were not admitted."
                )
        if (
            await asyncio.to_thread(_sha256, Path(executable), cancel)
            != executable_hash
        ):
            raise ValueError("The fastp executable changed during processing.")
        native_reports = {}
        for name in ("fastp", "merge")[: len(commands)]:
            native = root / f"{name}.json"
            if native.stat().st_size > MAX_REPORT_BYTES:
                raise ValueError("The native fastp report exceeds the supported size.")
            native_data = json.loads(native.read_bytes())
            expected_reads = (
                count * 2
                if name == "fastp"
                else artifacts["merged"].reads * 2
                + artifacts["unmerged1"].reads
                + artifacts["unmerged2"].reads
            )
            if (
                native_data.get("summary", {})
                .get("before_filtering", {})
                .get("total_reads")
                != expected_reads
            ):
                raise ValueError(
                    "The native fastp report does not match the processed read count."
                )
            native_reports[name] = PreparedFastqReport(
                path=str(native),
                sha256=await asyncio.to_thread(_sha256, native, cancel),
            )
        result = FastqPreprocessingResult(
            inputRevision=fastq_preprocessing_revision(request),
            settings=FastqPreprocessingRequest.model_validate(
                request.model_dump(exclude={"read1_generation", "read2_generation"})
            ),
            inputPairs=count,
            rejectedReads=rejected,
            inputSha256=hashes,
            executablePath=executable,
            executableSha256=executable_hash,
            version=version_text,
            commands=commands,
            outputs=artifacts,
            reportPath=str(report_path),
            reportSha256=await asyncio.to_thread(_sha256, report_path, cancel),
            report=report,
            nativeReports=native_reports,
        )
        (root / "result.json").write_text(result.model_dump_json(by_alias=True))
        for temporary in [
            *trimmed,
            root / "fastp.html",
            root / "merge.html",
            root / "fastp.log",
        ]:
            temporary.unlink(missing_ok=True)
        return result

    return await run_scientific_workspace(cache, "preparation-", cancel, prepare)
