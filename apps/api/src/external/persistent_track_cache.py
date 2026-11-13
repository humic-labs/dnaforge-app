"""Restart-safe bounded content store for public genomic tracks.

The registry is the lookup and eviction authority. Payload files are addressed
by their SHA-256 digest so a registry row can never redirect reads outside the
cache route. Cache failures are deliberately fail-open: callers receive a miss
and may fetch the requested content from the admitted source.

BigWig/BigBed byte ranges and bounded UCSC sparse-track snapshots are typed
clients of this one store. They share the route, payload files, byte budget,
integrity checks, repair pass, and LRU. Only their identity contracts differ.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

_ROUTE_CONTRACT = "dnaforge.indexed-track-range-cache-route.v1"
_RANGE_KEY_CONTRACT = "dnaforge.indexed-track-range-block.v1"
_BLOB_KEY_CONTRACT = "dnaforge.indexed-track-content-blob.v1"
_PAYLOAD_HASH_RE = re.compile(r"[0-9a-f]{64}")
_EXPECTED_MANIFEST = {"contract": _ROUTE_CONTRACT, "kind": "local"}


@dataclass(frozen=True)
class _DisconnectedCache:
    pass


@dataclass(frozen=True)
class _InitializingCache:
    connection: sqlite3.Connection


@dataclass(frozen=True)
class _ReadyCache:
    connection: sqlite3.Connection


class PersistentTrackCache:
    """One bounded local track-content route shared by every profile viewer."""

    def __init__(
        self,
        root: str | Path,
        *,
        max_bytes: int,
        clock_ns: Callable[[], int] = time.time_ns,
    ) -> None:
        if max_bytes < 1:
            raise ValueError("Persistent track cache max_bytes must be positive")
        self._root = Path(root).expanduser()
        self._cache_root = self._root / "hot-cache-v1"
        self._payload_root = self._cache_root / "payloads"
        self._registry_path = self._cache_root / "registry.sqlite3"
        self._manifest_path = self._root / "route-manifest.json"
        self._max_bytes = max_bytes
        self._clock_ns = clock_ns
        self._state: _DisconnectedCache | _InitializingCache | _ReadyCache = (
            _DisconnectedCache()
        )
        self._lock = threading.RLock()

    def get(
        self,
        source_key: str,
        generation_key: str,
        start: int,
        length: int,
    ) -> bytes | None:
        """Return a verified payload or a miss. Cache faults never escape."""

        try:
            _validate_lookup(source_key, generation_key, start, length)
            with self._lock:
                self._ensure_initialized()
                return self._get(source_key, generation_key, start, length)
        except (OSError, OverflowError, sqlite3.Error, TypeError, ValueError):
            with self._lock:
                self._reset_connection()
            return None

    def put(
        self,
        source_key: str,
        generation_key: str,
        start: int,
        payload: bytes,
    ) -> bool:
        """Publish a complete payload atomically. False means caching was skipped."""

        try:
            _validate_lookup(source_key, generation_key, start, len(payload))
            if len(payload) > self._max_bytes:
                return False
            with self._lock:
                self._ensure_initialized()
                self._put(source_key, generation_key, start, payload)
            return True
        except (OSError, OverflowError, sqlite3.Error, TypeError, ValueError):
            with self._lock:
                self._reset_connection()
            return False

    def get_blob(
        self,
        namespace: str,
        identity: str,
        *,
        max_age_ns: int | None = None,
    ) -> bytes | None:
        """Return one verified typed payload or a miss.

        ``namespace`` is the client contract (for example a UCSC sparse
        snapshot); ``identity`` is that client's stable scientific source key.
        Both remain separate from the physical cache route.
        """

        try:
            _validate_blob_lookup(namespace, identity, max_age_ns=max_age_ns)
            with self._lock:
                self._ensure_initialized()
                return self._get_entry(
                    _blob_cache_key(namespace, identity),
                    source_key=namespace,
                    generation_key=identity,
                    start=0,
                    logical_length=None,
                    max_age_ns=max_age_ns,
                )
        except (OSError, OverflowError, sqlite3.Error, TypeError, ValueError):
            with self._lock:
                self._reset_connection()
            return None

    def put_blob(self, namespace: str, identity: str, payload: bytes) -> bool:
        """Publish one complete typed payload into the shared bounded store."""

        try:
            _validate_blob_lookup(namespace, identity, max_age_ns=None)
            if not isinstance(payload, bytes) or len(payload) < 1:
                raise ValueError("Persistent track payload must be non-empty bytes")
            if len(payload) > self._max_bytes:
                return False
            with self._lock:
                self._ensure_initialized()
                self._put_entry(
                    _blob_cache_key(namespace, identity),
                    source_key=namespace,
                    generation_key=identity,
                    start=0,
                    logical_length=len(payload),
                    payload=payload,
                )
            return True
        except (OSError, OverflowError, sqlite3.Error, TypeError, ValueError):
            with self._lock:
                self._reset_connection()
            return False

    def close(self) -> None:
        with self._lock:
            self._reset_connection()

    def repair(self) -> bool:
        """Best-effort full route repair for deferred background maintenance.

        Ordinary reads validate only the requested row and payload. A recursive
        payload-tree scan is deliberately kept off the first-viewer-read path;
        the sidecar schedules this method after startup instead.
        """

        try:
            with self._lock:
                self._ensure_initialized()
            connection = self._new_connection()
            orphan_candidates: set[str] = set()
            try:
                with connection:
                    connection.execute("BEGIN IMMEDIATE")
                    orphan_candidates.update(self._repair_payload_registry(connection))
                    orphan_candidates.update(self._evict_to_budget(connection))
                    connection.commit()
            finally:
                connection.close()
            with self._lock:
                for candidate in orphan_candidates:
                    self._delete_payload_if_unreferenced(candidate)
            return True
        except (OSError, OverflowError, sqlite3.Error, TypeError, ValueError):
            return False

    def _ensure_initialized(self) -> None:
        if isinstance(self._state, _ReadyCache):
            return
        self._root.mkdir(parents=True, exist_ok=True)
        if self._manifest_path.exists():
            manifest = json.loads(self._manifest_path.read_text(encoding="utf-8"))
            if manifest != _EXPECTED_MANIFEST:
                raise ValueError("Indexed-track cache route manifest is incompatible")
        else:
            _atomic_write(
                self._manifest_path,
                json.dumps(
                    _EXPECTED_MANIFEST, sort_keys=True, separators=(",", ":")
                ).encode(),
            )
        self._payload_root.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS range_blocks (
                    cache_key TEXT PRIMARY KEY,
                    source_key TEXT NOT NULL,
                    generation_key TEXT NOT NULL,
                    range_start INTEGER NOT NULL CHECK (range_start >= 0),
                    range_length INTEGER NOT NULL CHECK (range_length > 0),
                    payload_hash TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
                    created_ns INTEGER NOT NULL,
                    last_access_ns INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS range_blocks_lru
                    ON range_blocks(last_access_ns, created_ns, cache_key);
                CREATE INDEX IF NOT EXISTS range_blocks_payload
                    ON range_blocks(payload_hash);
                """)
            connection.execute("BEGIN IMMEDIATE")
            orphan_candidates = self._evict_to_budget(connection)
            connection.commit()
        for candidate in orphan_candidates:
            self._delete_payload_if_unreferenced(candidate)
        self._state = _ReadyCache(connection)

    def _connect(self) -> sqlite3.Connection:
        if isinstance(self._state, _DisconnectedCache):
            self._state = _InitializingCache(self._new_connection())
        return self._state.connection

    def _new_connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self._registry_path,
            timeout=5.0,
            check_same_thread=False,
        )
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        connection.execute("PRAGMA trusted_schema = OFF")
        return connection

    def _reset_connection(self) -> None:
        previous = self._state
        self._state = _DisconnectedCache()
        if isinstance(previous, _DisconnectedCache):
            return
        connection = previous.connection
        try:
            connection.close()
        except sqlite3.Error:
            pass

    def _get(
        self,
        source_key: str,
        generation_key: str,
        start: int,
        length: int,
    ) -> bytes | None:
        cache_key = _cache_key(source_key, generation_key, start, length)
        return self._get_entry(
            cache_key,
            source_key=source_key,
            generation_key=generation_key,
            start=start,
            logical_length=length,
            max_age_ns=None,
        )

    def _get_entry(
        self,
        cache_key: str,
        *,
        source_key: str,
        generation_key: str,
        start: int,
        logical_length: int | None,
        max_age_ns: int | None,
    ) -> bytes | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT source_key, generation_key, range_start, range_length,
                       payload_hash, size_bytes, created_ns
                FROM range_blocks
                WHERE cache_key = ?
                """,
                (cache_key,),
            ).fetchone()
            if row is None:
                return None
            expected_prefix = (source_key, generation_key, start)
            if row[:3] != expected_prefix or (
                logical_length is not None and int(row[3]) != logical_length
            ):
                self._remove_entry(connection, cache_key, str(row[4]))
                return None
            payload_hash = str(row[4])
            expected_size = int(row[5])
            created_ns = int(row[6])
            if (
                expected_size < 1
                or int(row[3]) != expected_size
                or _PAYLOAD_HASH_RE.fullmatch(payload_hash) is None
            ):
                self._remove_entry(connection, cache_key, payload_hash)
                return None
            if max_age_ns is not None and self._clock_ns() - created_ns > max_age_ns:
                self._remove_entry(connection, cache_key, payload_hash)
                return None
            try:
                payload = self._payload_path(payload_hash).read_bytes()
            except OSError:
                self._remove_entry(connection, cache_key, payload_hash)
                return None
            if (
                len(payload) != expected_size
                or hashlib.sha256(payload).hexdigest() != payload_hash
            ):
                self._remove_entry(connection, cache_key, payload_hash)
                return None
            connection.execute(
                "UPDATE range_blocks SET last_access_ns = ? WHERE cache_key = ?",
                (self._clock_ns(), cache_key),
            )
            return payload

    def _put(
        self,
        source_key: str,
        generation_key: str,
        start: int,
        payload: bytes,
    ) -> None:
        length = len(payload)
        cache_key = _cache_key(source_key, generation_key, start, length)
        self._put_entry(
            cache_key,
            source_key=source_key,
            generation_key=generation_key,
            start=start,
            logical_length=length,
            payload=payload,
        )

    def _put_entry(
        self,
        cache_key: str,
        *,
        source_key: str,
        generation_key: str,
        start: int,
        logical_length: int,
        payload: bytes,
    ) -> None:
        payload_hash = hashlib.sha256(payload).hexdigest()
        payload_path = self._payload_path(payload_hash)
        now = self._clock_ns()
        orphan_candidates: set[str] = set()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if not _valid_existing_payload(payload_path, payload_hash, len(payload)):
                payload_path.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write(payload_path, payload)
            previous = connection.execute(
                "SELECT payload_hash FROM range_blocks WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
            if previous is not None and str(previous[0]) != payload_hash:
                orphan_candidates.add(str(previous[0]))
            connection.execute(
                """
                INSERT INTO range_blocks (
                    cache_key, source_key, generation_key, range_start,
                    range_length, payload_hash, size_bytes, created_ns,
                    last_access_ns
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    source_key = excluded.source_key,
                    generation_key = excluded.generation_key,
                    range_start = excluded.range_start,
                    range_length = excluded.range_length,
                    payload_hash = excluded.payload_hash,
                    size_bytes = excluded.size_bytes,
                    created_ns = excluded.created_ns,
                    last_access_ns = excluded.last_access_ns
                """,
                (
                    cache_key,
                    source_key,
                    generation_key,
                    start,
                    logical_length,
                    payload_hash,
                    len(payload),
                    now,
                    now,
                ),
            )
            orphan_candidates.update(self._evict_to_budget(connection))
            connection.commit()
        for candidate in orphan_candidates:
            self._delete_payload_if_unreferenced(candidate)

    def _repair_payload_registry(self, connection: sqlite3.Connection) -> set[str]:
        """Remove crash orphans and registry rows whose payload is already gone."""

        orphan_candidates: set[str] = set()
        rows = connection.execute(
            "SELECT DISTINCT payload_hash, size_bytes FROM range_blocks"
        ).fetchall()
        for raw_hash, raw_size in rows:
            payload_hash = str(raw_hash)
            expected_size = int(raw_size)
            if _PAYLOAD_HASH_RE.fullmatch(payload_hash) is None:
                connection.execute(
                    "DELETE FROM range_blocks WHERE payload_hash = ?", (payload_hash,)
                )
                continue
            payload_path = self._payload_path(payload_hash)
            try:
                actual_size = payload_path.stat().st_size
            except OSError:
                actual_size = -1
            if actual_size != expected_size:
                connection.execute(
                    "DELETE FROM range_blocks WHERE payload_hash = ?", (payload_hash,)
                )
                orphan_candidates.add(payload_hash)

        referenced = {
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT payload_hash FROM range_blocks"
            ).fetchall()
        }
        for candidate in self._payload_root.rglob("*"):
            if not candidate.is_file():
                continue
            if candidate.name.endswith(".tmp"):
                _unlink_best_effort(candidate)
                continue
            if not candidate.name.endswith(".block"):
                continue
            payload_hash = candidate.name.removesuffix(".block")
            expected_path = (
                self._payload_path(payload_hash)
                if _PAYLOAD_HASH_RE.fullmatch(payload_hash)
                else None
            )
            if candidate != expected_path:
                _unlink_best_effort(candidate)
            elif payload_hash not in referenced:
                orphan_candidates.add(payload_hash)
        return orphan_candidates

    def _evict_to_budget(self, connection: sqlite3.Connection) -> set[str]:
        orphan_candidates: set[str] = set()
        total = int(
            connection.execute(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM range_blocks"
            ).fetchone()[0]
        )
        while total > self._max_bytes:
            evicted = connection.execute("""
                SELECT cache_key, payload_hash, size_bytes
                FROM range_blocks
                ORDER BY last_access_ns, created_ns, cache_key
                LIMIT 1
                """).fetchone()
            if evicted is None:
                break
            connection.execute(
                "DELETE FROM range_blocks WHERE cache_key = ?", (str(evicted[0]),)
            )
            orphan_candidates.add(str(evicted[1]))
            total -= int(evicted[2])
        return orphan_candidates

    def _remove_entry(
        self,
        connection: sqlite3.Connection,
        cache_key: str,
        payload_hash: str,
    ) -> None:
        connection.execute("DELETE FROM range_blocks WHERE cache_key = ?", (cache_key,))
        connection.commit()
        self._delete_payload_if_unreferenced(payload_hash)

    def _delete_payload_if_unreferenced(self, payload_hash: str) -> None:
        if _PAYLOAD_HASH_RE.fullmatch(payload_hash) is None:
            return
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            referenced = connection.execute(
                "SELECT 1 FROM range_blocks WHERE payload_hash = ? LIMIT 1",
                (payload_hash,),
            ).fetchone()
            if referenced is None:
                try:
                    self._payload_path(payload_hash).unlink()
                except OSError:
                    pass
            connection.commit()

    def _payload_path(self, payload_hash: str) -> Path:
        if _PAYLOAD_HASH_RE.fullmatch(payload_hash) is None:
            raise ValueError("Invalid persistent range payload hash")
        return self._payload_root / payload_hash[:2] / f"{payload_hash}.block"


def _validate_lookup(
    source_key: str, generation_key: str, start: int, length: int
) -> None:
    if not isinstance(source_key, str) or not source_key:
        raise ValueError("Persistent range source key is required")
    if not isinstance(generation_key, str) or not generation_key:
        raise ValueError("Persistent range generation key is required")
    if not isinstance(start, int) or start < 0:
        raise ValueError("Persistent range start must be non-negative")
    if not isinstance(length, int) or length < 1:
        raise ValueError("Persistent range length must be positive")


def _cache_key(source_key: str, generation_key: str, start: int, length: int) -> str:
    identity = json.dumps(
        [_RANGE_KEY_CONTRACT, source_key, generation_key, start, length],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(identity.encode()).hexdigest()


def _validate_blob_lookup(
    namespace: str,
    identity: str,
    *,
    max_age_ns: int | None,
) -> None:
    if not isinstance(namespace, str) or not namespace:
        raise ValueError("Persistent track namespace is required")
    if not isinstance(identity, str) or not identity:
        raise ValueError("Persistent track identity is required")
    if max_age_ns is not None and (not isinstance(max_age_ns, int) or max_age_ns < 0):
        raise ValueError("Persistent track maximum age must be non-negative")


def _blob_cache_key(namespace: str, identity: str) -> str:
    value = json.dumps(
        [_BLOB_KEY_CONTRACT, namespace, identity],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(value.encode()).hexdigest()


def _valid_existing_payload(path: Path, expected_hash: str, expected_size: int) -> bool:
    try:
        payload = path.read_bytes()
    except OSError:
        return False
    return (
        len(payload) == expected_size
        and hashlib.sha256(payload).hexdigest() == expected_hash
    )


def _atomic_write(path: Path, payload: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
        _fsync_directory(path.parent)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def _unlink_best_effort(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def _fsync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
