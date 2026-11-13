"""The track-store directory layout: naming rules, reads, and atomic writes.

Mirrors apps/desktop/src/main/track-store/layout.ts. A version directory is
named by the first 12 hex digits of the data file's SHA-256 and is never
modified once written; `current.json` is the one mutable file per track and is
replaced atomically.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

META_SCHEMA = "dnaforge.track-meta.v1"
CURRENT_SCHEMA = "dnaforge.track-current.v1"
META_FILE = "meta.json"
CURRENT_FILE = "current.json"

TRACK_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
ASSEMBLY_ACCESSION = re.compile(r"^[A-Za-z]{1,6}_?[A-Za-z]{0,4}[0-9]+\.[0-9]+$")
TRACK_VERSION = re.compile(r"^[0-9a-f]{12}$")
_WINDOWS_RESERVED = re.compile(r"^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$", re.I)


class TrackStoreError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def track_slug_problem(value: str) -> str | None:
    if not value:
        return "A track name is required."
    if not TRACK_SLUG.match(value):
        return (
            "A track name uses lowercase letters, digits and hyphens, starts with a "
            "letter or digit, and is at most 48 characters."
        )
    if _WINDOWS_RESERVED.match(value):
        return "That name is reserved by Windows and cannot be a directory."
    return None


def assert_accession(accession: str) -> None:
    if not ASSEMBLY_ACCESSION.match(accession):
        raise TrackStoreError(
            "bad-accession",
            f'"{accession}" is not a versioned accession such as NC_000913.3.',
        )


def assert_track_slug(track: str) -> None:
    problem = track_slug_problem(track)
    if problem:
        raise TrackStoreError("bad-track-name", problem)


def assert_version(version: str) -> None:
    if not TRACK_VERSION.match(version):
        raise TrackStoreError("bad-version", f'"{version}" is not a track version.')


def track_directory(store_root: Path, accession: str, track: str) -> Path:
    assert_accession(accession)
    assert_track_slug(track)
    return store_root / accession / track


def version_directory(
    store_root: Path, accession: str, track: str, version: str
) -> Path:
    assert_version(version)
    return track_directory(store_root, accession, track) / version


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def version_id(data: bytes) -> str:
    """The version a data file gets: the first 12 hex digits of its SHA-256."""
    return sha256_hex(data)[:12]


def _read_json(path: Path) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise TrackStoreError("not-found", f"{path} does not exist.") from exc
    except OSError as exc:
        raise TrackStoreError("unreadable", f"{path} could not be read: {exc}") from exc
    try:
        return json.loads(text)
    except ValueError as exc:
        raise TrackStoreError("unreadable", f"{path} is not valid JSON: {exc}") from exc


def read_current(track_dir: Path) -> dict:
    current = _read_json(track_dir / CURRENT_FILE)
    if (
        not isinstance(current, dict)
        or current.get("schema") != CURRENT_SCHEMA
        or not isinstance(current.get("version"), str)
        or not TRACK_VERSION.match(current["version"])
    ):
        raise TrackStoreError(
            "unreadable", f"{track_dir / CURRENT_FILE} is not a {CURRENT_SCHEMA} file."
        )
    return current


def read_meta(version_dir: Path) -> dict:
    meta = _read_json(version_dir / META_FILE)
    if not isinstance(meta, dict) or meta.get("schema") != META_SCHEMA:
        raise TrackStoreError(
            "unreadable", f"{version_dir / META_FILE} is not a {META_SCHEMA} file."
        )
    return meta


def _write_json_atomic(path: Path, value: Any) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


def write_current(
    store_root: Path,
    accession: str,
    track: str,
    version: str,
    *,
    reason: str | None = None,
    now: datetime | None = None,
) -> dict:
    track_dir = track_directory(store_root, accession, track)
    assert_version(version)
    selected_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    current = {
        "schema": CURRENT_SCHEMA,
        "version": version,
        "selectedAt": selected_at.isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        ),
    }
    if reason:
        current["reason"] = reason
    track_dir.mkdir(parents=True, exist_ok=True)
    _write_json_atomic(track_dir / CURRENT_FILE, current)
    return current


def write_version(store_root: Path, meta: dict, data: bytes) -> Path:
    """Create one immutable version directory: the data file and its metadata.

    Refuses when the directory already exists, because a version's contents are
    fixed by its name; callers that want "same bytes, nothing to do" check for
    the directory first.
    """
    expected = version_id(data)
    if meta.get("version") != expected:
        raise TrackStoreError(
            "bad-version",
            f"meta.json names version {meta.get('version')} but the file's bytes give {expected}.",
        )
    version_dir = version_directory(
        store_root, meta["assembly"]["accession"], meta["track"], meta["version"]
    )
    if version_dir.exists():
        raise TrackStoreError("already-exists", f"{version_dir} already exists.")
    staging = version_dir.with_name(f"{version_dir.name}.{os.getpid()}.staging")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    try:
        (staging / meta["file"]["name"]).write_bytes(data)
        (staging / META_FILE).write_text(
            json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        staging.rename(version_dir)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return version_dir


__all__ = [
    "ASSEMBLY_ACCESSION",
    "CURRENT_FILE",
    "CURRENT_SCHEMA",
    "META_FILE",
    "META_SCHEMA",
    "TRACK_SLUG",
    "TRACK_VERSION",
    "TrackStoreError",
    "assert_accession",
    "assert_track_slug",
    "assert_version",
    "read_current",
    "read_meta",
    "sha256_hex",
    "track_directory",
    "track_slug_problem",
    "version_directory",
    "version_id",
    "write_current",
    "write_version",
]
