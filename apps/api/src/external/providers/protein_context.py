"""Experimental, read-only protein MCP adapters inside the provider substrate.

Use the official MCP client, not a second JSON-RPC implementation. The existing
service owns grants, rate limits, retries, caching, persistence and fetch logs.
Only public identifiers and bounded text searches leave the application.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..contract import (
    Capability,
    FetchOptions,
    FetchResult,
    ParsedId,
    ProviderContractError,
    ProviderError,
    ProviderHttpError,
    ProviderTimeoutError,
    Xref,
)


class ProteinContextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["search", "structure", "annotations", "binding_site"]
    query: str | None = Field(None, min_length=1, max_length=80)
    pdbId: str | None = Field(None, pattern=r"^[0-9][A-Za-z0-9]{3}$")
    uniprotId: str | None = Field(
        None, min_length=6, max_length=10, pattern=r"^[A-Z0-9]+$"
    )
    chain: str | None = Field(None, min_length=1, max_length=12)
    ligandId: str | None = Field(
        None, min_length=1, max_length=8, pattern=r"^[A-Za-z0-9]+$"
    )
    limit: int = Field(20, ge=1, le=20)
    sections: list[str] | None = Field(None, max_length=8)

    def upstream(self, source: str) -> tuple[str, dict[str, Any]]:
        if self.operation == "search" and self.query:
            if source == "protein-mcp":
                return "protein_search_structures", {
                    "query": self.query,
                    "content_type": "experimental",
                    "limit": min(self.limit, 5),
                }
            return "uniprot_search_proteins", {
                "text_search": self.query,
                "reviewed": True,
                "size": min(self.limit, 5),
            }
        if (
            source == "uniprot-mcp"
            and self.operation == "annotations"
            and self.uniprotId
        ):
            args: dict[str, Any] = {"accessions": [self.uniprotId]}
            if self.sections:
                if any(len(s) > 24 for s in self.sections):
                    raise ValueError("Section names exceed the context budget")
                args["sections"] = self.sections
            return "uniprot_get_entry", args
        if source == "protein-mcp":
            if self.operation == "structure" and self.pdbId:
                return "protein_get_structure", {
                    "ids": [self.pdbId.upper()],
                    "include_coords": False,
                    "source": "experimental",
                }
            if self.operation == "annotations":
                if self.uniprotId:
                    return "protein_get_annotations", {
                        "uniprot": self.uniprotId,
                        "include": "features",
                        "limit": self.limit,
                    }
                if self.pdbId and self.chain:
                    return "protein_get_annotations", {
                        "pdb_id": self.pdbId.upper(),
                        "chain": self.chain,
                        "include": "features",
                        "limit": self.limit,
                    }
            if self.operation == "binding_site" and self.pdbId and self.ligandId:
                return "protein_track_ligands", {
                    "mode": "binding_site",
                    "pdb_id": self.pdbId.upper(),
                    "comp_id": self.ligandId.upper(),
                    "limit": self.limit,
                }
        raise ValueError(f"Unsupported or incomplete {source} {self.operation} request")


async def call_protein_mcp(
    endpoint: str, name: str, arguments: dict[str, Any], timeout: float
) -> dict[str, Any]:
    try:
        async with asyncio.timeout(timeout):
            async with streamable_http_client(endpoint) as (read, write, *_):
                async with ClientSession(
                    read, write, read_timeout_seconds=timeout
                ) as session:
                    initialized = await session.initialize()
                    result = await session.call_tool(name, arguments)
                    if getattr(result, "is_error", False):
                        raise ProviderContractError(
                            f"{name} returned an MCP tool error: {str(result.content)[:400]}"
                        )
                    payload = getattr(result, "structured_content", None)
                    if payload is None:
                        texts = [
                            c.text
                            for c in result.content
                            if getattr(c, "type", None) == "text"
                        ]
                        if len(texts) != 1:
                            raise ProviderContractError(
                                f"{name} returned no single structured context result"
                            )
                        payload = json.loads(texts[0])
                    if not isinstance(payload, dict):
                        raise ProviderContractError(
                            f"{name} returned an invalid context object"
                        )
                    if len(json.dumps(payload).encode()) > 250_000:
                        raise ProviderContractError(
                            f"{name} context exceeds the 250 kB response budget"
                        )
                    return {
                        "server": initialized.server_info.model_dump(by_alias=True),
                        "payload": payload,
                    }
    except TimeoutError as exc:
        raise ProviderTimeoutError(f"{name} exceeded the context timeout") from exc
    except ProviderContractError:
        raise
    except Exception as exc:
        nested = [exc]
        while nested:
            cause = nested.pop()
            if isinstance(cause, ProviderError):
                raise cause from None
            if isinstance(cause, ExceptionGroup):
                nested.extend(cause.exceptions)
        raise ProviderHttpError(
            f"MCP context request failed ({type(exc).__name__}): {str(exc)[:300]}"
        ) from exc


class ProteinContextProvider:
    rate_limit_per_s = 1.0
    rate_limit_burst = 1

    def __init__(
        self,
        source: Literal["protein-mcp", "uniprot-mcp"],
        *,
        call_remote=call_protein_mcp,
    ):
        self.provider_id = source
        self.endpoint = f"https://{source.removesuffix('-mcp')}.caseyjhand.com/mcp"
        self._call_remote = call_remote

    def declared_capabilities(self) -> list[Capability]:
        return [Capability.EXTERNAL_FETCH_ANNOTATION]

    def detect_id(self, raw: str) -> ParsedId | None:
        try:
            if len(raw) > 200:
                return None
            request = ProteinContextRequest.model_validate_json(raw)
            request.upstream(self.provider_id)
            canonical = request.model_dump_json(exclude_none=True)
            digest = hashlib.sha256(canonical.encode()).hexdigest()
            day = datetime.now(timezone.utc).date().isoformat()
            return ParsedId(
                canonical_id=canonical,
                provider=self.provider_id,
                scope=f"context:{day}:{digest}",
            )
        except (ValidationError, ValueError):
            return None

    async def fetch(self, parsed_id: ParsedId, opts: FetchOptions) -> FetchResult:
        request = ProteinContextRequest.model_validate_json(parsed_id.canonical_id)
        name, arguments = request.upstream(self.provider_id)
        response = await self._call_remote(
            self.endpoint, name, arguments, opts.total_timeout_s
        )
        metadata = {
            "experimental": True,
            "result": response["payload"],
            "provenance": {
                "source": self.provider_id,
                "endpoint": self.endpoint,
                "tool": name,
                "arguments": arguments,
                "server": response["server"],
                "fetchedAt": datetime.now(timezone.utc).isoformat(),
            },
            "interpretation": {
                "annotations": "UniProt feature positions use UniProt numbering. Map to loaded coordinates before rendering; never assume an offset.",
                "contacts": "Binding-site distances describe geometric contacts, not classified hydrogen bonds or proof of causality. Preserve author/label chain and residue namespaces and ligand instance identity.",
                "missing": "Empty or outline results are not evidence of a known active site. Report missing evidence and retrieve indicated sections if necessary.",
            },
        }
        return FetchResult(
            parsed_id=parsed_id,
            metadata=metadata,
            external_url=self.endpoint,
            version_identifier=response["server"].get("version"),
            license="CC-BY-4.0" if self.provider_id == "uniprot-mcp" else None,
            attribution=(
                "UniProt Consortium via uniprot-mcp-server"
                if self.provider_id == "uniprot-mcp"
                else "protein-mcp-server; retain source attribution supplied in the result"
            ),
            bytes_received=len(json.dumps(metadata).encode()),
        )

    async def resolve_xrefs(
        self, parsed_id: ParsedId, target_provider: str | None = None
    ) -> list[Xref]:
        return []
