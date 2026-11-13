"""Managed application adapter for the standalone annotation package.

This module retains app provisioning and readiness while the shared package owns
the validated domain contract and synchronous scientific execution.
"""

import asyncio
import os
import shutil
import stat as stat_mod
import threading
import traceback
from pathlib import Path
from typing import Any

from dnaforge_annotation.contract import (
    AnnotationExecutables,
    AnnotationFeature,
    AnnotationRequest,
    AnnotationResult,
    AnnotationRuntime,
    DbSource,
)
from dnaforge_annotation.core import (
    DB_SOURCE_MAP,
    clean_sequence,
    normalize_annotate_range,
    run_annotation,
)

from ..toolbox.executable_paths import executable_variants as executable_variants
from ..toolbox.executable_paths import get_platform_suffix as get_platform_suffix
from .base import ServiceDefinition, describe_model_fields

PLANNOTATE_SERVICE_NAME = "plannotate_service"


def _format_annotation_error(exc: Exception) -> str:
    if os.environ.get("DNAFORGE_ANNOTATION_DEBUG_ERRORS") == "1":
        return f"{exc}\n{traceback.format_exc()}"
    return str(exc)


def get_app_data_dir() -> Path:
    """Get the application data directory for storing databases.

    Delegates to the canonical path in annotation.setup to avoid path mismatches.
    """
    from ..annotation.setup import get_annotation_data_dir

    return get_annotation_data_dir()


def find_binaries_dir() -> Path | None:
    """
    Find the directory containing bundled binaries.

    Checks in order:
    1. WAYPOINT_BINARIES_PATH environment variable (explicit override)
    2. Runtime-downloaded tools dir (requires ALL required tools present)
    3. Development location: apps/desktop/resources/binaries/
    4. Returns None if not found (fall back to system PATH)
    """
    env_path = os.environ.get("WAYPOINT_BINARIES_PATH")
    if env_path:
        path = Path(env_path)
        if path.is_dir():
            return path

    try:
        from ..annotation.tools import get_tools_dir, validate_tools

        tools_dir = get_tools_dir()
        tool_status = validate_tools(tools_dir)
        if tool_status and all(tool_status.values()):
            return tools_dir
    except (ImportError, OSError):
        pass

    this_file = Path(__file__)
    dev_binaries = (
        this_file.parent.parent.parent.parent / "desktop" / "resources" / "binaries"
    )
    if dev_binaries.is_dir():
        return dev_binaries

    return None


def get_binary_path(name: str, binaries_dir: Path | None) -> str | None:
    """
    Get the full path to a binary, checking bundled location first.

    Args:
        name: Binary name (e.g., "blastn", "diamond", "cmscan")
        binaries_dir: Directory containing bundled binaries, or None

    Returns:
        Full path to binary if found in bundled location, None otherwise
    """
    if binaries_dir is None:
        return None

    suffix = get_platform_suffix()

    for base in (binaries_dir / f"{name}-{suffix}", binaries_dir / name):
        for candidate in executable_variants(base):
            try:
                st = candidate.stat()
                if stat_mod.S_ISREG(st.st_mode) and st.st_size > 0:
                    return str(candidate)
            except OSError:
                continue

    return None


def check_required_binaries(binaries_dir: Path | None) -> dict[str, str | None]:
    """
    Check availability of required binaries for the CURRENT platform.

    Binary names are derived from TOOL_REGISTRY — not hardcoded — and filtered to
    the tools that actually ship a build for this platform.
    Returns dict mapping binary name to path (or None if not found).
    """
    from ..annotation.tools import get_platform_binary_names

    result = {}

    for name in get_platform_binary_names(required_by="plannotate"):
        bundled_path = get_binary_path(name, binaries_dir)
        if bundled_path:
            result[name] = bundled_path
            continue

        result[name] = shutil.which(name)

    return result


def _path_env_key(env: dict[str, str]) -> str:
    """Return the existing PATH key, preserving Windows' usual ``Path`` casing."""
    for key in env:
        if key.upper() == "PATH":
            return key
    return "PATH"


_normalize_annotate_range = normalize_annotate_range


class PlannotateService(ServiceDefinition):
    """
    Automatic plasmid annotation using pLannotate.

    Identifies common genetic features (origins, promoters, genes, etc.)
    in plasmid sequences by comparing against a curated database.
    """

    INPUT_TYPES = describe_model_fields(AnnotationRequest)
    RETURN_TYPES = describe_model_fields(AnnotationResult)

    def __init__(self):
        self._db_path = get_app_data_dir()
        self._binaries_dir = find_binaries_dir()
        self._plannotate_available = self._check_plannotate()
        self._physical_engine_lock = threading.Lock()

    def _check_plannotate(self) -> bool:
        """Check whether the compatibility engine module can be resolved.

        The service is instantiated at import time, so ``find_spec`` preserves the
        Windows startup boundary by deferring pandas and NumPy until execution.
        """
        import importlib.util

        try:
            return importlib.util.find_spec("src.annotation.annotate") is not None
        except (ImportError, ValueError):
            return False

    def _get_env_with_binaries(self) -> dict[str, str]:
        """
        Get environment dict with bundled binaries directory prepended to PATH.

        This ensures pLannotate subprocess calls find our bundled binaries.
        """
        env = os.environ.copy()

        if self._binaries_dir:
            path_key = _path_env_key(env)
            current_path = env.get(path_key, "")
            binaries_dir = str(self._binaries_dir)
            env[path_key] = (
                f"{binaries_dir}{os.pathsep}{current_path}"
                if current_path
                else binaries_dir
            )
            for key in list(env):
                if key.upper() == "PATH" and key != path_key:
                    del env[key]

        return env

    @property
    def runtime(self) -> AnnotationRuntime:
        """Return the explicit standalone runtime backed by managed app assets."""
        binaries = check_required_binaries(self._binaries_dir)
        missing = [
            name for name in ("blastn", "diamond", "cmscan") if not binaries.get(name)
        ]
        if missing:
            raise FileNotFoundError(
                "missing annotation executables: " + ", ".join(missing)
            )
        return AnnotationRuntime(
            data_dir=self._db_path,
            executables=AnnotationExecutables(
                blastn=Path(str(binaries["blastn"])),
                diamond=Path(str(binaries["diamond"])),
                cmscan=Path(str(binaries["cmscan"])),
            ),
            temp_dir=self._db_path / "tmp",
            threads=1,
        )

    def get_database_status(self) -> dict[str, Any]:
        """Check if annotation databases are downloaded."""
        db_downloaded = False

        if self._plannotate_available:
            try:
                from src.annotation.resources import databases_exist

                db_downloaded = databases_exist()
            except Exception:
                pass

        return {
            "downloaded": db_downloaded,
            "path": str(self._db_path),
            "plannotate_available": self._plannotate_available,
            "binaries_dir": str(self._binaries_dir) if self._binaries_dir else None,
            "binaries": check_required_binaries(self._binaries_dir),
        }

    async def annotate(self, request: AnnotationRequest) -> AnnotationResult:
        """Annotate a validated request; the only annotation implementation.

        Args:
            request: validated wire request (see ``AnnotationRequest``)

        Returns:
            ``AnnotationResult`` whose ``error`` carries readiness or engine
            failures for presentation, with an empty feature list.
        """
        sequence = clean_sequence(request.sequence)
        if not sequence:
            return AnnotationResult(features=[], sequence_length=0)
        sequence_length = len(sequence)

        def failure(message: str) -> AnnotationResult:
            return AnnotationResult(
                features=[],
                sequence_length=sequence_length,
                error=message or "Annotation failed without a message from the engine.",
            )

        from ..annotation.setup import (
            is_annotation_provisioning,
            is_rfam_runtime_ready,
        )

        if is_annotation_provisioning():
            return failure(
                "Annotation databases are downloading or being prepared. "
                "This may take a few minutes."
            )

        if not self.get_database_status()["downloaded"]:
            return failure(
                "Annotation databases not installed. Check Annotation Engine in Settings."
            )

        if not is_rfam_runtime_ready():
            return failure("Rfam annotation indexes are unavailable for this platform.")

        if self._binaries_dir is None:
            self._binaries_dir = find_binaries_dir()

        binary_status = check_required_binaries(self._binaries_dir)
        missing_binaries = [
            name for name, path in binary_status.items() if path is None
        ]
        if missing_binaries:
            from ..annotation.tools import is_downloading_tools

            if is_downloading_tools():
                return failure(
                    "Bioinformatics tools are being installed. This may take a few minutes."
                )
            return failure(
                f"Missing required tools: {', '.join(missing_binaries)}. "
                "Check the Annotation Engine section in Settings."
            )

        subrange = _normalize_annotate_range(
            request.start, request.end, sequence_length
        )
        if subrange is not None:
            start0, end0 = subrange
            annotate_sequence = sequence[start0:end0]
            annotate_linear = True
            coord_offset = start0
        else:
            annotate_sequence = sequence
            annotate_linear = request.linear
            coord_offset = 0

        try:
            features = await self._run_plannotate(annotate_sequence, annotate_linear)
            if coord_offset:
                for feature in features:
                    feature.start += coord_offset
                    feature.end += coord_offset
            return AnnotationResult(features=features, sequence_length=sequence_length)
        except FileNotFoundError as e:
            missing_tool = str(e).split("No such file or directory: ")[-1].strip("'\"")
            return failure(
                f"Missing system tool: {missing_tool}. "
                "Check the Annotation Engine section in Settings."
            )
        except Exception as e:
            return failure(_format_annotation_error(e))

    DB_SOURCE_MAP: dict[str, DbSource] = DB_SOURCE_MAP

    async def _run_plannotate(
        self, sequence: str, linear: bool
    ) -> list[AnnotationFeature]:
        """Run shared annotation without surrendering capacity on awaiter cancel."""
        runtime = self.runtime

        def run_physical_annotation() -> list[AnnotationFeature]:
            with self._physical_engine_lock:
                result = run_annotation(
                    AnnotationRequest(sequence=sequence, linear=linear), runtime
                )
                return result.features

        return await asyncio.to_thread(run_physical_annotation)
