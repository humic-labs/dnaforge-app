"""Shell-out path to the Rust `dna-indexer` binary  Step 4).

Replaces the BioPython-based GenBank → FASTA+GFF3 pipeline in
`genome_indexer.py` for GenBank, FASTA, and GFF3 inputs.

The Rust binary produces the BGZF FASTA bundle (.fa.gz, .fa.gz.fai,
.fa.gz.gzi) plus GFF3/tabix when annotated, directly into the staging
directory, so this function is a thin wrapper around subprocess + JSON
parsing.

Schema-doc contract: see docs/INDEXED_GENOME_FORMAT.md § "Progress
events" and § "Error taxonomy" for the stdout/stderr formats this code
parses.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional


class DnaIndexerError(Exception):
    """Raised when the Rust binary signals a structured failure."""

    def __init__(self, code: str, message: str, context: Optional[dict] = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.context = context or {}


class DnaIndexerNotFoundError(DnaIndexerError):
    """The Rust binary isn't on disk where we expect it."""

    def __init__(self, searched: list[Path]):
        super().__init__(
            "BINARY_NOT_FOUND",
            "dna-indexer binary not found",
            {"searched": [str(p) for p in searched]},
        )


@dataclass(frozen=True)
class DnaIndexerProgress:
    """One progress event from the Rust binary's stdout stream."""

    progress: float
    stage: str
    feature_count: int


@dataclass(frozen=True)
class DnaIndexerResult:
    """Terminal status reported by the Rust binary on success."""

    length: int
    feature_count: int
    topology: str
    fa_path: Path
    fai_path: Path
    gzi_path: Path
    gff_gz_path: Path
    tbi_path: Path
    annotation_rows: Optional[int] = None


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
    raise DnaIndexerError(
        "UNSUPPORTED_INPUT_FORMAT",
        f"dna-indexer not built for {system}/{machine}",
    )


def find_dna_indexer_binary() -> Path:
    """Locate the `dna-indexer` binary.

    Search order:
      1. `DNA_INDEXER_PATH` env var (explicit override — used by tests).
      2. The packaged desktop bundle: `<.app>/Contents/Helpers/dna-indexer-<suffix>`
         (apps/desktop bundles via electron-builder extraFiles per the
         Step 1 install path commit).
      3. The dev tree: `apps/desktop/resources/helpers/dna-indexer-<suffix>`
         (LFS-tracked, present in the worktree).
      4. The cargo build output: `target/release/dna-indexer` (for cargo-test
         scenarios where the desktop bundle isn't built).
    """
    if env := os.environ.get("DNA_INDEXER_PATH"):
        p = Path(env)
        if p.is_file() and os.access(p, os.X_OK):
            return p
        raise DnaIndexerNotFoundError([p])

    suffix = _host_suffix()
    candidates: list[Path] = []

    if app_helpers := os.environ.get("DNAFORGE_HELPERS_DIR"):
        candidates.append(Path(app_helpers) / f"dna-indexer-{suffix}")

    repo_root = _find_repo_root()
    if repo_root is not None:
        candidates.append(
            repo_root
            / "apps"
            / "desktop"
            / "resources"
            / "helpers"
            / f"dna-indexer-{suffix}"
        )
        candidates.append(repo_root / "target" / "release" / "dna-indexer")

    runtime_tools_dir = _runtime_tools_dir(suffix)
    if runtime_tools_dir is not None:
        candidates.append(runtime_tools_dir / "dna-indexer")

    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return c
    raise DnaIndexerNotFoundError(candidates)


def _find_repo_root() -> Optional[Path]:
    """Walk up from this file to find the worktree root (marked by Cargo.toml
    + tools/dna-indexer/)."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "Cargo.toml").is_file() and (
            parent / "tools" / "dna-indexer"
        ).is_dir():
            return parent
    return None


def _runtime_tools_dir(helper_suffix: str) -> Optional[Path]:
    """Return the runtime tools directory populated by ensure_tools().

    The helper binary in apps/desktop/resources/helpers is stored with a
    platform suffix in its filename, but ensure_tools/download-binaries install
    it as an unsuffixed `dna-indexer` beside the third-party tools.
    """
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


SUPPORTED_SCHEMA_VERSIONS = frozenset({1, 2})


def check_binary_compatibility(binary: Path) -> int:
    """Run `dna-indexer --version`, parse the schema version, raise if
    incompatible. Returns the schema version on success."""
    proc = subprocess.run(
        [str(binary), "--version"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    if proc.returncode != 0:
        raise DnaIndexerError(
            "BINARY_NOT_FOUND",
            f"dna-indexer --version exited {proc.returncode}: {proc.stderr.strip()}",
        )
    parts = proc.stdout.strip().split()
    schema = None
    for i, tok in enumerate(parts):
        if tok == "schema" and i + 1 < len(parts):
            try:
                schema = int(parts[i + 1])
            except ValueError:
                pass
            break
    if schema is None:
        raise DnaIndexerError(
            "VERSION_MISMATCH",
            f"could not parse schema version from: {proc.stdout.strip()!r}",
        )
    if schema not in SUPPORTED_SCHEMA_VERSIONS:
        raise DnaIndexerError(
            "VERSION_MISMATCH",
            f"dna-indexer reports schema {schema}, sidecar supports {sorted(SUPPORTED_SCHEMA_VERSIONS)}",
        )
    return schema


def detect_input_format(input_path: Path) -> str:
    """Map the input file's extension to a dna-indexer subcommand.

    Returns 'index' for GenBank (`.gb`, `.gbk`, `.gbff`) or FASTA inputs
    (the index subcommand handles both), and 'ingest-gff3' for GFF3
    inputs (`.gff`, `.gff3`, with optional `.gz` suffix).

    The GFF3 path is the CANONICAL path for production data — it
    preserves explicit Parent= edges from the upstream source (NCBI,
    Ensembl, GENCODE) and bypasses our inference heuristics entirely.
    The GenBank path is a best-effort fallback for sources without
    explicit cross-references.
    """
    name = input_path.name.lower()
    if name.endswith(".gz"):
        name = name[:-3]
    if name.endswith(".gff") or name.endswith(".gff3"):
        return "ingest-gff3"
    return "index"


def find_companion_fasta(gff3_path: Path) -> Optional[Path]:
    """For a GFF3 input, locate its companion FASTA by convention.

    Tries `<stem>.fa`, `<stem>.fasta`, `<stem>.fna`, plus the `.gz`
    variants of each. The stem strips both the outer `.gz` and the
    inner `.gff`/`.gff3`. Returns the first existing file, or None
    when no companion is found.
    """
    name = gff3_path.name
    inner = name[:-3] if name.lower().endswith(".gz") else name
    for suffix in (".gff3", ".gff"):
        if inner.lower().endswith(suffix):
            stem_name = inner[: -len(suffix)]
            break
    else:
        stem_name = inner
    parent = gff3_path.parent
    candidates = [
        parent / f"{stem_name}.fa",
        parent / f"{stem_name}.fa.gz",
        parent / f"{stem_name}.fasta",
        parent / f"{stem_name}.fasta.gz",
        parent / f"{stem_name}.fna",
        parent / f"{stem_name}.fna.gz",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def run_index(
    *,
    input_path: Path,
    out_dir: Path,
    name: str,
    binary: Optional[Path] = None,
    timeout_sec: float = 120.0,
    progress_cb: Optional[callable] = None,
    companion_fasta: Optional[Path] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> DnaIndexerResult:
    """Run the appropriate dna-indexer subcommand based on the input
    format, and parse the result.

    For GenBank or FASTA inputs: shells out to `dna-indexer index`.
    For GFF3 inputs: shells out to `dna-indexer ingest-gff3` with a
    companion FASTA (passed explicitly via `companion_fasta`, or
    auto-discovered via `find_companion_fasta`).

    `progress_cb` is invoked once per NDJSON progress event with a
    `DnaIndexerProgress` instance; the caller can stream these to the
    renderer as SSE events.

    Raises `DnaIndexerError` on any structured failure (parse, write,
    BGZF, missing-fasta, etc.). The error's `code` field matches the
    schema doc's error taxonomy 1:1.
    """
    bin_path = binary or find_dna_indexer_binary()
    out_dir.mkdir(parents=True, exist_ok=True)

    subcommand = detect_input_format(input_path)

    if subcommand == "ingest-gff3":
        fasta = companion_fasta or find_companion_fasta(input_path)
        if fasta is None:
            raise DnaIndexerError(
                "UNSUPPORTED_INPUT_FORMAT",
                f"GFF3 input {input_path} has no companion FASTA. "
                f"Expected one of {input_path.stem}.fa / .fasta / .fna "
                f"(optionally .gz) alongside the GFF3 file.",
            )
        cmd = [
            str(bin_path),
            "ingest-gff3",
            "--in",
            str(input_path),
            "--in-fasta",
            str(fasta),
            "--out-dir",
            str(out_dir),
            "--name",
            name,
        ]
    else:
        cmd = [
            str(bin_path),
            "index",
            "--in",
            str(input_path),
            "--out-dir",
            str(out_dir),
            "--name",
            name,
        ]
    child = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    deadline = time.monotonic() + timeout_sec
    while True:
        if cancel_check is not None and cancel_check():
            child.terminate()
            try:
                stdout, stderr = child.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                stdout, stderr = child.communicate()
            raise DnaIndexerError(
                "CANCELLED",
                "dna-indexer operation was cancelled",
                {"stdout": stdout[-500:], "stderr": stderr[-500:]},
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            child.kill()
            child.communicate()
            raise subprocess.TimeoutExpired(cmd, timeout_sec)
        try:
            stdout, stderr = child.communicate(timeout=min(0.05, remaining))
            break
        except subprocess.TimeoutExpired:
            continue
    proc = subprocess.CompletedProcess(cmd, child.returncode, stdout, stderr)

    terminal: Optional[dict] = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "ok" in obj:
            terminal = obj
        elif "progress" in obj and progress_cb is not None:
            progress_cb(
                DnaIndexerProgress(
                    progress=float(obj.get("progress", 0.0)),
                    stage=str(obj.get("stage", "unknown")),
                    feature_count=int(obj.get("feature_count", 0)),
                )
            )

    if proc.returncode != 0:
        raise _parse_error_from_stderr(proc.stderr, terminal, proc.returncode)

    if terminal is None:
        raise DnaIndexerError(
            "GENBANK_PARSE_FAILED",
            f"dna-indexer exited cleanly but produced no terminal status. stdout={proc.stdout!r}",
        )
    if not terminal.get("ok"):
        raise DnaIndexerError(
            terminal.get("code", "GENBANK_PARSE_FAILED"),
            terminal.get("message", "dna-indexer reported failure"),
            terminal,
        )

    paths = terminal.get("paths", {})
    return DnaIndexerResult(
        length=int(terminal["length"]),
        feature_count=int(terminal["feature_count"]),
        topology=str(terminal.get("topology", "linear")),
        fa_path=Path(paths.get("fa", out_dir / f"{name}.fa.gz")),
        fai_path=Path(paths.get("fai", out_dir / f"{name}.fa.gz.fai")),
        gzi_path=Path(paths.get("gzi", out_dir / f"{name}.fa.gz.gzi")),
        gff_gz_path=Path(paths.get("gff3_gz", out_dir / f"{name}.gff3.gz")),
        tbi_path=Path(paths.get("tbi", out_dir / f"{name}.gff3.gz.tbi")),
        annotation_rows=(
            int(terminal["annotation_rows"])
            if terminal.get("annotation_rows") is not None
            else None
        ),
    )


def iter_progress_events(stderr_or_stdout_text: str) -> Iterator[DnaIndexerProgress]:
    """Parse a captured stdout/stderr blob for progress events. Useful for
    tests; live runs use `run_index`'s callback instead."""
    for line in stderr_or_stdout_text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "progress" in obj:
            yield DnaIndexerProgress(
                progress=float(obj.get("progress", 0.0)),
                stage=str(obj.get("stage", "unknown")),
                feature_count=int(obj.get("feature_count", 0)),
            )


def _parse_error_from_stderr(
    stderr: str, terminal: Optional[dict], returncode: int
) -> DnaIndexerError:
    """Walk stderr looking for a structured error JSON line. Falls back to a
    generic error wrapping the terminal status (or the returncode) if no
    parseable error is found."""
    for line in stderr.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("level") == "error" and "code" in obj:
            return DnaIndexerError(
                obj["code"],
                obj.get("message", "unknown failure"),
                obj.get("context"),
            )
    if terminal and terminal.get("code"):
        return DnaIndexerError(
            terminal["code"],
            terminal.get("message", f"dna-indexer exited {returncode}"),
            terminal,
        )
    return DnaIndexerError(
        "GENBANK_PARSE_FAILED",
        f"dna-indexer exited {returncode}: {stderr.strip()[:500]}",
    )
