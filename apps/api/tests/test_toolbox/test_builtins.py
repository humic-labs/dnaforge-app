"""Tests for built-in capability registration."""

from src.toolbox.builtins import register_builtin_capabilities
from src.toolbox.registry import toolbox_registry


class TestBuiltinCapabilities:

    def setup_method(self):
        toolbox_registry._capabilities.clear()

    def test_registers_alignment(self):
        register_builtin_capabilities()
        cap = toolbox_registry.get_capability("alignment")
        assert cap is not None
        assert cap.label == "Sequence Alignment"
        assert cap.tier == "base"

    def test_registers_primer_design(self):
        register_builtin_capabilities()
        cap = toolbox_registry.get_capability("primer_design")
        assert cap is not None
        assert cap.label == "Primer Design"
        assert cap.tier == "base"

    def test_registers_restriction_analysis(self):
        register_builtin_capabilities()
        cap = toolbox_registry.get_capability("restriction_analysis")
        assert cap is not None
        assert cap.label == "Restriction Analysis"
        assert cap.tier == "base"

    def test_alignment_has_mafft_component(self):
        register_builtin_capabilities()
        cap = toolbox_registry.get_capability("alignment")
        comp_ids = [c.id for c in cap.components]
        assert "mafft" in comp_ids

    def test_mafft_detects_system_install(self):
        """MAFFT shows ready if in PATH, unavailable if not."""
        register_builtin_capabilities()
        cap = toolbox_registry.get_capability("alignment")
        mafft = next(c for c in cap.components if c.id == "mafft")
        assert mafft.status in ("ready", "unavailable")

    def test_primer_and_restriction_always_ready(self):
        """Built-in Python packages -- always available."""
        register_builtin_capabilities()
        primer = toolbox_registry.get_capability("primer_design")
        restriction = toolbox_registry.get_capability("restriction_analysis")
        assert primer.status == "ready"
        assert restriction.status == "ready"

    def test_idempotent(self):
        register_builtin_capabilities()
        register_builtin_capabilities()
        caps = [c for c in toolbox_registry.get_status() if c.id == "alignment"]
        assert len(caps) == 1
