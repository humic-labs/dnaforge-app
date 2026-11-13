"""The per-machine track store, as the sidecar sees it.

Tracks live beside reference genomes, never inside them, in a directory tree
that is readable without the app:

    <dataRoot>/tracks/<accession>/<track>/
        current.json            which version is live
        <version>/meta.json     provenance, licence, checksum
        <version>/<file>        the bytes, in a standard format

The TypeScript side (apps/desktop/src/main/track-store) reads this tree for the
renderer; this package writes it for the registration operation and the CLI.
Both follow the same layout and the same naming rules.
"""

from .layout import (
    CURRENT_SCHEMA,
    META_SCHEMA,
    TrackStoreError,
    read_current,
    read_meta,
    track_directory,
    version_directory,
    version_id,
    write_current,
    write_version,
)
from .root import resolve_dnaforge_data_root, track_store_root

__all__ = [
    "CURRENT_SCHEMA",
    "META_SCHEMA",
    "TrackStoreError",
    "read_current",
    "read_meta",
    "resolve_dnaforge_data_root",
    "track_directory",
    "track_store_root",
    "version_directory",
    "version_id",
    "write_current",
    "write_version",
]
