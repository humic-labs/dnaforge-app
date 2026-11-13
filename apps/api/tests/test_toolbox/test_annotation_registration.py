"""Tests for annotation capability registration into ToolboxRegistry."""

from src.toolbox.annotation import register_annotation_capability
from src.toolbox.registry import toolbox_registry


class TestAnnotationRegistration:
    """Annotation engine registers as a base capability."""

    def setup_method(self):
        toolbox_registry._capabilities.clear()

    def test_registers_annotation_capability(self):
        register_annotation_capability()
        cap = toolbox_registry.get_capability("annotation")
        assert cap is not None
        assert cap.label == "Annotation Engine"
        assert cap.tier == "base"
        assert cap.auto_install is True

    def test_has_expected_components(self):
        from src.annotation.tools import get_platform_binary_names

        register_annotation_capability()
        cap = toolbox_registry.get_capability("annotation")
        comp_ids = [c.id for c in cap.components]
        expected = get_platform_binary_names(required_by="plannotate")
        assert "blastn" in comp_ids or "makeblastdb" in comp_ids
        assert "diamond" in comp_ids
        if "cmscan" in expected:
            assert "cmscan" in comp_ids
        else:
            assert "cmscan" not in comp_ids
        assert "databases" in comp_ids

    def test_component_versions_from_registry(self):
        register_annotation_capability()
        cap = toolbox_registry.get_capability("annotation")
        from src.annotation.tools import TOOL_REGISTRY

        blast_version = TOOL_REGISTRY["blast"]["version"]
        blast_comps = [c for c in cap.components if c.version == blast_version]
        assert len(blast_comps) > 0

    def test_components_derived_from_tool_registry(self):
        """Every annotation binary that ships on THIS platform has a component.

        Platform-aware : a tool with no build for the current platform
        is intentionally absent, so we assert against get_platform_binary_versions
        rather than every platform's binaries.
        """
        from src.annotation.tools import get_platform_binary_versions

        register_annotation_capability()
        cap = toolbox_registry.get_capability("annotation")
        comp_ids = {c.id for c in cap.components}

        for binary_name in get_platform_binary_versions(required_by="plannotate"):
            assert (
                binary_name in comp_ids
            ), f"Missing component for platform binary '{binary_name}'"

    def test_idempotent_registration(self):
        register_annotation_capability()
        register_annotation_capability()
        assert len(toolbox_registry.get_status()) == 1


class TestAnnotationStatusSync:
    """Toolbox component status reflects real download/binary state."""

    def setup_method(self):
        toolbox_registry._capabilities.clear()

    def test_sync_updates_component_statuses(self, tmp_path, monkeypatch):
        """sync_annotation_status reads real state and updates toolbox."""
        from src.toolbox.annotation import (
            register_annotation_capability,
            sync_annotation_status,
        )

        monkeypatch.setenv("WAYPOINT_DATA_DIR", str(tmp_path))
        import src.toolbox.executable_paths as executable_paths

        monkeypatch.setattr(executable_paths, "_platform_suffix_cache", None)

        register_annotation_capability()
        sync_annotation_status()

        cap = toolbox_registry.get_capability("annotation")
        db_comp = next(c for c in cap.components if c.id == "databases")
        assert db_comp.status != "ready"

    def test_databases_stay_unready_during_startup_provisioning(self, monkeypatch):
        """A ready on-disk Rfam must not be read while startup may replace it."""
        from src.toolbox.annotation import (
            register_annotation_capability,
            sync_annotation_status,
        )

        monkeypatch.setattr(
            "src.toolbox.annotation.get_database_status",
            lambda: {"downloaded": True, "version": "1.2.2"},
        )
        monkeypatch.setattr(
            "src.toolbox.annotation.is_annotation_provisioning", lambda: True
        )

        register_annotation_capability()
        sync_annotation_status()

        cap = toolbox_registry.get_capability("annotation")
        db_comp = next(c for c in cap.components if c.id == "databases")
        assert db_comp.status == "downloading"
        assert db_comp.progress == {
            "phase": "provisioning",
            "detail": "Preparing annotation databases...",
        }
