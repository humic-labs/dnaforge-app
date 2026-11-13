"""IUPAC reverse complement backed by the generated canonical resource."""

from __future__ import annotations

import json
from functools import lru_cache
from importlib.resources import files


@lru_cache(maxsize=1)
def _complements() -> dict[str, str]:
    resource = files(__package__) / "data/iupac-complements.json"
    with resource.open("r", encoding="utf-8") as source:
        return json.load(source)


def reverse_complement(sequence: str) -> str:
    """Return the canonical IUPAC-aware, case-preserving reverse complement."""
    complements = _complements()
    return "".join(complements.get(base, base) for base in reversed(sequence))
