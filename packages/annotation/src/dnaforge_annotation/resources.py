"""Packaged annotation metadata resolved against explicit local resources."""

from __future__ import annotations

import os
import shlex
from importlib.resources import files
from pathlib import Path

import yaml

from .contract import AnnotationRuntime

ANNOTATION_VERSION = "1.2.2"

valid_genbank_exts = [".gbk", ".gb", ".gbf", ".gbff"]
valid_fasta_exts = [".fa", ".fasta", ".fas", ".fna"]
MAX_PLAS_SIZE = 50000

DF_COLS = [
    "sseqid",
    "qstart",
    "qend",
    "sstart",
    "send",
    "sframe",
    "score",
    "evalue",
    "qseq",
    "length",
    "slen",
    "pident",
    "qlen",
    "db",
    "Feature",
    "Description",
    "Type",
    "priority",
    "percmatch",
    "abs percmatch",
    "pi_permatch",
    "wiggle",
    "wstart",
    "wend",
    "kind",
    "qstart_dup",
    "qend_dup",
    "fragment",
]


def get_resource(group: str, name: str) -> str:
    return str(files(__package__) / f"data/{group}/{name}")


def get_image(name: str) -> str:
    return get_resource("images", name)


def get_template(name: str) -> str:
    return get_resource("templates", name)


def get_example_fastas() -> str:
    return get_resource("fastas", "")


def get_yaml_path() -> str:
    return get_resource("data", "databases.yml")


def get_reference_versions(yaml_file_loc: str | Path) -> dict[str, str | None]:
    """Read the declared version of each configured reference database."""
    with open(yaml_file_loc, "r", encoding="utf-8") as source:
        databases = yaml.load(source, Loader=yaml.SafeLoader)
    if not isinstance(databases, dict):
        raise ValueError("annotation database configuration must be a mapping")
    return {
        str(name): (str(database["version"]) if database.get("version") else None)
        for name, database in databases.items()
    }


def get_details(name: str, *, data_dir: Path | None = None) -> str:
    """Resolve a detail table from explicit reference data or package data."""
    if data_dir is not None:
        external = data_dir / f"{name}.csv.gz"
        if external.exists():
            return str(data_dir / name)
    return get_resource("data", name)


def get_name_ext(file_loc: str) -> tuple[str, str]:
    base = os.path.basename(file_loc)
    return os.path.splitext(base)[0], os.path.splitext(base)[1]


def _replace_parameter(parameters: list[str], flag: str, value: int) -> None:
    try:
        index = parameters.index(flag)
    except ValueError:
        parameters.extend((flag, str(value)))
    else:
        if index + 1 == len(parameters):
            parameters.append(str(value))
        else:
            parameters[index + 1] = str(value)


def get_yaml(
    yaml_file_loc: str | Path,
    *,
    runtime: AnnotationRuntime | None = None,
    data_dir: Path | None = None,
) -> dict[str, dict[str, object]]:
    """Load database metadata and bind every implicit resource to a runtime."""
    with open(yaml_file_loc, "r", encoding="utf-8") as source:
        databases = yaml.load(source, Loader=yaml.SafeLoader)

    if not isinstance(databases, dict):
        raise ValueError("annotation database configuration must be a mapping")
    if runtime is not None:
        database_dir = runtime.data_dir / "BLAST_dbs"
    elif data_dir is not None:
        database_dir = data_dir / "BLAST_dbs"
    else:
        database_dir = Path(get_resource("BLAST_dbs", ""))
    executable_by_method = {}
    if runtime is not None:
        executable_by_method = {
            "blastn": str(runtime.executables.blastn),
            "diamond": str(runtime.executables.diamond),
            "infernal": str(runtime.executables.cmscan),
        }

    for database_name, database in databases.items():
        if not isinstance(database, dict):
            raise ValueError(f"invalid database configuration for {database_name}")
        configured_location = database["location"]
        resolved_location = (
            database_dir
            if configured_location == "Default"
            else Path(configured_location)
        )
        parameters = [
            token
            for parameter in database.get("parameters", [])
            for token in shlex.split(str(parameter))
        ]
        method = str(database["method"])
        if runtime is not None:
            flag = {
                "blastn": "-num_threads",
                "diamond": "--threads",
                "infernal": "--cpu",
            }[method]
            _replace_parameter(parameters, flag, runtime.threads)
            database["executable"] = executable_by_method[method]
        database["parameters"] = " ".join(parameters)
        if method == "infernal":
            database["db_loc"] = (
                str(resolved_location / f"{database_name}.clanin"),
                str(resolved_location / f"{database_name}.cm"),
            )
        else:
            database["db_loc"] = str(resolved_location / database_name)
    return databases


def databases_exist(data_dir: Path) -> bool:
    """Return whether the explicit reference directory has each configured root."""
    databases = get_yaml(get_yaml_path())
    blast_dir = data_dir / "BLAST_dbs"
    if not blast_dir.is_dir():
        return False
    for name, database in databases.items():
        if database["method"] == "infernal":
            if not (blast_dir / f"{name}.cm").is_file():
                return False
            if not (blast_dir / f"{name}.clanin").is_file():
                return False
    return True
