#!/usr/bin/env python3
"""Fail closed when a sidecar build does not match its target label."""

from __future__ import annotations

import argparse
import platform
import re
import subprocess
import sys
from pathlib import Path

ARCHITECTURE_ALIASES = {
    "aarch64": "arm64",
    "arm64": "arm64",
    "amd64": "x86_64",
    "x86_64": "x86_64",
}


def normalize_architecture(value: str) -> str:
    """Return the canonical architecture name used by package validation."""
    normalized = ARCHITECTURE_ALIASES.get(value.strip().lower())
    if normalized is None:
        raise ValueError(f"unsupported architecture: {value or '<empty>'}")
    return normalized


def expected_architecture(target: str) -> str:
    """Extract the expected CPU architecture from a Rust-style target triple."""
    target_architecture = target.split("-", 1)[0]
    try:
        return normalize_architecture(target_architecture)
    except ValueError as error:
        raise ValueError(f"unsupported sidecar target: {target}") from error


def validate_runtime_architecture(target: str, runtime_machine: str) -> str:
    """Require the active Python runtime to match the build target."""
    expected = expected_architecture(target)
    actual = normalize_architecture(runtime_machine)
    if actual != expected:
        raise ValueError(
            f"sidecar target {target} requires {expected}, but the active "
            f"Python runtime is {actual}"
        )
    return expected


def architectures_from_file_output(output: str) -> set[str]:
    """Parse all supported architecture tokens reported by the `file` utility."""
    tokens = re.findall(
        r"(?<![A-Za-z0-9_])(aarch64|arm64|amd64|x86[-_]64)(?![A-Za-z0-9_])",
        output,
        re.I,
    )
    return {normalize_architecture(token.replace("-", "_")) for token in tokens}


def validate_binary_architecture_output(target: str, output: str) -> set[str]:
    """Require the built executable to contain the target architecture slice."""
    expected = expected_architecture(target)
    actual = architectures_from_file_output(output)
    if expected not in actual:
        found = ", ".join(sorted(actual)) if actual else "unknown"
        raise ValueError(
            f"sidecar target {target} requires {expected}, but the built "
            f"binary contains {found}"
        )
    return actual


def inspect_binary(path: Path) -> str:
    """Return the platform binary description used for architecture validation."""
    result = subprocess.run(
        ["file", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--runtime", action="store_true")
    source.add_argument("--binary", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        if args.runtime:
            actual = platform.machine()
            validated = validate_runtime_architecture(args.target, actual)
            print(f"Sidecar Python architecture verified: {validated}")
        else:
            output = inspect_binary(args.binary)
            validated = validate_binary_architecture_output(args.target, output)
            print(
                "Sidecar binary architecture verified: "
                f"{', '.join(sorted(validated))}"
            )
    except (OSError, subprocess.CalledProcessError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
