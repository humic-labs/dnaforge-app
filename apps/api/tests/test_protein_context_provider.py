import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from src.control_plane.store import ControlPlaneStore
from src.external.contract import FetchOptions, ProviderContractError
from src.external.providers import protein_context
from src.external.providers.protein_context import ProteinContextProvider
from src.external.service import (
    CapabilityDenied,
    ExternalResourcesService,
    FetchRequest,
)


@pytest.mark.asyncio
async def test_existing_mcp_result_is_preserved_with_provenance():
    calls = []

    async def remote(endpoint, name, arguments, timeout):
        calls.append((endpoint, name, arguments))
        return {
            "server": {"name": "protein", "version": "0.8.5"},
            "payload": {"sites": []},
        }

    provider = ProteinContextProvider("protein-mcp", call_remote=remote)
    parsed = provider.detect_id(
        json.dumps({"operation": "annotations", "pdbId": "1FS0", "chain": "E"})
    )
    assert parsed is not None
    result = await provider.fetch(parsed, FetchOptions())
    assert calls[0][1:] == (
        "protein_get_annotations",
        {"pdb_id": "1FS0", "chain": "E", "include": "features", "limit": 20},
    )
    assert result.metadata["result"] == {"sites": []}
    assert result.metadata["provenance"]["source"] == "protein-mcp"
    assert result.metadata["provenance"]["server"]["version"] == "0.8.5"


@pytest.mark.asyncio
async def test_unknown_operation_never_calls_remote():
    async def remote(*args):
        pytest.fail("Rejected input reached remote MCP")

    provider = ProteinContextProvider("uniprot-mcp", call_remote=remote)
    assert (
        provider.detect_id(
            '{"operation":"binding_site","pdbId":"1IEP","ligandId":"STI"}'
        )
        is None
    )
    assert (
        provider.detect_id(
            '{"operation":"search","query":"test","endpoint":"http://localhost"}'
        )
        is None
    )


@pytest.mark.asyncio
async def test_mcp_error_cannot_become_context_success():
    async def remote(*args):
        raise ProviderContractError("Upstream MCP tool failed")

    provider = ProteinContextProvider("protein-mcp", call_remote=remote)
    parsed = provider.detect_id(
        '{"operation":"binding_site","pdbId":"1IEP","ligandId":"STI"}'
    )
    with pytest.raises(ProviderContractError, match="Upstream MCP"):
        await provider.fetch(parsed, FetchOptions())


def test_context_request_cache_identity_includes_all_selectors_and_source():
    p = ProteinContextProvider("protein-mcp")
    a = p.detect_id('{"operation":"annotations","pdbId":"1FS0","chain":"E"}')
    b = p.detect_id('{"chain":"E","pdbId":"1FS0","operation":"annotations"}')
    c = p.detect_id('{"operation":"annotations","pdbId":"1FS0","chain":"G"}')
    assert a.cache_key() == b.cache_key()
    assert a.cache_key() != c.cache_key()


@pytest.mark.asyncio
async def test_substrate_denial_precedes_remote_and_success_persists_provenance(
    tmp_path,
):
    calls = []

    async def remote(*args):
        calls.append(args)
        return {"server": {"version": "0.8.5"}, "payload": {"features": []}}

    store = ControlPlaneStore(tmp_path / "context.sqlite")
    store.initialize()
    service = ExternalResourcesService(store)
    service.register(ProteinContextProvider("protein-mcp", call_remote=remote))
    raw_id = '{"operation":"annotations","pdbId":"1FS0","chain":"E"}'
    with pytest.raises(CapabilityDenied):
        await service.fetch(
            FetchRequest(provider="protein-mcp", raw_id=raw_id, granted_capabilities=[])
        )
    assert calls == []
    result = await service.fetch(
        FetchRequest(
            provider="protein-mcp",
            raw_id=raw_id,
            granted_capabilities=["external-fetch:annotation"],
        )
    )
    row = store.get_external_resource(result.external_resource_id)
    assert row["metadata_json"]["provenance"]["tool"] == "protein_get_annotations"
    repeated = await service.fetch(
        FetchRequest(
            provider="protein-mcp",
            raw_id=raw_id,
            granted_capabilities=["external-fetch:annotation"],
        )
    )
    assert repeated.cache_hit and len(calls) == 1


@pytest.mark.asyncio
async def test_sdk_tool_error_retains_nonretryable_contract_failure(monkeypatch):
    @asynccontextmanager
    async def transport(*args):
        try:
            yield (None, None, None)
        except Exception as exc:
            raise ExceptionGroup("SDK transport cleanup", [exc]) from None

    class Session:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def initialize(self):
            return SimpleNamespace()

        async def call_tool(self, *args):
            return SimpleNamespace(is_error=True, content=["unavailable"])

    monkeypatch.setattr(protein_context, "streamable_http_client", transport)
    monkeypatch.setattr(protein_context, "ClientSession", Session)
    with pytest.raises(ProviderContractError, match="MCP tool error"):
        await protein_context.call_protein_mcp(
            "https://protein.caseyjhand.com/mcp",
            "protein_get_structure",
            {"ids": ["1IEP"]},
            1,
        )
