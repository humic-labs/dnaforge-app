"""Native sidecar capability receipts shared by health and packaging probes."""

from __future__ import annotations

import importlib
import sys

GENOME_RUNTIME_CAPABILITY = "genome.pysam-htslib.v1"
GENOME_RUNTIME_UNAVAILABLE_SCHEMA = "dnaforge.genome-runtime-unavailable.v1"


def genome_extra_enabled_for_target(target: str) -> bool:
    """Return whether the build/runtime target is expected to carry pysam."""
    normalized = target.strip().lower()
    if not normalized:
        raise ValueError("genome runtime target is required")
    return not (normalized.startswith("win") or "windows" in normalized)


def genome_runtime_receipt() -> dict[str, str]:
    """Prove the native reader and exact coverage-helper command contract."""
    pysam = importlib.import_module("pysam")
    version = getattr(pysam, "__version__", None)
    if not isinstance(version, str) or not version.strip():
        raise RuntimeError("pysam imported without reporting a version")
    from .services.dna_coverage_shellout import coverage_engine_identity

    return {
        "schema": "dnaforge.genome-runtime-capability.v1",
        "capability": GENOME_RUNTIME_CAPABILITY,
        "pysamVersion": version.strip(),
        "coverageEngineIdentity": coverage_engine_identity(),
    }


def genome_runtime_status_receipt(platform: str | None = None) -> dict[str, str]:
    """Prove the runtime, or prove that its absence matches the target policy."""
    target = platform or sys.platform
    try:
        return genome_runtime_receipt()
    except Exception:
        if genome_extra_enabled_for_target(target):
            raise
        return {
            "schema": GENOME_RUNTIME_UNAVAILABLE_SCHEMA,
            "capability": GENOME_RUNTIME_CAPABILITY,
            "reason": "unsupported-on-target",
            "target": target,
        }


def runtime_capabilities() -> list[str]:
    """Advertise a native capability only when its import actually succeeds."""
    try:
        genome_runtime_receipt()
    except Exception:
        return []
    return [GENOME_RUNTIME_CAPABILITY]
