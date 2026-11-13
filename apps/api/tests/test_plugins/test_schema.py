"""Tests for plugin manifest schema."""

import pytest
from pydantic import ValidationError


class TestPluginManifest:
    def test_valid_manifest(self):
        from src.plugins.schema import PluginManifest

        manifest = PluginManifest(
            name="my_tool",
            description="A custom bioinformatics tool",
            version="1.0.0",
            input_types={"sequence": {"type": "string", "required": True}},
            return_types={"result": {"type": "object"}},
        )
        assert manifest.name == "my_tool"

    def test_manifest_requires_name(self):
        from src.plugins.schema import PluginManifest

        with pytest.raises(ValidationError):
            PluginManifest(
                description="Missing name",
                version="1.0.0",
                input_types={},
                return_types={},
            )

    def test_manifest_name_validation(self):
        """Plugin names must be snake_case identifiers."""
        from src.plugins.schema import PluginManifest

        with pytest.raises(ValidationError):
            PluginManifest(
                name="My Tool!",
                description="Bad name",
                version="1.0.0",
                input_types={},
                return_types={},
            )
