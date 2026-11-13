""" — structural guard: every capability a provider declares MUST be
granted to the renderer's own session, or the shipped in-app feature that
provider backs silently 403s forever.

This is the hardening that would have caught the real  bug BEFORE it
shipped: NebTmProvider.declared_capabilities() has always required
`external-compute:tm`, but apps/desktop/src/main/sidecar-capabilities.json's
`requiredRendererExternalCapabilities` never listed it. Every real NEB Tm
call from the desktop app's own primer-Tm feature (not an AI agent -- the
renderer's OWN direct session) was capability_denied (403) from the day the
feature shipped, regardless of which enzyme/product the user selected. No
mocked test caught it because every mocked test injects its OWN
`granted_capabilities` list by hand instead of reading the real grant config
this test reads.

This test is intentionally NOT scoped to NEB -- it derives the full set of
capabilities every registered provider declares and cross-checks ALL of them
against the renderer's grant config, so a FUTURE provider that adds a new
required capability without updating sidecar-capabilities.json fails CI
immediately, instead of shipping a silently-broken feature the same way.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.external.providers import (
    NcbiNuccoreProvider,
    NebTmProvider,
    PaperSourceProvider,
    RCSBProvider,
    UniProtProvider,
)

_ALL_PROVIDERS = [
    NcbiNuccoreProvider(),
    NebTmProvider(),
    PaperSourceProvider(),
    RCSBProvider(),
    UniProtProvider(),
]


def _renderer_capability_config() -> dict:
    repo_root = Path(__file__).resolve().parents[3]
    config_path = (
        repo_root / "apps" / "desktop" / "src" / "main" / "sidecar-capabilities.json"
    )
    assert (
        config_path.is_file()
    ), f"renderer capability config not found at {config_path}"
    return json.loads(config_path.read_text())


def test_every_provider_capability_is_in_the_renderer_required_grant():
    config = _renderer_capability_config()
    required_renderer_capabilities = set(config["requiredRendererExternalCapabilities"])

    missing: dict[str, list[str]] = {}
    for provider in _ALL_PROVIDERS:
        declared = {cap.value for cap in provider.declared_capabilities()}
        gap = declared - required_renderer_capabilities
        if gap:
            missing[provider.__class__.__name__] = sorted(gap)

    assert missing == {}, (
        "One or more providers declare a capability the renderer's own session "
        "is never granted (apps/desktop/src/main/sidecar-capabilities.json "
        "requiredRendererExternalCapabilities). Every real call from the "
        "shipped renderer feature backed by that provider will 403 "
        "capability_denied, regardless of what the user does in the UI -- "
        "this is the exact  bug shape. Add the missing capability "
        "string(s) to requiredRendererExternalCapabilities (and "
        f"defaultMcpGrantCapabilities for consistency): {missing}"
    )


def test_required_renderer_capabilities_are_also_in_default_grant():
    """The two arrays are meant to stay in lockstep (buildSidecarGrantCapabilities
    unions REQUIRED into whatever grant is configured either way, but a required
    capability missing from the default list is a red flag someone edited one
    array and not the other)."""
    config = _renderer_capability_config()
    required = set(config["requiredRendererExternalCapabilities"])
    default = set(config["defaultMcpGrantCapabilities"])
    missing_from_default = required - default
    assert missing_from_default == set(), (
        "requiredRendererExternalCapabilities has entries missing from "
        f"defaultMcpGrantCapabilities: {sorted(missing_from_default)}. Keep "
        "both arrays in apps/desktop/src/main/sidecar-capabilities.json in sync."
    )


@pytest.mark.parametrize(
    "capability",
    ["external-compute:tm"],
)
def test_dna_1658_specific_capability_present(capability: str):
    """Narrow, explicit pin for the exact capability  was missing --
    kept alongside the general cross-check above so this specific regression
    has its own named, unmissable assertion."""
    config = _renderer_capability_config()
    assert capability in config["requiredRendererExternalCapabilities"]
    assert capability in config["defaultMcpGrantCapabilities"]
