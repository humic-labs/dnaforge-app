"""Runtime environment checks for the API sidecar."""

from __future__ import annotations

import os
import platform
import subprocess
from dataclasses import dataclass


def _read_sysctl(name: str) -> str | None:
    try:
        result = subprocess.run(
            ["sysctl", "-in", name],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return None

    value = result.stdout.strip()
    return value or None


@dataclass(frozen=True)
class RuntimeArchitecture:
    python_arch: str
    machine_arch: str
    on_arm_hardware: bool
    translated: bool

    @property
    def summary(self) -> str:
        details = [
            f"python={self.python_arch}",
            f"machine={self.machine_arch}",
        ]
        if self.on_arm_hardware:
            details.append("hardware=arm64")
        if self.translated:
            details.append("translated=yes")
        return ", ".join(details)


def detect_runtime_architecture() -> RuntimeArchitecture:
    python_arch = platform.machine().lower() or "unknown"
    machine_arch = platform.machine().lower() or "unknown"

    translated = _read_sysctl("sysctl.proc_translated") == "1"
    on_arm_hardware = _read_sysctl("hw.optional.arm64") == "1"
    if not on_arm_hardware and platform.system() == "Darwin":
        on_arm_hardware = "arm" in (platform.processor().lower() or "")

    return RuntimeArchitecture(
        python_arch=python_arch,
        machine_arch=machine_arch,
        on_arm_hardware=on_arm_hardware,
        translated=translated,
    )


def enforce_runtime_architecture(mode: str) -> RuntimeArchitecture:
    runtime = detect_runtime_architecture()
    enforce_native = os.getenv("WAYPOINT_API_ENFORCE_NATIVE") == "1" or mode == "perf"

    if runtime.on_arm_hardware and runtime.translated:
        message = (
            "API sidecar is running under Rosetta translation on arm64 hardware. "
            f"Detected runtime: {runtime.summary}. Rebuild or reinstall the "
            "virtualenv natively for benchmark/perf runs."
        )
        if enforce_native:
            raise RuntimeError(message)
        print(f"WARNING: {message}")

    return runtime
