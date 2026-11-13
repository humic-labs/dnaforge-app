from __future__ import annotations

import hashlib
import json
import os
import plistlib
import re
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from ._macos_signing_policy_generated import (
    DEVELOPER_ID_REQUIREMENTS,
    MACOS_SIGNERS,
)

_SHA = re.compile(r"^[0-9a-f]{64}$")
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class AppOwnedToolIdentityError(RuntimeError):
    pass


@dataclass(frozen=True)
class AppOwnedExecutableIdentity:
    path: Path
    sha256: str
    source_build_sha256: str
    source_receipt_sha256: str
    verification_type: Literal[
        "exact-source-build-bytes", "sealed-package-signing-handoff"
    ]
    package_identity: dict[str, str] | None = None
    signing_handoff_sha256: str | None = None


def _read(path: Path, limit: int) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= limit:
        raise AppOwnedToolIdentityError(
            "App-owned tool input is not a bounded regular file"
        )
    return path.read_bytes()


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _codesign(path: Path, *flags: str) -> str:
    result = subprocess.run(
        ["/usr/bin/codesign", *flags, str(path)],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return result.stdout + "\n" + result.stderr


def _publisher(path: Path) -> dict[str, str]:
    _codesign(path, "--verify", "--strict")
    output = _codesign(path, "--display", "--verbose=4")
    fields = [line.strip() for line in output.splitlines()]
    authorities = [
        line.removeprefix("Authority=")
        for line in fields
        if line.startswith("Authority=")
    ]
    teams = [
        line.removeprefix("TeamIdentifier=")
        for line in fields
        if line.startswith("TeamIdentifier=")
    ]
    for mode, policy in MACOS_SIGNERS.items():
        if authorities[:1] == [policy["authority"]] and teams == [policy["teamId"]]:
            _codesign(
                path,
                "--verify",
                "--strict",
                "-R",
                "=" + DEVELOPER_ID_REQUIREMENTS[mode],
            )
            return {"mode": mode, **policy}
    raise AppOwnedToolIdentityError("App-owned tool package publisher is unqualified")


def _package_root(helpers: Path) -> Path | None:
    if (
        helpers.name.casefold() == "helpers"
        and helpers.parent.name.casefold() == "contents"
    ):
        return helpers.parent.parent
    return None


def resolve_app_owned_executable(
    filename: str,
    *,
    source_build_sha256: str,
    source_receipt_name: str,
    source_receipt_sha256: str,
) -> AppOwnedExecutableIdentity:
    if (
        not _NAME.fullmatch(filename)
        or not _NAME.fullmatch(source_receipt_name)
        or not _SHA.fullmatch(source_build_sha256)
        or not _SHA.fullmatch(source_receipt_sha256)
    ):
        raise AppOwnedToolIdentityError("Invalid app-owned tool identity descriptor")
    configured = os.environ.get("DNAFORGE_HELPERS_DIR")
    if not configured or not Path(configured).is_absolute():
        raise AppOwnedToolIdentityError("App-owned tools directory is unavailable")
    try:
        configured_helpers = Path(configured)
        lexical_app = _package_root(configured_helpers)
        helpers = configured_helpers.resolve(strict=True)
        resolved_app = _package_root(helpers)
        app = lexical_app.resolve(strict=True) if lexical_app else resolved_app
        if app is not None:
            app = app.resolve(strict=True)
            if not helpers.is_relative_to(app) or not (app / "Contents").resolve(
                strict=True
            ).is_relative_to(app):
                raise AppOwnedToolIdentityError(
                    "Packaged Helpers escaped the containing app"
                )
            if resolved_app is not None and resolved_app.resolve(strict=True) != app:
                raise AppOwnedToolIdentityError(
                    "Packaged Helpers changed their containing app"
                )
        executable = helpers / filename
        raw = _read(executable, 64 * 1024 * 1024)
        if not executable.stat().st_mode & 0o111:
            raise AppOwnedToolIdentityError("App-owned tool is not executable")
        receipt = _read(helpers / source_receipt_name, 256 * 1024)
        if _digest(receipt) != source_receipt_sha256:
            raise AppOwnedToolIdentityError("App-owned tool source receipt changed")
        actual = _digest(raw)
        if actual == source_build_sha256 and app is None:
            return AppOwnedExecutableIdentity(
                executable,
                actual,
                source_build_sha256,
                source_receipt_sha256,
                "exact-source-build-bytes",
            )
        if app is None:
            raise AppOwnedToolIdentityError(
                "Changed tool bytes require a sealed app package"
            )
        contents = app / "Contents"
        resources = contents / "Resources"
        handoff_bytes = _read(resources / "app-owned-tools.signing.json", 256 * 1024)
        handoff = json.loads(handoff_bytes)
        handoff_sha = _digest(handoff_bytes)
        entry = handoff.get("tools", {}).get(filename)
        expected_entry = {
            "sourceBuildSha256": source_build_sha256,
            "sourceReceiptFile": source_receipt_name,
            "sourceReceiptSha256": source_receipt_sha256,
            "signedSha256": actual,
        }
        if (
            handoff.get("schema") != "dnaforge.app-owned-tools-signing.v1"
            or handoff.get("phase") != "existing-signer-before-containing-app-seal"
            or entry != expected_entry
        ):
            raise AppOwnedToolIdentityError(
                "Signed tool does not match the package source handoff"
            )
        info = plistlib.loads(_read(contents / "Info.plist", 1024 * 1024))
        if not info.get("CFBundleIdentifier") or info[
            "CFBundleIdentifier"
        ] != handoff.get("bundleIdentifier"):
            raise AppOwnedToolIdentityError(
                "Tool handoff belongs to a different app package"
            )
        seal = plistlib.loads(
            _read(contents / "_CodeSignature" / "CodeResources", 16 * 1024 * 1024)
        )
        sealed = seal.get("files2", {}).get(
            "Resources/app-owned-tools.signing.json", {}
        )
        if (
            sealed.get("hash2") != hashlib.sha256(handoff_bytes).digest()
            or sealed.get("optional")
            or sealed.get("omit")
        ):
            raise AppOwnedToolIdentityError(
                "Tool handoff is absent from the containing app resource seal"
            )
        _codesign(app, "--verify", "--deep", "--strict")
        package = _publisher(app)
        if _publisher(executable) != package or handoff.get("packageAuthority") != {
            **package,
            "publisherVerified": True,
        }:
            raise AppOwnedToolIdentityError(
                "Tool handoff package publisher does not match"
            )
        if (
            _digest(_read(executable, 64 * 1024 * 1024)) != actual
            or _digest(_read(resources / "app-owned-tools.signing.json", 256 * 1024))
            != handoff_sha
            or _digest(_read(helpers / source_receipt_name, 256 * 1024))
            != source_receipt_sha256
        ):
            raise AppOwnedToolIdentityError(
                "App-owned tool identity changed during verification"
            )
        return AppOwnedExecutableIdentity(
            executable,
            actual,
            source_build_sha256,
            source_receipt_sha256,
            "sealed-package-signing-handoff",
            {**package, "bundleIdentifier": info["CFBundleIdentifier"]},
            handoff_sha,
        )
    except (
        OSError,
        ValueError,
        TypeError,
        AttributeError,
        subprocess.SubprocessError,
        plistlib.InvalidFileException,
    ) as error:
        raise AppOwnedToolIdentityError(
            "App-owned tool provenance verification failed"
        ) from error
