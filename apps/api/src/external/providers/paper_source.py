"""Bounded public paper-source capture for PDF, HTML, text, and JATS."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Literal
from urllib.parse import urlsplit

import httpx

from ..contract import (
    Capability,
    FetchOptions,
    FetchResult,
    ParsedId,
    ProviderContractError,
    ProviderHttpError,
    ProviderRateLimitError,
    ProviderTimeoutError,
    Xref,
)
from ..public_http import PublicHttpBoundary, Resolver

PaperSourceKind = Literal["pdf", "captured_text"]

DEFAULT_PAPER_SOURCE_MAX_BYTES = 25 * 1024 * 1024
MAX_CAPTURED_TEXT_BYTES = 100_000
_PDF_MAGIC = b"%PDF-"
_TEXT_MEDIA_TYPES = {
    "application/jats+xml",
    "application/xhtml+xml",
    "application/xml",
    "text/html",
    "text/plain",
    "text/xml",
}


_TEXT_BOUNDARY_TAGS = frozenset(
    {
        "p",
        "div",
        "li",
        "tr",
        "section",
        "article",
        "title",
        "article-id",
        "pub-id",
        "elocation-id",
        "article-title",
    }
)


class PaperSourceRejected(ProviderContractError):
    """The source URL or response is not an admissible paper source."""


class PaperSourceTooLarge(Exception):
    """The source exceeded the explicit paper-fetch byte budget."""

    def __init__(self, byte_count: int, max_bytes: int) -> None:
        super().__init__(f"Paper source is {byte_count} bytes; limit is {max_bytes}")
        self.byte_count = byte_count
        self.max_bytes = max_bytes


@dataclass(frozen=True)
class PaperSourceResult:
    kind: PaperSourceKind
    original_url: str
    canonical_url: str
    media_type: str
    response_sha256: str
    byte_count: int
    title: str
    pdf_bytes: bytes | None = None
    captured_text: str | None = None
    captured_text_sha256: str | None = None


class PaperSourceProvider:
    """Fetch an arbitrary public paper URL through the provider substrate."""

    provider_id = "paper-source"
    rate_limit_per_s = 2.0
    rate_limit_burst = 2.0

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        resolver: Resolver | None = None,
    ) -> None:
        self._client = client
        self._resolver = resolver

    def detect_id(self, raw: str) -> ParsedId | None:
        return None

    async def fetch(self, parsed_id: ParsedId, opts: FetchOptions) -> FetchResult:
        raise ProviderContractError(
            "paper-source uses capture_source(), not canonical-id fetch()"
        )

    async def resolve_xrefs(
        self, parsed_id: ParsedId, target_provider: str | None = None
    ) -> list[Xref]:
        return []

    def declared_capabilities(self) -> list[Capability]:
        return [Capability.EXTERNAL_FETCH_PAPER]

    async def capture_source(
        self,
        source_url: str,
        *,
        opts: FetchOptions,
        max_bytes: int = DEFAULT_PAPER_SOURCE_MAX_BYTES,
    ) -> PaperSourceResult:
        if self._client is None:
            raise RuntimeError(
                "PaperSourceProvider used without an httpx.AsyncClient; "
                "the service layer must inject one."
            )
        boundary = PublicHttpBoundary(
            self._client,
            resolver=self._resolver,
            error_factory=PaperSourceRejected,
        )
        try:
            response, canonical_url = await boundary.open_get(
                source_url,
                accept=(
                    "application/pdf, application/jats+xml, application/xml, "
                    "text/html, text/plain;q=0.9, */*;q=0.1"
                ),
                user_agent=opts.user_agent,
                timeout=httpx.Timeout(
                    timeout=opts.total_timeout_s, connect=opts.connect_timeout_s
                ),
            )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                f"Paper source request timed out after {opts.total_timeout_s}s"
            ) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise ProviderHttpError(
                f"Paper source network error: {exc.__class__.__name__}"
            ) from exc

        try:
            if response.status_code == 429:
                raise ProviderRateLimitError(
                    "Paper source rate-limited the request",
                    retry_after_s=_parse_retry_after(
                        response.headers.get("Retry-After")
                    ),
                )
            if response.status_code >= 400:
                raise ProviderHttpError(
                    f"Paper source returned HTTP {response.status_code}",
                    status_code=response.status_code,
                )
            declared_length = _parse_content_length(
                response.headers.get("Content-Length")
            )
            if declared_length is not None and declared_length > max_bytes:
                raise PaperSourceTooLarge(declared_length, max_bytes)

            payload = bytearray()
            async for chunk in response.aiter_bytes():
                payload.extend(chunk)
                if len(payload) > max_bytes:
                    raise PaperSourceTooLarge(len(payload), max_bytes)
        finally:
            await response.aclose()

        content = bytes(payload)
        if not content:
            raise PaperSourceRejected("The paper source returned an empty response")
        response_sha256 = f"sha256:{hashlib.sha256(content).hexdigest()}"
        media_type = _media_type(response.headers.get("Content-Type"))
        title_fallback = _title_from_url(canonical_url)

        if content.startswith(_PDF_MAGIC):
            return PaperSourceResult(
                kind="pdf",
                original_url=source_url,
                canonical_url=canonical_url,
                media_type="application/pdf",
                response_sha256=response_sha256,
                byte_count=len(content),
                title=title_fallback,
                pdf_bytes=content,
            )
        if media_type == "application/pdf":
            raise PaperSourceRejected(
                "The paper source claimed to be a PDF but did not contain PDF bytes"
            )
        if media_type not in _TEXT_MEDIA_TYPES and not media_type.startswith("text/"):
            raise PaperSourceRejected(
                f"Unsupported paper source media type: {media_type or 'unknown'}"
            )

        decoded = _decode_text(content, response)
        title, captured_text = _extract_visible_text(
            decoded, media_type=media_type, fallback_title=title_fallback
        )
        if not captured_text:
            raise PaperSourceRejected("The paper source contained no readable text")
        captured_bytes = captured_text.encode("utf-8")
        if len(captured_bytes) > MAX_CAPTURED_TEXT_BYTES:
            captured_bytes = captured_bytes[:MAX_CAPTURED_TEXT_BYTES]
            captured_text = captured_bytes.decode("utf-8", errors="ignore").rstrip()
        captured_text_sha256 = (
            f"sha256:{hashlib.sha256(captured_text.encode('utf-8')).hexdigest()}"
        )
        return PaperSourceResult(
            kind="captured_text",
            original_url=source_url,
            canonical_url=canonical_url,
            media_type=media_type,
            response_sha256=response_sha256,
            byte_count=len(content),
            title=title,
            captured_text=captured_text,
            captured_text_sha256=captured_text_sha256,
        )


class _VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._hidden_depth = 0
        self._in_title = False
        self.text_parts: list[str] = []
        self.title_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = tag.casefold()
        if normalized in {"script", "style", "noscript", "svg"}:
            self._hidden_depth += 1
        if normalized == "title":
            self._in_title = True
        if normalized == "br" or normalized in _TEXT_BOUNDARY_TAGS:
            self.text_parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.casefold()
        if normalized in {"script", "style", "noscript", "svg"} and self._hidden_depth:
            self._hidden_depth -= 1
        if normalized == "title":
            self._in_title = False
        if normalized in _TEXT_BOUNDARY_TAGS:
            self.text_parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._hidden_depth:
            return
        if self._in_title:
            self.title_parts.append(data)
        self.text_parts.append(data)


def _extract_visible_text(
    source: str, *, media_type: str, fallback_title: str
) -> tuple[str, str]:
    if media_type == "text/plain":
        normalized = _normalize_text(source)
        return fallback_title, normalized
    parser = _VisibleTextParser()
    try:
        parser.feed(source)
        parser.close()
    except Exception as exc:
        raise PaperSourceRejected(
            "The paper source markup could not be parsed"
        ) from exc
    title = _normalize_inline(" ".join(parser.title_parts)) or fallback_title
    return title[:200], _normalize_text("".join(parser.text_parts))


def _normalize_text(value: str) -> str:
    lines = []
    for line in value.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        clean = re.sub(r"[\t\f\v ]+", " ", line).strip()
        if clean:
            lines.append(clean)
        elif lines and lines[-1] != "":
            lines.append("")
    return "\n".join(lines).strip()


def _normalize_inline(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _decode_text(content: bytes, response: httpx.Response) -> str:
    encoding = response.charset_encoding or "utf-8"
    try:
        return content.decode(encoding)
    except (LookupError, UnicodeDecodeError):
        return content.decode("utf-8", errors="replace")


def _media_type(value: str | None) -> str:
    return (value or "").split(";", maxsplit=1)[0].strip().casefold()


def _title_from_url(url: str) -> str:
    path = urlsplit(url).path.rstrip("/")
    leaf = path.rsplit("/", maxsplit=1)[-1] if path else ""
    return (leaf or urlsplit(url).hostname or "Paper source")[:200]


def _parse_content_length(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None
