#!/usr/bin/env python3
"""Export the complete FastAPI schema without starting the sidecar.

The command is deliberately import-only: it does not enter the FastAPI
lifespan, bind a port, load credentials, or run any biological computation.
DNAForge prohibits BioPython use, so the export fails if any BioPython module is
loaded while constructing the route graph.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

required_python = (
    (Path(__file__).resolve().parents[3] / ".python-version")
    .read_text(encoding="utf-8")
    .strip()
)
actual_python = f"{sys.version_info.major}.{sys.version_info.minor}"
if actual_python != required_python:
    raise SystemExit(
        f"OpenAPI export requires Python {required_python} from .python-version; "
        f"found {actual_python}. Recreate apps/api/.venv with the pinned version."
    )

from src.main import app  # noqa: E402 - reject the wrong Python before loading FastAPI


def main() -> None:
    loaded_biopython = sorted(
        name for name in sys.modules if name == "Bio" or name.startswith("Bio.")
    )
    if loaded_biopython:
        raise RuntimeError(
            "OpenAPI export loaded forbidden BioPython modules: "
            + ", ".join(loaded_biopython)
        )
    rendered = json.dumps(app.openapi(), sort_keys=True, separators=(",", ":")) + "\n"
    if len(sys.argv) == 3 and sys.argv[1] == "--output":
        output = Path(sys.argv[2])
        temporary = output.with_name(f"{output.name}.tmp")
        temporary.write_text(rendered, encoding="utf-8")
        temporary.replace(output)
        return
    if len(sys.argv) != 1:
        raise SystemExit("usage: export_openapi.py [--output PATH]")
    sys.stdout.write(rendered)


if __name__ == "__main__":
    main()
