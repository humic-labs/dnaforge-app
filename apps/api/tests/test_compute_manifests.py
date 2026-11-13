""" — sidecar manifest loader mirrors the load-bearing zod rules."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.compute.contract import ComputeOperation
from src.compute.manifests import (
    ManifestError,
    load_manifests,
    parse_manifest,
    resolve_manifests_dir,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFESTS = REPO_ROOT / "packages" / "core" / "compute-endpoints" / "manifests"


def _tamarind() -> dict:
    return json.loads((MANIFESTS / "tamarind.json").read_text())


def test_bundled_manifests_load_and_resolve_from_source_checkout():
    assert resolve_manifests_dir() == MANIFESTS
    manifests = load_manifests()
    assert set(manifests) == {
        "tamarind",
        "boltz",
        "nvidia-nim",
        "subseq",
        "replicate",
    }
    tamarind = manifests["tamarind"]
    assert (
        tamarind.transport == "mcp"
        and tamarind.mcp_url == "https://mcp.tamarind.bio/mcp"
    )
    assert tamarind.mapping_for(ComputeOperation.SUBMIT).tool == "submitJob"
    assert tamarind.mapping_for(ComputeOperation.SUBMIT).args == {
        "jobName": "$label",
        "type": "$tool_id",
        "settings": "$settings",
    }
    assert tamarind.status_map["complete"] == "completed"
    assert tamarind.auth_header_name == "x-api-key"
    assert manifests["nvidia-nim"].static_tools and manifests[
        "nvidia-nim"
    ].base_url.startswith("https://")
    assert manifests["nvidia-nim"].schema_version == 2
    assert manifests["nvidia-nim"].driver_kind == "nvcf"
    assert all(
        isinstance(tool.get("inputSchema"), dict)
        for tool in manifests["nvidia-nim"].static_tools
    )


def test_public_view_carries_no_toolmap_or_internal_fields():
    view = load_manifests(MANIFESTS)["tamarind"].public_view()
    assert set(view) == {
        "id",
        "display_name",
        "summary",
        "transport",
        "driver",
        "custom",
        "auth_scheme",
        "credential_header",
        "endpoint_url",
        "verify_target",
        "catalog",
        "job_model",
        "cost",
        "disclosure",
        "retention_note",
        "cancellation_mode",
        "cancellation_note",
        "docs_url",
        "key_page_url",
        "terms_url",
        "privacy_url",
    }
    assert view["endpoint_url"] == "https://mcp.tamarind.bio/mcp"
    assert view["credential_header"] == "x-api-key"
    assert view["verify_target"] == "listModalities"


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda m: m.update(schemaVersion=3), "schemaVersion"),
        (lambda m: m.update(transport="grpc"), "transport"),
        (lambda m: m["auth"].update(headerName="cookie"), "headerName"),
        (lambda m: m.update(docsUrl="http://insecure"), "docsUrl"),
        (lambda m: m.update(mcpUrl="http://insecure/mcp"), "mcpUrl"),
        (lambda m: m["toolMap"].pop("submit"), "required operation 'submit'"),
        (lambda m: m["toolMap"].update(bogus="x"), "unknown operation"),
        (
            lambda m: m["toolMap"].update(
                submit={"tool": "submitJob", "args": {"jobName": "$nope"}}
            ),
            "unknown placeholder",
        ),
        (lambda m: m.update(rateLimitRps=0), "rateLimitRps"),
    ],
)
def test_loader_rejects_manifests_that_would_break_a_binding(mutate, match):
    raw = _tamarind()
    mutate(raw)
    with pytest.raises(ManifestError, match=match):
        parse_manifest(raw)


def test_duplicate_ids_are_rejected(tmp_path):
    a = _tamarind()
    (tmp_path / "a.json").write_text(json.dumps(a))
    (tmp_path / "b.json").write_text(json.dumps(a))
    with pytest.raises(ManifestError, match="duplicate"):
        load_manifests(tmp_path)


def test_env_override_for_packaged_apps(tmp_path, monkeypatch):
    (tmp_path / "tamarind.json").write_text(json.dumps(_tamarind()))
    monkeypatch.setenv("DNAFORGE_COMPUTE_MANIFESTS_DIR", str(tmp_path))
    assert resolve_manifests_dir() == tmp_path
    monkeypatch.setenv("DNAFORGE_COMPUTE_MANIFESTS_DIR", str(tmp_path / "missing"))
    with pytest.raises(RuntimeError, match="not a directory"):
        resolve_manifests_dir()


def test_public_view_preserves_the_catalog_summary():
    raw = _tamarind()
    raw["summary"] = "Protein and molecular modeling tools."
    assert parse_manifest(raw).public_view()["summary"] == raw["summary"]


def test_v2_driver_is_required_known_and_transport_compatible():
    raw = json.loads((MANIFESTS / "nvidia-nim.json").read_text())
    raw.pop("driver")
    with pytest.raises(ManifestError, match="driver"):
        parse_manifest(raw)

    raw["driver"] = {"kind": "made-up"}
    with pytest.raises(ManifestError, match="driver"):
        parse_manifest(raw)

    raw["driver"] = {"kind": "mcp-tool-map"}
    with pytest.raises(ManifestError, match="transport"):
        parse_manifest(raw)


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (lambda m: m.update(id="../redirect"), "id must match"),
        (
            lambda m: m["verify"].update(target="https://attacker.example/account"),
            "same-origin relative path",
        ),
        (
            lambda m: m["staticTools"][0].update(path="//attacker.example/predictions"),
            "same-origin relative path",
        ),
        (
            lambda m: m["driver"]["status"].update(
                pathTemplate="https://attacker.example/{remote_id}"
            ),
            "same-origin relative path",
        ),
        (
            lambda m: m["driver"]["submit"].update(
                headers={"Authorization": "Bearer manifest-secret"}
            ),
            "outside the allowlist",
        ),
        (
            lambda m: m["staticTools"][0]["inputSchema"]["properties"][
                "version"
            ].update(pattern="^(a+)+$"),
            "simple character-class",
        ),
        (
            lambda m: m["staticTools"][0]["inputSchema"]["properties"][
                "version"
            ].update({"$ref": "https://attacker.example/schema.json"}),
            "unsupported schema keyword",
        ),
    ],
)
def test_http_job_manifest_cannot_redirect_authenticated_requests(mutate, match):
    raw = json.loads((MANIFESTS / "replicate.json").read_text())
    mutate(raw)
    with pytest.raises(ManifestError, match=match):
        parse_manifest(raw, source="user")


def test_manifest_must_be_an_object():
    with pytest.raises(ManifestError, match="JSON object"):
        parse_manifest([])  # type: ignore[arg-type]


def test_user_manifest_directory_merges_without_overriding_bundled_ids(tmp_path):
    raw = json.loads((MANIFESTS / "replicate.json").read_text())
    raw.update(
        id="lab-predictions",
        displayName="Lab Predictions",
        disclosure=(
            "This sends inputs to Lab Predictions under your own account. Lab Predictions "
            "bills that account; DNAForge does not charge for it."
        ),
    )
    (tmp_path / "lab-predictions.json").write_text(json.dumps(raw))
    manifests = load_manifests(MANIFESTS, user_directory=tmp_path)
    assert manifests["lab-predictions"].source == "user"
    assert manifests["replicate"].source == "bundled"

    raw["id"] = "replicate"
    (tmp_path / "lab-predictions.json").write_text(json.dumps(raw))
    with pytest.raises(ManifestError, match="duplicate provider id"):
        load_manifests(MANIFESTS, user_directory=tmp_path)
