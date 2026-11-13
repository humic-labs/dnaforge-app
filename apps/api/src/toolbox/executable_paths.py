"""Dependency-light platform and executable naming shared by tool discovery.

Finding an alignment executable must not initialize an annotation service or
require its scientific Python dependencies in the hosted operation runtime.
"""

import platform
import subprocess
from pathlib import Path

_platform_suffix_cache: str | None = None
_WINDOWS_EXECUTABLE_EXTENSIONS = (".exe", ".bat", ".cmd", ".com")


def get_platform_suffix() -> str:
    """Resolve the native tool platform, caching macOS's Rosetta check."""
    global _platform_suffix_cache
    if _platform_suffix_cache is not None:
        return _platform_suffix_cache

    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "darwin":
        if machine in ("arm64", "aarch64"):
            result = "aarch64-apple-darwin"
        else:
            try:
                proc = subprocess.run(
                    ["sysctl", "-n", "machdep.cpu.brand_string"],
                    capture_output=True,
                    text=True,
                )
                result = (
                    "aarch64-apple-darwin"
                    if proc.returncode == 0 and "Apple" in proc.stdout
                    else "x86_64-apple-darwin"
                )
            except OSError:
                result = "x86_64-apple-darwin"
    elif system == "linux":
        result = (
            "aarch64-unknown-linux-gnu"
            if machine in ("arm64", "aarch64")
            else "x86_64-unknown-linux-gnu"
        )
    elif system == "windows":
        result = "x86_64-pc-windows-msvc"
    else:
        result = ""
    _platform_suffix_cache = result
    return result


def executable_variants(base: Path) -> list[Path]:
    """Probe Windows executable suffixes first, then the bare POSIX name."""
    if platform.system().lower() == "windows":
        return [
            *(Path(str(base) + ext) for ext in _WINDOWS_EXECUTABLE_EXTENSIONS),
            base,
        ]
    return [base]
