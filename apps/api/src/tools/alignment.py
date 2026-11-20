"""
Sequence Alignment Tool using MAFFT

Provides endpoints for pairwise and multiple sequence alignment using MAFFT,
the gold standard for biological sequence alignment.

Features:
- Pairwise alignment (query vs reference)
- Multiple sequence alignment
- Circular plasmid offset detection
- File-based caching with SHA256 checksums
"""

import asyncio
import hashlib
import json
import logging
import os
import signal
import subprocess
import tempfile
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from types import MappingProxyType
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from ..routes.mcp_auth import check_session
from ..toolbox.builtins import _find_mafft
from .structural import OverallAssessment, StructuralType, analyze_alignment_structure

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tools/alignment", tags=["Sequence Alignment"])


CACHE_DIR = Path("/tmp/waypoint_alignment_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

_MAX_CONCURRENT_MAFFT = 2
_mafft_capacity = threading.BoundedSemaphore(_MAX_CONCURRENT_MAFFT)


class AlignmentCanceled(Exception):
    """Raised after the full MAFFT process group has physically stopped."""


async def _terminate_owned_process(
    proc: asyncio.subprocess.Process,
    communicate_task: asyncio.Task[tuple[bytes, bytes]],
) -> None:
    if os.name == "nt":
        try:
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(proc.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
        except (FileNotFoundError, ProcessLookupError):
            if proc.returncode is None:
                proc.kill()
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    try:
        await asyncio.wait_for(asyncio.shield(communicate_task), timeout=2)
        return
    except asyncio.TimeoutError:
        pass

    if os.name == "nt":
        if proc.returncode is None:
            proc.kill()
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    await communicate_task


async def _acquire_mafft_capacity(
    cancel_event: threading.Event | None,
    deadline: float,
) -> None:
    loop = asyncio.get_running_loop()
    while True:
        if cancel_event is not None and cancel_event.is_set():
            raise AlignmentCanceled("Alignment was canceled before engine entry")
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise asyncio.TimeoutError
        if _mafft_capacity.acquire(blocking=False):
            return
        await asyncio.sleep(min(0.05, remaining))


class AlignmentAlgorithm(str, Enum):
    """Supported alignment algorithms/modes in MAFFT."""

    AUTO = "auto"
    FAST = "fast"
    ACCURATE = "accurate"
    GINSI = "ginsi"
    LINSI = "linsi"
    EINSI = "einsi"


class PairwiseAlignmentRequest(BaseModel):
    """Request model for pairwise sequence alignment."""

    query: str = Field(
        ...,
        min_length=10,
        description="Query sequence (DNA, RNA, or protein)",
    )
    reference: str = Field(
        ...,
        min_length=10,
        description="Reference sequence to align against",
    )
    algorithm: AlignmentAlgorithm = Field(
        AlignmentAlgorithm.AUTO,
        description="MAFFT algorithm mode",
    )
    threads: int = Field(
        4,
        ge=1,
        le=16,
        description="Number of threads for parallel execution",
    )
    use_cache: bool = Field(
        True,
        description="Use cached results if available",
    )
    is_circular: bool = Field(
        False,
        description="Whether the reference is circular (e.g., plasmid). If true, aligns against doubled reference to find origin-spanning alignments.",
    )

    @field_validator("query", "reference")
    @classmethod
    def validate_sequence(cls, v: str) -> str:
        """Validate and clean sequence."""
        cleaned = "".join(v.split()).upper()
        valid_bases = set("ATCGUNRYKMSWBDHV-")
        invalid = set(cleaned) - valid_bases
        if invalid:
            raise ValueError(f"Invalid characters: {invalid}")
        return cleaned


def _validate_fasta_id(seq_id: object, index: int) -> None:
    """Reject an `id` that could splice a bogus record into the FASTA input
    written for MAFFT (a bare newline or leading '>' forges a second header
    line, corrupting record boundaries in the alignment output)."""
    if (
        not isinstance(seq_id, str)
        or "\n" in seq_id
        or "\r" in seq_id
        or seq_id.startswith(">")
    ):
        raise ValueError(
            f"Sequence {index}'s 'id' must not contain newlines or start with '>'"
        )


class MultipleAlignmentRequest(BaseModel):
    """Request model for multiple sequence alignment."""

    sequences: list[dict] = Field(
        ...,
        min_length=2,
        description="List of sequences with 'id' and 'sequence' fields",
    )
    algorithm: AlignmentAlgorithm = Field(
        AlignmentAlgorithm.AUTO,
        description="MAFFT algorithm mode",
    )
    threads: int = Field(
        4,
        ge=1,
        le=16,
        description="Number of threads for parallel execution",
    )

    @field_validator("sequences")
    @classmethod
    def validate_sequences(cls, v: list[dict]) -> list[dict]:
        """Validate sequence list format."""
        valid_bases = set("ATCGUNRYKMSWBDHV-")
        for i, seq_dict in enumerate(v):
            if "id" not in seq_dict or "sequence" not in seq_dict:
                raise ValueError(f"Sequence {i} must have 'id' and 'sequence' fields")
            _validate_fasta_id(seq_dict["id"], i)
            cleaned = "".join(seq_dict["sequence"].split()).upper()
            invalid = set(cleaned) - valid_bases
            if invalid:
                raise ValueError(
                    f"Sequence {seq_dict['id']} has invalid characters: {invalid}"
                )
            seq_dict["sequence"] = cleaned
        return v


PROTEIN_ALPHABET = set("ACDEFGHIKLMNPQRSTVWYX*-")


def _enforce_alignment_session(session_token: str | None) -> None:
    """ slice 2.3 — gate the protein multi-alignment route behind the
    same X-DNAForge-Session contract /mcp/call and /external/* use (mirrors
    routes/external.py's `_enforce_session`). Unlike `/multiple` (DNA/RNA,
    called unauthenticated by the manual Alignment Manager UI today), this
    route is called only by the run_msa AI tool and must not be left open.
    """
    err = check_session(session_token)
    if err is None:
        return
    error = err["error"]
    code = error.get("code", "BAD_SESSION")
    status_code = (
        status.HTTP_500_INTERNAL_SERVER_ERROR
        if code == "MCP_SESSION_NOT_CONFIGURED"
        else status.HTTP_401_UNAUTHORIZED
    )
    raise HTTPException(status_code=status_code, detail=error)


class ProteinMultipleAlignmentRequest(BaseModel):
    """Request model for PROTEIN multiple sequence alignment ."""

    sequences: list[dict] = Field(
        ...,
        min_length=2,
        description="List of protein sequences with 'id' and 'sequence' fields",
    )
    algorithm: AlignmentAlgorithm = Field(
        AlignmentAlgorithm.AUTO,
        description="MAFFT algorithm mode",
    )
    threads: int = Field(
        4,
        ge=1,
        le=16,
        description="Number of threads for parallel execution",
    )

    @field_validator("sequences")
    @classmethod
    def validate_protein_sequences(cls, v: list[dict]) -> list[dict]:
        """Validate protein sequence list format (20 AA + X/*/gap, never DNA/RNA)."""
        for i, seq_dict in enumerate(v):
            if "id" not in seq_dict or "sequence" not in seq_dict:
                raise ValueError(f"Sequence {i} must have 'id' and 'sequence' fields")
            _validate_fasta_id(seq_dict["id"], i)
            cleaned = "".join(seq_dict["sequence"].split()).upper()
            invalid = set(cleaned) - PROTEIN_ALPHABET
            if invalid:
                raise ValueError(
                    f"Sequence {seq_dict['id']} has invalid amino-acid characters: {invalid}"
                )
            seq_dict["sequence"] = cleaned
        return v


class MutationInfo(BaseModel):
    """Information about a single mutation."""

    type: str = Field(..., description="substitution, insertion, or deletion")
    position: int = Field(..., description="1-indexed position in reference")
    length: int = Field(1, description="Length of mutation")
    ref_base: Optional[str] = Field(None, description="Reference base(s)")
    query_base: Optional[str] = Field(None, description="Query base(s)")


class AlignmentResult(BaseModel):
    """Result of a pairwise alignment."""

    aligned_query: str = Field(..., description="Aligned query with gap characters")
    aligned_reference: str = Field(
        ..., description="Aligned reference with gap characters"
    )
    identity: float = Field(..., description="Percent identity (0-100)")
    matches: int = Field(..., description="Number of matching positions")
    mismatches: int = Field(..., description="Number of mismatched positions")
    gaps: int = Field(..., description="Total gap characters")
    alignment_length: int = Field(..., description="Length of alignment including gaps")
    query_length: int = Field(..., description="Original query length")
    reference_length: int = Field(..., description="Original reference length")
    mutations: list[MutationInfo] = Field(
        default_factory=list, description="List of mutations"
    )
    cached: bool = Field(False, description="Whether result was from cache")
    circular_offset: int = Field(
        0, description="For circular references, the offset where alignment starts"
    )
    analysis: Optional[dict[str, Any]] = Field(
        None, description="Structural analysis results"
    )


class MultipleAlignmentResult(BaseModel):
    """Result of a multiple sequence alignment."""

    aligned_sequences: list[dict] = Field(..., description="List of aligned sequences")
    alignment_length: int = Field(..., description="Length of alignment")
    num_sequences: int = Field(..., description="Number of sequences")


def compute_checksum(*args: str) -> str:
    """Compute SHA256 checksum of concatenated strings."""
    combined = "".join(args)
    return hashlib.sha256(combined.encode()).hexdigest()


def get_cached_alignment(cache_key: str) -> Optional[dict]:
    """Retrieve cached alignment if exists."""
    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with open(cache_file, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return None


def save_to_cache(cache_key: str, result: dict) -> None:
    """Save alignment result to cache."""
    cache_file = CACHE_DIR / f"{cache_key}.json"
    try:
        with open(cache_file, "w") as f:
            json.dump(result, f)
    except IOError:
        pass


def get_mafft_args(algorithm: AlignmentAlgorithm, threads: int) -> list[str]:
    """Get MAFFT command line arguments for algorithm."""
    base_args = ["mafft", "--quiet", "--thread", str(threads)]

    if algorithm == AlignmentAlgorithm.FAST:
        base_args.extend(["--retree", "1"])
    elif algorithm == AlignmentAlgorithm.ACCURATE:
        base_args.append("--localpair")
    elif algorithm == AlignmentAlgorithm.GINSI:
        base_args.append("--globalpair")
    elif algorithm == AlignmentAlgorithm.LINSI:
        base_args.append("--localpair")
    elif algorithm == AlignmentAlgorithm.EINSI:
        base_args.append("--genafpair")

    return base_args


@dataclass(frozen=True)
class MafftRuntime:
    executable: str
    environment: Mapping[str, str]


def resolve_mafft_runtime() -> MafftRuntime:
    """Resolve one launcher and its binaries for an entire managed execution."""

    executable = _find_mafft()
    if executable is None:
        raise FileNotFoundError("MAFFT not installed. Please install MAFFT.")
    environment = dict(os.environ)
    mafftdir = Path(executable).parent.parent
    libexec = mafftdir / "libexec"
    if mafftdir.name == "mafftdir" and (libexec / "version").is_file():
        environment["MAFFT_BINARIES"] = str(libexec)
    return MafftRuntime(executable, MappingProxyType(environment))


async def run_mafft(
    mafft_args: list[str],
    timeout_seconds: float,
    cancel_event: threading.Event | None = None,
    *,
    runtime: MafftRuntime | None = None,
    deadline: float | None = None,
    subprocess_timeout_seconds: float | None = None,
) -> tuple[str, str]:
    """Run MAFFT with total-budget admission and optional subprocess ceiling."""
    mafft_env = None
    if mafft_args and mafft_args[0] == "mafft":
        resolved = runtime or resolve_mafft_runtime()
        mafft_args = [resolved.executable, *mafft_args[1:]]
        mafft_env = resolved.environment
    loop = asyncio.get_running_loop()
    if deadline is None:
        deadline = loop.time() + timeout_seconds
    await _acquire_mafft_capacity(cancel_event, deadline)
    proc: asyncio.subprocess.Process | None = None
    communicate_task: asyncio.Task[tuple[bytes, bytes]] | None = None

    try:
        if cancel_event is not None and cancel_event.is_set():
            raise AlignmentCanceled("Alignment was canceled before engine entry")
        if subprocess_timeout_seconds is not None:
            deadline = min(deadline, loop.time() + subprocess_timeout_seconds)
        if loop.time() >= deadline:
            raise asyncio.TimeoutError
        process_options = (
            {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
            if os.name == "nt"
            else {"start_new_session": True}
        )
        proc = await asyncio.create_subprocess_exec(
            *mafft_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(mafft_env) if mafft_env is not None else None,
            **process_options,
        )
        communicate_task = asyncio.create_task(proc.communicate())
        while not communicate_task.done():
            if cancel_event is not None and cancel_event.is_set():
                await _terminate_owned_process(proc, communicate_task)
                raise AlignmentCanceled("Alignment was canceled")
            remaining = deadline - loop.time()
            if remaining <= 0:
                await _terminate_owned_process(proc, communicate_task)
                raise asyncio.TimeoutError
            await asyncio.wait({communicate_task}, timeout=min(0.05, remaining))
        stdout_bytes, stderr_bytes = await communicate_task
    except asyncio.CancelledError:
        if proc is not None and communicate_task is not None:
            await _terminate_owned_process(proc, communicate_task)
        raise
    finally:
        _mafft_capacity.release()

    stdout = stdout_bytes.decode() if stdout_bytes else ""
    stderr = stderr_bytes.decode() if stderr_bytes else ""
    if proc.returncode != 0:
        raise subprocess.CalledProcessError(
            proc.returncode,
            mafft_args,
            output=stdout,
            stderr=stderr,
        )
    return stdout, stderr


async def read_mafft_version(
    runtime: MafftRuntime,
    *,
    deadline: float,
    cancel_event: threading.Event,
) -> str:
    stdout, stderr = await run_mafft(
        ["mafft", "--version"],
        timeout_seconds=max(0, deadline - asyncio.get_running_loop().time()),
        cancel_event=cancel_event,
        runtime=runtime,
        deadline=deadline,
        subprocess_timeout_seconds=5,
    )
    lines = {
        line.strip()
        for output in (stdout, stderr)
        for line in output.splitlines()
        if line.strip()
    }
    if len(lines) != 1:
        raise ValueError("MAFFT did not report one version line")
    return lines.pop()


def unresolved_alignment_columns(aligned_query: str, aligned_ref: str) -> set[int]:
    """Missing ends and ambiguous calls do not establish matches or mutations."""
    first = len(aligned_query) - len(aligned_query.lstrip("-"))
    last = len(aligned_query.rstrip("-"))
    return {
        col
        for col, (query, ref) in enumerate(
            zip(aligned_query.upper(), aligned_ref.upper(), strict=True)
        )
        if col < first or col >= last or query not in "ACGTU-" or ref not in "ACGTU-"
    }


def analyze_alignment(aligned_query: str, aligned_ref: str) -> dict:
    """
    Analyze alignment to extract statistics and mutations.

    Returns dict with matches, mismatches, gaps, identity, and mutations list.
    """
    matches = 0
    mismatches = 0
    gaps = 0
    mutations = []
    unresolved = unresolved_alignment_columns(aligned_query, aligned_ref)

    ref_pos = 1

    i = 0
    while i < len(aligned_ref):
        ref_base = aligned_ref[i]
        query_base = aligned_query[i]

        if i in unresolved and ref_base != "-":
            ref_pos += int(ref_base != "-")
            i += 1
            continue

        if ref_base == "-":

            insertion_seq = query_base
            j = i + 1
            while j < len(aligned_ref) and aligned_ref[j] == "-":
                insertion_seq += aligned_query[j]
                j += 1

            if not any(col in unresolved for col in range(i, j)):
                mutations.append(
                    MutationInfo(
                        type="insertion",
                        position=ref_pos,
                        length=len(insertion_seq),
                        query_base=insertion_seq,
                    )
                )
                gaps += len(insertion_seq)
            i = j
            continue

        elif query_base == "-":

            deletion_seq = ref_base
            j = i + 1
            while (
                j < len(aligned_ref) and aligned_query[j] == "-" and j not in unresolved
            ):
                deletion_seq += aligned_ref[j]
                j += 1
            mutations.append(
                MutationInfo(
                    type="deletion",
                    position=ref_pos,
                    length=len(deletion_seq),
                    ref_base=deletion_seq,
                )
            )
            gaps += len(deletion_seq)
            ref_pos += len(deletion_seq)
            i = j
            continue

        elif ref_base.upper() != query_base.upper():

            mutations.append(
                MutationInfo(
                    type="substitution",
                    position=ref_pos,
                    ref_base=ref_base,
                    query_base=query_base,
                )
            )
            mismatches += 1
            ref_pos += 1

        else:

            matches += 1
            ref_pos += 1

        i += 1

    total = matches + mismatches + gaps
    identity = (matches / total * 100) if total > 0 else 0

    return {
        "matches": matches,
        "mismatches": mismatches,
        "gaps": gaps,
        "identity": identity,
        "mutations": mutations,
    }


def _find_column_for_position(ref_position: int, aligned_ref: str) -> int:
    """
    Find the column index in the aligned reference for a given reference position.

    Args:
        ref_position: 1-indexed position in the ungapped reference
        aligned_ref: The aligned reference string (with gaps)

    Returns:
        0-indexed column in the alignment
    """
    ref_pos = 0
    for col, base in enumerate(aligned_ref):
        if base != "-":
            ref_pos += 1
            if ref_pos == ref_position:
                return col
    return len(aligned_ref) - 1


def trim_circular_alignment(
    aligned_query: str, aligned_ref: str, original_ref_length: int
) -> tuple[str, str, int]:
    """
    Trim a circular alignment to the relevant region.

    When aligning against a doubled circular reference (ref+ref), find where the
    query actually aligns and return just that portion, plus the offset into the
    original circular sequence.

    Returns: (trimmed_query, trimmed_ref, circular_offset)
    """

    first_query_pos = None
    last_query_pos = None
    for i, c in enumerate(aligned_query):
        if c != "-":
            if first_query_pos is None:
                first_query_pos = i
            last_query_pos = i

    if first_query_pos is None:

        return aligned_query, aligned_ref, 0

    ref_pos = 0
    for i in range(first_query_pos):
        if aligned_ref[i] != "-":
            ref_pos += 1

    circular_offset = ref_pos % original_ref_length

    trimmed_query = aligned_query[first_query_pos : last_query_pos + 1]
    trimmed_ref = aligned_ref[first_query_pos : last_query_pos + 1]

    if len(trimmed_ref.replace("-", "")) > original_ref_length:
        gap_start = 0
        gap_reference_bases = 0
        for index, query_base in enumerate(trimmed_query):
            if query_base != "-":
                gap_start = index + 1
                gap_reference_bases = 0
                continue
            if trimmed_ref[index] != "-":
                gap_reference_bases += 1
            if gap_reference_bases == original_ref_length:
                trimmed_query = trimmed_query[:gap_start] + trimmed_query[index + 1 :]
                trimmed_ref = trimmed_ref[:gap_start] + trimmed_ref[index + 1 :]
                break

    return trimmed_query, trimmed_ref, circular_offset


def canonicalize_complete_circular_alignment(
    query: str, reference: str, offset: int, reference_length: int
) -> tuple[str, str, int]:
    """Put a complete circular clone back in the reference's coordinate order.

    Partial reads retain their offset. Rotating those would incorrectly imply
    that the unobserved part of the reference had been sequenced.
    """
    if not offset or len(reference.replace("-", "")) != reference_length:
        return query, reference, offset
    remaining = reference_length - offset
    split = 0
    for index, base in enumerate(reference):
        if base != "-":
            remaining -= 1
        if remaining == 0:
            split = index + 1
            break
    while split < len(reference) and reference[split] == "-":
        split += 1
    return query[split:] + query[:split], reference[split:] + reference[:split], 0


async def _execute_pairwise_alignment(
    request: PairwiseAlignmentRequest,
    *,
    timeout_seconds: float = 300,
    cancel_event: threading.Event | None = None,
    runtime: MafftRuntime | None = None,
    deadline: float | None = None,
) -> AlignmentResult:
    """
    Perform pairwise sequence alignment using MAFFT.

    Aligns a query sequence against a reference sequence and returns:
    - Aligned sequences with gap characters
    - Identity percentage
    - Mutation list (substitutions, insertions, deletions)

    For circular references (is_circular=True), the reference is doubled to allow
    alignments that span the origin. The best alignment position is detected and
    coordinates are adjusted accordingly.

    Results are cached by sequence checksum for fast repeated requests.
    """
    started_at = asyncio.get_running_loop().time()

    query = request.query
    reference = request.reference
    original_ref_length = len(reference)

    if request.is_circular:
        reference = reference + reference

    if request.use_cache:
        cache_key = compute_checksum(
            "pairwise-v6-circular-mutation-columns",
            query,
            reference,
            request.algorithm.value,
            str(request.is_circular),
        )
        cached = get_cached_alignment(cache_key)
        if cached:
            return AlignmentResult(**cached, cached=True)

    with tempfile.TemporaryDirectory() as temp_dir:
        input_file = Path(temp_dir) / "input.fasta"

        with open(input_file, "w") as f:
            f.write(f">reference\n{reference}\n")
            f.write(f">query\n{query}\n")

        mafft_args = get_mafft_args(request.algorithm, request.threads)

        mafft_args.append(
            "--adjustdirection"
            if request.algorithm in (AlignmentAlgorithm.AUTO, AlignmentAlgorithm.FAST)
            else "--adjustdirectionaccurately"
        )
        mafft_args.append(str(input_file))

        try:
            stdout, _stderr = await run_mafft(
                mafft_args,
                timeout_seconds=timeout_seconds,
                cancel_event=cancel_event,
                **(
                    {"runtime": runtime, "deadline": deadline}
                    if runtime is not None
                    else {}
                ),
            )
        except asyncio.TimeoutError as e:
            raise HTTPException(
                status_code=504,
                detail="Alignment timed out. Try a shorter sequence or faster algorithm.",
            ) from e
        except subprocess.CalledProcessError as e:
            raise HTTPException(
                status_code=500,
                detail=f"MAFFT error: {e.stderr}",
            ) from e
        except FileNotFoundError as e:
            raise HTTPException(
                status_code=500,
                detail="MAFFT not installed. Please install MAFFT.",
            ) from e
        except HTTPException:
            raise

        aligned_query = ""
        aligned_reference = ""
        current_seq = None

        for line in stdout.strip().split("\n"):
            if line.startswith(">"):
                current_seq = "query" if "query" in line.lower() else "reference"
            elif current_seq:
                if current_seq == "query":
                    aligned_query += line.strip()
                else:
                    aligned_reference += line.strip()

        if not aligned_query or not aligned_reference:
            raise HTTPException(
                status_code=500,
                detail="Failed to parse MAFFT output",
            )

    circular_offset = 0
    if request.is_circular:

        aligned_query, aligned_reference, circular_offset = trim_circular_alignment(
            aligned_query, aligned_reference, original_ref_length
        )
        if len(aligned_reference.replace("-", "")) > original_ref_length:
            remaining = timeout_seconds - (
                asyncio.get_running_loop().time() - started_at
            )
            if deadline is not None:
                remaining = min(remaining, deadline - asyncio.get_running_loop().time())
            if remaining <= 0:
                raise HTTPException(status_code=504, detail="Alignment timed out.")
            result = await _execute_pairwise_alignment(
                request.model_copy(update={"is_circular": False, "use_cache": False}),
                timeout_seconds=remaining,
                cancel_event=cancel_event,
                runtime=runtime,
                deadline=deadline,
            )
            if result.analysis is not None:
                result.analysis.setdefault("warnings", []).append(
                    {
                        "type": "circular_alignment_recomputed",
                        "message": "Circular placement crossed the reference more than once. The comparison uses one reference copy; review origin-spanning changes.",
                        "severity": "info",
                    }
                )
                if result.analysis["overall_assessment"]["result"] == "PASS":
                    result.analysis["overall_assessment"] = {
                        "result": "REVIEW",
                        "reason": "Circular placement needs review before the full clone can be verified.",
                    }
            if request.use_cache:
                save_to_cache(cache_key, result.model_dump(exclude={"cached"}))
            return result
        aligned_query, aligned_reference, circular_offset = (
            canonicalize_complete_circular_alignment(
                aligned_query, aligned_reference, circular_offset, original_ref_length
            )
        )

    analysis = analyze_alignment(aligned_query, aligned_reference)

    mutations = analysis["mutations"]
    mutations_for_structural = [
        {
            "type": m.type,
            "position": m.position,
            "column": _find_column_for_position(m.position, aligned_reference),
            "length": m.length,
            "ref_base": m.ref_base,
            "query_base": m.query_base,
        }
        for m in mutations
    ]
    try:
        structural_analysis = analyze_alignment_structure(
            aligned_reference,
            aligned_query,
            mutations_for_structural,
            ignored_columns=unresolved_alignment_columns(
                aligned_query, aligned_reference
            ),
        )
        if unresolved_alignment_columns(aligned_query, aligned_reference):
            if (
                structural_analysis["overall_assessment"]["result"]
                == OverallAssessment.PASS
            ):
                structural_analysis["overall_assessment"] = {
                    "result": OverallAssessment.REVIEW,
                    "reason": "Sequence is incomplete or ambiguous; the full clone cannot be verified.",
                }
            structural_analysis["warnings"].append(
                {
                    "type": "incomplete_sequence",
                    "message": "Unsequenced ends and ambiguous bases are unresolved, not definite mutations.",
                    "severity": "info",
                }
            )
    except Exception as e:

        logger.warning("Structural analysis failed: %s", e, exc_info=True)
        structural_analysis = {
            "structural_regions": [],
            "point_mutations": [],
            "warnings": [f"Structural analysis error: {e}"],
            "overall_assessment": {
                "result": "REVIEW",
                "reason": f"Structural analysis error: {e}",
            },
            "quality_trim": {"start": 0, "end": 0},
            "homopolymer_regions": [],
        }

    if circular_offset:
        def reference_position(local_position: int) -> int:
            return (local_position - 1 + circular_offset) % original_ref_length + 1

        for mutation in mutations:
            mutation.position = reference_position(mutation.position)
        for point in structural_analysis["point_mutations"]:
            point["position"] = mutations[point["index"]].position
        for region in structural_analysis["structural_regions"]:
            for endpoint in ("ref_start", "ref_end"):
                if region[endpoint] is not None:
                    region[endpoint] = reference_position(region[endpoint])

    def serialize_analysis(obj):
        if isinstance(obj, dict):
            return {k: serialize_analysis(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [serialize_analysis(item) for item in obj]
        elif isinstance(obj, (StructuralType, OverallAssessment)):
            return obj.value
        else:
            return obj

    serialized_analysis = serialize_analysis(structural_analysis)

    result_data = {
        "aligned_query": aligned_query,
        "aligned_reference": aligned_reference,
        "identity": round(analysis["identity"], 2),
        "matches": analysis["matches"],
        "mismatches": analysis["mismatches"],
        "gaps": analysis["gaps"],
        "alignment_length": len(aligned_query),
        "query_length": len(request.query),
        "reference_length": original_ref_length,
        "mutations": [m.model_dump() for m in mutations],
        "circular_offset": circular_offset,
        "analysis": serialized_analysis,
    }

    if request.use_cache:
        save_to_cache(cache_key, result_data)

    return AlignmentResult(**result_data, cached=False)


@router.post(
    "/pairwise", response_model=AlignmentResult, operation_id="pairwiseAlignment"
)
async def pairwise_alignment(request: PairwiseAlignmentRequest) -> AlignmentResult:
    """
    Perform pairwise sequence alignment using MAFFT.

    Aligns a query sequence against a reference sequence and returns:
    - Aligned sequences with gap characters
    - Identity percentage
    - Mutation list (substitutions, insertions, deletions)

    For circular references (is_circular=True), the reference is doubled to allow
    alignments that span the origin. The best alignment position is detected and
    coordinates are adjusted accordingly.

    Results are cached by sequence checksum for fast repeated requests.
    """
    return await _execute_pairwise_alignment(request)


async def _execute_multiple_alignment(
    sequences: list[dict],
    algorithm: AlignmentAlgorithm,
    threads: int,
    *,
    timeout_seconds: int = 600,
    cancel_event: threading.Event | None = None,
) -> MultipleAlignmentResult:
    """Shared MAFFT multiple-alignment core. Used by BOTH the DNA/RNA route
    (`/multiple`, unauthenticated, the manual Alignment Manager UI) and the
    protein route (`/multiple-protein`, session-gated,  run_msa tool).
    MAFFT itself is alphabet-agnostic — only the request-level Pydantic
    validators differ per route (see `PROTEIN_ALPHABET` above).
    """
    with tempfile.TemporaryDirectory() as temp_dir:
        input_file = Path(temp_dir) / "input.fasta"

        with open(input_file, "w") as f:
            for seq in sequences:
                f.write(f">{seq['id']}\n{seq['sequence']}\n")

        mafft_args = get_mafft_args(algorithm, threads)
        mafft_args.append(str(input_file))

        try:
            stdout, _stderr = await run_mafft(
                mafft_args,
                timeout_seconds=timeout_seconds,
                cancel_event=cancel_event,
            )
        except AlignmentCanceled:
            raise
        except asyncio.TimeoutError as e:
            raise HTTPException(
                status_code=504,
                detail="Alignment timed out. Try fewer sequences or faster algorithm.",
            ) from e
        except subprocess.CalledProcessError as e:
            raise HTTPException(
                status_code=500,
                detail=f"MAFFT error: {(e.stderr or '')[:1000]}",
            ) from e
        except FileNotFoundError as e:
            raise HTTPException(
                status_code=500,
                detail="MAFFT not installed. Please install MAFFT.",
            ) from e
        except HTTPException:
            raise

        aligned_sequences = []
        names_by_id = {
            str(sequence["id"]): sequence.get("name") for sequence in sequences
        }

        def append_aligned_sequence(sequence_id: str, sequence: str) -> None:
            record = {"id": sequence_id, "sequence": sequence}
            name = names_by_id.get(sequence_id)
            if name is not None:
                record["name"] = name
            aligned_sequences.append(record)

        current_id = None
        current_seq = ""

        for line in stdout.strip().split("\n"):
            if line.startswith(">"):
                if current_id is not None:
                    append_aligned_sequence(current_id, current_seq)
                current_id = line[1:].strip()
                current_seq = ""
            else:
                current_seq += line.strip()

        if current_id is not None:
            append_aligned_sequence(current_id, current_seq)

        if not aligned_sequences:
            raise HTTPException(
                status_code=500,
                detail="Failed to parse MAFFT output",
            )

        alignment_length = (
            len(aligned_sequences[0]["sequence"]) if aligned_sequences else 0
        )

    return MultipleAlignmentResult(
        aligned_sequences=aligned_sequences,
        alignment_length=alignment_length,
        num_sequences=len(aligned_sequences),
    )


@router.post(
    "/multiple",
    response_model=MultipleAlignmentResult,
    operation_id="multipleAlignment",
)
async def multiple_alignment(
    request: MultipleAlignmentRequest,
) -> MultipleAlignmentResult:
    """
    Perform multiple sequence alignment using MAFFT.

    Aligns multiple sequences and returns aligned sequences with gaps.
    """
    return await _execute_multiple_alignment(
        request.sequences, request.algorithm, request.threads
    )


@router.post(
    "/multiple-protein",
    response_model=MultipleAlignmentResult,
    operation_id="multipleProteinAlignment",
)
async def multiple_protein_alignment(
    request: ProteinMultipleAlignmentRequest,
    x_dnaforge_session: str | None = Header(default=None, alias="X-DNAForge-Session"),
) -> MultipleAlignmentResult:
    """
    Perform multiple sequence alignment for PROTEIN sequences using MAFFT
     `run_msa` tool).

    Session-gated: unlike `/multiple` (DNA/RNA, called unauthenticated by the
    manual Alignment Manager UI), this route is called only by the run_msa AI
    tool and requires a valid X-DNAForge-Session header.

    Error shape note: session-gate failures (401/500, via
    `_enforce_alignment_session`) return a dict `detail` (`{code, message}`),
    matching every other session-gated route's convention (see
    `routes/external.py`'s `_enforce_session`). MAFFT-failure errors (504/500,
    via the shared `_execute_multiple_alignment` core) return a plain string
    `detail`, matching this route's own alignment-error convention. Callers
    must handle both shapes — `run_msa`'s `describeAlignmentFailure`
    (apps/desktop/src/features/ai/tools/run-msa.ts) already does.
    """
    _enforce_alignment_session(x_dnaforge_session)
    return await _execute_multiple_alignment(
        request.sequences, request.algorithm, request.threads
    )


@router.get("/algorithms", operation_id="getAlgorithms")
async def get_algorithms() -> dict:
    """
    Get available alignment algorithms and their descriptions.
    """
    return {
        "algorithms": [
            {
                "id": AlignmentAlgorithm.AUTO.value,
                "name": "Auto",
                "description": "Let MAFFT choose the best algorithm based on input size",
            },
            {
                "id": AlignmentAlgorithm.FAST.value,
                "name": "Fast",
                "description": "FFT-NS-2: Fast progressive method, good for large datasets",
            },
            {
                "id": AlignmentAlgorithm.ACCURATE.value,
                "name": "Accurate",
                "description": "L-INS-i: Accurate but slow, best for small datasets",
            },
            {
                "id": AlignmentAlgorithm.GINSI.value,
                "name": "G-INS-i",
                "description": "Global alignment with iterative refinement",
            },
            {
                "id": AlignmentAlgorithm.LINSI.value,
                "name": "L-INS-i",
                "description": "Local alignment with iterative refinement",
            },
            {
                "id": AlignmentAlgorithm.EINSI.value,
                "name": "E-INS-i",
                "description": "Multiple domain alignment with large gaps",
            },
        ]
    }


class CacheDeleteRequest(BaseModel):
    """Request model for deleting a specific cache entry."""

    query: str = Field(..., description="Query sequence used in alignment")
    reference: str = Field(..., description="Reference sequence used in alignment")
    algorithm: AlignmentAlgorithm = Field(default=AlignmentAlgorithm.AUTO)
    is_circular: bool = Field(default=False)


@router.delete("/cache")
async def delete_cache_entry(request: CacheDeleteRequest) -> dict:
    """
    Delete a specific cached alignment result.

    Use this when removing an alignment session to ensure subsequent
    alignments use fresh data instead of stale cache.
    """

    reference = request.reference
    if request.is_circular:
        reference = reference + reference

    cache_key = compute_checksum(
        request.query, reference, request.algorithm.value, str(request.is_circular)
    )
    cache_file = CACHE_DIR / f"{cache_key}.json"

    if cache_file.exists():
        try:
            cache_file.unlink()
            return {"deleted": True, "cache_key": cache_key}
        except IOError as e:
            return {"deleted": False, "error": str(e), "cache_key": cache_key}
    else:
        return {"deleted": False, "reason": "not_found", "cache_key": cache_key}


@router.delete("/cache/all")
async def clear_all_cache() -> dict:
    """
    Clear all cached alignment results.

    Use sparingly - this removes all cached alignments for all users.
    """
    deleted_count = 0
    errors = []

    for cache_file in CACHE_DIR.glob("*.json"):
        try:
            cache_file.unlink()
            deleted_count += 1
        except IOError as e:
            errors.append(str(e))

    return {
        "deleted_count": deleted_count,
        "errors": errors if errors else None,
    }


@router.get("/health", operation_id="alignmentHealth")
async def alignment_health() -> dict:
    """
    Check if MAFFT is available and working.
    """
    try:
        stdout, stderr = await run_mafft(
            ["mafft", "--version"],
            timeout_seconds=5,
        )
        version_text = stderr or stdout
        version = version_text.strip() if version_text else "unknown"
        return {
            "status": "ok",
            "mafft_available": True,
            "mafft_version": version,
        }
    except (asyncio.TimeoutError, FileNotFoundError, subprocess.CalledProcessError):
        return {
            "status": "degraded",
            "mafft_available": False,
            "mafft_version": None,
            "message": "MAFFT not installed or not accessible",
        }
