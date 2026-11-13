"""Annotation database setup and management.

Handles downloading, extracting, validating, and versioning the BLAST/Diamond/
Infernal databases required for plasmid annotation.
"""

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid
from pathlib import Path
from typing import AsyncGenerator

from .asset_updater import (
    VersionedAssetSpec,
    asset_needs_update,
    download_and_swap_asset,
    ensure_asset_current,
    fetch_asset,
    get_asset_version,
    is_updating,
    verify_sha256,
)
from .provisioning_lock import (
    annotation_installation_is_locked,
    annotation_installation_needs_recovery,
)

logger = logging.getLogger(__name__)

ANNOTATION_VERSION = "1.2.2"
ANNOTATION_DB_ASSET_VERSION = ".".join(ANNOTATION_VERSION.split(".")[:2] + ["0"])
DB_DOWNLOAD_URL = (
    f"https://github.com/mmcguffi/pLannotate/releases/download/"
    f"v{ANNOTATION_DB_ASSET_VERSION}/BLAST_dbs.tar.gz"
)

SWISSPROT_DETAILS_URL = (
    f"https://github.com/mmcguffi/pLannotate/raw/"
    f"v{ANNOTATION_VERSION}/plannotate/data/data/swissprot.csv.gz"
)

EXPECTED_DB_FILES = [
    "BLAST_dbs/snapgene.nsq",
    "BLAST_dbs/fpbase.dmnd",
    "BLAST_dbs/swissprot.dmnd",
    "BLAST_dbs/Rfam.clanin",
    "BLAST_dbs/Rfam.cm",
    "BLAST_dbs/Rfam.cm.i1f",
    "BLAST_dbs/Rfam.cm.i1i",
    "BLAST_dbs/Rfam.cm.i1m",
    "BLAST_dbs/Rfam.cm.i1p",
    "swissprot.csv.gz",
]

BUNDLED_RFAM_VERSION = "14.5"
RFAM_VERSION = "15.1"
RFAM_DB_URL = f"https://downloads.dnaforge.com/annotation-db/rfam/Rfam-{RFAM_VERSION}-pressed.tar.gz"
RFAM_SHA256 = "0b98b9ea5266b26d0010270ca97e73972691aa1d7cbeacb151723ee7bdb5591f"
RFAM_ASSET_FILES = [
    "Rfam.cm",
    "Rfam.cm.i1f",
    "Rfam.cm.i1i",
    "Rfam.cm.i1m",
    "Rfam.cm.i1p",
    "Rfam.clanin",
]
RFAM_VERSION_FILE = "rfam-version.json"
MAX_RFAM_UPDATE_ATTEMPTS = 3
RFAM_DOWNLOAD_TIMEOUT_S = 300
RFAM_MIN_FREE_BYTES = 1_500_000_000

PLANNOTATE_DBS_VERSION = "1.2.0"
PLANNOTATE_DBS_URL = (
    "https://downloads.dnaforge.com/"
    f"annotation-db/plannotate/plannotate-dbs-{PLANNOTATE_DBS_VERSION}.tar.gz"
)
PLANNOTATE_DBS_SHA256 = (
    "cf651656e2188c35580d4a4c025a1b742c454413f91a466a41310a51aa43ea2a"
)
PLANNOTATE_DBS_FILES = [
    "snapgene.ndb",
    "snapgene.nhr",
    "snapgene.nin",
    "snapgene.nog",
    "snapgene.nos",
    "snapgene.not",
    "snapgene.nsq",
    "snapgene.ntf",
    "snapgene.nto",
    "fpbase.dmnd",
    "swissprot.dmnd",
]
PLANNOTATE_DBS_VERSION_FILE = "plannotate-dbs-version.json"
PLANNOTATE_DBS_MIN_FREE_BYTES = 1_000_000_000
PLANNOTATE_DBS_VALIDATE_TIMEOUT_S = 120
DEFAULT_ASSET_DOWNLOAD_TIMEOUT_S = 300
DEFAULT_ASSET_UPDATE_ATTEMPTS = 3

SWISSPROT_DETAILS_R2_URL = f"https://downloads.dnaforge.com/annotation-db/plannotate/swissprot-{PLANNOTATE_DBS_VERSION}.csv.gz"


def get_app_data_base() -> Path:
    """Get the platform-specific Waypoint app data base directory.

    Checks WAYPOINT_DATA_DIR env var first, then platform-specific paths.
    Shared by annotation (setup.py) and tool downloads (tools.py).
    """
    env_override = os.environ.get("WAYPOINT_DATA_DIR")
    if env_override:
        return Path(env_override)
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Waypoint"
    elif os.name == "nt":
        return (
            Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
            / "Waypoint"
        )
    else:
        return (
            Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
            / "waypoint"
        )


def get_annotation_data_dir() -> Path:
    """Get the annotation data directory.

    Checks WAYPOINT_DATA_DIR env var first, then platform-specific app data.
    """
    data_dir = get_app_data_base() / "annotation"
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def _asset_series(version: str) -> str:
    """The DB-asset identity of a version string: its major.minor.

    The 309 MB BLAST_dbs.tar.gz is pinned to ANNOTATION_DB_ASSET_VERSION
    (major.minor.0), so what determines the downloaded bytes is the major.minor
    series — NOT the patch. Keying staleness on the full ANNOTATION_VERSION would
    force a full re-download of byte-identical data on a code-only patch bump
    . Compare the series instead.
    """
    return ".".join(version.split(".")[:2])


def get_database_status(data_dir: Path | None = None) -> dict:
    """Check annotation database status."""
    if data_dir is None:
        data_dir = get_annotation_data_dir()

    version_file = data_dir / "version.json"
    version = None
    if version_file.exists():
        try:
            version = json.loads(version_file.read_text()).get("version")
        except (json.JSONDecodeError, KeyError):
            pass

    downloaded = validate_databases(data_dir)

    return {
        "downloaded": downloaded,
        "version": version,
        "path": str(data_dir),
        "expected_version": ANNOTATION_VERSION,
        "needs_update": (
            version is not None
            and _asset_series(version) != _asset_series(ANNOTATION_DB_ASSET_VERSION)
        ),
    }


def validate_databases(data_dir: Path) -> bool:
    """Check if all expected database files exist."""
    for expected in EXPECTED_DB_FILES:
        if not (data_dir / expected).exists():
            return False
    return True


def _record_bundle_version(data_dir: Path) -> None:
    """Record the freshly-(re)installed pLannotate DB bundle version AND drop the
    rfam-version marker together, in ONE place. The bundle lays down Rfam 14.5, so
    the marker MUST be cleared or the background updater trusts a stale 15.1 marker
    and the app silently serves 14.5 (the  silent-downgrade bug). The sole
    transactional installer owns this coupled update; the streaming compatibility
    wrapper delegates to that installer."""
    (data_dir / "version.json").write_text(json.dumps({"version": ANNOTATION_VERSION}))
    (data_dir / RFAM_VERSION_FILE).unlink(missing_ok=True)


def _curl_download(
    dest: Path, urls: list[str], timeout: int
) -> subprocess.CompletedProcess:
    """curl each URL in order until one succeeds — prefer our Cloudflare R2 mirror,
    fall back to the upstream. Returns the first success, else the last failure
    (so a total outage still surfaces a real stderr). Removes the single-point-of-
    failure of depending solely on a third-party host.

    A HANGING mirror (curl runs to ``timeout``) is caught and treated as a failure
    of THAT url so the next (fallback) url is still tried — otherwise the timeout
    would escape and the whole point of the fallback is lost. ``--proto =https``
    keeps a redirect from downgrading the transport."""
    result = None
    for url in urls:
        try:
            result = subprocess.run(
                ["curl", "-fL", "--proto", "=https", "-o", str(dest), url],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            result = subprocess.CompletedProcess(
                ["curl", url],
                returncode=28,
                stdout="",
                stderr=f"curl timed out after {timeout}s",
            )
            continue
        if result.returncode == 0 and dest.exists():
            return result
    return result


_DATABASE_TRANSACTION_PREFIX = ".annotation-db-transaction-"
_DATABASE_COMMITTED_PREFIX = ".annotation-db-committed-"
_DATABASE_TRANSACTION_TARGETS = (
    "BLAST_dbs",
    "swissprot.csv.gz",
    "version.json",
    RFAM_VERSION_FILE,
)


def _remove_install_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _write_install_manifest(
    transaction: Path, *, targets: list[str], present: list[str]
) -> None:
    manifest = transaction / "manifest.json"
    with manifest.open("w", encoding="utf-8") as destination:
        json.dump({"targets": targets, "present": present}, destination)
        destination.flush()
        os.fsync(destination.fileno())


def _rollback_database_transaction(data_dir: Path, transaction: Path) -> None:
    manifest = transaction / "manifest.json"
    if not manifest.is_file():
        shutil.rmtree(transaction, ignore_errors=True)
        return
    try:
        value = json.loads(manifest.read_text())
        raw_targets = value["targets"]
        raw_present = value["present"]
        if not isinstance(raw_targets, list) or not isinstance(raw_present, list):
            return
        if not all(isinstance(item, str) for item in raw_targets + raw_present):
            return
        targets = list(raw_targets)
        present = set(raw_present)
    except (KeyError, TypeError, ValueError, OSError):
        return
    allowed = set(_DATABASE_TRANSACTION_TARGETS)
    if (
        len(targets) != len(set(targets))
        or not set(targets).issubset(allowed)
        or not present.issubset(targets)
    ):
        return
    backup = transaction / "backup"
    for relative in targets:
        source = backup / relative
        destination = data_dir / relative
        if source.exists():
            _remove_install_path(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, destination)
        elif relative not in present:
            _remove_install_path(destination)
    shutil.rmtree(transaction, ignore_errors=True)


def _recover_database_transactions(data_dir: Path) -> None:
    for committed in data_dir.glob(f"{_DATABASE_COMMITTED_PREFIX}*"):
        shutil.rmtree(committed, ignore_errors=True)
    for transaction in data_dir.glob(f"{_DATABASE_TRANSACTION_PREFIX}*"):
        _rollback_database_transaction(data_dir, transaction)


def _publish_staged_databases(data_dir: Path, transaction: Path) -> None:
    staging = transaction / "staging"
    backup = transaction / "backup"
    backup.mkdir()
    targets = list(_DATABASE_TRANSACTION_TARGETS)
    present = [relative for relative in targets if (data_dir / relative).exists()]
    _write_install_manifest(transaction, targets=targets, present=present)
    try:
        for relative in present:
            source = data_dir / relative
            destination = backup / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, destination)
        for relative in ("BLAST_dbs", "swissprot.csv.gz"):
            os.replace(staging / relative, data_dir / relative)
        _record_bundle_version(data_dir)
    except BaseException:
        _rollback_database_transaction(data_dir, transaction)
        raise

    committed = data_dir / transaction.name.replace(
        _DATABASE_TRANSACTION_PREFIX, _DATABASE_COMMITTED_PREFIX, 1
    )
    os.replace(transaction, committed)
    shutil.rmtree(committed, ignore_errors=True)


def download_databases(data_dir: Path | None = None) -> dict:
    """Download and extract annotation databases.

    Returns status dict with success/error information.
    """
    if data_dir is None:
        data_dir = get_annotation_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)

    _recover_database_transactions(data_dir)
    (data_dir / "BLAST_dbs.tar.gz").unlink(missing_ok=True)
    transaction = Path(
        tempfile.mkdtemp(
            dir=str(data_dir),
            prefix=f"{_DATABASE_TRANSACTION_PREFIX}{uuid.uuid4().hex}-",
        )
    )
    staging = transaction / "staging"
    staging.mkdir()
    tarball_path = staging / "BLAST_dbs.tar.gz"

    try:
        result = subprocess.run(
            ["curl", "-fL", "-o", str(tarball_path), DB_DOWNLOAD_URL],
            capture_output=True,
            text=True,
            timeout=600,
        )
        if result.returncode != 0:
            return {"success": False, "error": f"Download failed: {result.stderr}"}

        if not tarball_path.exists():
            return {"success": False, "error": "Download completed but file not found"}

        with tarfile.open(tarball_path, "r:gz") as tar:
            tar.extractall(path=staging, filter="data")

        tarball_path.unlink(missing_ok=True)

        swissprot_dest = staging / "swissprot.csv.gz"
        result = _curl_download(
            swissprot_dest,
            [SWISSPROT_DETAILS_R2_URL, SWISSPROT_DETAILS_URL],
            300,
        )
        if result is None or result.returncode != 0 or not swissprot_dest.exists():
            err = result.stderr if result is not None else "no source URL"
            return {
                "success": False,
                "error": f"swissprot.csv.gz download failed: {err}",
            }

        if not validate_databases(staging):
            return {
                "success": False,
                "error": "Extraction completed but validation failed",
            }

        _publish_staged_databases(data_dir, transaction)

        return {"success": True, "version": ANNOTATION_VERSION, "path": str(data_dir)}

    except Exception as e:
        tarball_path.unlink(missing_ok=True)
        return {"success": False, "error": str(e)}
    finally:
        if transaction.exists():
            if (transaction / "manifest.json").exists():
                _rollback_database_transaction(data_dir, transaction)
            else:
                shutil.rmtree(transaction, ignore_errors=True)


_downloading = False
_initial_provisioning = False


def is_downloading() -> bool:
    """Whether databases are currently being downloaded."""
    return _downloading


def set_initial_annotation_provisioning(active: bool) -> None:
    """Mark the startup database/tool/update sequence as active.

    The sidecar becomes healthy before its background provisioning task finishes.
    Exposing that whole window prevents an annotation reader from opening Rfam on
    Windows while the updater is replacing the same files.
    """
    global _initial_provisioning
    _initial_provisioning = active


def is_annotation_provisioning() -> bool:
    """Whether annotation databases are unsafe to read right now."""
    return (
        _initial_provisioning
        or _downloading
        or is_updating("rfam")
        or is_updating("plannotate-dbs")
        or annotation_installation_is_locked(get_app_data_base())
        or annotation_installation_needs_recovery(get_app_data_base())
    )


async def ensure_databases(data_dir: Path | None = None) -> None:
    """Ensure annotation databases are present, downloading if needed.

    Called during sidecar startup. Runs download in a thread to avoid
    blocking the event loop. Logs errors but never raises — the sidecar
    must start even if download fails.
    """
    if data_dir is None:
        data_dir = get_annotation_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    _recover_database_transactions(data_dir)

    if validate_databases(data_dir):
        status = get_database_status(data_dir)
        if not status.get("needs_update"):
            print(f"[annotation] Databases found at {data_dir}")
            return
        print(
            f"[annotation] Databases present but stale "
            f"(v{status.get('version')} -> v{status.get('expected_version')}); "
            f"refreshing at {data_dir}..."
        )
    else:
        if os.environ.get("DNAFORGE_OFFLINE_ANNOTATION") == "1":
            print(
                "[annotation] Offline annotation mode forbids provisioning; "
                f"databases are incomplete at {data_dir}"
            )
            return
        print(f"[annotation] Databases not found, downloading to {data_dir}...")

    if os.environ.get("DNAFORGE_OFFLINE_ANNOTATION") == "1":
        print("[annotation] Offline annotation mode forbids refreshing stale databases")
        return

    global _downloading
    _downloading = True
    try:
        result = await asyncio.to_thread(download_databases, data_dir)
        if result["success"]:
            print(
                f"[annotation] Databases downloaded successfully (v{result.get('version', '?')})"
            )
        else:
            print(
                f"[annotation] Database download failed: {result.get('error', 'unknown')}"
            )
            print("[annotation] Annotation will be unavailable. Retry from Settings.")
    except Exception as e:
        print(f"[annotation] Database download error: {e}")
        print("[annotation] Annotation will be unavailable. Retry from Settings.")
    finally:
        _downloading = False


_download_lock = asyncio.Lock()


async def download_databases_stream(
    data_dir: Path | None = None,
) -> AsyncGenerator[dict, None]:
    """Report a streamed result for the transactional database installer.

    Events:
        progress: {"phase": str, "detail": str}
        complete: {"success": True, "version": str, "path": str}
        error:    {"message": str}
    """
    if _download_lock.locked():
        yield {"event": "error", "data": {"message": "Download already in progress"}}
        return

    async with _download_lock:
        if data_dir is None:
            data_dir = get_annotation_data_dir()
        yield {
            "event": "progress",
            "data": {"phase": "downloading", "detail": "Starting download..."},
        }
        result = await asyncio.to_thread(download_databases, data_dir)
        if not result["success"]:
            yield {
                "event": "error",
                "data": {"message": result.get("error", "Database setup failed")},
            }
            return
        yield {"event": "complete", "data": result}


RFAM_VALIDATE_TIMEOUT_S = 180


def _is_windows() -> bool:
    return os.name == "nt"


_rfam_runtime_ready = not _is_windows()


def is_rfam_runtime_ready() -> bool:
    """Whether this process has proven its Rfam indexes load on this platform."""
    return _rfam_runtime_ready


def _infernal_binary(name: str) -> str | None:
    """Resolve a bundled Infernal executable without creating an import cycle."""
    from ..services.plannotate import find_binaries_dir, get_binary_path

    binaries_dir = find_binaries_dir()
    return get_binary_path(name, binaries_dir) or shutil.which(name)


def _press_rfam_for_windows(install_dir: Path) -> None:
    """Create Windows-native binary indexes for the portable Rfam CM flatfile."""
    cmpress = _infernal_binary("cmpress")
    if not cmpress:
        raise RuntimeError("cmpress is required to prepare Rfam on Windows")

    cm = install_dir / "Rfam.cm"
    result = subprocess.run(
        [cmpress, "-F", str(cm)],
        capture_output=True,
        text=True,
        timeout=RFAM_VALIDATE_TIMEOUT_S,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[:400]
        raise RuntimeError(
            f"cmpress could not create Windows Rfam indexes (exit {result.returncode}): {detail}"
        )


def _probe_rfam_loads(install_dir: Path) -> None:
    """Run one real cmscan load probe against the installed Rfam database."""
    cmscan = _infernal_binary("cmscan")
    if not cmscan:
        logger.info("[annotation] cmscan not found; skipping Rfam load validation")
        return

    cm = install_dir / "Rfam.cm"
    clanin = install_dir / "Rfam.clanin"
    with tempfile.TemporaryDirectory() as td:
        fasta = Path(td) / "probe.fa"
        fasta.write_text(">probe\n" + "ACGT" * 20 + "\n")
        tblout = Path(td) / "probe.tbl"
        try:
            result = subprocess.run(
                [
                    cmscan,
                    "--cut_ga",
                    "--noali",
                    "--nohmmonly",
                    "--fmt",
                    "2",
                    "--tblout",
                    str(tblout),
                    "--clanin",
                    str(clanin),
                    str(cm),
                    str(fasta),
                ],
                capture_output=True,
                text=True,
                timeout=RFAM_VALIDATE_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            logger.warning(
                "[annotation] Rfam load validation timed out; proceeding "
                "(inconclusive — not treated as a bad asset)"
            )
            return
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[:400]
        raise RuntimeError(
            f"cmscan could not load the swapped Rfam DB (exit {result.returncode}): {detail}"
        )


def _validate_rfam_loads(install_dir: Path) -> None:
    """Q2 post-install probe: prove the freshly-swapped, pre-pressed Rfam DB
    actually LOADS under the bundled cmscan on THIS machine before the version is
    recorded.

    A real functional load test is the only thing that proves the ``.i1*`` press
    indexes are compatible with this platform's Infernal build (sha256 already
    ruled out corruption upstream). It **fails OPEN** when it cannot run (cmscan
    absent, or the scan times out on a slow machine) so a good asset is never
    wrongly rejected, and **fails CLOSED** (raises → the generic swap rolls back,
    records no version, and does NOT retry) only on a DEFINITIVE cmscan load
    failure — so a platform-incompatible asset can never brick annotation; the
    working Rfam keeps serving.
    """
    global _rfam_runtime_ready
    if _is_windows():
        _press_rfam_for_windows(install_dir)
    _probe_rfam_loads(install_dir)
    _rfam_runtime_ready = True


async def ensure_rfam_platform_compatible(data_dir: Path | None = None) -> None:
    """Best-effort proof/repair of the currently installed Rfam indexes.

    The Rfam ``.cm`` flatfile is portable, but the pressed ``.i1*`` files are
    binary. Windows must create them with the same native Infernal build that
    will read them. This also repairs the bundled fallback when a network update
    cannot run.
    """
    global _rfam_runtime_ready
    if not _is_windows():
        _rfam_runtime_ready = True
        return
    if data_dir is None:
        data_dir = get_annotation_data_dir()
    install_dir = data_dir / "BLAST_dbs"
    if not (install_dir / "Rfam.cm").exists():
        return
    try:
        await asyncio.to_thread(_probe_rfam_loads, install_dir)
    except RuntimeError:
        try:
            await asyncio.to_thread(_press_rfam_for_windows, install_dir)
            await asyncio.to_thread(_probe_rfam_loads, install_dir)
        except Exception:
            _rfam_runtime_ready = False
            logger.error(
                "[annotation] Windows Rfam index preparation failed",
                exc_info=True,
            )
            return
    _rfam_runtime_ready = True


def _rfam_spec() -> VersionedAssetSpec:
    """Build the Rfam asset spec from the live module constants (read fresh so a
    test that monkeypatches e.g. ``RFAM_MIN_FREE_BYTES`` or ``_validate_rfam_loads``
    reconfigures the updater)."""
    return VersionedAssetSpec(
        asset_id="rfam",
        target_version=RFAM_VERSION,
        url=RFAM_DB_URL,
        sha256=RFAM_SHA256,
        files=RFAM_ASSET_FILES,
        install_subdir="BLAST_dbs",
        version_filename=RFAM_VERSION_FILE,
        version_key="rfam_version",
        bundled_version=BUNDLED_RFAM_VERSION,
        presence_probe="BLAST_dbs/Rfam.cm",
        min_free_bytes=RFAM_MIN_FREE_BYTES,
        download_timeout_s=RFAM_DOWNLOAD_TIMEOUT_S,
        max_filesize="200M",
        max_attempts=MAX_RFAM_UPDATE_ATTEMPTS,
        validate=_validate_rfam_loads,
        validation_revision="windows-native-press-v1",
    )


RFAM_ASSET_SPEC = _rfam_spec()


def get_rfam_version(data_dir: Path | None = None) -> str | None:
    """The installed Rfam release (recorded marker wins, else bundled, else None)."""
    if data_dir is None:
        data_dir = get_annotation_data_dir()
    return get_asset_version(_rfam_spec(), data_dir)


def rfam_needs_update(data_dir: Path | None = None) -> bool:
    """True when an Rfam is installed but older than the hosted target."""
    if data_dir is None:
        data_dir = get_annotation_data_dir()
    return asset_needs_update(_rfam_spec(), data_dir)


def _verify_sha256(path: Path, expected: str) -> None:
    """Back-compat alias — the implementation lives in ``asset_updater``."""
    verify_sha256(path, expected)


def _fetch_rfam_asset(staging: Path) -> None:
    """Back-compat wrapper: download+verify+extract the pre-pressed Rfam asset."""
    fetch_asset(_rfam_spec(), staging)


def _download_and_swap_rfam(data_dir: Path, *, _fetch=None) -> None:
    """Back-compat wrapper over the generic transactional swap. ``_fetch`` keeps
    the historical single-arg ``_fetch(staging)`` signature used by the tests."""
    adapted = (lambda _spec, staging: _fetch(staging)) if _fetch is not None else None
    download_and_swap_asset(_rfam_spec(), data_dir, _fetch=adapted)


def is_updating_rfam() -> bool:
    """Whether a background Rfam update is in flight."""
    return is_updating("rfam")


async def ensure_rfam_current(data_dir: Path | None = None) -> None:
    """Best-effort background update of Rfam to ``RFAM_VERSION`` via the generic
    ``ensure_asset_current``. Never blocks startup, never raises; skips when the
    base DB is absent, Rfam is current, or an update is already in flight; retries
    transient failures with backoff; reports terminal failure at ERROR (the
    Electron host funnels sidecar stderr to Sentry/PostHog — ."""
    if data_dir is None:
        data_dir = get_annotation_data_dir()
    await ensure_asset_current(_rfam_spec(), data_dir)


def _validate_plannotate_dbs_loads(install_dir: Path) -> None:
    """Post-install probe (Q2): prove the swapped-in Diamond databases actually
    LOAD under the bundled ``diamond`` on THIS machine before recording the version.

    Diamond's ``.dmnd`` format is VERSION-sensitive (a db built by a newer diamond
    can be unreadable by an older one), so this is the genuinely-risky part of a
    future bump — the check runs ``diamond dbinfo`` on fpbase + swissprot, which
    reads the db header without a query. snapgene is a BLAST db whose format is
    stable and is covered by the framework's file-presence check, so it needs no
    separate probe. Like the Rfam probe this **fails OPEN** when it can't run
    (diamond absent / timeout — inconclusive, proceed) and **fails CLOSED** only on
    a definitive non-zero ``dbinfo`` exit → the generic swap rolls back, records no
    version, and does not retry, keeping the working DBs.
    """
    from ..services.plannotate import find_binaries_dir, get_binary_path

    binaries_dir = find_binaries_dir()
    diamond = get_binary_path("diamond", binaries_dir) or shutil.which("diamond")
    if not diamond:
        logger.info(
            "[annotation] diamond not found; skipping plannotate-dbs load validation"
        )
        return

    for dmnd in ("fpbase.dmnd", "swissprot.dmnd"):
        db = install_dir / dmnd
        try:
            result = subprocess.run(
                [diamond, "dbinfo", "--db", str(db)],
                capture_output=True,
                text=True,
                timeout=PLANNOTATE_DBS_VALIDATE_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            logger.warning(
                "[annotation] plannotate-dbs validation timed out on %s; proceeding (inconclusive)",
                dmnd,
            )
            return
        if result.returncode != 0:
            raise RuntimeError(
                f"diamond could not load {dmnd} (exit {result.returncode}): "
                f"{(result.stderr or '').strip()[:400]}"
            )


def _plannotate_dbs_spec() -> VersionedAssetSpec:
    """Build the non-Rfam DB spec from the live module constants."""
    return VersionedAssetSpec(
        asset_id="plannotate-dbs",
        target_version=PLANNOTATE_DBS_VERSION,
        url=PLANNOTATE_DBS_URL,
        sha256=PLANNOTATE_DBS_SHA256,
        files=PLANNOTATE_DBS_FILES,
        install_subdir="BLAST_dbs",
        version_filename=PLANNOTATE_DBS_VERSION_FILE,
        version_key="plannotate_dbs_version",
        bundled_version=PLANNOTATE_DBS_VERSION,
        presence_probe="BLAST_dbs/swissprot.dmnd",
        min_free_bytes=PLANNOTATE_DBS_MIN_FREE_BYTES,
        download_timeout_s=DEFAULT_ASSET_DOWNLOAD_TIMEOUT_S,
        max_filesize="200M",
        max_attempts=DEFAULT_ASSET_UPDATE_ATTEMPTS,
        validate=_validate_plannotate_dbs_loads,
    )


PLANNOTATE_DBS_SPEC = _plannotate_dbs_spec()


async def ensure_plannotate_dbs_current(data_dir: Path | None = None) -> None:
    """Best-effort background update of the non-Rfam DBs (snapgene/fpbase/swissprot)
    to ``PLANNOTATE_DBS_VERSION`` via the generic ``ensure_asset_current``. Today a
    deliberate no-op (installed == hosted); the wiring exists so a future bump (the
    pLannotate v2 migration, or a hotfix) is a one-line constant change. Same
    guarantees as Rfam: never blocks startup, never raises."""
    if data_dir is None:
        data_dir = get_annotation_data_dir()
    await ensure_asset_current(_plannotate_dbs_spec(), data_dir)
