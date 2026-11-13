"""Tests for loading plugins from config file."""

import json
from pathlib import Path as Path
from unittest.mock import MagicMock as MagicMock
from unittest.mock import patch as patch

import pytest as pytest


class TestPluginConfigLoader:
    def test_load_from_config_file(self, tmp_path):
        from src.plugins.loader import load_plugins_from_config
        from src.plugins.registry import PluginRegistry

        config = {
            "plugins": [
                {
                    "name": "my_tool",
                    "url": "http://localhost:9001",
                    "manifest": {
                        "name": "my_tool",
                        "description": "A test tool",
                        "version": "1.0.0",
                        "input_types": {},
                        "return_types": {},
                    },
                }
            ]
        }
        config_file = tmp_path / "plugins.json"
        config_file.write_text(json.dumps(config))

        reg = PluginRegistry()
        load_plugins_from_config(config_file, reg)
        assert "my_tool" in reg.list_plugins()

    def test_missing_config_file_is_ok(self, tmp_path):
        from src.plugins.loader import load_plugins_from_config
        from src.plugins.registry import PluginRegistry

        reg = PluginRegistry()
        load_plugins_from_config(tmp_path / "nonexistent.json", reg)
        assert reg.list_plugins() == []

    def test_invalid_json_logs_warning(self, tmp_path):
        from src.plugins.loader import load_plugins_from_config
        from src.plugins.registry import PluginRegistry

        config_file = tmp_path / "plugins.json"
        config_file.write_text("not json")

        reg = PluginRegistry()
        load_plugins_from_config(config_file, reg)
        assert reg.list_plugins() == []

    def test_multiple_plugins_from_config(self, tmp_path):
        from src.plugins.loader import load_plugins_from_config
        from src.plugins.registry import PluginRegistry

        config = {
            "plugins": [
                {
                    "name": "tool_a",
                    "url": "http://localhost:9001",
                    "manifest": {
                        "name": "tool_a",
                        "description": "Tool A",
                        "version": "1.0.0",
                        "input_types": {},
                        "return_types": {},
                    },
                },
                {
                    "name": "tool_b",
                    "url": "http://localhost:9002",
                    "manifest": {
                        "name": "tool_b",
                        "description": "Tool B",
                        "version": "2.0.0",
                        "input_types": {},
                        "return_types": {},
                    },
                },
            ]
        }
        config_file = tmp_path / "plugins.json"
        config_file.write_text(json.dumps(config))

        reg = PluginRegistry()
        load_plugins_from_config(config_file, reg)
        assert sorted(reg.list_plugins()) == ["tool_a", "tool_b"]

    def test_invalid_entry_skipped(self, tmp_path):
        from src.plugins.loader import load_plugins_from_config
        from src.plugins.registry import PluginRegistry

        config = {
            "plugins": [
                {"url": "http://localhost:9001"},
                {
                    "name": "valid_tool",
                    "url": "http://localhost:9002",
                    "manifest": {
                        "name": "valid_tool",
                        "description": "Valid",
                        "version": "1.0.0",
                        "input_types": {},
                        "return_types": {},
                    },
                },
            ]
        }
        config_file = tmp_path / "plugins.json"
        config_file.write_text(json.dumps(config))

        reg = PluginRegistry()
        load_plugins_from_config(config_file, reg)
        assert reg.list_plugins() == ["valid_tool"]

    def test_manifest_defaults_when_omitted(self, tmp_path):
        from src.plugins.loader import load_plugins_from_config
        from src.plugins.registry import PluginRegistry

        config = {
            "plugins": [
                {
                    "name": "minimal_tool",
                    "url": "http://localhost:9001",
                }
            ]
        }
        config_file = tmp_path / "plugins.json"
        config_file.write_text(json.dumps(config))

        reg = PluginRegistry()
        load_plugins_from_config(config_file, reg)
        assert "minimal_tool" in reg.list_plugins()
        plugin = reg.get("minimal_tool")
        assert plugin["manifest"]["version"] == "0.0.0"
