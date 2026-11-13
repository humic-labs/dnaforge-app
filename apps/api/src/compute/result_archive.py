"""Bounded extraction for provider result archives.

Providers often expose one authenticated or signed ZIP instead of a file
manifest. Extract only text-like scientific artifacts that the desktop import
contract can safely carry inline; flatten names and put structures first.
"""

from __future__ import annotations

import io
import re
import zipfile

from .contract import ResultFile

EXTRACT_MAX_FILE_BYTES = 25 * 1024 * 1024
EXTRACT_MAX_FILES = 50
RESULT_TEXT_EXT = re.compile(
    r"\.(pdb|cif|mmcif|fa|fasta|faa|csv|tsv|json|txt|a3m|sdf|mol2)$", re.I
)
_STRUCTURE_EXT = re.compile(r"\.(pdb|cif|mmcif)$", re.I)


def extract_text_result_archive(data: bytes) -> list[ResultFile]:
    """Return bounded, importable files from a ZIP; malformed archives yield none."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return []
    files: list[ResultFile] = []
    seen: set[str] = set()
    with archive:
        members = [
            member
            for member in archive.infolist()
            if not member.is_dir() and RESULT_TEXT_EXT.search(member.filename)
        ]
        members.sort(
            key=lambda member: (
                0 if _STRUCTURE_EXT.search(member.filename) else 1,
                member.filename,
            )
        )
        for member in members[:EXTRACT_MAX_FILES]:
            with archive.open(member) as handle:
                content = handle.read(EXTRACT_MAX_FILE_BYTES + 1)
            if len(content) > EXTRACT_MAX_FILE_BYTES:
                continue
            name = member.filename.rsplit("/", 1)[-1]
            if name in seen:
                name = member.filename.strip("/").replace("/", "_")
            seen.add(name)
            files.append(ResultFile(name=name, content=content))
    return files
