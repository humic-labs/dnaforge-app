"""Shell-out path to the Rust `dna-coverage` helper.

This helper is for exact local coverage tiles only. Broad overview coverage must
come from the resident pyramid path; it must not be hidden behind foreground BAM
scans, no matter how fast the scanner is.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
from functools import lru_cache
from pathlib import Path
from typing import NotRequired, Optional, TypedDict


class DnaCoverageError(Exception):
    """Raised when the Rust coverage helper fails."""

    def __init__(self, code: str, message: str, context: Optional[dict] = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.context = context or {}


class DnaCoverageNotFoundError(DnaCoverageError):
    """The helper binary is not available in any supported location."""

    def __init__(self, searched: list[Path]):
        super().__init__(
            "BINARY_NOT_FOUND",
            "dna-coverage binary not found",
            {"searched": [str(path) for path in searched]},
        )


class CoverageTileResult(TypedDict):
    chrom: str
    start: int
    end: int
    bins: list[float]
    binSize: int
    maxDepth: float
    provenance: dict


class BaseLayerResult(TypedDict):
    alignedBaseCount: NotRequired[int]
    meanDepth: NotRequired[float]
    chrom: str
    chromLength: int
    baseBins: int
    baseBinBp: int
    maxDepth: float
    outPath: str
    provenance: dict


SUPPORTED_SCHEMA_VERSIONS = frozenset({2})
REQUIRED_COMMAND_FLAGS = {
    "tile": ("--bin-size",),
    "build-base": ("--threads",),
}


def _host_suffix() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "darwin":
        if machine in ("arm64", "aarch64"):
            return "aarch64-apple-darwin"
        try:
            proc = subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                capture_output=True,
                text=True,
                timeout=2,
            )
            if proc.returncode == 0 and "Apple" in proc.stdout:
                return "aarch64-apple-darwin"
        except (OSError, subprocess.TimeoutExpired):
            pass
        return "x86_64-apple-darwin"
    if system == "linux":
        return "x86_64-unknown-linux-musl"
    raise DnaCoverageError(
        "UNSUPPORTED_PLATFORM",
        f"dna-coverage not built for {system}/{machine}",
    )


def _find_repo_root() -> Optional[Path]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "Cargo.toml").is_file() and (
            parent / "tools" / "dna-coverage"
        ).is_dir():
            return parent
    return None


def _runtime_tools_dir(helper_suffix: str) -> Path:
    if base := os.environ.get("WAYPOINT_DATA_DIR"):
        root = Path(base)
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Application Support" / "Waypoint"
    elif os.name == "nt":
        root = (
            Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
            / "Waypoint"
        )
    else:
        root = (
            Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
            / "waypoint"
        )

    suffixes = [helper_suffix]
    if helper_suffix.endswith("-unknown-linux-musl"):
        suffixes.append(
            helper_suffix.replace("-unknown-linux-musl", "-unknown-linux-gnu")
        )
    for suffix in suffixes:
        tools_dir = root / "tools" / suffix
        if tools_dir.is_dir():
            return tools_dir
    return root / "tools" / suffixes[0]


def find_dna_coverage_binary() -> Path:
    if env := os.environ.get("DNA_COVERAGE_PATH"):
        path = Path(env)
        if path.is_file() and os.access(path, os.X_OK):
            return path
        raise DnaCoverageNotFoundError([path])

    suffix = _host_suffix()
    candidates: list[Path] = []
    if helpers_dir := os.environ.get("DNAFORGE_HELPERS_DIR"):
        candidates.append(Path(helpers_dir) / f"dna-coverage-{suffix}")

    repo_root = _find_repo_root()
    if repo_root is not None:
        candidates.append(
            repo_root
            / "apps"
            / "desktop"
            / "resources"
            / "helpers"
            / f"dna-coverage-{suffix}"
        )
        candidates.append(repo_root / "target" / "release" / "dna-coverage")

    candidates.append(_runtime_tools_dir(suffix) / "dna-coverage")

    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise DnaCoverageNotFoundError(candidates)


def check_binary_compatibility(binary: Path) -> int:
    proc = subprocess.run(
        [str(binary), "schema-version"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    if proc.returncode != 0:
        raise DnaCoverageError(
            "BINARY_NOT_FOUND",
            f"dna-coverage schema-version exited {proc.returncode}: {proc.stderr.strip()}",
        )
    parts = proc.stdout.strip().split()
    schema = None
    for i, token in enumerate(parts):
        if token == "schema" and i + 1 < len(parts):
            try:
                schema = int(parts[i + 1])
            except ValueError:
                pass
            break
    if schema is None:
        raise DnaCoverageError(
            "VERSION_MISMATCH",
            f"could not parse schema version from: {proc.stdout.strip()!r}",
        )
    if schema not in SUPPORTED_SCHEMA_VERSIONS:
        raise DnaCoverageError(
            "VERSION_MISMATCH",
            f"dna-coverage reports schema {schema}, sidecar supports {sorted(SUPPORTED_SCHEMA_VERSIONS)}",
        )
    for command, required_flags in REQUIRED_COMMAND_FLAGS.items():
        help_probe = subprocess.run(
            [str(binary), command, "--help"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        help_text = f"{help_probe.stdout}\n{help_probe.stderr}"
        missing = [flag for flag in required_flags if flag not in help_text]
        if help_probe.returncode != 0 or missing:
            detail = (
                f"exited {help_probe.returncode}: {help_text.strip()[:500]}"
                if help_probe.returncode != 0
                else f"does not support {', '.join(missing)}"
            )
            raise DnaCoverageError(
                "VERSION_MISMATCH",
                f"dna-coverage {command} {detail}",
                {
                    "binary": str(binary),
                    "command": command,
                    "missingFlags": missing,
                },
            )
    return schema


@lru_cache(maxsize=8)
def _binary_content_identity(path: str, size: int, mtime_ns: int) -> str:
    del size, mtime_ns
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@lru_cache(maxsize=8)
def _coverage_engine_identity(path: str, size: int, mtime_ns: int) -> str:
    """Cache compatibility and content identity for one immutable binary."""
    binary = Path(path)
    schema = check_binary_compatibility(binary)
    digest = _binary_content_identity(path, size, mtime_ns)
    return f"dna-coverage:schema-{schema}:sha256-{digest}"


def coverage_engine_identity(binary: Optional[Path] = None) -> str:
    """Exact identity of the executable that owns persisted coverage semantics."""
    path = (binary or find_dna_coverage_binary()).resolve()
    stat = path.stat()
    return _coverage_engine_identity(str(path), stat.st_size, stat.st_mtime_ns)


def run_coverage_tile(
    *,
    bam_path: Path,
    chrom: str,
    start: int,
    end: int,
    bins: int,
    bin_size_bp: Optional[int] = None,
    index_path: Optional[Path] = None,
    reference_fasta: Optional[Path] = None,
    binary: Optional[Path] = None,
    timeout_sec: float = 15.0,
) -> CoverageTileResult:
    bin_path = binary or find_dna_coverage_binary()
    coverage_engine_identity(bin_path)
    cmd = [
        str(bin_path),
        "tile",
        "--bam",
        str(bam_path),
        "--chrom",
        chrom,
        "--start",
        str(start),
        "--end",
        str(end),
        "--bins",
        str(bins),
    ]
    if bin_size_bp is not None:
        cmd.extend(["--bin-size", str(int(bin_size_bp))])
    if index_path is not None:
        cmd.extend(["--index", str(index_path)])
    if reference_fasta is not None:
        cmd.extend(["--reference-fasta", str(reference_fasta)])

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        raise DnaCoverageError(
            "COVERAGE_TILE_FAILED",
            f"dna-coverage tile exited {proc.returncode}: {proc.stderr.strip()[:500]}",
            {"stderr": proc.stderr.strip(), "stdout": proc.stdout.strip()},
        )
    try:
        obj = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise DnaCoverageError(
            "COVERAGE_TILE_FAILED",
            f"dna-coverage produced invalid JSON: {proc.stdout[:500]!r}",
        ) from exc

    return {
        "chrom": str(obj["chrom"]),
        "start": int(obj["start"]),
        "end": int(obj["end"]),
        "bins": [float(v) for v in obj["bins"]],
        "binSize": int(obj["binSize"]),
        "maxDepth": float(obj["maxDepth"]),
        "provenance": dict(obj["provenance"]),
    }


def run_build_base_layer(
    *,
    bam_path: Path,
    chrom: str,
    out_path: Path,
    base_bins: int,
    window_bp: int,
    threads: int = 1,
    index_path: Optional[Path] = None,
    reference_fasta: Optional[Path] = None,
    binary: Optional[Path] = None,
    timeout_sec: float = 300.0,
) -> BaseLayerResult:
    if threads < 1:
        raise ValueError("threads must be positive")
    bin_path = binary or find_dna_coverage_binary()
    coverage_engine_identity(bin_path)
    cmd = [
        str(bin_path),
        "build-base",
        "--bam",
        str(bam_path),
        "--chrom",
        chrom,
        "--out",
        str(out_path),
        "--base-bins",
        str(base_bins),
        "--window-bp",
        str(window_bp),
        "--threads",
        str(threads),
    ]
    if index_path is not None:
        cmd.extend(["--index", str(index_path)])
    if reference_fasta is not None:
        cmd.extend(["--reference-fasta", str(reference_fasta)])

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
    )
    if proc.returncode != 0:
        raise DnaCoverageError(
            "COVERAGE_BASE_LAYER_FAILED",
            f"dna-coverage build-base exited {proc.returncode}: {proc.stderr.strip()[:500]}",
            {"stderr": proc.stderr.strip(), "stdout": proc.stdout.strip()},
        )
    try:
        obj = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise DnaCoverageError(
            "COVERAGE_BASE_LAYER_FAILED",
            f"dna-coverage produced invalid JSON: {proc.stdout[:500]!r}",
        ) from exc

    result: BaseLayerResult = {
        "chrom": str(obj["chrom"]),
        "chromLength": int(obj["chromLength"]),
        "baseBins": int(obj["baseBins"]),
        "baseBinBp": int(obj["baseBinBp"]),
        "maxDepth": float(obj["maxDepth"]),
        "outPath": str(obj["outPath"]),
        "provenance": dict(obj["provenance"]),
    }
    if "alignedBaseCount" in obj and "meanDepth" in obj:
        result["alignedBaseCount"] = int(obj["alignedBaseCount"])
        result["meanDepth"] = float(obj["meanDepth"])
    return result


def use_rust_coverage() -> bool:
    return os.environ.get("DNA_COVERAGE_USE_RUST", "1").lower() not in (
        "0",
        "false",
        "no",
    )
