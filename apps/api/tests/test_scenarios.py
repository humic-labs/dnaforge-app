"""Tests for composable scenario fixtures.

Verifies each scenario produces a valid ToolboxStatusResponse with
correct statuses, and that modifiers compose correctly.
"""

import pytest

from src.models.toolbox import ToolboxStatusResponse

from .scenarios import (
    downloading_all,
    downloading_databases,
    downloading_tools,
    fresh_install,
    fully_ready,
    mixed_component_status,
    partial_ready,
    tools_error,
    with_mafft,
    with_plugin,
)


def _get_cap(scenario: ToolboxStatusResponse, cap_id: str):
    return next((c for c in scenario.capabilities if c.id == cap_id), None)


def _get_comp(scenario: ToolboxStatusResponse, cap_id: str, comp_id: str):
    cap = _get_cap(scenario, cap_id)
    if cap is None:
        return None
    return next((c for c in cap.components if c.id == comp_id), None)


class TestScenarioValidity:
    """Every scenario must produce valid, serializable responses."""

    @pytest.mark.parametrize(
        "builder",
        [
            fresh_install,
            fully_ready,
            tools_error,
            lambda: downloading_tools(50),
            lambda: downloading_databases(30),
            lambda: downloading_all(25, 60),
            lambda: partial_ready(["blastn"]),
        ],
        ids=[
            "fresh_install",
            "fully_ready",
            "tools_error",
            "downloading_tools",
            "downloading_databases",
            "downloading_all",
            "partial_ready",
        ],
    )
    def test_roundtrip(self, builder):
        """Serialize → deserialize → assert equal."""
        scenario = builder()
        json_data = scenario.model_dump()
        restored = ToolboxStatusResponse.model_validate(json_data)
        assert restored == scenario

    @pytest.mark.parametrize(
        "builder",
        [
            fresh_install,
            fully_ready,
            tools_error,
            lambda: downloading_tools(),
            lambda: downloading_databases(),
            lambda: downloading_all(),
            lambda: partial_ready(["blastn"]),
        ],
        ids=[
            "fresh_install",
            "fully_ready",
            "tools_error",
            "downloading_tools",
            "downloading_databases",
            "downloading_all",
            "partial_ready",
        ],
    )
    def test_has_annotation_capability(self, builder):
        scenario = builder()
        assert _get_cap(scenario, "annotation") is not None


class TestFreshInstall:
    def test_all_unavailable(self):
        s = fresh_install()
        ann = _get_cap(s, "annotation")
        assert ann is not None
        assert ann.status == "unavailable"
        for comp in ann.components:
            assert comp.status == "unavailable"

    def test_mafft_unavailable(self):
        s = fresh_install()
        mafft = _get_comp(s, "alignment", "mafft")
        assert mafft is not None
        assert mafft.status == "unavailable"


class TestFullyReady:
    def test_all_ready(self):
        s = fully_ready()
        for cap in s.capabilities:
            assert cap.status == "ready", f"{cap.id} not ready"

    def test_annotation_components_ready(self):
        s = fully_ready()
        ann = _get_cap(s, "annotation")
        assert ann is not None
        for comp in ann.components:
            assert comp.status == "ready"


class TestDownloading:
    def test_downloading_tools_status(self):
        s = downloading_tools(45)
        ann = _get_cap(s, "annotation")
        assert ann is not None
        assert ann.status == "downloading"
        blastn = _get_comp(s, "annotation", "blastn")
        assert blastn is not None
        assert blastn.status == "downloading"
        assert blastn.progress is not None
        assert blastn.progress.percent == 45

    def test_downloading_databases_tools_ready(self):
        s = downloading_databases(70)
        blastn = _get_comp(s, "annotation", "blastn")
        assert blastn is not None
        assert blastn.status == "ready"
        db = _get_comp(s, "annotation", "databases")
        assert db is not None
        assert db.status == "downloading"
        assert db.progress is not None
        assert db.progress.percent == 70

    def test_downloading_all(self):
        s = downloading_all(30, 60)
        blastn = _get_comp(s, "annotation", "blastn")
        assert blastn is not None
        assert blastn.progress.percent == 30
        db = _get_comp(s, "annotation", "databases")
        assert db is not None
        assert db.progress.percent == 60


class TestToolsError:
    def test_error_status(self):
        s = tools_error()
        ann = _get_cap(s, "annotation")
        assert ann is not None
        assert ann.status == "error"
        for comp in ann.components:
            if comp.id != "databases":
                assert comp.status == "error"


class TestPartialReady:
    def test_some_ready(self):
        s = partial_ready(["blastn", "diamond"])
        blastn = _get_comp(s, "annotation", "blastn")
        cmscan = _get_comp(s, "annotation", "cmscan")
        assert blastn is not None
        assert blastn.status == "ready"
        assert cmscan is not None
        assert cmscan.status == "unavailable"

    def test_all_tools_ready_but_no_db(self):
        s = partial_ready(["blastn", "diamond", "cmscan"])
        ann = _get_cap(s, "annotation")
        assert ann is not None
        assert ann.status == "unavailable"


class TestModifiers:
    def test_with_mafft(self):
        s = with_mafft(fresh_install())
        mafft = _get_comp(s, "alignment", "mafft")
        assert mafft is not None
        assert mafft.status == "ready"
        ann = _get_cap(s, "annotation")
        assert ann.status == "unavailable"

    def test_with_plugin(self):
        s = with_plugin(
            fully_ready(),
            "custom_tool",
            label="Custom Tool",
            url="http://localhost:9001",
        )
        plugin = _get_cap(s, "custom_tool")
        assert plugin is not None
        assert plugin.status == "ready"
        assert plugin.source == "plugin"
        assert plugin.components[0].path == "http://localhost:9001"
        assert len(s.capabilities) == 5

    def test_composability(self):
        """Chain multiple modifiers."""
        s = with_plugin(with_mafft(fresh_install()), "ext_plugin")
        assert _get_comp(s, "alignment", "mafft").status == "ready"
        assert _get_cap(s, "ext_plugin") is not None
        assert _get_cap(s, "annotation").status == "unavailable"

    def test_immutability(self):
        """Modifiers return new instances, don't mutate originals."""
        original = fresh_install()
        modified = with_mafft(original)
        assert _get_comp(original, "alignment", "mafft").status == "unavailable"
        assert _get_comp(modified, "alignment", "mafft").status == "ready"

    def test_duplicate_plugin_replaces(self):
        """Adding a plugin twice appends both (caller should deduplicate if needed)."""
        s = with_plugin(with_plugin(fully_ready(), "tool_a"), "tool_a")
        plugins = [c for c in s.capabilities if c.id == "tool_a"]
        assert len(plugins) == 2


class TestMixedComponentStatus:
    def test_mixed_status_is_downloading(self):
        s = mixed_component_status()
        ann = _get_cap(s, "annotation")
        assert ann is not None
        assert ann.status == "downloading"

    def test_mixed_has_ready_and_downloading(self):
        s = mixed_component_status()
        blastn = _get_comp(s, "annotation", "blastn")
        diamond = _get_comp(s, "annotation", "diamond")
        assert blastn is not None and blastn.status == "ready"
        assert diamond is not None and diamond.status == "downloading"


class TestPartialReadyEdgeCases:
    def test_all_tools_and_db_ready(self):
        """All tools + databases → fully ready annotation."""
        s = partial_ready(["blastn", "diamond", "cmscan", "databases"])
        ann = _get_cap(s, "annotation")
        assert ann is not None
        assert ann.status == "ready"

    def test_empty_list(self):
        """No ready tools → all unavailable."""
        s = partial_ready([])
        ann = _get_cap(s, "annotation")
        assert ann is not None
        assert ann.status == "unavailable"
        for comp in ann.components:
            assert comp.status == "unavailable"


class TestStatusDerivationParity:
    """Verify derive_capability_status matches across all status combos."""

    @pytest.mark.parametrize(
        "statuses,expected",
        [
            (["ready", "ready", "ready"], "ready"),
            (["downloading", "ready", "ready"], "downloading"),
            (["error", "ready", "ready"], "error"),
            (["unavailable", "ready", "ready"], "unavailable"),
            (["downloading", "error", "ready"], "downloading"),
            ([], "unavailable"),
        ],
        ids=[
            "all_ready",
            "one_downloading",
            "one_error",
            "one_unavailable",
            "downloading_beats_error",
            "empty_list",
        ],
    )
    def test_derive_status(self, statuses, expected):
        from src.toolbox.registry import derive_capability_status

        assert derive_capability_status(statuses) == expected
