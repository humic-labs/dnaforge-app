"""Tests for the ToolboxRegistry — central capability status aggregation."""

from src.toolbox.registry import Capability, Component, ToolboxRegistry


class TestComponent:
    """Component dataclass behavior."""

    def test_ready_component(self):
        c = Component(
            id="blastn",
            label="BLAST+",
            status="ready",
            version="2.16.0",
            source="downloaded",
        )
        assert c.status == "ready"
        assert c.version == "2.16.0"

    def test_downloading_component_with_progress(self):
        c = Component(
            id="blastn",
            label="BLAST+",
            status="downloading",
            version="2.16.0",
            source="downloaded",
            progress={
                "phase": "downloading",
                "percent": 45,
                "detail": "Downloading BLAST+...",
            },
        )
        assert c.status == "downloading"
        assert c.progress["percent"] == 45

    def test_component_defaults(self):
        c = Component(id="x", label="X", status="ready", source="builtin")
        assert c.version is None
        assert c.path is None
        assert c.progress is None
        assert c.size_mb is None

    def test_to_dict_strips_none_fields(self):
        c = Component(id="x", label="X", status="ready", source="builtin")
        d = c.to_dict()
        assert "version" not in d
        assert "path" not in d
        assert "progress" not in d
        assert "size_mb" not in d

    def test_to_dict_includes_present_optional_fields(self):
        c = Component(
            id="x",
            label="X",
            status="ready",
            source="builtin",
            version="1.0",
            size_mb=200,
        )
        d = c.to_dict()
        assert d["version"] == "1.0"
        assert d["size_mb"] == 200


class TestCapability:
    """Capability status derivation from components."""

    def test_all_ready(self):
        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(id="a", label="A", status="ready", source="downloaded"),
                Component(id="b", label="B", status="ready", source="downloaded"),
            ],
        )
        assert cap.status == "ready"

    def test_any_downloading(self):
        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(id="a", label="A", status="ready", source="downloaded"),
                Component(id="b", label="B", status="downloading", source="downloaded"),
            ],
        )
        assert cap.status == "downloading"

    def test_any_error(self):
        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(id="a", label="A", status="ready", source="downloaded"),
                Component(id="b", label="B", status="error", source="downloaded"),
            ],
        )
        assert cap.status == "error"

    def test_no_degraded_state(self):
        """Partial = error, NOT degraded. If any component is broken, whole cap is error."""
        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(id="a", label="A", status="ready", source="downloaded"),
                Component(id="b", label="B", status="unavailable", source="downloaded"),
            ],
        )
        assert cap.status == "unavailable"

    def test_empty_components(self):
        cap = Capability(
            id="primer",
            label="Primer Design",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[],
        )
        assert cap.status == "unavailable"

    def test_downloading_takes_precedence_over_error(self):
        """While downloading, show downloading — not error."""
        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(id="a", label="A", status="downloading", source="downloaded"),
                Component(id="b", label="B", status="error", source="downloaded"),
            ],
        )
        assert cap.status == "downloading"

    def test_to_dict(self):
        cap = Capability(
            id="test",
            label="Test",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(
                    id="a",
                    label="A",
                    status="ready",
                    version="1.0",
                    source="downloaded",
                ),
            ],
        )
        d = cap.to_dict()
        assert d["id"] == "test"
        assert d["status"] == "ready"
        assert d["tier"] == "base"
        assert len(d["components"]) == 1
        assert d["components"][0]["id"] == "a"


class TestToolboxRegistry:
    """Registry register/update/get operations."""

    def test_register_and_get(self):
        reg = ToolboxRegistry()
        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[],
        )
        reg.register(cap)
        result = reg.get_status()
        assert len(result) == 1
        assert result[0].id == "annotation"

    def test_register_replaces_existing(self):
        reg = ToolboxRegistry()
        cap1 = Capability(
            id="x",
            label="V1",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[],
        )
        cap2 = Capability(
            id="x",
            label="V2",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[],
        )
        reg.register(cap1)
        reg.register(cap2)
        assert len(reg.get_status()) == 1
        assert reg.get_status()[0].label == "V2"

    def test_update_component_status(self):
        reg = ToolboxRegistry()
        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(
                    id="blastn",
                    label="BLAST+",
                    status="unavailable",
                    source="downloaded",
                ),
            ],
        )
        reg.register(cap)
        reg.update_component(
            "annotation",
            "blastn",
            status="downloading",
            progress={"phase": "downloading", "percent": 50},
        )
        result = reg.get_status()
        comp = result[0].components[0]
        assert comp.status == "downloading"
        assert comp.progress["percent"] == 50

    def test_update_component_nonexistent_capability(self):
        reg = ToolboxRegistry()
        reg.update_component("nope", "nope", status="ready")

    def test_update_component_nonexistent_component(self):
        reg = ToolboxRegistry()
        cap = Capability(
            id="x",
            label="X",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[],
        )
        reg.register(cap)
        reg.update_component("x", "nope", status="ready")

    def test_update_component_rejects_unknown_fields(self):
        import pytest

        reg = ToolboxRegistry()
        cap = Capability(
            id="x",
            label="X",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(id="a", label="A", status="ready", source="builtin"),
            ],
        )
        reg.register(cap)
        with pytest.raises(ValueError, match="Unknown Component fields"):
            reg.update_component("x", "a", stattus="ready")

    def test_get_capability(self):
        reg = ToolboxRegistry()
        cap = Capability(
            id="x",
            label="X",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[],
        )
        reg.register(cap)
        assert reg.get_capability("x") is not None
        assert reg.get_capability("nope") is None

    def test_to_dict(self):
        reg = ToolboxRegistry()
        cap = Capability(
            id="x",
            label="X",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[],
        )
        reg.register(cap)
        d = reg.to_dict()
        assert "capabilities" in d
        assert len(d["capabilities"]) == 1
