"""Generic background updater for versioned remote assets .

A reusable substrate for any asset that ships bundled at one version but is kept
current out-of-band by downloading a newer pre-built copy and swapping it in —
Rfam is the first consumer, but nothing here knows about Rfam. Describe an asset
with a :class:`VersionedAssetSpec` and call :func:`ensure_asset_current`.

Guarantees (identical to the hand-rolled Rfam path this generalises):

* **Verify before install** — the download is checked against a pinned sha256
  BEFORE extraction; a truncated/corrupt/tampered asset is rejected, never applied.
* **Bounded transfer** — ``curl --proto =https --max-filesize`` so a compromised
  origin/redirect can't stream an unbounded body before the hash gate rejects it.
* **Transactional swap** — every old file is moved to a rollback dir and the new
  one ``os.replace``'d in on the SAME filesystem (atomic per file); ANY failure
  restores the originals, so a partial swap never leaves a mixed old/new set.
* **Self-healing** — the version marker is written LAST, so a hard-kill mid-swap
  leaves ``needs_update`` True and the next run re-applies. Orphaned rollback dirs
  from a prior crash are reclaimed on the next run.
* **Post-install validation (optional)** — if the spec carries a ``validate``
  probe, it runs AFTER install but BEFORE the version is recorded; on failure the
  swap rolls back and the version is NOT recorded, so an asset that won't load on
  THIS platform never bricks the feature — the working copy keeps serving and the
  bad version is not retried (it's platform-incompatible, not transient).
* **Never blocks, never raises** at the :func:`ensure_asset_current` boundary —
  it runs best-effort in a thread, retries transient failures with exponential
  backoff, and reports terminal failure at ``logger.error`` (the Electron host
  funnels sidecar stderr to Sentry/PostHog; the sidecar must not init Sentry —
  .
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from src.storage_capacity import read_storage_capacity

logger = logging.getLogger(__name__)

_SWAP_LOCK_STALE_S = 3600


class AssetValidationError(RuntimeError):
    """The post-install validation probe rejected a freshly-installed asset.

    Distinct from transient download/swap failures: a validation failure means
    the asset is incompatible with THIS machine (bad indexes, wrong platform,
    unloadable), so retrying the same download is pointless — the swap is rolled
    back and the update is abandoned without retry, keeping the current asset.
    """


class AssetUpdateInProgressError(RuntimeError):
    """Another process already holds this asset's swap lock. The peer is doing the
    update; this caller should SKIP (not fail, not retry) — the annotation data dir
    is installation-global (shared across worktrees / app instances), so two
    sidecars can reach the same swap concurrently."""


@dataclass(frozen=True)
class VersionedAssetSpec:
    """Describes one versioned remote asset kept current by a background swap.

    All coordinates a generic updater needs, and nothing asset-specific in code.
    """

    asset_id: str
    """Stable slug — used in logs and to namespace the rollback dir
    (``.<asset_id>-rollback-*``) and staging tarball (``<asset_id>.tar.gz``).
    Two assets updating concurrently must have distinct ids."""

    target_version: str
    """The version we host and want installed (e.g. ``"15.1"``)."""

    url: str
    """Download URL of the pre-built tarball for ``target_version``."""

    sha256: str
    """Expected sha256 of the exact hosted tarball. Verified before extraction."""

    files: list[str]
    """Files the asset installs, relative to ``install_subdir``. All must be
    present in the download or the swap aborts; all are swapped transactionally."""

    install_subdir: str
    """Sub-directory of the data dir the files install into (e.g. ``"BLAST_dbs"``)."""

    version_filename: str
    """Marker file (under the data dir) recording the installed version."""

    version_key: str
    """JSON key inside the marker holding the version string."""

    bundled_version: str | None
    """Version to report when the marker is absent but the asset is present on
    disk (it came from the app bundle). ``None`` if there is no bundled fallback."""

    presence_probe: str
    """A path (relative to the data dir) whose existence means "the asset is
    installed" — gates both bundled-version detection and the update itself."""

    min_free_bytes: int = 0
    """Free-space pre-flight; a low-disk machine aborts cleanly (old copy intact)
    instead of ENOSPC-ing mid-swap and thrashing retries."""

    download_timeout_s: int = 300
    """curl timeout. Bounded so a background fetch can't stall sidecar shutdown."""

    max_filesize: str = "200M"
    """curl ``--max-filesize`` bound on the transfer."""

    max_attempts: int = 3
    """Retry budget for transient download/swap failures (backoff between)."""

    validate: Callable[[Path], None] | None = field(default=None, compare=False)
    """Optional post-install probe, called with the install dir
    (``data_dir / install_subdir``) after the swap and before the version is
    recorded. Raise to reject the asset (triggers rollback, no retry). ``None``
    skips validation."""

    validation_revision: str = "1"
    """Version of the validation contract. A recorded rejection is reused only
    while this value still matches, so a validator fix gets one fresh attempt."""


def verify_sha256(path: Path, expected: str) -> None:
    """Raise unless ``path``'s sha256 matches ``expected`` (streamed, not in RAM)."""
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    actual = digest.hexdigest()
    if actual != expected:
        raise RuntimeError(
            f"asset checksum mismatch: expected {expected[:12]}…, got {actual[:12]}…"
        )


def get_asset_version(spec: VersionedAssetSpec, data_dir: Path) -> str | None:
    """The installed version of ``spec``.

    An explicit version marker wins (written by a successful update); otherwise a
    present asset came from the bundle and is ``spec.bundled_version``; if the
    asset is not present at all, ``None``.
    """
    marker = data_dir / spec.version_filename
    if marker.exists():
        try:
            data = json.loads(marker.read_text())
            recorded = data.get(spec.version_key) if isinstance(data, dict) else None
            if recorded:
                return recorded
        except (json.JSONDecodeError, ValueError, OSError):
            pass
    if (data_dir / spec.presence_probe).exists():
        return spec.bundled_version
    return None


def asset_needs_update(spec: VersionedAssetSpec, data_dir: Path) -> bool:
    """True when the asset is installed but older than ``spec.target_version`` —
    UNLESS this exact target already failed post-install validation on this machine
    (platform-incompatible; a re-download can't fix it, so we don't thrash the
    ~100 MB download every launch)."""
    current = get_asset_version(spec, data_dir)
    if current is None or current == spec.target_version:
        return False
    if _validation_failed_version(data_dir, spec) == spec.target_version:
        return False
    return True


def fetch_asset(spec: VersionedAssetSpec, staging: Path) -> None:
    """Download, verify (sha256), and extract ``spec``'s tarball into ``staging``.

    The checksum is verified BEFORE extraction so a truncated/corrupt/tampered
    download is never unpacked. The transfer is bounded (``--proto =https`` +
    ``--max-filesize``) so a compromised origin can't stream an unbounded body to
    disk before the hash gate rejects it.
    """
    tarball = staging / f"{spec.asset_id}.tar.gz"
    result = subprocess.run(
        [
            "curl",
            "-fL",
            "--proto",
            "=https",
            "--max-filesize",
            spec.max_filesize,
            "-o",
            str(tarball),
            spec.url,
        ],
        capture_output=True,
        text=True,
        timeout=spec.download_timeout_s,
    )
    if result.returncode != 0 or not tarball.exists():
        raise RuntimeError(
            f"{spec.asset_id} download failed: {(result.stderr or '').strip()}"
        )
    verify_sha256(tarball, spec.sha256)
    with tarfile.open(tarball, "r:gz") as tar:
        tar.extractall(path=staging, filter="data")
    tarball.unlink(missing_ok=True)


def _run_validate(spec: VersionedAssetSpec, install_dir: Path) -> None:
    """Run the spec's post-install probe, normalising any failure to
    :class:`AssetValidationError` (so the caller can distinguish it from a
    transient download/swap error and skip retry)."""
    if spec.validate is None:
        return
    try:
        spec.validate(install_dir)
    except AssetValidationError:
        raise
    except Exception as e:  # noqa: BLE001 — any probe failure means "reject"
        raise AssetValidationError(
            f"{spec.asset_id} post-install validation failed: {e}"
        ) from e


def _acquire_swap_lock(data_dir: Path, asset_id: str) -> Path:
    """Take an exclusive per-asset swap lock via atomic ``os.mkdir`` (portable
    across platforms/filesystems). A lock older than ``_SWAP_LOCK_STALE_S`` was
    left by a crashed holder and is reclaimed. Raises ``AssetUpdateInProgressError``
    when a live peer owns it, so the caller SKIPs instead of racing the swap on the
    installation-global data dir."""
    lock = data_dir / f".{asset_id}.swap-lock"
    try:
        os.mkdir(lock)
        return lock
    except FileExistsError:
        try:
            age = time.time() - lock.stat().st_mtime
        except OSError:
            age = 0.0
        if age > _SWAP_LOCK_STALE_S:
            shutil.rmtree(lock, ignore_errors=True)
            try:
                os.mkdir(lock)
                return lock
            except OSError:
                pass
        raise AssetUpdateInProgressError(
            f"{asset_id} swap already in progress in another process"
        ) from None


def _reclaim_orphan_rollbacks(
    data_dir: Path, spec: VersionedAssetSpec, install_dir: Path
) -> None:
    """Complete a rollback interrupted by a prior crash WITHOUT ever deleting the
    sole copy of a file. For each orphaned ``.<asset_id>-rollback-*`` dir, a backed-
    up managed file is RESTORED only when its install slot is empty (recovering a
    hard-kill mid-swap); an occupied slot keeps its current file, and non-managed
    leftovers are discarded. Runs under the swap lock, so no live peer's backup is
    touched. (Replaces the old blind ``rmtree`` that could destroy the last copy —
    the  review's confirmed data-loss P1.)"""
    managed = set(spec.files)
    for orphan in data_dir.glob(f".{spec.asset_id}-rollback-*"):
        try:
            for f in orphan.iterdir():
                if f.name not in managed:
                    continue
                dest = install_dir / f.name
                if not dest.exists():
                    os.replace(str(f), str(dest))
        except OSError:
            pass
        shutil.rmtree(orphan, ignore_errors=True)


def _validation_failed_marker(data_dir: Path, spec: VersionedAssetSpec) -> Path:
    return data_dir / f".{spec.asset_id}.validation-failed.json"


def _validation_failed_version(data_dir: Path, spec: VersionedAssetSpec) -> str | None:
    """The target version last rejected by this asset's post-install probe on THIS
    machine, or None. Lets ``asset_needs_update`` skip re-downloading an asset that
    is platform-incompatible (a re-download can't fix it)."""
    marker = _validation_failed_marker(data_dir, spec)
    if not marker.exists():
        return None
    try:
        data = json.loads(marker.read_text())
        if not isinstance(data, dict):
            return None
        if data.get("validation_revision") != spec.validation_revision:
            return None
        return data.get("failed_version")
    except (json.JSONDecodeError, ValueError, OSError):
        return None


def record_validation_failure(data_dir: Path, spec: VersionedAssetSpec) -> None:
    """Persist that ``spec.target_version`` failed post-install validation here, so
    the next launch does not re-download + re-swap + re-fail the same asset forever."""
    try:
        _validation_failed_marker(data_dir, spec).write_text(
            json.dumps(
                {
                    "failed_version": spec.target_version,
                    "validation_revision": spec.validation_revision,
                }
            )
        )
    except OSError:
        pass


def _clear_validation_failure(data_dir: Path, spec: VersionedAssetSpec) -> None:
    _validation_failed_marker(data_dir, spec).unlink(missing_ok=True)


def download_and_swap_asset(
    spec: VersionedAssetSpec,
    data_dir: Path,
    *,
    _fetch: Callable[[VersionedAssetSpec, Path], None] | None = None,
) -> None:
    """Fetch ``spec`` into staging on the SAME filesystem, validate every expected
    file is present, install it with a TRANSACTIONAL swap, run the optional
    post-install probe, then record the version LAST. Raises on any failure; the
    caller (``ensure_asset_current``) handles it.

    The swap is transactional against exceptions and self-healing against a
    hard-kill, but it is NOT a read barrier: a reader that runs during the brief
    per-file rename window can see a mismatched set and fail loudly (retryable),
    never silent-wrong data. A read lock is deferred — the window is a rare, ~ms,
    once-per-update event.
    """
    fetch = _fetch or fetch_asset
    install_dir = data_dir / spec.install_subdir
    lock = _acquire_swap_lock(data_dir, spec.asset_id)
    try:
        _reclaim_orphan_rollbacks(data_dir, spec, install_dir)
        capacity = read_storage_capacity(data_dir, purpose="opportunistic")
        free = capacity.available_bytes
        if free < spec.min_free_bytes:
            raise RuntimeError(
                f"Insufficient disk for {spec.asset_id} update: {free // (1 << 20)} MB "
                f"available ({capacity.source}), need ~{spec.min_free_bytes // (1 << 20)} MB"
            )
        with tempfile.TemporaryDirectory(dir=str(data_dir)) as td:
            staging = Path(td)
            fetch(spec, staging)
            missing = [f for f in spec.files if not (staging / f).exists()]
            if missing:
                raise RuntimeError(
                    f"{spec.asset_id} asset incomplete, missing: {', '.join(missing)}"
                )
            backup = Path(
                tempfile.mkdtemp(
                    dir=str(data_dir), prefix=f".{spec.asset_id}-rollback-"
                )
            )
            installed: list[str] = []
            try:
                for name in spec.files:
                    dest = install_dir / name
                    if dest.exists():
                        os.replace(str(dest), str(backup / name))
                    os.replace(str(staging / name), str(dest))
                    installed.append(name)
                _run_validate(spec, install_dir)
            except Exception:
                for name in installed:
                    (install_dir / name).unlink(missing_ok=True)
                for original in backup.iterdir():
                    os.replace(str(original), str(install_dir / original.name))
                raise
            finally:
                shutil.rmtree(backup, ignore_errors=True)
        (data_dir / spec.version_filename).write_text(
            json.dumps({spec.version_key: spec.target_version})
        )
        _clear_validation_failure(data_dir, spec)
    finally:
        shutil.rmtree(lock, ignore_errors=True)


_in_flight: set[str] = set()


def is_updating(asset_id: str) -> bool:
    """Whether a background update for ``asset_id`` is in flight."""
    return asset_id in _in_flight


async def ensure_asset_current(spec: VersionedAssetSpec, data_dir: Path) -> None:
    """Best-effort background update of ``spec`` to ``spec.target_version``.

    Never blocks startup, never raises. Skips when the asset is absent, already
    current, or an update for this asset is already in flight (re-entrancy guard).
    Retries transient failures with exponential backoff; a validation failure is
    terminal (no retry). On terminal failure logs at ERROR — the Electron host
    funnels sidecar stderr to Sentry/PostHog  — and leaves the existing
    asset serving.
    """
    if not (data_dir / spec.presence_probe).exists():
        return
    if not asset_needs_update(spec, data_dir):
        return
    if spec.asset_id in _in_flight:
        return

    _in_flight.add(spec.asset_id)
    try:
        for attempt in range(1, spec.max_attempts + 1):
            try:
                await asyncio.to_thread(download_and_swap_asset, spec, data_dir)
                logger.info(
                    "[asset-updater] %s updated to %s",
                    spec.asset_id,
                    spec.target_version,
                )
                return
            except AssetValidationError:
                record_validation_failure(data_dir, spec)
                logger.error(
                    "[asset-updater] %s %s failed post-install validation; "
                    "rolled back and kept the current asset (no retry).",
                    spec.asset_id,
                    spec.target_version,
                    exc_info=True,
                )
                return
            except AssetUpdateInProgressError:
                logger.info(
                    "[asset-updater] %s swap in progress in another process; skipping",
                    spec.asset_id,
                )
                return
            except Exception:
                logger.warning(
                    "[asset-updater] %s update attempt %d/%d failed",
                    spec.asset_id,
                    attempt,
                    spec.max_attempts,
                    exc_info=True,
                )
                if attempt < spec.max_attempts:
                    await asyncio.sleep(2**attempt)
        logger.error(
            "[asset-updater] %s update to %s failed after %d attempts; keeping the current asset.",
            spec.asset_id,
            spec.target_version,
            spec.max_attempts,
        )
    finally:
        _in_flight.discard(spec.asset_id)
