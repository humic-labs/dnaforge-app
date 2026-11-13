from __future__ import annotations

import argparse
import decimal
import json
import platform
import pyexpat
import re
import sqlite3
import ssl
import subprocess
from importlib import metadata
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from urllib.request import url2pathname

SCHEMA = "dnaforge.sidecar-python-licenses.v1"
FIRST_PARTY = frozenset({"molbio-api", "dnaforge-annotation"})
COMPILER = "nuitka"
API_DIR = Path(__file__).resolve().parent.parent
LICENSE_FILE_NAME = re.compile(
    r"^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[._-].*)?$",
    re.IGNORECASE,
)
LOCKED_REQUIREMENT = re.compile(
    r"^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?==([^\s;\\]+)"
)
MAX_LICENSE_FILE_BYTES = 1024 * 1024


def canonical_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_locked_requirements(text: str) -> set[str]:
    return {
        canonical_name(match.group(1))
        for match in map(LOCKED_REQUIREMENT.match, text.splitlines())
        if match
    }


def locked_requirements(extras: list[str], api_dir: Path = API_DIR) -> set[str]:
    command = [
        "uv",
        "export",
        "--frozen",
        "--no-dev",
        "--no-hashes",
        "--format",
        "requirements-txt",
    ]
    for extra in extras:
        command += ["--extra", extra]
    result = subprocess.run(
        command, cwd=api_dir, check=True, capture_output=True, text=True
    )
    names = parse_locked_requirements(result.stdout)
    local_paths = set()
    for line in result.stdout.splitlines():
        requirement = line.strip().removeprefix("-e ").split(";", 1)[0].strip()
        if requirement.startswith(("./", "../", "/")):
            local_paths.add((api_dir / requirement).resolve())
    for distribution in metadata.distributions():
        direct = distribution.read_text("direct_url.json")
        name = distribution.metadata.get("Name")
        if not direct or not name:
            continue
        location = urlparse(json.loads(direct).get("url", ""))
        if location.scheme != "file" or location.netloc not in ("", "localhost"):
            continue
        if Path(url2pathname(location.path)).resolve() in local_paths:
            names.add(canonical_name(name))
    return names


def license_label(fields: Any) -> str:
    expression = fields.get("License-Expression")
    if expression:
        return expression
    declared = fields.get("License")
    if (
        declared
        and "\n" not in declared
        and len(declared) <= 80
        and declared != "UNKNOWN"
    ):
        return declared
    classifiers = [
        classifier.split("::")[-1].strip()
        for classifier in fields.get_all("Classifier") or []
        if classifier.startswith("License ::")
    ]
    return " / ".join(classifiers) if classifiers else "UNKNOWN"


def homepage(fields: Any) -> str | None:
    if fields.get("Home-page"):
        return fields.get("Home-page")
    urls = fields.get_all("Project-URL") or []
    return urls[0].split(",")[-1].strip() if urls else None


def is_license_file(parts: tuple[str, ...]) -> bool:
    if len(parts) < 2 or not parts[0].endswith(".dist-info"):
        return False
    if parts[1] == "licenses":
        return len(parts) > 2
    return len(parts) == 2 and LICENSE_FILE_NAME.match(parts[1]) is not None


def license_texts(distribution: metadata.Distribution) -> list[dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    for file in sorted(distribution.files or [], key=str):
        if not is_license_file(file.parts):
            continue
        path = Path(str(distribution.locate_file(file)))
        if not path.is_file() or path.stat().st_size > MAX_LICENSE_FILE_BYTES:
            continue
        text = path.read_text(encoding="utf-8", errors="replace").strip()
        if text and text not in found:
            found[text] = {"file": file.name, "text": text}
    return list(found.values())


def openssl_version(description: str) -> str:
    match = re.match(r"^OpenSSL (\S+)", description)
    return match.group(1) if match else description


def runtime() -> dict[str, Any]:
    return {
        "implementation": platform.python_implementation(),
        "version": platform.python_version(),
        "libraries": {
            "OpenSSL": openssl_version(ssl.OPENSSL_VERSION),
            "SQLite": sqlite3.sqlite_version,
            "Expat": ".".join(map(str, pyexpat.version_info)),
            "libmpdec": getattr(decimal, "__libmpdec_version__", "not included"),
        },
    }


def shipped_packages(
    locked: set[str], distributions: list[metadata.Distribution]
) -> list[dict[str, Any]]:
    packages: dict[str, dict[str, Any]] = {}
    for distribution in distributions:
        fields = distribution.metadata
        name = fields.get("Name")
        if not name:
            continue
        key = canonical_name(name)
        if key in packages or key in FIRST_PARTY:
            continue
        if key not in locked and key != COMPILER:
            continue
        packages[key] = {
            "name": name,
            "version": distribution.version,
            "license": license_label(fields),
            "homepage": homepage(fields),
            "licenses": license_texts(distribution),
        }
    return [packages[key] for key in sorted(packages)]


def inventory(
    extras: list[str], target: str, api_dir: Path = API_DIR
) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "target": target,
        "python": runtime(),
        "packages": shipped_packages(
            locked_requirements(extras, api_dir), list(metadata.distributions())
        ),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m src.license_inventory")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--target", required=True)
    parser.add_argument("--extra", action="append", default=[])
    args = parser.parse_args(argv)
    document = inventory(args.extra, args.target)
    if not document["packages"]:
        parser.error("found no installed Python packages from apps/api/uv.lock")
    args.output.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {args.output} ({len(document['packages'])} Python packages)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
