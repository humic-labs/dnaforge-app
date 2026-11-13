"""Guard: production code (apps/api/src) must NEVER import biopython.

biopython is a banned runtime dependency (unmaintained). GenBank parsing lives in
the Rust ``dna-assembly`` binary; FASTA I/O + reverse-complement in
``src/seq_io.py``. biopython survives ONLY as a test-only differential oracle
(see the ``dev`` extra in pyproject.toml). This test fails the build if
``import Bio`` / ``from Bio ...`` ever reappears anywhere under ``src/`` — the
mechanical enforcement of the "NO BIOPYTHON" constraint. AST-based, so it never
false-matches a comment or docstring that merely mentions biopython.
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"


def _bio_imports(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(), filename=str(path))
    hits: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "Bio" or alias.name.startswith("Bio."):
                    hits.append(f"import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module == "Bio" or module.startswith("Bio."):
                hits.append(f"from {module} import ...")
    return hits


def test_no_biopython_imports_in_src():
    offenders = {
        str(path.relative_to(SRC)): hits
        for path in sorted(SRC.rglob("*.py"))
        if (hits := _bio_imports(path))
    }
    assert not offenders, (
        "biopython is banned in production code (apps/api/src). Move parsing to "
        "the Rust dna-assembly binary or FASTA/revcomp to src/seq_io.py. "
        f"Offenders: {offenders}"
    )
