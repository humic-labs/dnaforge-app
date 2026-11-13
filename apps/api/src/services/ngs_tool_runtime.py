from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import stat
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .app_owned_tool_identity import (
    AppOwnedExecutableIdentity,
    AppOwnedToolIdentityError,
    resolve_app_owned_executable,
)

SOURCE_LOCK_SHA256 = "e36e6710829baf54b7e4942796164c4163682ab554deebc76d06c3d3823a1b05"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_TARGETS = {
    "arm64": ("aarch64-apple-darwin", 0x0100000C),
    "aarch64": ("aarch64-apple-darwin", 0x0100000C),
    "x86_64": ("x86_64-apple-darwin", 0x01000007),
    "amd64": ("x86_64-apple-darwin", 0x01000007),
}


class NgsToolRuntimeError(RuntimeError):
    def __init__(self, code: str, message: str, context: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.context = context or {}


@dataclass(frozen=True)
class VerifiedNgsTool(AppOwnedExecutableIdentity):
    version: str = ""


@dataclass(frozen=True)
class AppOwnedNgsTools:
    minimap2: VerifiedNgsTool
    samtools: VerifiedNgsTool
    target: str
    profile: Literal["local-bam-v1"]
    htslib_version: str


def _unqualified(message: str, context: dict | None = None) -> NgsToolRuntimeError:
    return NgsToolRuntimeError("NGS_TOOLS_PROVENANCE_UNQUALIFIED", message, context)


def _read_metadata(path: Path) -> tuple[dict, str]:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > 128 * 1024:
            raise ValueError("Metadata is not a bounded regular file")
        data = path.read_bytes()
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError("Metadata must be an object")
        return value, hashlib.sha256(data).hexdigest()
    except (OSError, ValueError) as error:
        raise _unqualified(
            "DNAForge's installed alignment-tool provenance is unavailable."
        ) from error


def _binary_hash(path: Path, cpu: int) -> str:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or not 32 <= info.st_size <= 64 * 1024 * 1024:
            raise ValueError("The executable is not a bounded regular file")
        if not info.st_mode & 0o111:
            raise ValueError("The tool is not executable")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            header = stream.read(8)
            if struct.unpack("<II", header) != (0xFEEDFACF, cpu):
                raise ValueError("The tool has a different native architecture")
            digest.update(header)
            while block := stream.read(1024 * 1024):
                digest.update(block)
        return digest.hexdigest()
    except (OSError, ValueError, struct.error) as error:
        raise _unqualified(
            "DNAForge's installed alignment tools do not match this build."
        ) from error


def resolve_app_owned_ngs_tools() -> AppOwnedNgsTools:
    target = _TARGETS.get(platform.machine().lower())
    if platform.system() != "Darwin" or target is None:
        raise NgsToolRuntimeError(
            "NGS_TOOLS_PLATFORM_UNSUPPORTED",
            "App-owned alignment tools are available only in supported macOS builds.",
        )
    configured = os.environ.get("DNAFORGE_HELPERS_DIR")
    if not configured or not Path(configured).is_absolute():
        raise NgsToolRuntimeError(
            "NGS_TOOLS_UNAVAILABLE",
            "DNAForge cannot find its alignment tools. Update or repair the app.",
        )
    try:
        directory = Path(configured).resolve(strict=True)
        if not directory.is_dir():
            raise OSError("Helpers must be a directory")
    except OSError as error:
        raise NgsToolRuntimeError(
            "NGS_TOOLS_UNAVAILABLE",
            "DNAForge cannot find its alignment tools. Update or repair the app.",
        ) from error
    lock, lock_sha = _read_metadata(directory / "ngs-tools.source.lock.json")
    receipt, receipt_sha = _read_metadata(directory / "ngs-tools.build.json")
    suffix, cpu = target
    if (
        lock_sha != SOURCE_LOCK_SHA256
        or lock.get("schema") != "dnaforge.ngs-tools-source.v1"
        or receipt.get("schema") != "dnaforge.ngs-tools-build.v1"
        or receipt.get("phase") != "source-build-before-package-signing"
        or receipt.get("target") != suffix
        or receipt.get("profile") != "local-bam-v1"
        or receipt.get("sourceLockSha256") != lock_sha
        or receipt.get("sources") != lock.get("sources")
        or not _SHA256.fullmatch(str(receipt.get("recipeKey", "")))
    ):
        raise _unqualified(
            "DNAForge's installed alignment-tool provenance does not match this build."
        )
    tools = receipt.get("tools")
    if not isinstance(tools, dict) or set(tools) != {"minimap2", "samtools"}:
        raise _unqualified("DNAForge's installed alignment tools are incomplete.")
    versions = lock["versions"]
    verified: dict[str, VerifiedNgsTool] = {}
    for name in ("minimap2", "samtools"):
        metadata = tools[name]
        file = f"{name}-{suffix}"
        if (
            not isinstance(metadata, dict)
            or metadata.get("file") != file
            or metadata.get("version") != versions[name]
            or not _SHA256.fullmatch(str(metadata.get("sha256", "")))
        ):
            raise _unqualified(
                "DNAForge's installed alignment-tool identity is unqualified."
            )
        executable = directory / file
        try:
            identity = resolve_app_owned_executable(
                file,
                source_build_sha256=metadata["sha256"],
                source_receipt_name="ngs-tools.build.json",
                source_receipt_sha256=receipt_sha,
            )
        except AppOwnedToolIdentityError as error:
            raise _unqualified(
                "DNAForge could not verify its installed alignment-tool provenance."
            ) from error
        actual_sha = _binary_hash(executable, cpu)
        if actual_sha != identity.sha256:
            raise _unqualified(
                "DNAForge's alignment tools changed during verification."
            )
        try:
            probe = subprocess.run(
                [str(executable), "--version"],
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise NgsToolRuntimeError(
                "NGS_TOOLS_VERSION_UNQUALIFIED",
                "DNAForge could not verify its installed alignment tools.",
            ) from error
        lines = probe.stdout.strip().splitlines()
        expected = (
            [versions[name]]
            if name == "minimap2"
            else [f"samtools {versions[name]}", f"Using htslib {versions['htslib']}"]
        )
        if (
            lines[: len(expected)] != expected
            or _binary_hash(executable, cpu) != actual_sha
        ):
            raise NgsToolRuntimeError(
                "NGS_TOOLS_VERSION_UNQUALIFIED",
                "DNAForge's installed alignment-tool version does not match this build.",
            )
        verified[name] = VerifiedNgsTool(
            path=executable,
            version=versions[name],
            sha256=actual_sha,
            source_build_sha256=metadata["sha256"],
            source_receipt_sha256=receipt_sha,
            verification_type=identity.verification_type,
            package_identity=identity.package_identity,
            signing_handoff_sha256=identity.signing_handoff_sha256,
        )
    return AppOwnedNgsTools(
        minimap2=verified["minimap2"],
        samtools=verified["samtools"],
        target=suffix,
        profile="local-bam-v1",
        htslib_version=versions["htslib"],
    )
