"""Official UCSC Genome Browser API provider.

This provider covers UCSC's complete documented JSON endpoint set behind one
allowlisted dispatch boundary. Higher-level track search and regional reads
continue to normalize the two endpoint shapes they consume directly.

Large remote BigBed/BigWig files use byte-range reads in the desktop worker;
they do not pass through this JSON path. UCSC asks API clients to stay near one
request per second, so the provider advertises that limit to the shared
external-resource resilience layer.
"""

from __future__ import annotations

import asyncio
import codecs
import html
import ipaddress
import json
import re
import tempfile
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any, BinaryIO, Literal, TypeVar
from urllib.parse import quote, urljoin, urlsplit

import httpx
import ijson

from ..async_single_flight import AsyncSingleFlight
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

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_TRACK_REFERENCE_RE = re.compile(r"[A-Za-z0-9_.:+-]{1,200}")
_CATALOG_COLOR_RE = re.compile(
    r"\s*(?P<red>\d{1,3})\s*,\s*(?P<green>\d{1,3})\s*,\s*(?P<blue>\d{1,3})\s*"
)
_ENCODE_EXPERIMENT_RE = re.compile(r"(?<![A-Z0-9])ENCSR[A-Z0-9]{6}(?![A-Z0-9])")
_ENCODE_FILE_RE = re.compile(r"(?<![A-Z0-9])ENCFF[A-Z0-9]{6}(?![A-Z0-9])")
_QUANTITATIVE_TYPES = {"bigwig", "wig", "wiggle"}
_TRANSCRIPT_TYPES = {"biggenepred", "genepred"}
_PEAK_TYPES = {"bignarrowpeak", "broadpeak", "narrowpeak"}
_REPEAT_TYPES = {"rmsk"}
_INTERVAL_TYPES = {
    "bed",
    "bigbed",
    "chain",
    "gvf",
    "netalign",
    "pgsnp",
    "psl",
}
_READ_TYPES = {"bam", "cram"}
_VARIANT_TYPES = {"bcf", "vcf", "vcftabix"}
_CATALOG_CACHE_TTL_S = 15 * 60
_CATALOG_CACHE_MAX_ENTRIES = 8
_HUB_GENOME_CACHE_MAX_ENTRIES = 64
_GENARK_HUB_CACHE_MAX_ENTRIES = 128
_GENARK_HUB_ORIGIN = "https://hgdownload.soe.ucsc.edu/hubs/"
_GENARK_HUB_PREFIX_RE = re.compile(r"^/?gbdb/genark/")
_GENARK_ACCESSION = re.compile(r"^GC[AF]_\d{9}\.\d+$")
_JSON_SPOOL_MEMORY_BYTES = 8 * 1024 * 1024
_MAX_JSON_RESPONSE_BYTES = 1024 * 1024 * 1024
_MAX_STREAMED_API_RESPONSE_BYTES = _MAX_JSON_RESPONSE_BYTES
_HUB_METADATA_KEYS = {
    "downloadtime",
    "genomes",
    "huburl",
    "itemsreturned",
}


class UcscApiEndpoint(str, Enum):
    """The complete documented UCSC Genome Browser JSON endpoint set."""

    FIND_GENOME = "/findGenome"
    LIST_PUBLIC_HUBS = "/list/publicHubs"
    LIST_UCSC_GENOMES = "/list/ucscGenomes"
    LIST_GENARK_GENOMES = "/list/genarkGenomes"
    LIST_HUB_GENOMES = "/list/hubGenomes"
    LIST_FILES = "/list/files"
    LIST_TRACKS = "/list/tracks"
    LIST_CHROMOSOMES = "/list/chromosomes"
    LIST_SCHEMA = "/list/schema"
    GET_SEQUENCE = "/getData/sequence"
    GET_TRACK = "/getData/track"
    SEARCH = "/search"


@dataclass(frozen=True)
class UcscApiPayload:
    """A bounded UCSC response held outside the Python object heap."""

    body: BinaryIO
    byte_length: int
    content_kind: Literal["json", "text"]


@dataclass(frozen=True)
class _UcscEndpointSpec:
    required_params: frozenset[str]
    optional_params: frozenset[str]


_UCSC_ENDPOINT_SPECS = {
    UcscApiEndpoint.FIND_GENOME: _UcscEndpointSpec(
        required_params=frozenset({"q"}),
        optional_params=frozenset(
            {
                "statsOnly",
                "browser",
                "year",
                "category",
                "status",
                "level",
                "maxItemsOutput",
            }
        ),
    ),
    UcscApiEndpoint.LIST_PUBLIC_HUBS: _UcscEndpointSpec(
        required_params=frozenset(), optional_params=frozenset()
    ),
    UcscApiEndpoint.LIST_UCSC_GENOMES: _UcscEndpointSpec(
        required_params=frozenset(), optional_params=frozenset()
    ),
    UcscApiEndpoint.LIST_GENARK_GENOMES: _UcscEndpointSpec(
        required_params=frozenset(),
        optional_params=frozenset({"genome", "maxItemsOutput"}),
    ),
    UcscApiEndpoint.LIST_HUB_GENOMES: _UcscEndpointSpec(
        required_params=frozenset({"hubUrl"}), optional_params=frozenset()
    ),
    UcscApiEndpoint.LIST_FILES: _UcscEndpointSpec(
        required_params=frozenset({"genome"}),
        optional_params=frozenset({"format", "maxItemsOutput"}),
    ),
    UcscApiEndpoint.LIST_TRACKS: _UcscEndpointSpec(
        required_params=frozenset({"genome"}),
        optional_params=frozenset({"hubUrl", "trackLeavesOnly"}),
    ),
    UcscApiEndpoint.LIST_CHROMOSOMES: _UcscEndpointSpec(
        required_params=frozenset({"genome"}),
        optional_params=frozenset({"hubUrl", "track"}),
    ),
    UcscApiEndpoint.LIST_SCHEMA: _UcscEndpointSpec(
        required_params=frozenset({"genome", "track"}),
        optional_params=frozenset({"hubUrl"}),
    ),
    UcscApiEndpoint.GET_SEQUENCE: _UcscEndpointSpec(
        required_params=frozenset({"genome", "chrom"}),
        optional_params=frozenset({"hubUrl", "start", "end", "revComp"}),
    ),
    UcscApiEndpoint.GET_TRACK: _UcscEndpointSpec(
        required_params=frozenset({"genome", "track"}),
        optional_params=frozenset(
            {
                "hubUrl",
                "chrom",
                "start",
                "end",
                "maxItemsOutput",
                "jsonOutputArrays",
            }
        ),
    ),
    UcscApiEndpoint.SEARCH: _UcscEndpointSpec(
        required_params=frozenset({"search", "genome"}),
        optional_params=frozenset({"categories"}),
    ),
}

_UCSC_TEXT_PARAM_MAX_LENGTHS = {
    "q": 500,
    "genome": 200,
    "track": 200,
    "chrom": 200,
    "search": 500,
}
_UCSC_ENUM_PARAMS = {
    "browser": frozenset({"mustExist", "mayExist", "notExist"}),
    "category": frozenset({"reference", "representative"}),
    "status": frozenset({"reference", "representative"}),
    "level": frozenset({"complete", "chromosome", "scaffold", "contig"}),
    "categories": frozenset({"helpDocs", "publicHubs", "trackDb"}),
    "format": frozenset({"text"}),
}
_UCSC_FLAG_PARAMS = frozenset(
    {"statsOnly", "trackLeavesOnly", "revComp", "jsonOutputArrays"}
)


@dataclass(frozen=True)
class UcscCatalogContainer:
    """One grouping level a hub declares above its data tracks.

    trackDb nests tracks inside composites, the views inside a composite, and
    supertracks above both. UCSC returns that nesting only when the catalog is
    fetched whole, and the container carries the name a reader recognizes
    ("Conservation"), while a leaf knows its parent by identifier alone
    (``cons26way``).
    """

    track: str
    short_label: str
    long_label: str | None
    kind: str


@dataclass(frozen=True)
class UcscCatalogAttribute:
    """One declared fact about a track, as the catalog itself names it.

    trackDb carries these as ``subGroups`` (the facets a composite is sorted
    by, such as cellType or factor) and ``metadata``. They are the only
    machine-readable description of what a track measured: a consortium
    publishes thousands of tracks whose labels differ by a word, and the facets
    are what tell a vagina POLR2A peak set from a liver CTCF one.
    """

    key: str
    value: str
    origin: str


@dataclass(frozen=True)
class UcscCatalogSignalScale:
    """The value range a publisher intends a signal track to be drawn against."""

    auto: bool
    minimum: float | None
    maximum: float | None
    always_zero: bool


@dataclass(frozen=True)
class UcscCatalogLeaf:
    track: str
    short_label: str
    long_label: str
    group: str | None
    track_type: str
    scientific_kind: str
    format_id: str
    big_data_url: str | None
    source_kind: str
    hub_url: str | None
    parent_track: str | None
    parent_parent_track: str | None
    catalog_color: str | None
    experiment_accession: str | None
    file_accession: str | None
    big_data_index: str | None = None
    container_path: tuple[UcscCatalogContainer, ...] = ()
    attributes: tuple[UcscCatalogAttribute, ...] = ()
    signal_scale: UcscCatalogSignalScale | None = None


@dataclass(frozen=True)
class UcscRegionResult:
    records: list[dict[str, Any]]
    complete: bool
    items_returned: int
    max_items_output: int
    track_type: str | None
    big_data_url: str | None = None


class UcscProvider:
    """Catalog and regional-data adapter for api.genome.ucsc.edu."""

    provider_id = "ucsc"
    DEFAULT_BASE_URL = "https://api.genome.ucsc.edu"
    LIST_TRACKS_PATH = UcscApiEndpoint.LIST_TRACKS.value
    LIST_HUB_GENOMES_PATH = UcscApiEndpoint.LIST_HUB_GENOMES.value
    GET_TRACK_PATH = UcscApiEndpoint.GET_TRACK.value
    DOWNLOAD_BASE_URL = "https://hgdownload.soe.ucsc.edu"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        base_url: str | None = None,
    ) -> None:
        self._client = client
        self._base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        self.rate_limit_per_s = 1.0
        self.rate_limit_burst = 1.0
        self._catalog_cache: OrderedDict[
            tuple[str, str | None], tuple[float, tuple[UcscCatalogLeaf, ...]]
        ] = OrderedDict()
        self._catalog_single_flight = AsyncSingleFlight[
            tuple[str, str | None], tuple[UcscCatalogLeaf, ...]
        ]()
        self._hub_genome_cache: OrderedDict[str, tuple[float, frozenset[str]]] = (
            OrderedDict()
        )
        self._hub_genome_single_flight = AsyncSingleFlight[str, frozenset[str]]()
        self._genark_hub_cache: OrderedDict[str, tuple[float, str]] = OrderedDict()
        self._genark_hub_single_flight = AsyncSingleFlight[str, str]()

    def detect_id(self, raw: str) -> ParsedId | None:
        return None

    async def fetch(self, parsed_id: ParsedId, opts: FetchOptions) -> FetchResult:
        raise ProviderContractError(
            "ucsc is a regional track provider; use list_tracks() or "
            "fetch_track_region(), not fetch()"
        )

    async def resolve_xrefs(
        self, parsed_id: ParsedId, target_provider: str | None = None
    ) -> list[Xref]:
        return []

    def declared_capabilities(self) -> list[Capability]:
        return [Capability.EXTERNAL_FETCH_ANNOTATION]

    async def request_api(
        self,
        endpoint: UcscApiEndpoint,
        *,
        params: Mapping[str, str] | None = None,
        opts: FetchOptions | None = None,
    ) -> dict[str, Any] | str:
        """Call one documented UCSC endpoint through a bounded response reader.

        The enum and per-endpoint parameter registry prevent this method from
        becoming a general outbound proxy. Validation is repeated here, at the
        provider boundary, so non-HTTP callers cannot bypass the route models.
        """

        if not isinstance(endpoint, UcscApiEndpoint):
            raise ProviderContractError(
                "The UCSC API endpoint is not supported", status_code=422
            )
        payload = await self.request_api_payload(
            endpoint,
            params=params,
            opts=opts,
            max_response_bytes=_MAX_JSON_RESPONSE_BYTES,
        )
        if payload.content_kind == "text":
            try:
                return await _run_blocking_spool_operation(
                    _decode_text_and_close,
                    payload.body,
                )
            except UnicodeDecodeError as exc:
                raise ProviderContractError("UCSC returned non-UTF-8 text") from exc

        try:
            body: Any = await _run_blocking_spool_operation(
                _load_json_and_close,
                payload.body,
            )
        except (UnicodeDecodeError, ValueError) as exc:
            raise ProviderContractError("UCSC returned a non-JSON body") from exc
        if not isinstance(body, dict):
            raise ProviderContractError("UCSC returned a non-object JSON body")
        if body.get("error"):
            raise ProviderContractError(
                f"UCSC rejected the request: {_plain_text(body['error'])}"
            )
        return body

    async def request_api_payload(
        self,
        endpoint: UcscApiEndpoint,
        *,
        params: Mapping[str, str] | None = None,
        opts: FetchOptions | None = None,
        max_response_bytes: int = _MAX_STREAMED_API_RESPONSE_BYTES,
    ) -> UcscApiPayload:
        """Spool one allowlisted endpoint response without materializing it."""

        if not isinstance(endpoint, UcscApiEndpoint):
            raise ProviderContractError(
                "The UCSC API endpoint is not supported", status_code=422
            )
        clean_params = self._normalize_api_params(endpoint, params or {})
        content_kind: Literal["json", "text"] = (
            "text"
            if endpoint is UcscApiEndpoint.LIST_FILES
            and clean_params.get("format") == "text"
            else "json"
        )
        body, byte_length = await self._get_spooled_response(
            endpoint.value,
            params=clean_params,
            opts=opts or FetchOptions(),
            accept=("text/plain" if content_kind == "text" else "application/json"),
            max_response_bytes=max_response_bytes,
        )
        payload = UcscApiPayload(
            body=body,
            byte_length=byte_length,
            content_kind=content_kind,
        )
        try:
            await _run_blocking_spool_operation(_validate_api_payload, payload)
        except BaseException:
            await _run_blocking_spool_operation(payload.body.close)
            raise
        return payload

    def _normalize_api_params(
        self,
        endpoint: UcscApiEndpoint,
        params: Mapping[str, str],
    ) -> dict[str, str]:
        spec = _UCSC_ENDPOINT_SPECS[endpoint]
        supplied = set(params)
        allowed = spec.required_params | spec.optional_params
        extras = supplied - allowed
        if extras:
            names = ", ".join(sorted(extras))
            raise ProviderContractError(
                f"Unsupported parameter(s) for {endpoint.value}: {names}",
                status_code=422,
            )
        missing = spec.required_params - supplied
        if missing:
            names = ", ".join(sorted(missing))
            raise ProviderContractError(
                f"Missing parameter(s) for {endpoint.value}: {names}",
                status_code=422,
            )

        normalized: dict[str, str] = {}
        for name, raw_value in params.items():
            value = str(raw_value).strip()
            if not value:
                raise ProviderContractError(
                    f"UCSC parameter {name} must not be empty", status_code=422
                )
            max_length = _UCSC_TEXT_PARAM_MAX_LENGTHS.get(name)
            if max_length is not None and len(value) > max_length:
                raise ProviderContractError(
                    f"UCSC parameter {name} exceeds {max_length} characters",
                    status_code=422,
                )
            if name == "hubUrl":
                value = self.normalize_hub_url(value)
            elif name in _UCSC_FLAG_PARAMS and value not in {"0", "1"}:
                raise ProviderContractError(
                    f"UCSC parameter {name} must be 0 or 1", status_code=422
                )
            elif name in _UCSC_ENUM_PARAMS and value not in _UCSC_ENUM_PARAMS[name]:
                raise ProviderContractError(
                    f"UCSC parameter {name} has an unsupported value",
                    status_code=422,
                )
            normalized[name] = value

        self._validate_numeric_api_params(normalized)
        self._validate_coordinate_api_params(endpoint, normalized)
        return normalized

    @staticmethod
    def _validate_numeric_api_params(params: Mapping[str, str]) -> None:
        if "maxItemsOutput" in params:
            try:
                max_items_output = int(params["maxItemsOutput"])
            except ValueError as exc:
                raise ProviderContractError(
                    "UCSC maxItemsOutput must be an integer", status_code=422
                ) from exc
            if max_items_output != -1 and not 1 <= max_items_output <= 1_000_000:
                raise ProviderContractError(
                    "UCSC maxItemsOutput must be -1 or between 1 and 1000000",
                    status_code=422,
                )
        if "year" in params:
            try:
                year = int(params["year"])
            except ValueError as exc:
                raise ProviderContractError(
                    "UCSC year must be an integer", status_code=422
                ) from exc
            if year < 1800 or year > 2200:
                raise ProviderContractError(
                    "UCSC year must be between 1800 and 2200", status_code=422
                )

    @staticmethod
    def _validate_coordinate_api_params(
        endpoint: UcscApiEndpoint,
        params: Mapping[str, str],
    ) -> None:
        has_start = "start" in params
        has_end = "end" in params
        if has_start != has_end:
            raise ProviderContractError(
                "UCSC start and end must be supplied together", status_code=422
            )
        if has_start:
            try:
                start = int(params["start"])
                end = int(params["end"])
            except ValueError as exc:
                raise ProviderContractError(
                    "UCSC start and end must be integers", status_code=422
                ) from exc
            if start < 0 or end <= start:
                raise ProviderContractError(
                    "UCSC interval must satisfy 0 <= start < end", status_code=422
                )
            if endpoint is UcscApiEndpoint.GET_TRACK and "chrom" not in params:
                raise ProviderContractError(
                    "UCSC track intervals require a chromosome", status_code=422
                )

    async def list_tracks(
        self,
        genome: str,
        *,
        hub_url: str | None = None,
        opts: FetchOptions | None = None,
    ) -> list[UcscCatalogLeaf]:
        clean_genome = genome.strip()
        if not clean_genome:
            raise ProviderContractError("UCSC genome is required", status_code=422)
        clean_hub_url = self.normalize_hub_url(hub_url) if hub_url else None
        cache_key = (clean_genome, clean_hub_url)
        cached = self.get_cached_tracks(clean_genome, hub_url=clean_hub_url)
        if cached is not None:
            return cached

        async def load_catalog() -> tuple[UcscCatalogLeaf, ...]:
            cached = self.get_cached_tracks(
                clean_genome,
                hub_url=clean_hub_url,
            )
            if cached is not None:
                return tuple(cached)
            params = {"genome": clean_genome}
            if clean_hub_url:
                params["hubUrl"] = clean_hub_url
            request_opts = opts or FetchOptions()
            raw_catalog: Any = None
            try:
                body = await self.request_api(
                    UcscApiEndpoint.LIST_TRACKS,
                    params=params,
                    opts=request_opts,
                )
                raw_catalog = body.get(clean_genome)
            except (ProviderContractError, ProviderHttpError):
                if not clean_hub_url:
                    raise
                raw_catalog = None
            if not isinstance(raw_catalog, dict):
                if not clean_hub_url:
                    raise ProviderContractError(
                        f"UCSC returned no track catalog for {clean_genome!r}"
                    )
                track_db_text, track_db_url = await self._hub_track_db(
                    clean_hub_url, clean_genome, opts=request_opts
                )
                raw_catalog = _hub_catalog_tree(
                    _hub_stanzas(track_db_text), track_db_url
                )
                if not raw_catalog:
                    raise ProviderContractError(
                        f"This track hub publishes no tracks for {clean_genome}",
                        status_code=422,
                    )

            leaves: list[UcscCatalogLeaf] = []

            def collect(
                catalog: dict[str, Any],
                container_path: tuple[UcscCatalogContainer, ...],
            ) -> None:
                for track, value in catalog.items():
                    if not isinstance(value, dict):
                        continue
                    nested = {
                        name: child
                        for name, child in value.items()
                        if isinstance(child, dict)
                    }
                    if nested:
                        collect(
                            nested,
                            container_path + (_catalog_container(str(track), value),),
                        )
                        continue
                    leaves.append(_catalog_leaf(track, value, container_path))

            def _catalog_leaf(
                track: Any,
                value: dict[str, Any],
                container_path: tuple[UcscCatalogContainer, ...],
            ) -> UcscCatalogLeaf:
                track_id = str(track)
                track_type = str(value.get("type") or "").strip()
                short_label = _plain_text(value.get("shortLabel") or track)
                long_label = _plain_text(value.get("longLabel") or "")
                big_data_url = _optional_string(value.get("bigDataUrl"))
                big_data_index = _optional_string(value.get("bigDataIndex"))
                scientific_kind, format_id = _classify_track(
                    track_type=track_type,
                    big_data_url=big_data_url,
                )
                accession_values = (track_id, short_label, long_label, big_data_url)
                return UcscCatalogLeaf(
                    track=track_id,
                    short_label=short_label,
                    long_label=long_label,
                    group=_optional_string(value.get("group")),
                    track_type=track_type,
                    scientific_kind=scientific_kind,
                    format_id=format_id,
                    big_data_url=big_data_url,
                    source_kind="ucsc-hub" if clean_hub_url else "ucsc-native",
                    hub_url=clean_hub_url,
                    parent_track=_catalog_track_reference(value.get("parent")),
                    parent_parent_track=_catalog_track_reference(
                        value.get("parentParent")
                    ),
                    catalog_color=_catalog_color(value.get("color")),
                    experiment_accession=_extract_accession(
                        _ENCODE_EXPERIMENT_RE, accession_values
                    ),
                    file_accession=_extract_accession(
                        _ENCODE_FILE_RE, accession_values
                    ),
                    big_data_index=big_data_index,
                    container_path=container_path,
                    attributes=_catalog_attributes(value),
                    signal_scale=_catalog_signal_scale(value),
                )

            collect(raw_catalog, ())

            support_order = {
                "transcript": 0,
                "quantitative": 1,
                "peak": 2,
                "repeat": 3,
                "interval": 4,
                "reads": 5,
                "variants": 6,
                "unsupported": 7,
            }
            leaves.sort(
                key=lambda leaf: (
                    support_order.get(leaf.scientific_kind, 8),
                    leaf.short_label.casefold(),
                    leaf.track.casefold(),
                )
            )
            frozen = tuple(leaves)
            self._catalog_cache[cache_key] = (
                time.monotonic() + _CATALOG_CACHE_TTL_S,
                frozen,
            )
            self._catalog_cache.move_to_end(cache_key)
            while len(self._catalog_cache) > _CATALOG_CACHE_MAX_ENTRIES:
                self._catalog_cache.popitem(last=False)
            return frozen

        frozen = await self._catalog_single_flight.run(cache_key, load_catalog)
        return list(frozen)

    def get_cached_tracks(
        self,
        genome: str,
        *,
        hub_url: str | None = None,
    ) -> list[UcscCatalogLeaf] | None:
        clean_genome = genome.strip()
        clean_hub_url = self.normalize_hub_url(hub_url) if hub_url else None
        cache_key = (clean_genome, clean_hub_url)
        cached = self._catalog_cache.get(cache_key)
        if cached is None:
            return None
        expires_at, leaves = cached
        if expires_at <= time.monotonic():
            self._catalog_cache.pop(cache_key, None)
            return None
        self._catalog_cache.move_to_end(cache_key)
        return list(leaves)

    async def list_hub_genomes(
        self,
        hub_url: str,
        *,
        opts: FetchOptions | None = None,
    ) -> set[str]:
        """Return the exact assembly names advertised by a public UCSC hub."""

        clean_hub_url = self.normalize_hub_url(hub_url)
        cached = self.get_cached_hub_genomes(clean_hub_url)
        if cached is not None:
            return cached

        async def load_hub_genomes() -> frozenset[str]:
            cached = self.get_cached_hub_genomes(clean_hub_url)
            if cached is not None:
                return frozenset(cached)
            body = await self.request_api(
                UcscApiEndpoint.LIST_HUB_GENOMES,
                params={"hubUrl": clean_hub_url},
                opts=opts or FetchOptions(),
            )
            genomes = _extract_hub_genomes(body)
            if not genomes:
                raise ProviderContractError(
                    "UCSC returned no assemblies for this track hub"
                )
            frozen = frozenset(genomes)
            self._hub_genome_cache[clean_hub_url] = (
                time.monotonic() + _CATALOG_CACHE_TTL_S,
                frozen,
            )
            self._hub_genome_cache.move_to_end(clean_hub_url)
            while len(self._hub_genome_cache) > _HUB_GENOME_CACHE_MAX_ENTRIES:
                self._hub_genome_cache.popitem(last=False)
            return frozen

        frozen = await self._hub_genome_single_flight.run(
            clean_hub_url,
            load_hub_genomes,
        )
        return set(frozen)

    @staticmethod
    def is_genark_accession(genome: str) -> bool:
        """Is this an assembly UCSC serves from GenArk rather than its database?"""
        return bool(_GENARK_ACCESSION.match(genome.strip()))

    async def resolve_genark_hub_url(
        self,
        genome: str,
        *,
        opts: FetchOptions | None = None,
    ) -> str | None:
        """The hub address UCSC serves a GenArk assembly from, or None.

        UCSC's two endpoints disagree about GenArk. `list/tracks` resolves a
        bare accession for every assembly, so catalogs load without this.
        `getData/track` resolves only the assemblies it has aliased centrally,
        and 404s for the rest: of the 51 accessions DNAForge maps, 50 worked by
        luck and Pan troglodytes GCF_028858775.2 did not. Naming the hub makes
        the request explicit, which every one of them accepts.

        Returning None leaves the caller exactly where it was, so a genome this
        cannot resolve is never worse off than before.
        """

        clean = genome.strip()
        if not self.is_genark_accession(clean):
            return None
        cached = self._cached_genark_hub_url(clean)
        if cached is not None:
            return cached

        async def load_hub_url() -> str:
            again = self._cached_genark_hub_url(clean)
            if again is not None:
                return again
            body = await self.request_api(
                UcscApiEndpoint.LIST_GENARK_GENOMES,
                params={"genome": clean},
                opts=opts or FetchOptions(),
            )
            hub_url = _extract_genark_hub_url(body, clean)
            if not hub_url:
                raise ProviderContractError(
                    f"UCSC GenArk does not advertise a hub for {clean}"
                )
            normalized = self.normalize_hub_url(hub_url)
            self._genark_hub_cache[clean] = (
                time.monotonic() + _CATALOG_CACHE_TTL_S,
                normalized,
            )
            self._genark_hub_cache.move_to_end(clean)
            while len(self._genark_hub_cache) > _GENARK_HUB_CACHE_MAX_ENTRIES:
                self._genark_hub_cache.popitem(last=False)
            return normalized

        try:
            return await self._genark_hub_single_flight.run(clean, load_hub_url)
        except (
            ProviderContractError,
            ProviderHttpError,
            ProviderRateLimitError,
            ProviderTimeoutError,
        ):
            return None

    def _cached_genark_hub_url(self, genome: str) -> str | None:
        cached = self._genark_hub_cache.get(genome)
        if cached is None:
            return None
        expires_at, hub_url = cached
        if expires_at <= time.monotonic():
            self._genark_hub_cache.pop(genome, None)
            return None
        self._genark_hub_cache.move_to_end(genome)
        return hub_url

    async def _fetch_hub_text(self, url: str, *, opts: FetchOptions) -> str:
        """Read one of a hub's own text files, bounded in size and time."""

        if self._client is None:
            raise RuntimeError(
                "UcscProvider used without an httpx.AsyncClient; the service layer must inject one"
            )
        chunks: list[bytes] = []
        total = 0
        try:
            async with self._client.stream(
                "GET",
                url,
                timeout=httpx.Timeout(
                    timeout=min(
                        opts.total_timeout_s or _HUB_FILE_TIMEOUT_S, _HUB_FILE_TIMEOUT_S
                    ),
                    connect=opts.connect_timeout_s,
                ),
                headers={"User-Agent": opts.user_agent, "Accept": "text/plain"},
                follow_redirects=True,
            ) as response:
                if response.status_code >= 400:
                    raise ProviderHttpError(
                        f"The track hub returned HTTP {response.status_code}",
                        status_code=response.status_code,
                    )
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > _HUB_TEXT_MAX_BYTES:
                        raise ProviderContractError(
                            "This track hub's description is too large to read"
                        )
                    chunks.append(chunk)
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError("The track hub did not answer in time") from exc
        except httpx.HTTPError as exc:
            raise ProviderHttpError(f"Could not read the track hub: {exc}") from exc
        return b"".join(chunks).decode("utf-8", errors="replace")

    async def _read_hub_file_with_includes(
        self,
        url: str,
        *,
        opts: FetchOptions,
    ) -> str:
        """A hub file plus whatever it pulls in, bounded to a few files.

        trackDb is routinely split up with `include` lines. They name files
        beside the one including them, and `_hub_relative_url` keeps them
        there.
        """

        text = await self._fetch_hub_text(url, opts=opts)
        seen = {url}
        pending = [(url, text)]
        collected = [text]
        while pending and len(seen) <= _HUB_MAX_INCLUDES:
            base, body = pending.pop(0)
            for match in re.finditer(r"^\s*include\s+(\S+)\s*$", body, re.M):
                included = _hub_relative_url(base, match.group(1))
                if not included or included in seen:
                    continue
                seen.add(included)
                if len(seen) > _HUB_MAX_INCLUDES:
                    break
                more = await self._fetch_hub_text(included, opts=opts)
                collected.append(more)
                pending.append((included, more))
        return "\n\n".join(collected)

    async def _hub_track_db(
        self,
        hub_url: str,
        genome: str,
        *,
        opts: FetchOptions,
    ) -> tuple[str, str]:
        """Find and read the trackDb this hub publishes for one assembly.

        Returns the text and the address it came from, because a track's
        `bigDataUrl` is relative to that address rather than to hub.txt.
        """

        hub_text = await self._fetch_hub_text(hub_url, opts=opts)
        stanzas = _hub_stanzas(hub_text)
        head = stanzas[0] if stanzas else {}
        if head.get("useOneFile", "").strip().lower() == "on":
            return hub_text, hub_url

        genomes_url = _hub_relative_url(
            hub_url, head.get("genomesFile") or "genomes.txt"
        )
        if not genomes_url:
            raise ProviderContractError(
                "This track hub does not say where its assemblies are listed"
            )
        genomes_text = await self._fetch_hub_text(genomes_url, opts=opts)
        track_db_path: str | None = None
        for stanza in _hub_stanzas(genomes_text):
            if stanza.get("genome", "").strip() == genome:
                track_db_path = stanza.get("trackDb")
                break
        if not track_db_path:
            raise ProviderContractError(
                f"This track hub does not publish tracks for {genome}",
                status_code=422,
            )
        track_db_url = _hub_relative_url(genomes_url, track_db_path)
        if not track_db_url:
            raise ProviderContractError(
                "This track hub points its trackDb somewhere it does not own"
            )
        return (
            await self._read_hub_file_with_includes(track_db_url, opts=opts),
            track_db_url,
        )

    def get_cached_hub_genomes(self, hub_url: str) -> set[str] | None:
        clean_hub_url = self.normalize_hub_url(hub_url)
        cached = self._hub_genome_cache.get(clean_hub_url)
        if cached is None:
            return None
        expires_at, genomes = cached
        if expires_at <= time.monotonic():
            self._hub_genome_cache.pop(clean_hub_url, None)
            return None
        self._hub_genome_cache.move_to_end(clean_hub_url)
        return set(genomes)

    @staticmethod
    def normalize_hub_url(hub_url: str) -> str:
        """Admit only ordinary public HTTP(S) hub URLs.

        UCSC, not the local sidecar, retrieves this URL. Rejecting private and
        loopback literals still prevents DNAForge from becoming a convenient
        relay for requests that were never track-hub traffic.
        """

        clean = hub_url.strip()
        if not clean or len(clean) > 2048:
            raise ProviderContractError(
                "A public UCSC hub URL is required", status_code=422
            )
        try:
            parsed = urlsplit(clean)
            port = parsed.port
        except ValueError as exc:
            raise ProviderContractError(
                "The UCSC hub URL is invalid", status_code=422
            ) from exc
        if (
            parsed.scheme.casefold() not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or port not in {None, 80, 443}
        ):
            raise ProviderContractError(
                "The UCSC hub URL must be a public HTTP or HTTPS URL",
                status_code=422,
            )
        hostname = parsed.hostname.casefold().rstrip(".")
        if hostname == "localhost" or hostname.endswith(".localhost"):
            raise ProviderContractError(
                "The UCSC hub URL must use a public host", status_code=422
            )
        try:
            address = ipaddress.ip_address(hostname)
        except ValueError:
            address = None
        if address is not None and not address.is_global:
            raise ProviderContractError(
                "The UCSC hub URL must use a public host", status_code=422
            )
        return clean

    async def fetch_track_region(
        self,
        *,
        genome: str,
        track: str,
        chrom: str | None,
        start: int | None,
        end: int | None,
        max_items_output: int = 10_000,
        hub_url: str | None = None,
        opts: FetchOptions | None = None,
    ) -> UcscRegionResult:
        if not genome.strip() or not track.strip():
            raise ProviderContractError(
                "UCSC genome and track are required", status_code=422
            )
        whole_track = chrom is None and start is None and end is None
        regional = chrom is not None and start is not None and end is not None
        if not whole_track and not regional:
            raise ProviderContractError(
                "UCSC chromosome, start, and end must be supplied together",
                status_code=422,
            )
        if regional and (not chrom.strip() or start < 0 or end <= start):
            raise ProviderContractError(
                "UCSC interval must satisfy 0 <= start < end", status_code=422
            )
        if max_items_output < 1 or max_items_output > 1_000_000:
            raise ProviderContractError(
                "max_items_output must be between 1 and 1000000", status_code=422
            )

        params = {
            "genome": genome.strip(),
            "track": track.strip(),
            "maxItemsOutput": str(max_items_output),
        }
        if regional:
            params.update(
                {
                    "chrom": chrom.strip(),
                    "start": str(start),
                    "end": str(end),
                }
            )
        if hub_url:
            params["hubUrl"] = self.normalize_hub_url(hub_url)
        body = await self.request_api(
            UcscApiEndpoint.GET_TRACK,
            params=params,
            opts=opts or FetchOptions(),
        )
        raw_records = body.get(track.strip(), [])
        records = _normalize_track_records(
            raw_records,
            track=track.strip(),
            allow_chromosome_groups=whole_track,
        )
        raw_items_returned = body.get("itemsReturned", len(records))
        try:
            items_returned = int(raw_items_returned)
        except (TypeError, ValueError) as exc:
            raise ProviderContractError(
                "UCSC returned an invalid itemsReturned value"
            ) from exc
        return UcscRegionResult(
            records=records,
            complete=items_returned < max_items_output,
            items_returned=items_returned,
            max_items_output=max_items_output,
            track_type=_optional_string(body.get("trackType")),
            big_data_url=_optional_string(body.get("bigDataUrl")),
        )

    def resolve_big_data_url(
        self,
        big_data_url: str,
        *,
        hub_url: str | None = None,
    ) -> str:
        """Resolve catalog-relative binary URLs at the provider boundary."""

        clean = big_data_url.strip()
        if not clean:
            raise ProviderContractError(
                "The UCSC track does not expose an indexed binary source",
                status_code=422,
            )
        parsed = urlsplit(clean)
        if parsed.scheme:
            return clean
        if hub_url:
            return urljoin(self.normalize_hub_url(hub_url), clean)
        if not clean.startswith("/"):
            raise ProviderContractError(
                "The UCSC native track returned an invalid binary source path",
                status_code=422,
            )
        return urljoin(f"{self.DOWNLOAD_BASE_URL}/", quote(clean.lstrip("/"), safe="/"))

    async def _get_spooled_response(
        self,
        path: str,
        *,
        params: dict[str, str],
        opts: FetchOptions,
        accept: str,
        max_response_bytes: int,
    ) -> tuple[BinaryIO, int]:
        if self._client is None:
            raise RuntimeError(
                "UcscProvider used without an httpx.AsyncClient; the service layer must inject one"
            )
        try:
            async with self._client.stream(
                "GET",
                f"{self._base_url}{path}",
                params=params,
                timeout=httpx.Timeout(
                    timeout=opts.total_timeout_s, connect=opts.connect_timeout_s
                ),
                headers={"User-Agent": opts.user_agent, "Accept": accept},
            ) as response:
                if response.status_code == 429:
                    raise ProviderRateLimitError(
                        "UCSC rate-limited the request",
                        retry_after_s=_parse_retry_after(
                            response.headers.get("Retry-After")
                        ),
                    )
                if response.status_code >= 400:
                    raise ProviderHttpError(
                        f"UCSC returned HTTP {response.status_code}",
                        status_code=response.status_code,
                    )
                payload = await _spool_bounded_response(
                    response,
                    max_response_bytes=max_response_bytes,
                )
        except httpx.TimeoutException as exc:
            raise ProviderTimeoutError(
                f"UCSC request timed out after {opts.total_timeout_s}s"
            ) from exc
        except (httpx.HTTPError, OSError) as exc:
            raise ProviderHttpError(
                f"UCSC network error: {exc.__class__.__name__}"
            ) from exc

        return payload


async def _spool_bounded_response(
    response: httpx.Response,
    *,
    max_response_bytes: int,
) -> tuple[BinaryIO, int]:
    raw_content_length = response.headers.get("Content-Length")
    if raw_content_length is not None:
        try:
            content_length = int(raw_content_length)
        except ValueError as exc:
            raise ProviderContractError(
                "UCSC returned an invalid Content-Length", status_code=502
            ) from exc
        if content_length > max_response_bytes:
            raise ProviderContractError(
                "UCSC returned an oversized track response", status_code=502
            )

    payload = tempfile.SpooledTemporaryFile(
        max_size=_JSON_SPOOL_MEMORY_BYTES,
        mode="w+b",
    )
    bytes_read = 0
    try:
        async for chunk in response.aiter_bytes():
            bytes_read += len(chunk)
            if bytes_read > max_response_bytes:
                raise ProviderContractError(
                    "UCSC returned an oversized track response", status_code=502
                )
            await _run_blocking_spool_operation(payload.write, chunk)
        await _run_blocking_spool_operation(payload.seek, 0)
        return payload, bytes_read
    except BaseException:
        await _run_blocking_spool_operation(payload.close)
        raise


_T = TypeVar("_T")


async def _run_blocking_spool_operation(
    operation: Callable[..., _T], *args: object
) -> _T:
    """Run one file operation off-loop and settle it before cancellation."""

    task = asyncio.create_task(asyncio.to_thread(operation, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        except BaseException:
            pass
        raise


def _load_json_and_close(payload: BinaryIO) -> Any:
    try:
        return json.load(payload)
    finally:
        payload.close()


def _decode_text_and_close(payload: BinaryIO) -> str:
    try:
        return payload.read().decode("utf-8")
    finally:
        payload.close()


def _validate_api_payload(payload: UcscApiPayload) -> None:
    """Validate one spooled response in bounded memory and rewind it."""

    try:
        if payload.content_kind == "text":
            decoder = codecs.getincrementaldecoder("utf-8")()
            while chunk := payload.body.read(_JSON_SPOOL_MEMORY_BYTES):
                decoder.decode(chunk, final=False)
            decoder.decode(b"", final=True)
            return

        events = iter(ijson.parse(payload.body))
        try:
            prefix, event, _value = next(events)
        except StopIteration as exc:
            raise ProviderContractError("UCSC returned a non-JSON body") from exc
        if prefix != "" or event != "start_map":
            raise ProviderContractError("UCSC returned a non-object JSON body")

        for prefix, event, value in events:
            if prefix != "error":
                continue
            if event in {"start_map", "start_array"}:
                raise ProviderContractError(
                    "UCSC rejected the request: upstream error payload"
                )
            if event in {"string", "number", "boolean", "null"} and value:
                raise ProviderContractError(
                    f"UCSC rejected the request: {_plain_text(value)}"
                )
    except (UnicodeDecodeError, ijson.JSONError) as exc:
        raise ProviderContractError("UCSC returned a non-JSON body") from exc
    finally:
        payload.body.seek(0)


def _normalize_track_records(
    raw_records: Any,
    *,
    track: str,
    allow_chromosome_groups: bool,
) -> list[dict[str, Any]]:
    """Flatten UCSC's regional list and whole-track chromosome-map shapes."""

    if isinstance(raw_records, list):
        return [record for record in raw_records if isinstance(record, dict)]
    if not allow_chromosome_groups or not isinstance(raw_records, dict):
        raise ProviderContractError(
            f"UCSC track {track!r} returned an invalid record payload"
        )

    records: list[dict[str, Any]] = []
    for chromosome, chromosome_records in raw_records.items():
        if not isinstance(chromosome, str) or not isinstance(chromosome_records, list):
            raise ProviderContractError(
                f"UCSC track {track!r} returned an invalid chromosome record group"
            )
        for raw_record in chromosome_records:
            if not isinstance(raw_record, dict):
                continue
            record = dict(raw_record)
            if not isinstance(record.get("chrom"), str) or not record["chrom"].strip():
                record["chrom"] = chromosome
            records.append(record)
    return records


def _classify_track(
    *,
    track_type: str,
    big_data_url: str | None,
) -> tuple[str, str]:
    primary_type = (track_type.split(maxsplit=1)[0] if track_type else "").casefold()
    url = (big_data_url or "").casefold()
    if primary_type in _QUANTITATIVE_TYPES or url.endswith((".bw", ".bigwig")):
        return "quantitative", "bigwig"
    if primary_type in _TRANSCRIPT_TYPES:
        return "transcript", "bigbed" if big_data_url else "ucsc-native"
    if primary_type in _PEAK_TYPES:
        return "peak", "bigbed" if big_data_url else "ucsc-native"
    if primary_type in _REPEAT_TYPES:
        return "repeat", "bigbed" if big_data_url else "ucsc-native"
    if primary_type in _READ_TYPES or url.endswith((".bam", ".cram")):
        return "reads", "bam"
    if primary_type in _VARIANT_TYPES or url.endswith((".vcf", ".vcf.gz", ".bcf")):
        return "variants", "vcf"
    if primary_type in _INTERVAL_TYPES or url.endswith((".bb", ".bigbed")):
        return "interval", "bigbed" if big_data_url else "ucsc-native"
    return "unsupported", "ucsc-native"


def _extract_hub_genomes(body: dict[str, Any]) -> set[str]:
    genomes: set[str] = set()
    nested = body.get("genomes")
    if isinstance(nested, dict):
        genomes.update(str(key).strip() for key in nested if str(key).strip())
    elif isinstance(nested, list):
        genomes.update(
            str(value).strip()
            for value in nested
            if isinstance(value, str) and value.strip()
        )
    for key, value in body.items():
        if key.casefold() in _HUB_METADATA_KEYS or not isinstance(value, dict):
            continue
        if any(
            field in value
            for field in ("trackDbFile", "organism", "description", "twoBitPath")
        ):
            genomes.add(str(key).strip())
    return genomes


_HUB_TEXT_MAX_BYTES = 8 * 1024 * 1024
_HUB_FILE_TIMEOUT_S = 30.0
_HUB_MAX_INCLUDES = 16
_HUB_COMMENT_RE = re.compile(r"^\s*#")


def _hub_stanzas(text: str) -> list[dict[str, str]]:
    """Split a trackDb or genomes file into its stanzas.

    The format is blank-line separated stanzas of `key value` lines. Leading
    whitespace marks nesting for a human reader, but `parent` is what actually
    says so, and that is what gets read here. A line ending in a backslash
    continues onto the next.
    """

    stanzas: list[dict[str, str]] = []
    current: dict[str, str] = {}
    pending = ""
    for raw_line in text.splitlines():
        if pending:
            line = pending + " " + raw_line.strip()
            pending = ""
        else:
            line = raw_line
        if line.rstrip().endswith("\\"):
            pending = line.rstrip()[:-1].strip()
            continue
        stripped = line.strip()
        if not stripped:
            if current:
                stanzas.append(current)
                current = {}
            continue
        if _HUB_COMMENT_RE.match(line):
            continue
        key, _, value = stripped.partition(" ")
        key = key.strip()
        if not key:
            continue
        current[key] = value.strip()
    if current:
        stanzas.append(current)
    return stanzas


def _hub_relative_url(hub_url: str, path: str) -> str | None:
    """Resolve one of a hub's internal references, refusing to leave the hub.

    A hub names its files relative to itself. An absolute address is honoured
    only when it stays on the hub's own origin, so a hub cannot use DNAForge
    to fetch somewhere else.
    """

    clean = path.strip()
    if not clean or len(clean) > 2048:
        return None
    resolved = urljoin(hub_url, clean)
    hub_parts = urlsplit(hub_url)
    parts = urlsplit(resolved)
    if parts.scheme not in {"http", "https"}:
        return None
    if (parts.scheme, parts.netloc) != (hub_parts.scheme, hub_parts.netloc):
        return None
    return resolved


def _hub_catalog_tree(
    stanzas: list[dict[str, str]],
    track_db_url: str,
) -> dict[str, Any]:
    """Shape a hub's track stanzas the way UCSC's own catalog reply is shaped.

    `list/tracks` nests a child inside its parent, and the leaf builder reads
    that nesting to work out a track's containers. Rebuilding the same shape
    here means one leaf builder serves both the API and the hub.
    """

    entries: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for stanza in stanzas:
        name = stanza.get("track", "").strip()
        if not name or name in entries:
            continue
        entry: dict[str, Any] = {
            key: value for key, value in stanza.items() if key != "track"
        }
        big_data_url = entry.get("bigDataUrl")
        if isinstance(big_data_url, str) and big_data_url.strip():
            entry["bigDataUrl"] = urljoin(track_db_url, big_data_url.strip())
        big_data_index = entry.get("bigDataIndex")
        if isinstance(big_data_index, str) and big_data_index.strip():
            entry["bigDataIndex"] = urljoin(track_db_url, big_data_index.strip())
        short_label = entry.get("shortLabel")
        if not isinstance(short_label, str) or not short_label.strip():
            entry["shortLabel"] = name
        long_label = entry.get("longLabel")
        if not isinstance(long_label, str) or not long_label.strip():
            entry["longLabel"] = entry["shortLabel"]
        entries[name] = entry
        order.append(name)

    def parent_of(name: str) -> str | None:
        raw = entries[name].get("parent")
        if not isinstance(raw, str) or not raw.strip():
            return None
        candidate = raw.split()[0].strip()
        return candidate if candidate in entries and candidate != name else None

    def has_cycle(name: str) -> bool:
        seen = {name}
        walker = parent_of(name)
        while walker is not None:
            if walker in seen:
                return True
            seen.add(walker)
            walker = parent_of(walker)
        return False

    roots: dict[str, Any] = {}
    for name in order:
        parent = parent_of(name)
        if parent is None or has_cycle(name):
            roots[name] = entries[name]
            continue
        entries[parent][name] = entries[name]
    return roots


def _extract_genark_hub_url(body: dict[str, Any], accession: str) -> str | None:
    """Pull one assembly's hub address out of a genarkGenomes reply.

    UCSC answers with `{"genarkGenomes": {"<accession>": {"hubUrl": ...}}}`,
    and has also been seen answering with the accession at the top level, so
    both shapes are read rather than assumed.
    """

    listing = body.get("genarkGenomes")
    entry = listing.get(accession) if isinstance(listing, dict) else None
    if not isinstance(entry, dict):
        candidate = body.get(accession)
        entry = candidate if isinstance(candidate, dict) else None
    if not isinstance(entry, dict):
        return None
    hub_url = entry.get("hubUrl")
    if not isinstance(hub_url, str) or not hub_url.strip():
        return None
    return _absolute_genark_hub_url(hub_url)


def _absolute_genark_hub_url(raw: str) -> str | None:
    """Make UCSC's GenArk hub address one that can actually be fetched.

    `list/genarkGenomes` answers with a path relative to its own
    `hubUrlPrefix` ("GCF/028/858/775/GCF_028858775.2/hub.txt"), not a URL.
    The desktop client resolves it the same way against the same origin.
    """

    clean = raw.strip()
    if not clean:
        return None
    if clean.lower().startswith(("http://", "https://")):
        return clean
    relative = _GENARK_HUB_PREFIX_RE.sub("", clean).lstrip("/")
    if not relative:
        return None
    return urljoin(_GENARK_HUB_ORIGIN, relative)


def _plain_text(value: Any) -> str:
    return " ".join(html.unescape(_HTML_TAG_RE.sub("", str(value))).split())


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    clean = str(value).strip()
    return clean or None


_ATTRIBUTE_PAIR_RE = re.compile(r"([A-Za-z0-9_.+-]+)=(\"[^\"]*\"|\S+)")


def _catalog_attributes(value: dict[str, Any]) -> tuple[UcscCatalogAttribute, ...]:
    """Read the declared facets and metadata, keeping the catalog's own order."""

    attributes: list[UcscCatalogAttribute] = []
    seen: set[tuple[str, str]] = set()
    for field, origin in (("subGroups", "subgroup"), ("metadata", "metadata")):
        raw = _optional_string(value.get(field))
        if not raw:
            continue
        for key, declared in _ATTRIBUTE_PAIR_RE.findall(raw):
            clean = declared.strip('"').strip()
            if not clean or key == "view":
                continue
            if (key, clean) in seen:
                continue
            seen.add((key, clean))
            attributes.append(UcscCatalogAttribute(key=key, value=clean, origin=origin))
    return tuple(attributes)


def _catalog_signal_scale(value: dict[str, Any]) -> UcscCatalogSignalScale | None:
    """Read the publisher's intended value range for a signal track."""

    auto = (_optional_string(value.get("autoScale")) or "").casefold() == "on"
    always_zero = (_optional_string(value.get("alwaysZero")) or "").casefold() == "on"
    minimum = maximum = None
    limits = _optional_string(value.get("viewLimits"))
    if limits and ":" in limits:
        low, _, high = limits.partition(":")
        try:
            minimum, maximum = float(low), float(high)
        except ValueError:
            minimum = maximum = None
        else:
            if maximum <= minimum:
                minimum = maximum = None
    if not auto and not always_zero and minimum is None:
        return None
    return UcscCatalogSignalScale(
        auto=auto, minimum=minimum, maximum=maximum, always_zero=always_zero
    )


def _catalog_container(track: str, value: dict[str, Any]) -> UcscCatalogContainer:
    """Describe one grouping level, naming what kind of grouping it is."""

    if _optional_string(value.get("view")):
        kind = "view"
    elif _optional_string(value.get("superTrack")):
        kind = "super"
    elif _optional_string(value.get("compositeContainer")) or _optional_string(
        value.get("compositeTrack")
    ):
        kind = "composite"
    else:
        kind = "container"
    return UcscCatalogContainer(
        track=track,
        short_label=_plain_text(value.get("shortLabel") or track),
        long_label=_optional_string(_plain_text(value.get("longLabel") or "")),
        kind=kind,
    )


def _catalog_track_reference(value: Any) -> str | None:
    """Return the parent track identifier without its optional display mode."""

    clean = _plain_text(value) if value is not None else ""
    if not clean:
        return None
    identifier = clean.split(maxsplit=1)[0]
    return identifier if _TRACK_REFERENCE_RE.fullmatch(identifier) else None


def _catalog_color(value: Any) -> str | None:
    """Normalize UCSC's optional RGB setting and reject invalid components."""

    if value is None:
        return None
    match = _CATALOG_COLOR_RE.fullmatch(str(value))
    if match is None:
        return None
    components = tuple(int(match.group(name)) for name in ("red", "green", "blue"))
    if any(component > 255 for component in components):
        return None
    return ",".join(str(component) for component in components)


def _extract_accession(
    pattern: re.Pattern[str], values: tuple[str | None, ...]
) -> str | None:
    for value in values:
        if not value:
            continue
        match = pattern.search(value)
        if match is not None:
            return match.group(0)
    return None


def _parse_retry_after(header: str | None) -> float | None:
    if not header:
        return None
    try:
        return float(header)
    except ValueError:
        return None
