"""Intrinsic identity for the source or frozen sidecar actually serving requests."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
from pathlib import Path

SOURCE_INPUTS_SCHEMA = "dnaforge.sidecar-source-inputs.v1"
SHA256_HEX_LENGTH = 64
GENERATED_IDENTITY_PATH = "apps/api/src/_frozen_build_identity.py"
API_SOURCE_PREFIX = "apps/api/src/"
ANNOTATION_SOURCE_PREFIX = "packages/annotation/src/"
ALLOWED_GUIDANCE_SYMLINK = "packages/core/agent-tools/AGENTS.md"
ALLOWED_GUIDANCE_TARGET = "CLAUDE.local.md"
MAX_SOURCE_FILES = 4_096
MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024
MAX_SOURCE_TOTAL_BYTES = 128 * 1024 * 1024

try:
    from ._frozen_build_identity import SOURCE_FINGERPRINT as _FROZEN_SOURCE_FINGERPRINT
except ImportError:
    _FROZEN_SOURCE_FINGERPRINT = None


def _is_sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == SHA256_HEX_LENGTH
        and all(character in "0123456789abcdef" for character in value)
    )


def _repo_root() -> Path | None:
    candidate = Path(__file__).resolve().parents[3]
    contract = candidate / "apps" / "api" / "src" / "sidecar-source-inputs.json"
    return candidate if contract.is_file() else None


def _source_inputs(repo_root: Path) -> list[str]:
    contract_path = repo_root / "apps" / "api" / "src" / "sidecar-source-inputs.json"
    try:
        contract = json.loads(contract_path.read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return []
    paths = contract.get("paths")
    if contract.get("schema") != SOURCE_INPUTS_SCHEMA or not isinstance(paths, list):
        return []
    if not paths or any(not isinstance(path, str) or not path for path in paths):
        return []
    return paths


def _path_identity(file_stat: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        file_stat.st_dev,
        file_stat.st_ino,
        file_stat.st_mode,
        file_stat.st_size,
        file_stat.st_mtime_ns,
    )


def _stable_identity(file_stat: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (*_path_identity(file_stat), file_stat.st_ctime_ns)


def _collected_regular_file_stat(
    file_path: Path, collected_stat: os.stat_result
) -> os.stat_result:
    if os.name != "nt":
        return collected_stat
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(file_path, flags)
    try:
        observed = os.fstat(descriptor)
        if not stat.S_ISREG(observed.st_mode) or _path_identity(
            collected_stat
        ) != _path_identity(observed):
            raise ValueError(
                f"sidecar source input changed during collection: {file_path}"
            )
        return observed
    finally:
        os.close(descriptor)


def _relative_path(repo_root: Path, target: Path) -> str:
    return target.relative_to(repo_root).as_posix()


def _is_generated_build_artifact(relative_path: str, mode: int) -> bool:
    if relative_path == GENERATED_IDENTITY_PATH:
        return True
    return (
        stat.S_ISDIR(mode)
        and relative_path.startswith((API_SOURCE_PREFIX, ANNOTATION_SOURCE_PREFIX))
        and "__pycache__" in relative_path.split("/")
    )


def _assert_allowed_guidance_symlink(
    repo_root: Path, target: Path, relative_path: str
) -> None:
    if relative_path != ALLOWED_GUIDANCE_SYMLINK:
        raise ValueError(
            f"sidecar source input contains an unsupported symbolic link: {relative_path}"
        )
    link_target = os.readlink(target)
    if link_target != ALLOWED_GUIDANCE_TARGET:
        raise ValueError(
            f"sidecar source guidance link has an invalid target: {relative_path}"
        )
    resolved_target = target.parent / link_target
    target_stat = os.lstat(resolved_target)
    if not stat.S_ISREG(target_stat.st_mode):
        raise ValueError(
            f"sidecar source guidance link target is not a regular file: {relative_path}"
        )
    try:
        resolved_target.relative_to(repo_root)
    except ValueError as error:
        raise ValueError(
            f"sidecar source guidance link target escapes the repository: {relative_path}"
        ) from error


def _collect_files(
    repo_root: Path,
    target: Path,
    files: list[tuple[Path, os.stat_result]],
    directories: list[tuple[Path, os.stat_result]],
) -> None:
    target_stat = os.lstat(target)
    relative_path = _relative_path(repo_root, target)
    if _is_generated_build_artifact(relative_path, target_stat.st_mode):
        return
    if stat.S_ISLNK(target_stat.st_mode):
        _assert_allowed_guidance_symlink(repo_root, target, relative_path)
        files.append((target, target_stat))
    elif stat.S_ISREG(target_stat.st_mode):
        files.append((target, _collected_regular_file_stat(target, target_stat)))
    elif stat.S_ISDIR(target_stat.st_mode):
        directories.append((target, target_stat))
        for entry in sorted(target.iterdir(), key=lambda path: path.name):
            _collect_files(repo_root, entry, files, directories)
    else:
        raise ValueError(
            f"sidecar source input has an unsupported filesystem kind: {relative_path}"
        )
    if len(files) > MAX_SOURCE_FILES:
        raise ValueError(
            f"sidecar source input exceeds the {MAX_SOURCE_FILES}-file limit"
        )


def _normalized_content(content: bytes) -> bytes:
    if b"\0" in content:
        return content
    try:
        decoded = content.decode("utf-8")
    except UnicodeDecodeError:
        return content
    return decoded.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")


def _read_bounded_regular_file(
    file_path: Path, collected_stat: os.stat_result
) -> bytes:

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    descriptor = os.open(file_path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError(f"sidecar source input is not a regular file: {file_path}")
        if _stable_identity(collected_stat) != _stable_identity(before):
            raise ValueError(
                f"sidecar source input changed before hashing: {file_path}"
            )
        if before.st_size > MAX_SOURCE_FILE_BYTES:
            raise ValueError(
                f"sidecar source input exceeds the per-file byte limit: {file_path}"
            )
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining > 0:
            chunk = os.read(descriptor, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        after = os.fstat(descriptor)
        if remaining != 0 or _stable_identity(before) != _stable_identity(after):
            raise ValueError(f"sidecar source input changed while hashing: {file_path}")
        return _normalized_content(b"".join(chunks))
    finally:
        os.close(descriptor)


def _read_stable_symlink(file_path: Path, collected_stat: os.stat_result) -> bytes:
    before = os.lstat(file_path)
    link_target = os.readlink(file_path)
    after = os.lstat(file_path)
    if _stable_identity(collected_stat) != _stable_identity(before) or _stable_identity(
        before
    ) != _stable_identity(after):
        raise ValueError(f"sidecar source input changed while hashing: {file_path}")
    return f"symlink:{link_target}".encode("utf-8")


def compute_source_sidecar_fingerprint(repo_root: Path) -> str | None:
    inputs = _source_inputs(repo_root)
    if not inputs:
        return None
    files: list[tuple[Path, os.stat_result]] = []
    directories: list[tuple[Path, os.stat_result]] = []
    for relative_path in inputs:
        _collect_files(repo_root, repo_root / relative_path, files, directories)
    files.sort(key=lambda entry: entry[0].relative_to(repo_root).as_posix())
    if not files:
        return None

    digest = hashlib.sha256()
    total_bytes = 0
    for file_path, collected_stat in files:
        relative_path = file_path.relative_to(repo_root).as_posix()
        content = (
            _read_stable_symlink(file_path, collected_stat)
            if stat.S_ISLNK(collected_stat.st_mode)
            else _read_bounded_regular_file(file_path, collected_stat)
        )
        if len(content) > MAX_SOURCE_FILE_BYTES:
            raise ValueError(
                f"sidecar source input exceeds the per-file byte limit: {relative_path}"
            )
        total_bytes += len(content)
        if total_bytes > MAX_SOURCE_TOTAL_BYTES:
            raise ValueError("sidecar source inputs exceed the aggregate byte limit")
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(len(content)).encode("ascii"))
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\0")
    for directory, collected_stat in directories:
        after = os.lstat(directory)
        if _stable_identity(collected_stat) != _stable_identity(after):
            raise ValueError(
                f"sidecar source directory changed while hashing: "
                f"{directory.relative_to(repo_root).as_posix()}"
            )
    return digest.hexdigest()


def _resolve_intrinsic_sidecar_source_fingerprint() -> str | None:
    frozen = bool(getattr(sys, "frozen", False) or "__compiled__" in globals())
    if frozen:
        return (
            _FROZEN_SOURCE_FINGERPRINT
            if _is_sha256(_FROZEN_SOURCE_FINGERPRINT)
            else None
        )
    repo_root = _repo_root()
    return (
        compute_source_sidecar_fingerprint(repo_root) if repo_root is not None else None
    )


_INTRINSIC_SIDECAR_SOURCE_FINGERPRINT = _resolve_intrinsic_sidecar_source_fingerprint()


def intrinsic_sidecar_source_fingerprint() -> str | None:
    """Return identity bound to executable bytes or source loaded at startup."""

    return _INTRINSIC_SIDECAR_SOURCE_FINGERPRINT
