"""Load plugins from configuration files."""

import json
import os
import sys
from pathlib import Path

from .registry import PluginRegistry


def get_plugin_config_path() -> Path:
    """Default plugin config location."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "Waypoint"
    elif os.name == "nt":
        base = (
            Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
            / "Waypoint"
        )
    else:
        base = (
            Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
            / "waypoint"
        )

    return base / "plugins.json"


def load_plugins_from_config(
    config_path: Path | None = None,
    registry: PluginRegistry | None = None,
) -> None:
    """Load plugin registrations from a JSON config file."""
    if config_path is None:
        config_path = get_plugin_config_path()

    if registry is None:
        from .registry import plugin_registry

        registry = plugin_registry

    if not config_path.exists():
        return

    try:
        config = json.loads(config_path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        print(f"Warning: Failed to load plugin config {config_path}: {e}")
        return

    for entry in config.get("plugins", []):
        try:
            name = entry["name"]
            url = entry["url"]
            manifest = entry.get(
                "manifest",
                {
                    "name": name,
                    "description": "",
                    "version": "0.0.0",
                    "input_types": {},
                    "return_types": {},
                },
            )
            registry.register(name, url, manifest)
        except (KeyError, TypeError) as e:
            print(f"Warning: Skipping invalid plugin entry: {e}")
