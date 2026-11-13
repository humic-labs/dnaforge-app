"""Bounded, capability-safe htsget v1.3 client runtime.

Durable callers identify a source with only an endpoint, resource identifier,
data class, and format.  htsget tickets, signed block URLs, and ticket-provided
headers are consumed inside this process and are never returned to the desktop.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import re
import secrets
import shutil
import tempfile
import time
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import (
    parse_qsl,
    quote,
    unquote_to_bytes,
    urlencode,
    urlsplit,
    urlunsplit,
)

import httpx

from ..variant_source_operation_contract import (
    VariantReferenceIdentity,
    variant_assembly_revision,
)
from .credential_broker import CredentialBroker, CredentialBrokerError
from .public_http import PublicHttpBoundary, Resolver

HtsgetDataClass = Literal["reads", "variants"]
HtsgetFormat = Literal["BAM", "CRAM", "VCF", "BCF"]

_FORMATS_BY_CLASS: dict[HtsgetDataClass, frozenset[str]] = {
    "reads": frozenset({"BAM", "CRAM"}),
    "variants": frozenset({"VCF", "BCF"}),
}
_FORMAT_SUFFIX = {"BAM": ".bam", "CRAM": ".cram", "VCF": ".vcf.gz", "BCF": ".bcf"}
_TICKET_ACCEPT = "application/vnd.ga4gh.htsget.v1.3.0+json, application/json"
_USER_AGENT = "DNAForge/htsget-v1"
_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)
_MAX_TICKET_BYTES = 1024 * 1024
_MAX_TICKET_BLOCKS = 4096
_MAX_HEADER_BYTES = 64 * 1024 * 1024
_MAX_REGION_BYTES = 256 * 1024 * 1024
_MAX_REGION_BP = 5_000_000
_VARIANT_WINDOW_BP = 1_000_000
_SESSION_TTL_SECONDS = 15 * 60
_MAX_SESSIONS = 64
_HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_FORBIDDEN_TICKET_HEADERS = frozenset(
    {
        "connection",
        "content-length",
        "cookie",
        "host",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)


class HtsgetSourceError(Exception):
    """An htsget endpoint, ticket, block, or prepared session is invalid."""

    def __init__(
        self,
        message: str,
        *,
        failure_kind: str = "source_invalid",
        retryable: bool = False,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.failure_kind = failure_kind
        self.retryable = retryable
        self.status_code = status_code


@dataclass(frozen=True)
class HtsgetPreparedSource:
    source_token: str
    source_identity: str
    data_class: HtsgetDataClass
    format: HtsgetFormat
    references: tuple[tuple[str, int], ...]
    matched_references: tuple[str, ...]
    samples: tuple[str, ...]
    assembly_revision: str
    expires_in_seconds: int


@dataclass(frozen=True)
class HtsgetSession:
    source_token: str
    source_identity: str
    endpoint: str
    resource_id: str
    data_class: HtsgetDataClass
    format: HtsgetFormat
    references: tuple[tuple[str, int], ...]
    matched_references: tuple[str, ...]
    samples: tuple[str, ...]
    assembly_revision: str
    expires_at: float
    auth_ref: str | None = None


@dataclass(frozen=True)
class HtsgetRegionSnapshot:
    path: Path
    index_path: Path | None

    def cleanup(self) -> None:
        shutil.rmtree(self.path.parent, ignore_errors=True)


@dataclass(frozen=True)
class _TicketBlock:
    url: str
    headers: dict[str, str]


class HtsgetService:
    """Own process-local htsget sessions and bounded regional snapshots."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        resolver: Resolver | None = None,
        root: Path | None = None,
        credential_broker: CredentialBroker | None = None,
    ) -> None:
        self._credential_broker = credential_broker or CredentialBroker()
        self._endpoint_http = PublicHttpBoundary(
            client,
            resolver=resolver,
            error_factory=lambda message: HtsgetSourceError(message),
        )
        self._block_http = PublicHttpBoundary(
            client,
            resolver=resolver,
            allow_credential_query=True,
            error_factory=lambda message: HtsgetSourceError(message),
        )
        if root is None:
            self._root = Path(tempfile.mkdtemp(prefix="dnaforge-htsget-"))
        else:
            self._root = root
            self._root.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, HtsgetSession] = {}
        self._closed = False

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._sessions.clear()
        await asyncio.to_thread(shutil.rmtree, self._root, True)

    async def prepare(
        self,
        *,
        endpoint: str,
        resource_id: str,
        data_class: HtsgetDataClass,
        source_format: str,
        references: list[dict[str, object]],
        auth_ref: str | None = None,
    ) -> HtsgetPreparedSource:
        self._require_open()
        if auth_ref:
            self._credential_headers(auth_ref, endpoint)
        canonical_endpoint = (await self._endpoint_http.validate_url(endpoint)).rstrip(
            "/"
        )
        canonical_resource = _validate_resource_id(resource_id)
        expected_format = _validate_format(data_class, source_format)
        expected_references = _validate_references(references)
        ticket_url = _ticket_url(
            canonical_endpoint,
            canonical_resource,
            data_class,
            expected_format,
            header_only=True,
        )
        blocks, ticket_format = await self._fetch_ticket(
            ticket_url, expected_format, auth_ref=auth_ref
        )
        header_path, header_bytes = await self._materialize_blocks(
            blocks,
            suffix=_FORMAT_SUFFIX[expected_format],
            byte_limit=_MAX_HEADER_BYTES,
        )
        try:
            actual_references, samples, actual_format = await asyncio.to_thread(
                _inspect_source, header_path, data_class, expected_format
            )
        finally:
            shutil.rmtree(header_path.parent, ignore_errors=True)
        if ticket_format != expected_format or actual_format != expected_format:
            raise HtsgetSourceError(
                f"The htsget source is {actual_format}, not {expected_format}.",
                failure_kind="format_mismatch",
            )
        matched_references = _require_reference_compatibility(
            data_class=data_class,
            expected=expected_references,
            actual=actual_references,
        )
        assembly_revision = variant_assembly_revision(
            [
                VariantReferenceIdentity(name=name, length=length)
                for name, length in expected_references
            ]
        )
        identity_document = json.dumps(
            {
                "contract": "dnaforge.htsget-source.v1",
                "endpoint": canonical_endpoint,
                "resourceId": canonical_resource,
                "dataClass": data_class,
                "format": expected_format,
                "headerSha256": hashlib.sha256(header_bytes).hexdigest(),
                "references": actual_references,
                "samples": samples,
            },
            sort_keys=True,
            separators=(",", ":"),
        )
        source_identity = hashlib.sha256(identity_document.encode("utf-8")).hexdigest()
        self._expire_sessions()
        while len(self._sessions) >= _MAX_SESSIONS:
            oldest = min(self._sessions.values(), key=lambda item: item.expires_at)
            self._sessions.pop(oldest.source_token, None)
        token = secrets.token_urlsafe(32)
        session = HtsgetSession(
            source_token=token,
            source_identity=source_identity,
            endpoint=canonical_endpoint,
            resource_id=canonical_resource,
            data_class=data_class,
            format=expected_format,
            references=actual_references,
            matched_references=matched_references,
            samples=samples,
            assembly_revision=assembly_revision,
            expires_at=time.monotonic() + _SESSION_TTL_SECONDS,
            auth_ref=auth_ref,
        )
        self._sessions[token] = session
        return HtsgetPreparedSource(
            source_token=token,
            source_identity=source_identity,
            data_class=data_class,
            format=expected_format,
            references=actual_references,
            matched_references=matched_references,
            samples=samples,
            assembly_revision=assembly_revision,
            expires_in_seconds=_SESSION_TTL_SECONDS,
        )

    def get_session(
        self, source_token: str, *, source_identity: str | None = None
    ) -> HtsgetSession:
        self._require_open()
        self._expire_sessions()
        session = self._sessions.get(source_token)
        if session is None:
            raise HtsgetSourceError(
                "The htsget source grant expired; admit the durable source again.",
                failure_kind="grant_expired",
                status_code=401,
            )
        if source_identity is not None and session.source_identity != source_identity:
            raise HtsgetSourceError(
                "The htsget source changed after admission.",
                failure_kind="source_changed",
                status_code=409,
            )
        return session

    async def materialize_region(
        self,
        source_token: str,
        *,
        reference_name: str,
        start: int,
        end: int,
        source_identity: str | None = None,
    ) -> HtsgetRegionSnapshot:
        session = self.get_session(source_token, source_identity=source_identity)
        if session.data_class != "reads":
            raise HtsgetSourceError(
                "Only htsget read sources can create alignment snapshots."
            )
        _validate_region(session, reference_name, start, end)
        ticket_url = _ticket_url(
            session.endpoint,
            session.resource_id,
            session.data_class,
            session.format,
            reference_name=reference_name,
            start=start,
            end=end,
        )
        blocks, ticket_format = await self._fetch_ticket(
            ticket_url, session.format, auth_ref=session.auth_ref
        )
        if ticket_format != session.format:
            raise HtsgetSourceError("The htsget ticket format changed after admission.")
        path, _ = await self._materialize_blocks(
            blocks,
            suffix=_FORMAT_SUFFIX[session.format],
            byte_limit=_MAX_REGION_BYTES,
        )
        try:
            index_path = await asyncio.to_thread(
                _index_alignment_snapshot, path, session.format
            )
        except Exception:
            shutil.rmtree(path.parent, ignore_errors=True)
            raise
        return HtsgetRegionSnapshot(path=path, index_path=index_path)

    async def query_variant_page(
        self,
        source_token: str,
        *,
        source_identity: str,
        assembly_revision: str,
        references: list[dict[str, object]],
        cursor: str | None,
        limit: int,
    ) -> dict[str, Any]:
        from ..services import variant_queries

        session = self.get_session(source_token, source_identity=source_identity)
        if session.data_class != "variants":
            raise HtsgetSourceError(
                "The prepared htsget source does not contain variants."
            )
        expected_references = _validate_references(references)
        expected_revision = variant_assembly_revision(
            [
                VariantReferenceIdentity(name=name, length=length)
                for name, length in expected_references
            ]
        )
        if (
            assembly_revision != session.assembly_revision
            or expected_revision != assembly_revision
        ):
            raise HtsgetSourceError(
                "The htsget source or reference changed after preparation.",
                failure_kind="source_changed",
                status_code=409,
            )
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= 200
        ):
            raise HtsgetSourceError("Variant page limit must be between 1 and 200.")
        start_chrom_index, start_bp, start_offset = variant_queries._decode_cursor(
            cursor,
            source_identity=source_identity,
            assembly_revision=assembly_revision,
        )
        if start_chrom_index >= len(expected_references):
            raise HtsgetSourceError(
                "The variant page cursor is outside this reference."
            )

        summaries: list[dict[str, Any]] = []
        cursors_after: list[str] = []
        stop = False
        for chrom_index in range(start_chrom_index, len(expected_references)):
            chrom, chrom_length = expected_references[chrom_index]
            window_start = start_bp if chrom_index == start_chrom_index else 0
            while window_start < chrom_length:
                window_end = min(chrom_length, window_start + _VARIANT_WINDOW_BP)
                path = await self._materialize_variant_region(
                    session, reference_name=chrom, start=window_start, end=window_end
                )
                try:
                    page_rows = await asyncio.to_thread(
                        _read_variant_window,
                        path,
                        session.format,
                        chrom,
                        window_start,
                        window_end,
                        (
                            start_offset
                            if chrom_index == start_chrom_index
                            and window_start == start_bp
                            else 0
                        ),
                        source_identity,
                        limit + 1 - len(summaries),
                    )
                finally:
                    shutil.rmtree(path.parent, ignore_errors=True)
                for record_start, position_offset, summary in page_rows:
                    summaries.append(summary)
                    cursors_after.append(
                        variant_queries._encode_cursor(
                            chrom_index,
                            record_start,
                            position_offset,
                            source_identity=source_identity,
                            assembly_revision=assembly_revision,
                        )
                    )
                    if len(summaries) > limit:
                        stop = True
                        break
                if stop:
                    break
                window_start = window_end
            if stop:
                break
        has_more = len(summaries) > limit
        return {
            "variants": summaries[:limit],
            "nextCursor": cursors_after[limit - 1] if has_more else None,
        }

    async def query_variant_region(
        self,
        source_token: str,
        *,
        source_identity: str,
        assembly_revision: str,
        references: list[dict[str, object]],
        chrom: str,
        start: int,
        end: int,
        limit: int,
    ) -> dict[str, Any]:
        from ..services import variant_queries

        session = self.get_session(source_token, source_identity=source_identity)
        if session.data_class != "variants":
            raise HtsgetSourceError(
                "The prepared htsget source does not contain variants."
            )
        expected_references = _validate_references(references)
        expected_revision = variant_assembly_revision(
            [
                VariantReferenceIdentity(name=name, length=length)
                for name, length in expected_references
            ]
        )
        if (
            assembly_revision != session.assembly_revision
            or expected_revision != assembly_revision
        ):
            raise HtsgetSourceError(
                "The htsget source or reference changed after preparation.",
                failure_kind="source_changed",
                status_code=409,
            )
        variant_queries._validate_variant_region(
            chrom=chrom, start=start, end=end, limit=limit
        )
        expected_lengths = dict(expected_references)
        if chrom not in expected_lengths or end > expected_lengths[chrom]:
            raise HtsgetSourceError(
                "The htsget variant region is outside the selected assembly.",
                failure_kind="source_changed",
                status_code=409,
            )
        _validate_region(session, chrom, start, end)
        path = await self._materialize_variant_region(
            session, reference_name=chrom, start=start, end=end
        )
        try:
            rows = await asyncio.to_thread(
                _read_variant_window,
                path,
                session.format,
                chrom,
                start,
                end,
                0,
                source_identity,
                limit + 1,
                True,
            )
        finally:
            shutil.rmtree(path.parent, ignore_errors=True)
        return {
            "variants": [summary for _, _, summary in rows[:limit]],
            "truncated": len(rows) > limit,
        }

    async def _materialize_variant_region(
        self,
        session: HtsgetSession,
        *,
        reference_name: str,
        start: int,
        end: int,
    ) -> Path:
        _validate_region(session, reference_name, start, end)
        ticket_url = _ticket_url(
            session.endpoint,
            session.resource_id,
            session.data_class,
            session.format,
            reference_name=reference_name,
            start=start,
            end=end,
        )
        blocks, ticket_format = await self._fetch_ticket(
            ticket_url, session.format, auth_ref=session.auth_ref
        )
        if ticket_format != session.format:
            raise HtsgetSourceError("The htsget ticket format changed after admission.")
        path, _ = await self._materialize_blocks(
            blocks,
            suffix=_FORMAT_SUFFIX[session.format],
            byte_limit=_MAX_REGION_BYTES,
        )
        return path

    async def _fetch_ticket(
        self,
        ticket_url: str,
        expected_format: HtsgetFormat,
        *,
        auth_ref: str | None = None,
    ) -> tuple[tuple[_TicketBlock, ...], HtsgetFormat]:
        credential_headers = (
            self._credential_headers(auth_ref, ticket_url) if auth_ref else None
        )
        response, _ = await self._endpoint_http.open_get(
            ticket_url,
            headers=credential_headers,
            accept=_TICKET_ACCEPT,
            user_agent=_USER_AGENT,
            timeout=_TIMEOUT,
        )
        try:
            if response.status_code != 200:
                raise HtsgetSourceError(
                    f"The htsget endpoint returned HTTP {response.status_code}.",
                    failure_kind=(
                        "authentication_required"
                        if response.status_code == 401
                        else "provider_error"
                    ),
                    retryable=response.status_code >= 500,
                    status_code=response.status_code,
                )
            payload = await _read_bounded_response(
                response, _MAX_TICKET_BYTES, "htsget ticket"
            )
        finally:
            await response.aclose()
        try:
            document = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HtsgetSourceError(
                "The htsget endpoint returned an invalid JSON ticket."
            ) from exc
        if not isinstance(document, dict) or not isinstance(
            document.get("htsget"), dict
        ):
            raise HtsgetSourceError("The htsget response has no ticket object.")
        ticket = document["htsget"]
        ticket_format = _validate_format(
            "reads" if expected_format in {"BAM", "CRAM"} else "variants",
            ticket.get("format"),
        )
        raw_urls = ticket.get("urls")
        if (
            not isinstance(raw_urls, list)
            or not raw_urls
            or len(raw_urls) > _MAX_TICKET_BLOCKS
        ):
            raise HtsgetSourceError("The htsget ticket has an invalid block list.")
        blocks: list[_TicketBlock] = []
        for raw_block in raw_urls:
            if not isinstance(raw_block, dict) or not isinstance(
                raw_block.get("url"), str
            ):
                raise HtsgetSourceError("The htsget ticket contains an invalid block.")
            url = raw_block["url"].strip()
            if not url:
                raise HtsgetSourceError(
                    "The htsget ticket contains an empty block URL."
                )
            headers = _validate_ticket_headers(raw_block.get("headers"))
            blocks.append(_TicketBlock(url=url, headers=headers))
        return tuple(blocks), ticket_format

    def _credential_headers(self, auth_ref: str, url: str) -> dict[str, str]:
        try:
            return self._credential_broker.authorize(
                auth_ref=auth_ref,
                audience="htsget",
                url=url,
            )
        except CredentialBrokerError as exc:
            raise HtsgetSourceError(str(exc), failure_kind=exc.failure_kind) from exc

    async def _materialize_blocks(
        self,
        blocks: tuple[_TicketBlock, ...],
        *,
        suffix: str,
        byte_limit: int,
    ) -> tuple[Path, bytes]:
        directory = Path(tempfile.mkdtemp(prefix="snapshot-", dir=self._root))
        path = directory / f"source{suffix}"
        digest_bytes = bytearray()
        total = 0
        try:
            with path.open("wb") as output:
                for block in blocks:
                    if block.url.startswith("data:"):
                        payload = _decode_data_uri(block.url, byte_limit - total)
                        output.write(payload)
                        if len(digest_bytes) < _MAX_HEADER_BYTES:
                            digest_bytes.extend(payload)
                        total += len(payload)
                        continue
                    response, _ = await self._block_http.open_get(
                        block.url,
                        headers=block.headers,
                        accept="application/octet-stream, */*",
                        user_agent=_USER_AGENT,
                        timeout=_TIMEOUT,
                    )
                    try:
                        if response.status_code not in {200, 206}:
                            raise HtsgetSourceError(
                                f"An htsget data block returned HTTP {response.status_code}.",
                                failure_kind="block_unavailable",
                                retryable=response.status_code >= 500,
                                status_code=response.status_code,
                            )
                        encoding = response.headers.get(
                            "Content-Encoding", "identity"
                        ).casefold()
                        if encoding not in {"", "identity"}:
                            raise HtsgetSourceError(
                                "An htsget data block used an unsupported content encoding."
                            )
                        chunks = (
                            (response.content,)
                            if response.is_stream_consumed
                            else response.aiter_raw()
                        )
                        async for chunk in _as_async_chunks(chunks):
                            total += len(chunk)
                            if total > byte_limit:
                                raise HtsgetSourceError(
                                    "The htsget response exceeded the bounded snapshot quota.",
                                    failure_kind="quota_exceeded",
                                )
                            output.write(chunk)
                            if len(digest_bytes) < _MAX_HEADER_BYTES:
                                remaining = _MAX_HEADER_BYTES - len(digest_bytes)
                                digest_bytes.extend(chunk[:remaining])
                    finally:
                        await response.aclose()
            if total == 0:
                raise HtsgetSourceError("The htsget ticket returned no data.")
            return path, bytes(digest_bytes)
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            raise

    def _expire_sessions(self) -> None:
        now = time.monotonic()
        for token, session in tuple(self._sessions.items()):
            if session.expires_at <= now:
                self._sessions.pop(token, None)

    def _require_open(self) -> None:
        if self._closed:
            raise HtsgetSourceError("The htsget runtime is closed.")


def _validate_resource_id(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 2048:
        raise HtsgetSourceError("The htsget resource identifier is invalid.")
    normalized = value.strip()
    if normalized in {".", ".."} or any(
        part in {".", ".."} for part in normalized.split("/")
    ):
        raise HtsgetSourceError(
            "The htsget resource identifier contains an invalid path segment."
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise HtsgetSourceError(
            "The htsget resource identifier contains control characters."
        )
    return normalized


def _validate_format(data_class: HtsgetDataClass, value: object) -> HtsgetFormat:
    if data_class not in _FORMATS_BY_CLASS:
        raise HtsgetSourceError("The htsget data class must be reads or variants.")
    normalized = value.upper() if isinstance(value, str) else ""
    if normalized not in _FORMATS_BY_CLASS[data_class]:
        allowed = " or ".join(sorted(_FORMATS_BY_CLASS[data_class]))
        raise HtsgetSourceError(f"The htsget {data_class} format must be {allowed}.")
    return normalized  # type: ignore[return-value]


def _validate_references(
    values: list[dict[str, object]],
) -> tuple[tuple[str, int], ...]:
    if not values:
        raise HtsgetSourceError("The reference assembly has no chromosome identity.")
    references: list[tuple[str, int]] = []
    for value in values:
        name = value.get("name") if isinstance(value, dict) else None
        length = value.get("length") if isinstance(value, dict) else None
        if (
            not isinstance(name, str)
            or not name
            or any(character.isspace() for character in name)
            or not isinstance(length, int)
            or isinstance(length, bool)
            or length <= 0
        ):
            raise HtsgetSourceError("The htsget reference assembly is invalid.")
        references.append((name, length))
    if len({name for name, _ in references}) != len(references):
        raise HtsgetSourceError(
            "The htsget reference assembly contains duplicate names."
        )
    return tuple(references)


def _ticket_url(
    endpoint: str,
    resource_id: str,
    data_class: HtsgetDataClass,
    source_format: HtsgetFormat,
    *,
    header_only: bool = False,
    reference_name: str | None = None,
    start: int | None = None,
    end: int | None = None,
) -> str:
    parsed = urlsplit(endpoint)
    path = f"{parsed.path.rstrip('/')}/{data_class}/{quote(resource_id, safe='')}"
    query = list(parse_qsl(parsed.query, keep_blank_values=True))
    query.append(("format", source_format))
    if header_only:
        query.append(("class", "header"))
    if reference_name is not None:
        query.extend(
            (
                ("referenceName", reference_name),
                ("start", str(start)),
                ("end", str(end)),
            )
        )
    return urlunsplit((parsed.scheme, parsed.netloc, path, urlencode(query), ""))


def _validate_ticket_headers(value: object) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict) or len(value) > 64:
        raise HtsgetSourceError("The htsget ticket contains invalid request headers.")
    headers: dict[str, str] = {}
    for raw_name, raw_value in value.items():
        if (
            not isinstance(raw_name, str)
            or not _HEADER_NAME.fullmatch(raw_name)
            or not isinstance(raw_value, str)
            or len(raw_name) > 128
            or len(raw_value) > 8192
            or "\r" in raw_value
            or "\n" in raw_value
        ):
            raise HtsgetSourceError(
                "The htsget ticket contains an invalid request header."
            )
        if raw_name.casefold() in _FORBIDDEN_TICKET_HEADERS:
            raise HtsgetSourceError(
                f"The htsget ticket may not override the {raw_name} request header."
            )
        headers[raw_name] = raw_value
    return headers


async def _read_bounded_response(
    response: httpx.Response, limit: int, label: str
) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > limit:
            raise HtsgetSourceError(f"The {label} exceeded its size limit.")
        chunks.append(chunk)
    return b"".join(chunks)


async def _as_async_chunks(
    value: AsyncIterator[bytes] | Iterable[bytes],
) -> AsyncIterator[bytes]:
    if hasattr(value, "__aiter__"):
        async for chunk in value:  # type: ignore[union-attr]
            yield chunk
        return
    for chunk in value:
        yield chunk


def _decode_data_uri(value: str, remaining: int) -> bytes:
    try:
        metadata, encoded = value[5:].split(",", 1)
    except ValueError as exc:
        raise HtsgetSourceError(
            "The htsget ticket contains an invalid data URI."
        ) from exc
    try:
        payload = (
            base64.b64decode(encoded, validate=True)
            if metadata.casefold().endswith(";base64")
            else unquote_to_bytes(encoded)
        )
    except (binascii.Error, ValueError) as exc:
        raise HtsgetSourceError(
            "The htsget ticket contains an invalid data URI."
        ) from exc
    if len(payload) > remaining:
        raise HtsgetSourceError(
            "The htsget response exceeded the bounded snapshot quota.",
            failure_kind="quota_exceeded",
        )
    return payload


def _inspect_source(
    path: Path, data_class: HtsgetDataClass, expected_format: HtsgetFormat
) -> tuple[tuple[tuple[str, int], ...], tuple[str, ...], HtsgetFormat]:
    try:
        import pysam
    except ModuleNotFoundError as exc:
        raise HtsgetSourceError("htsget viewing requires pysam/htslib.") from exc
    try:
        if data_class == "reads":
            mode = "rb" if expected_format == "BAM" else "rc"
            with pysam.AlignmentFile(str(path), mode) as source:
                actual_format: HtsgetFormat = "CRAM" if source.is_cram else "BAM"
                references = tuple(
                    (name, int(length))
                    for name, length in zip(
                        source.references, source.lengths, strict=True
                    )
                )
                return references, (), actual_format
        with pysam.VariantFile(str(path)) as source:
            actual_format = "BCF" if source.is_bcf else "VCF"
            references = tuple(
                (name, int(contig.length))
                for name, contig in source.header.contigs.items()
                if contig.length is not None
            )
            return references, tuple(source.header.samples), actual_format
    except (OSError, ValueError) as exc:
        raise HtsgetSourceError(
            f"The htsget {data_class} header is unreadable: {exc}"
        ) from exc


def _require_reference_compatibility(
    *,
    data_class: HtsgetDataClass,
    expected: tuple[tuple[str, int], ...],
    actual: tuple[tuple[str, int], ...],
) -> tuple[str, ...]:
    expected_by_name = dict(expected)
    actual_by_name = dict(actual)
    if not actual_by_name:
        raise HtsgetSourceError("The htsget source header has no named references.")
    mismatched = [
        name
        for name, length in actual
        if name not in expected_by_name or expected_by_name[name] != length
    ]
    if mismatched:
        raise HtsgetSourceError(
            f"The htsget source does not match the selected assembly at {mismatched[0]}.",
            failure_kind="assembly_mismatch",
        )
    if data_class == "reads" and actual_by_name != expected_by_name:
        raise HtsgetSourceError(
            "The htsget read source does not contain the complete selected assembly.",
            failure_kind="assembly_mismatch",
        )
    return tuple(name for name, _ in actual)


def _validate_region(
    session: HtsgetSession, reference_name: str, start: int, end: int
) -> None:
    lengths = dict(session.references)
    length = lengths.get(reference_name)
    if length is None:
        raise HtsgetSourceError(
            f"Reference {reference_name} is not present in the htsget source."
        )
    if (
        not isinstance(start, int)
        or isinstance(start, bool)
        or not isinstance(end, int)
        or isinstance(end, bool)
        or start < 0
        or end <= start
        or end > length
    ):
        raise HtsgetSourceError(
            "The htsget region must satisfy 0 <= start < end <= reference length."
        )
    if end - start > _MAX_REGION_BP:
        raise HtsgetSourceError(
            f"The htsget region exceeds the {_MAX_REGION_BP:,}-base viewport limit.",
            failure_kind="region_too_large",
        )


def _index_alignment_snapshot(path: Path, source_format: HtsgetFormat) -> Path:
    try:
        import pysam

        pysam.index(str(path))
    except Exception as exc:
        raise HtsgetSourceError(
            f"The htsget regional alignment could not be indexed: {exc}"
        ) from exc
    candidates = (
        (Path(f"{path}.bai"), path.with_suffix(".bai"))
        if source_format == "BAM"
        else (Path(f"{path}.crai"), path.with_suffix(".crai"))
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise HtsgetSourceError("The htsget regional alignment index was not created.")


def _read_variant_window(
    path: Path,
    source_format: HtsgetFormat,
    chrom: str,
    start: int,
    end: int,
    skip_at_start: int,
    source_identity: str,
    max_rows: int | None = None,
    include_overlaps: bool = False,
) -> list[tuple[int, int, dict[str, Any]]]:
    from ..services import variant_queries

    try:
        import pysam

        variants = pysam.VariantFile(str(path))
    except Exception as exc:
        raise HtsgetSourceError(
            f"The htsget regional {source_format} is unreadable: {exc}"
        ) from exc
    rows: list[tuple[int, int, dict[str, Any]]] = []
    current_start: int | None = None
    visible_at_position = 0
    try:
        for record in variants:
            if record.contig != chrom:
                continue
            record_start = max(0, int(record.start))
            record_end = max(record_start + 1, int(record.stop or (record_start + 1)))
            if include_overlaps:
                outside_window = record_start >= end or record_end <= start
            else:
                outside_window = record_start < start or record_start >= end
            if outside_window:
                continue
            alts = variant_queries._visible_alts(record)
            if not alts:
                continue
            if current_start != record_start:
                current_start = record_start
                visible_at_position = 0
            visible_at_position += 1
            if record_start == start and visible_at_position <= skip_at_start:
                continue
            rows.append(
                (
                    record_start,
                    visible_at_position,
                    variant_queries._record_summary(
                        record, alts, visible_at_position, source_identity
                    ),
                )
            )
            if max_rows is not None and len(rows) >= max_rows:
                break
    finally:
        variants.close()
    return rows
