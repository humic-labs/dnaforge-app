"""Build a source-exact headless zipapp without the desktop control plane."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import zipfile
from pathlib import Path


def build(destination: Path, coverage_helper: Path | None = None) -> dict:
    api = Path(__file__).resolve().parents[1]
    pending = ["src.remote_tile_server"]
    included: dict[str, bytes] = {}
    generated = {
        "src/services/__init__.py": b'"""Headless genomic calculation services."""\n',
    }
    while pending:
        module = pending.pop()
        base = api.joinpath(*module.split("."))
        source = base.with_suffix(".py")
        if not source.is_file():
            source = base / "__init__.py"
        if not source.is_file():
            raise ValueError(f"Missing headless dependency: {module}")
        relative = source.relative_to(api).as_posix()
        if relative in generated:
            continue
        if relative in included:
            continue
        data = source.read_bytes()
        included[relative] = data
        package = (
            module.split(".")
            if source.name == "__init__.py"
            else module.split(".")[:-1]
        )
        for node in ast.walk(ast.parse(data, filename=relative)):
            if not isinstance(node, ast.ImportFrom):
                continue
            if node.level:
                prefix = package[: len(package) - node.level + 1]
                target = prefix + (node.module.split(".") if node.module else [])
            elif node.module and node.module.startswith("src."):
                target = node.module.split(".")
            else:
                continue
            target_name = ".".join(target)
            pending.append(target_name)
            for alias in node.names:
                child = api.joinpath(*target, alias.name)
                if (
                    child.with_suffix(".py").is_file()
                    or (child / "__init__.py").is_file()
                ):
                    pending.append(target_name + "." + alias.name)
        for length in range(1, len(module.split("."))):
            parent = api.joinpath(*module.split(".")[:length], "__init__.py")
            if parent.is_file():
                pending.append(".".join(module.split(".")[:length]))
    manifest = {
        name: hashlib.sha256(data).hexdigest()
        for name, data in sorted(included.items())
    }
    included.update(generated)
    included["__main__.py"] = b"from src.remote_tile_server import main\nmain()\n"
    included["source-manifest.json"] = (
        json.dumps(manifest, sort_keys=True, indent=2) + "\n"
    ).encode()
    helper_receipt = None
    if coverage_helper is not None:
        helper = coverage_helper.read_bytes()
        if not helper.startswith(b"\x7fELF"):
            raise ValueError("The HPC package requires a Linux ELF coverage helper.")
        helper_receipt = {
            "entry": "dna-coverage",
            "sha256": hashlib.sha256(helper).hexdigest(),
            "bytes": len(helper),
        }
        included["dna-coverage"] = helper
        included["hpc-bundle.json"] = json.dumps(
            {"coverageHelper": helper_receipt}
        ).encode()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(included.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, data)
    return {
        "artifact": str(destination),
        "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        "sourceSha256": manifest,
        "generatedSha256": {
            name: hashlib.sha256(data).hexdigest()
            for name, data in sorted(generated.items())
        },
        **({"coverageHelper": helper_receipt} if helper_receipt else {}),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--coverage-helper", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(build(arguments.output, arguments.coverage_helper), indent=2))


if __name__ == "__main__":
    main()
