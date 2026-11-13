"""Tool registry and runtime binary download for bioinformatics tools.

Manages downloading, extracting, and validating third-party binaries
(BLAST+, Diamond, Infernal) at runtime. These are required by the
annotation pipeline but too large to bundle in the app.

Architecture mirrors annotation/setup.py (database downloads) —
same patterns for download/extract/validate/version tracking.
"""

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import uuid
from pathlib import Path

_RELEASE_ASSET_BASE_URL = "https://downloads.dnaforge.com"


def _release_asset_url(key: str) -> str:
    """Resolve a content-addressed archive from DNAForge's immutable mirror."""
    return f"{_RELEASE_ASSET_BASE_URL}/{key}"


TOOL_REGISTRY: dict = {
    "blast": {
        "version": "2.16.0",
        "required_by": "plannotate",
        "platforms": {
            "aarch64-apple-darwin": {
                "url": _release_asset_url(
                    "tools/v1/blast/2.16.0/d81927ba817a48074408a7dce866a81fc117bfaba6ff94c44ca3f4bdbb2f03af/ncbi-blast-2.16.0+-universal-macosx.tar.gz"
                ),
                "sha256": "d81927ba817a48074408a7dce866a81fc117bfaba6ff94c44ca3f4bdbb2f03af",
                "archive_type": "tar.gz",
                "binaries": {
                    "blastn": "ncbi-blast-2.16.0+/bin/blastn",
                    "makeblastdb": "ncbi-blast-2.16.0+/bin/makeblastdb",
                },
            },
            "x86_64-apple-darwin": {
                "url": _release_asset_url(
                    "tools/v1/blast/2.16.0/d81927ba817a48074408a7dce866a81fc117bfaba6ff94c44ca3f4bdbb2f03af/ncbi-blast-2.16.0+-universal-macosx.tar.gz"
                ),
                "sha256": "d81927ba817a48074408a7dce866a81fc117bfaba6ff94c44ca3f4bdbb2f03af",
                "archive_type": "tar.gz",
                "binaries": {
                    "blastn": "ncbi-blast-2.16.0+/bin/blastn",
                    "makeblastdb": "ncbi-blast-2.16.0+/bin/makeblastdb",
                },
            },
            "x86_64-unknown-linux-gnu": {
                "url": _release_asset_url(
                    "tools/v1/blast/2.16.0/b0b13098c901d23b324ad1700e7471bb7408a7f7f517d74d5faad711be76e8f4/ncbi-blast-2.16.0+-x64-linux.tar.gz"
                ),
                "sha256": "b0b13098c901d23b324ad1700e7471bb7408a7f7f517d74d5faad711be76e8f4",
                "archive_type": "tar.gz",
                "binaries": {
                    "blastn": "ncbi-blast-2.16.0+/bin/blastn",
                    "makeblastdb": "ncbi-blast-2.16.0+/bin/makeblastdb",
                },
            },
            "x86_64-pc-windows-msvc": {
                "url": _release_asset_url(
                    "tools/v1/blast/2.16.0/3b6f27a72e9a875f1c02119704775a8e04ae97b5e4a148b560f9be9acd39e943/ncbi-blast-2.16.0+-x64-win64.tar.gz"
                ),
                "sha256": "3b6f27a72e9a875f1c02119704775a8e04ae97b5e4a148b560f9be9acd39e943",
                "archive_type": "tar.gz",
                "binaries": {
                    "blastn": "ncbi-blast-2.16.0+/bin/blastn.exe",
                    "makeblastdb": "ncbi-blast-2.16.0+/bin/makeblastdb.exe",
                },
            },
        },
    },
    "diamond": {
        "version": "2.1.19",
        "required_by": "plannotate",
        "platforms": {
            "aarch64-apple-darwin": {
                "url": _release_asset_url(
                    "tools/v1/diamond/2.1.19/e1718a7c91deff53f2d8ce8b813f39ec440b0aef1bbdd7f97a7d789abbdeaae9/diamond-macos.tar.gz"
                ),
                "sha256": "e1718a7c91deff53f2d8ce8b813f39ec440b0aef1bbdd7f97a7d789abbdeaae9",
                "archive_type": "tar.gz",
                "binaries": {
                    "diamond": "diamond",
                },
            },
            "x86_64-apple-darwin": {
                "url": _release_asset_url(
                    "tools/v1/diamond/2.1.19/e1718a7c91deff53f2d8ce8b813f39ec440b0aef1bbdd7f97a7d789abbdeaae9/diamond-macos.tar.gz"
                ),
                "sha256": "e1718a7c91deff53f2d8ce8b813f39ec440b0aef1bbdd7f97a7d789abbdeaae9",
                "archive_type": "tar.gz",
                "binaries": {
                    "diamond": "diamond",
                },
            },
            "x86_64-unknown-linux-gnu": {
                "url": _release_asset_url(
                    "tools/v1/diamond/2.1.19/78639951afd94c4d8b9e987e62869ade0c883e07af03b8da1114e3157a9e8fc3/diamond-linux64.tar.gz"
                ),
                "sha256": "78639951afd94c4d8b9e987e62869ade0c883e07af03b8da1114e3157a9e8fc3",
                "archive_type": "tar.gz",
                "binaries": {
                    "diamond": "diamond",
                },
            },
            "x86_64-pc-windows-msvc": {
                "url": _release_asset_url(
                    "tools/v1/diamond/2.1.19/e0095d040e0ac2ee024895fb9d9a3816e9b727bbe1d107de97e5cad78ee75b22/diamond-windows.zip"
                ),
                "sha256": "e0095d040e0ac2ee024895fb9d9a3816e9b727bbe1d107de97e5cad78ee75b22",
                "archive_type": "zip",
                "binaries": {
                    "diamond": "diamond.exe",
                },
            },
        },
    },
    "infernal": {
        "version": "1.1.5",
        "required_by": "plannotate",
        "platforms": {
            "aarch64-apple-darwin": {
                "url": _release_asset_url(
                    "tools/v1/infernal/1.1.5/5eec904168e01c7bc7ccb971b5de04919527b204d4a55a69aa3f9f584e76edb2/infernal-1.1.5-macosx-silicon.tar.gz"
                ),
                "sha256": "5eec904168e01c7bc7ccb971b5de04919527b204d4a55a69aa3f9f584e76edb2",
                "archive_type": "tar.gz",
                "binaries": {
                    "cmscan": "infernal-1.1.5-macosx-silicon/binaries/cmscan",
                },
            },
            "x86_64-apple-darwin": {
                "url": _release_asset_url(
                    "tools/v1/infernal/1.1.5/d55babd2d5a33322c8796f335fecb6408f7e3b3a2e04cbb1da8e1cdf93b60028/infernal-1.1.5-macosx-intel.tar.gz"
                ),
                "sha256": "d55babd2d5a33322c8796f335fecb6408f7e3b3a2e04cbb1da8e1cdf93b60028",
                "archive_type": "tar.gz",
                "binaries": {
                    "cmscan": "infernal-1.1.5-macosx-intel/binaries/cmscan",
                },
            },
            "x86_64-unknown-linux-gnu": {
                "url": _release_asset_url(
                    "tools/v1/infernal/1.1.5/df89bc3d54e606d6fccdc4f8571781f48431278727c18f0a73cc3b5e9f66566b/infernal-1.1.5-linux-intel-gcc.tar.gz"
                ),
                "sha256": "df89bc3d54e606d6fccdc4f8571781f48431278727c18f0a73cc3b5e9f66566b",
                "archive_type": "tar.gz",
                "binaries": {
                    "cmscan": "infernal-1.1.5-linux-intel-gcc/binaries/cmscan",
                },
            },
            "x86_64-pc-windows-msvc": {
                "url": _release_asset_url(
                    "tools/v1/infernal/1.1.5/ad4ddae02f924ca7c85bc8c4a79c9f875af8df96aeb726702fa985cbe752497f/infernal-1.1.5.tar.gz"
                ),
                "sha256": "ad4ddae02f924ca7c85bc8c4a79c9f875af8df96aeb726702fa985cbe752497f",
                "archive_type": "tar.gz",
                "binaries": {
                    "cmscan": "cmscan.exe",
                    "cmpress": "cmpress.exe",
                },
            },
        },
    },
    "mafft": {
        "version": "7.526",
        "required_by": "alignment",
        "extract_dir": True,
        "platforms": {
            "aarch64-apple-darwin": {
                "url": _release_asset_url(
                    "tools/v1/mafft/7.526/704e0d2284f87b1b40e7f065359880967649136d4d328809b00288e2370be71f/mafft-7.526-mac.zip"
                ),
                "sha256": "704e0d2284f87b1b40e7f065359880967649136d4d328809b00288e2370be71f",
                "archive_type": "zip",
                "archive_root": "mafft-mac",
                "binaries": {
                    "mafft": "mafft-mac/mafftdir/bin/mafft",
                },
            },
            "x86_64-apple-darwin": {
                "url": _release_asset_url(
                    "tools/v1/mafft/7.526/704e0d2284f87b1b40e7f065359880967649136d4d328809b00288e2370be71f/mafft-7.526-mac.zip"
                ),
                "sha256": "704e0d2284f87b1b40e7f065359880967649136d4d328809b00288e2370be71f",
                "archive_type": "zip",
                "archive_root": "mafft-mac",
                "binaries": {
                    "mafft": "mafft-mac/mafftdir/bin/mafft",
                },
            },
            "x86_64-unknown-linux-gnu": {
                "url": _release_asset_url(
                    "tools/v1/mafft/7.526/8a82f15c92e352592961691de671591b8117034a2375987ad2746dc4c447be67/mafft-7.526-linux-dnaforge.tgz"
                ),
                "sha256": "8a82f15c92e352592961691de671591b8117034a2375987ad2746dc4c447be67",
                "archive_type": "tar.gz",
                "archive_root": "mafft-linux64",
                "binaries": {
                    "mafft": "mafft-linux64/mafftdir/bin/mafft",
                },
            },
            "x86_64-pc-windows-msvc": {
                "url": _release_asset_url(
                    "tools/v1/mafft/7.526/89be74dc9c45b82f0a6f8fce195113a7e98bab98ae1144da9e81a23b4fe2c90f/mafft-7.526-win64-dnaforge.zip"
                ),
                "sha256": "89be74dc9c45b82f0a6f8fce195113a7e98bab98ae1144da9e81a23b4fe2c90f",
                "archive_type": "zip",
                "archive_root": "mafft-win",
                "binaries": {
                    "mafft": "mafft-win/mafft.bat",
                },
            },
        },
    },
}


def get_all_binary_names(required_by: str | None = None) -> list[str]:
    """Return deduplicated list of binary names from TOOL_REGISTRY.

    Args:
        required_by: Filter to tools required by a specific capability
                     (e.g., "plannotate", "alignment"). None returns all.
    """
    return list(get_binary_versions(required_by=required_by).keys())


def get_binary_versions(required_by: str | None = None) -> dict[str, str]:
    """Return {binary_name: version} from TOOL_REGISTRY, deduplicated.

    Platform-INDEPENDENT: uses the first platform entry per tool for the binary
    names. Use get_platform_binary_versions() when you need "what actually ships
    on THIS platform".

    Args:
        required_by: Filter to tools required by a specific capability. None returns all.
    """
    result: dict[str, str] = {}
    for info in TOOL_REGISTRY.values():
        if required_by and info.get("required_by") != required_by:
            continue
        for platform_info in info["platforms"].values():
            for binary_name in platform_info["binaries"]:
                if binary_name not in result:
                    result[binary_name] = info["version"]
            break
    return result


def get_platform_binary_versions(
    required_by: str | None = None, suffix: str | None = None
) -> dict[str, str]:
    """Return {binary_name: version} for tools that SHIP a build for `suffix`.

    Unlike get_binary_versions() (platform-independent, first-entry names), this
    returns only binaries whose registry entry declares a build for the given
    platform suffix (defaults to the current platform). A tool with no entry for
    the platform is omitted. This is the SSOT for platform-aware tool presence
    /: registry declares the build → the platform expects it.
    """
    if suffix is None:
        from ..toolbox.executable_paths import get_platform_suffix

        suffix = get_platform_suffix()

    result: dict[str, str] = {}
    for info in TOOL_REGISTRY.values():
        if required_by and info.get("required_by") != required_by:
            continue
        pdata = info["platforms"].get(suffix)
        if pdata is None:
            continue
        for binary_name in pdata["binaries"]:
            result.setdefault(binary_name, info["version"])
    return result


def get_platform_binary_names(
    required_by: str | None = None, suffix: str | None = None
) -> list[str]:
    """Binary names that ship a build for the current (or given) platform."""
    return list(
        get_platform_binary_versions(required_by=required_by, suffix=suffix).keys()
    )


SUPPORTED_PLATFORMS: tuple[str, ...] = (
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc",
)

PLATFORM_TOOL_EXCEPTIONS: dict[str, frozenset[str]] = {}


def tools_expected_for_platform(suffix: str) -> list[str]:
    """Registry tool IDs that MUST ship a build for ``suffix``.

    = every tool minus that platform's documented exceptions. This is the list
    the parity test asserts against — the SSOT for "both OSs have the right
    things" (the user's ask on .
    """
    exceptions = PLATFORM_TOOL_EXCEPTIONS.get(suffix, frozenset())
    return [name for name in TOOL_REGISTRY if name not in exceptions]


def get_bundle_manifest(suffix: str) -> dict[str, dict]:
    """Resolve the exact tool set + bundled file layout for ``suffix``.

    The single source of truth for platform bundling, keyed by tool id:

        {
          "blast": {
            "available": True, "version": "2.16.0", "required_by": "plannotate",
            "extract_dir": False, "archive_type": "tar.gz",
            "url": "...", "sha256": "...",
            "binaries": {"blastn": "ncbi-blast-.../bin/blastn.exe", ...},
          },
          "infernal": {"available": False, "version": "1.1.5", "binaries": {}},
          ...
        }

    ``available: False`` marks a documented per-platform exception (e.g. Infernal
    on Windows). Consumers that bundle or verify binaries should read this rather
    than re-deriving per-OS tool lists (which is how  happened).
    """
    manifest: dict[str, dict] = {}
    for name, entry in TOOL_REGISTRY.items():
        pdata = entry["platforms"].get(suffix)
        if pdata is None:
            manifest[name] = {
                "available": False,
                "version": entry["version"],
                "required_by": entry.get("required_by"),
                "binaries": {},
            }
            continue
        manifest[name] = {
            "available": True,
            "version": entry["version"],
            "required_by": entry.get("required_by"),
            "extract_dir": entry.get("extract_dir", False),
            "url": pdata["url"],
            "sha256": pdata["sha256"],
            "archive_type": pdata.get("archive_type", "tar.gz"),
            "binaries": dict(pdata["binaries"]),
        }
    return manifest


def get_tools_dir() -> Path:
    """Get the platform-specific tools directory under app data.

    Returns <app_data>/tools/<platform_suffix>/.
    Respects WAYPOINT_DATA_DIR override. Creates directory if missing.
    """
    from ..toolbox.executable_paths import get_platform_suffix
    from .setup import get_app_data_base

    base = get_app_data_base()
    suffix = get_platform_suffix()
    tools_dir = base / "tools" / suffix
    tools_dir.mkdir(parents=True, exist_ok=True)
    return tools_dir


def _fetch_archive(
    url: str, dest_path: Path, expected_sha256: str, archive_type: str = "tar.gz"
) -> dict:
    """Download archive from URL and verify integrity.

    Validates:
    1. curl exit code
    2. Archive magic bytes (gzip \\x1f\\x8b or zip PK)
    3. SHA256 checksum

    Returns {"success": True} or {"success": False, "error": str}.
    Cleans up file on failure.
    """
    try:
        if not dest_path.exists():
            result = subprocess.run(
                ["curl", "-L", "-o", str(dest_path), url],
                capture_output=True,
                text=True,
                timeout=600,
            )
            if result.returncode != 0:
                dest_path.unlink(missing_ok=True)
                return {"success": False, "error": f"Download failed: {result.stderr}"}

        if not dest_path.exists():
            return {"success": False, "error": "Download completed but file not found"}

        with open(dest_path, "rb") as f:
            magic = f.read(4)
        if archive_type == "zip":
            if magic[:2] != b"PK":
                dest_path.unlink(missing_ok=True)
                return {
                    "success": False,
                    "error": "Not a valid zip archive (bad magic bytes)",
                }
        else:
            if magic[:2] != b"\x1f\x8b":
                dest_path.unlink(missing_ok=True)
                return {
                    "success": False,
                    "error": "Not a valid gzip archive (bad magic bytes)",
                }

        sha256 = hashlib.sha256(dest_path.read_bytes()).hexdigest()
        if sha256 != expected_sha256:
            dest_path.unlink(missing_ok=True)
            return {
                "success": False,
                "error": f"SHA256 mismatch: expected {expected_sha256}, got {sha256}",
            }

        return {"success": True}

    except Exception as e:
        dest_path.unlink(missing_ok=True)
        return {"success": False, "error": str(e)}


def _extract_directory(
    archive_path: Path,
    archive_root: str,
    dest_dir: Path,
) -> dict:
    """Extract an entire directory tree from an archive.

    Handles both .tar.gz and .zip. Extracts <archive_root>/ into dest_dir.
    Sets all files executable. Returns {"success": True} or {"success": False, "error": str}.
    """
    extract_to = dest_dir / archive_root
    try:
        archive_str = str(archive_path)
        if archive_str.endswith(".zip"):
            import zipfile

            with zipfile.ZipFile(archive_path, "r") as zf:
                zf.extractall(dest_dir)
        else:
            with tarfile.open(archive_path, "r:gz") as tar:
                tar.extractall(dest_dir, filter="data")

        if not extract_to.exists():
            return {
                "success": False,
                "error": f"Expected directory not found: {extract_to}",
            }

        for f in extract_to.rglob("*"):
            if f.is_file():
                f.chmod(f.stat().st_mode | 0o755)

        return {"success": True}
    except Exception as e:
        if extract_to.exists():
            import shutil

            shutil.rmtree(extract_to, ignore_errors=True)
        return {"success": False, "error": str(e)}


def _extract_binaries(
    archive_path: Path,
    binaries: dict[str, str],
    dest_dir: Path,
) -> dict:
    """Extract specific binaries from archive.

    Args:
        archive_path: Path to tar.gz archive
        binaries: {output_name: path_in_archive} mapping
        dest_dir: Where to place extracted binaries (unsuffixed names)

    Returns {"success": True, "installed": [...]} or {"success": False, "error": str}.
    Cleans up partial files on failure.
    """
    installed = []
    try:
        with tarfile.open(archive_path, "r:gz") as tar:
            for out_name, archive_member in binaries.items():
                try:
                    member = tar.getmember(archive_member)
                except KeyError:
                    for name in installed:
                        (dest_dir / name).unlink(missing_ok=True)
                    return {
                        "success": False,
                        "error": f"Member not found in archive: {archive_member}",
                    }

                f = tar.extractfile(member)
                if f is None:
                    for name in installed:
                        (dest_dir / name).unlink(missing_ok=True)
                    return {
                        "success": False,
                        "error": f"Could not extract {archive_member} (is a directory?)",
                    }

                content = f.read()
                dest_file = dest_dir / out_name
                dest_file.write_bytes(content)

                if dest_file.stat().st_size == 0:
                    for name in installed:
                        (dest_dir / name).unlink(missing_ok=True)
                    dest_file.unlink(missing_ok=True)
                    return {
                        "success": False,
                        "error": f"Extracted file is zero bytes: {out_name}",
                    }

                dest_file.chmod(dest_file.stat().st_mode | 0o755)
                installed.append(out_name)

        return {"success": True, "installed": installed}

    except Exception as e:
        for name in installed:
            (dest_dir / name).unlink(missing_ok=True)
        return {"success": False, "error": str(e)}


def validate_tools(tools_dir: Path, registry: dict | None = None) -> dict[str, bool]:
    """Check which tools are present as non-zero executables.

    Returns {binary_name: True/False} for all binaries across all registry entries.
    For extract_dir tools, checks the binary inside the extracted directory.
    """
    if registry is None:
        registry = TOOL_REGISTRY

    from ..toolbox.executable_paths import executable_variants, get_platform_suffix

    suffix = get_platform_suffix()

    def _is_present(path: Path) -> bool:
        return path.exists() and path.is_file() and path.stat().st_size > 0

    result = {}
    for entry in registry.values():
        is_dir_tool = entry.get("extract_dir", False)
        pdata = entry["platforms"].get(suffix)
        if pdata is None:
            continue

        for bin_name, archive_path in pdata["binaries"].items():
            if bin_name not in result:
                if is_dir_tool:
                    result[bin_name] = _is_present(tools_dir / archive_path)
                else:
                    result[bin_name] = any(
                        _is_present(candidate)
                        for candidate in executable_variants(tools_dir / bin_name)
                    )

    return result


_downloading_tools = False
_tool_progress: dict[str, dict] = {}

_TOOL_TRANSACTION_GLOB = ".tool-*-transaction-*"
_TOOL_COMMITTED_GLOB = ".tool-*-committed-*"


def _remove_tool_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _rollback_tool_transaction(data_dir: Path, transaction: Path) -> None:
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
    root = data_dir.resolve(strict=False)
    if len(targets) != len(set(targets)) or not present.issubset(targets):
        return
    for relative in targets:
        candidate = Path(relative)
        if not relative or candidate.is_absolute() or ".." in candidate.parts:
            return
        try:
            (root / candidate).resolve(strict=False).relative_to(root)
        except ValueError:
            return
    backup = transaction / "backup"
    for relative in targets:
        source = backup / relative
        destination = data_dir / relative
        if source.exists():
            _remove_tool_path(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, destination)
        elif relative not in present:
            _remove_tool_path(destination)
    shutil.rmtree(transaction, ignore_errors=True)


def _recover_tool_transactions(data_dir: Path) -> None:
    for committed in data_dir.glob(_TOOL_COMMITTED_GLOB):
        shutil.rmtree(committed, ignore_errors=True)
    for transaction in data_dir.glob(_TOOL_TRANSACTION_GLOB):
        _rollback_tool_transaction(data_dir, transaction)


def _publish_staged_tools(
    data_dir: Path, transaction: Path, targets: list[str], archive_name: str
) -> None:
    staging = transaction / "staging"
    backup = transaction / "backup"
    backup.mkdir()
    present = [relative for relative in targets if (data_dir / relative).exists()]
    manifest = transaction / "manifest.json"
    with manifest.open("w", encoding="utf-8") as destination:
        json.dump({"targets": targets, "present": present}, destination)
        destination.flush()
        os.fsync(destination.fileno())
    try:
        for relative in present:
            source = data_dir / relative
            destination = backup / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, destination)
        for relative in targets:
            destination = data_dir / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            os.replace(staging / relative, destination)
    except BaseException:
        _rollback_tool_transaction(data_dir, transaction)
        raise

    committed = data_dir / transaction.name.replace(
        f".tool-{archive_name}-transaction-",
        f".tool-{archive_name}-committed-",
        1,
    )
    os.replace(transaction, committed)
    shutil.rmtree(committed, ignore_errors=True)


def is_downloading_tools() -> bool:
    """Whether tools are currently being downloaded."""
    return _downloading_tools


def get_tool_progress() -> dict[str, dict]:
    """Return per-tool download progress. Used by /toolbox/status."""
    return dict(_tool_progress)


async def ensure_tools(data_dir: Path | None = None) -> None:
    """Auto-download missing tools at startup. Never raises.

    Called in sidecar lifespan. Skips archives where ALL binaries are valid.
    Downloads missing archives. Writes tools-version.json on success.
    """
    global _downloading_tools

    try:
        bundled_dir = os.environ.get("WAYPOINT_BINARIES_PATH")
        if bundled_dir:
            bundled_path = Path(bundled_dir)
            if bundled_path.is_dir():
                from ..services.plannotate import check_required_binaries

                bundled_status = check_required_binaries(bundled_path)
                if bundled_status and all(bundled_status.values()):
                    print(
                        f"[tools] All annotation tools found in bundled dir: {bundled_dir}"
                    )
                    mafft_path = bundled_path / "mafft"
                    if mafft_path.exists():
                        print(f"[tools] MAFFT found in bundled dir: {mafft_path}")
                    return

        if data_dir is None:
            data_dir = get_tools_dir()
        data_dir.mkdir(parents=True, exist_ok=True)
        _recover_tool_transactions(data_dir)

        tool_status = validate_tools(data_dir)
        if all(tool_status.values()) and len(tool_status) > 0:
            print(f"[tools] All tools present at {data_dir}")
            return

        if os.environ.get("DNAFORGE_OFFLINE_ANNOTATION") == "1":
            missing = ", ".join(
                name for name, present in tool_status.items() if not present
            )
            print(
                "[tools] Offline annotation mode forbids provisioning; "
                f"missing tools: {missing or 'unknown'}"
            )
            return

        from ..toolbox.executable_paths import get_platform_suffix

        suffix = get_platform_suffix()

        if suffix == "x86_64-pc-windows-msvc":
            print(
                "[tools] Windows bioinformatics tools are provided by the "
                "packaging bundle (prepare-windows-bioinformatics-tools.ps1); "
                "skipping runtime auto-download."
            )
            return

        _downloading_tools = True

        try:
            versions_installed = {}

            for name, ent in TOOL_REGISTRY.items():
                pd = ent["platforms"].get(suffix)
                if pd is None:
                    continue
                all_ok = all(tool_status.get(bn, False) for bn in pd["binaries"])
                _tool_progress[name] = {
                    "phase": "done" if all_ok else "pending",
                    "percent": 100.0 if all_ok else 0.0,
                }

            for archive_name, entry in TOOL_REGISTRY.items():
                platform_data = entry["platforms"].get(suffix)
                if platform_data is None:
                    print(f"[tools] No {archive_name} available for {suffix}")
                    continue

                all_valid = all(
                    tool_status.get(bin_name, False)
                    for bin_name in platform_data["binaries"]
                )
                if all_valid:
                    print(f"[tools] {archive_name} already installed")
                    versions_installed[archive_name] = entry["version"]
                    continue

                _tool_progress[archive_name] = {"phase": "downloading", "percent": 0.0}
                print(f"[tools] Downloading {archive_name} v{entry['version']}...")
                archive_type = platform_data.get("archive_type", "tar.gz")
                ext = ".zip" if archive_type == "zip" else ".tar.gz"
                transaction = Path(
                    tempfile.mkdtemp(
                        dir=str(data_dir),
                        prefix=(
                            f".tool-{archive_name}-transaction-{uuid.uuid4().hex}-"
                        ),
                    )
                )
                staging = transaction / "staging"
                staging.mkdir()
                archive_path = staging / f"{archive_name}{ext}"

                try:
                    fetch_result = await asyncio.to_thread(
                        _fetch_archive,
                        platform_data["url"],
                        archive_path,
                        platform_data["sha256"],
                        archive_type,
                    )

                    if not fetch_result["success"]:
                        _tool_progress[archive_name] = {
                            "phase": "error",
                            "percent": 0.0,
                        }
                        print(
                            f"[tools] Failed to download {archive_name}: {fetch_result['error']}"
                        )
                        continue

                    _tool_progress[archive_name] = {
                        "phase": "extracting",
                        "percent": 50.0,
                    }
                    print(f"[tools] Extracting {archive_name}...")
                    is_dir_tool = entry.get("extract_dir", False)
                    if is_dir_tool:
                        extract_result = await asyncio.to_thread(
                            _extract_directory,
                            archive_path,
                            platform_data["archive_root"],
                            staging,
                        )
                        targets = [platform_data["archive_root"]]
                    else:
                        extract_result = await asyncio.to_thread(
                            _extract_binaries,
                            archive_path,
                            platform_data["binaries"],
                            staging,
                        )
                        targets = list(platform_data["binaries"])

                    archive_path.unlink(missing_ok=True)

                    if not extract_result["success"]:
                        _tool_progress[archive_name] = {
                            "phase": "error",
                            "percent": 0.0,
                        }
                        print(
                            f"[tools] Failed to extract {archive_name}: {extract_result['error']}"
                        )
                        continue

                    await asyncio.to_thread(
                        _publish_staged_tools,
                        data_dir,
                        transaction,
                        targets,
                        archive_name,
                    )

                    _tool_progress[archive_name] = {
                        "phase": "done",
                        "percent": 100.0,
                    }
                    versions_installed[archive_name] = entry["version"]
                    print(f"[tools] Installed {archive_name} v{entry['version']}")
                except Exception as error:
                    _tool_progress[archive_name] = {
                        "phase": "error",
                        "percent": 0.0,
                    }
                    print(f"[tools] Failed to install {archive_name}: {error}")
                finally:
                    if transaction.exists():
                        if (transaction / "manifest.json").exists():
                            _rollback_tool_transaction(data_dir, transaction)
                        else:
                            shutil.rmtree(transaction, ignore_errors=True)

            if versions_installed:
                version_file = data_dir / "tools-version.json"
                temporary_version = data_dir / f".tools-version-{uuid.uuid4().hex}.tmp"
                temporary_version.write_text(json.dumps(versions_installed))
                os.replace(temporary_version, version_file)

            final_status = validate_tools(data_dir)
            missing = [n for n, v in final_status.items() if not v]
            if missing:
                print(f"[tools] Warning: still missing tools: {', '.join(missing)}")
            else:
                print("[tools] All tools ready")

        finally:
            _downloading_tools = False

    except Exception as e:
        _downloading_tools = False
        print(f"[tools] Error during tool setup: {e}")
