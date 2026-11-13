"""Composable scenario builders for ToolboxStatusResponse.

Each function returns a valid ToolboxStatusResponse representing
a meaningful app state. Modifier functions layer on additional
capabilities.

Real capabilities in production:
- annotation (base): blastn, diamond, cmscan, databases
- alignment (base): mafft
- primer_design (base): primer3
- restriction_analysis (base): restriction-sites
"""

from __future__ import annotations

from src.models.toolbox import (
    CapabilityStatusResponse,
    ComponentStatusResponse,
    ToolboxStatusResponse,
)
from src.toolbox.registry import derive_capability_status

_ANNOTATION_TOOLS = ["blastn", "diamond", "cmscan"]


_TOOL_METADATA: dict[str, dict] = {
    "blastn": {"version": "2.13.0", "path": "/usr/local/bin/blastn"},
    "diamond": {"version": "2.1.8", "path": "/usr/local/bin/diamond"},
    "cmscan": {"version": "1.1.5", "path": "/usr/local/bin/cmscan"},
    "databases": {"version": "2024.1", "path": "/data/annotation-db"},
}

_TOOL_SIZES: dict[str, float] = {
    "blastn": 45.0,
    "diamond": 32.0,
    "cmscan": 28.0,
    "databases": 1200.0,
}


def _annotation_components(
    tool_status: str = "unavailable",
    db_status: str = "unavailable",
    tool_pct: float = 0,
    db_pct: float = 0,
) -> list[ComponentStatusResponse]:
    """Build annotation components with uniform tool/db status."""
    factory = {
        "ready": lambda id, **kw: ComponentStatusResponse.ready(
            id,
            version=_TOOL_METADATA[id]["version"],
            path=_TOOL_METADATA[id]["path"],
            **kw,
        ),
        "downloading": lambda id, **kw: ComponentStatusResponse.downloading(
            id, percent=tool_pct, size_mb=_TOOL_SIZES.get(id), **kw
        ),
        "error": ComponentStatusResponse.error,
        "unavailable": ComponentStatusResponse.unavailable,
    }
    db_factory = {
        "ready": lambda id, **kw: ComponentStatusResponse.ready(
            id,
            version=_TOOL_METADATA[id]["version"],
            path=_TOOL_METADATA[id]["path"],
            **kw,
        ),
        "downloading": lambda id, **kw: ComponentStatusResponse.downloading(
            id, percent=db_pct, size_mb=_TOOL_SIZES.get(id), **kw
        ),
        "error": ComponentStatusResponse.error,
        "unavailable": ComponentStatusResponse.unavailable,
    }
    components = [
        factory[tool_status](t, source="downloaded") for t in _ANNOTATION_TOOLS
    ]
    components.append(
        db_factory[db_status](
            "databases", label="Annotation Databases", source="downloaded"
        )
    )
    return components


def _annotation_capability(
    tool_status: str = "unavailable",
    db_status: str = "unavailable",
    tool_pct: float = 0,
    db_pct: float = 0,
) -> CapabilityStatusResponse:
    components = _annotation_components(tool_status, db_status, tool_pct, db_pct)
    status = derive_capability_status([c.status for c in components])
    return CapabilityStatusResponse(
        id="annotation",
        label="Annotation Engine",
        status=status,
        source="builtin",
        tier="base",
        auto_install=True,
        components=components,
    )


def _builtin_capabilities(mafft_ready: bool = True) -> list[CapabilityStatusResponse]:
    """The three always-present builtin capabilities."""
    return [
        CapabilityStatusResponse(
            id="alignment",
            label="Sequence Alignment",
            status="ready" if mafft_ready else "unavailable",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                (
                    ComponentStatusResponse.ready(
                        "mafft", label="MAFFT", source="system"
                    )
                    if mafft_ready
                    else ComponentStatusResponse.unavailable(
                        "mafft", label="MAFFT", source="system"
                    )
                )
            ],
        ),
        CapabilityStatusResponse(
            id="primer_design",
            label="Primer Design",
            status="ready",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                ComponentStatusResponse.ready(
                    "primer3", label="Primer3", source="builtin"
                )
            ],
        ),
        CapabilityStatusResponse(
            id="restriction_analysis",
            label="Restriction Analysis",
            status="ready",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                ComponentStatusResponse.ready(
                    "restriction-sites",
                    label="Built-in restriction engine",
                    source="builtin",
                )
            ],
        ),
    ]


def fresh_install() -> ToolboxStatusResponse:
    """First launch — nothing downloaded, everything unavailable."""
    return ToolboxStatusResponse(
        capabilities=[
            _annotation_capability(tool_status="unavailable", db_status="unavailable"),
            *_builtin_capabilities(mafft_ready=False),
        ]
    )


def downloading_tools(percent: float = 0) -> ToolboxStatusResponse:
    """Tools are being downloaded, databases not started."""
    return ToolboxStatusResponse(
        capabilities=[
            _annotation_capability(
                tool_status="downloading", db_status="unavailable", tool_pct=percent
            ),
            *_builtin_capabilities(),
        ]
    )


def downloading_databases(percent: float = 0) -> ToolboxStatusResponse:
    """Tools ready, databases downloading."""
    return ToolboxStatusResponse(
        capabilities=[
            _annotation_capability(
                tool_status="ready", db_status="downloading", db_pct=percent
            ),
            *_builtin_capabilities(),
        ]
    )


def downloading_all(tool_pct: float = 0, db_pct: float = 0) -> ToolboxStatusResponse:
    """Both tools and databases downloading."""
    return ToolboxStatusResponse(
        capabilities=[
            _annotation_capability(
                tool_status="downloading",
                db_status="downloading",
                tool_pct=tool_pct,
                db_pct=db_pct,
            ),
            *_builtin_capabilities(),
        ]
    )


def fully_ready() -> ToolboxStatusResponse:
    """Everything installed and operational."""
    return ToolboxStatusResponse(
        capabilities=[
            _annotation_capability(tool_status="ready", db_status="ready"),
            *_builtin_capabilities(),
        ]
    )


def tools_error() -> ToolboxStatusResponse:
    """Tool download failed."""
    return ToolboxStatusResponse(
        capabilities=[
            _annotation_capability(tool_status="error", db_status="unavailable"),
            *_builtin_capabilities(),
        ]
    )


def partial_ready(ready_tools: list[str]) -> ToolboxStatusResponse:
    """Some annotation tools ready, others unavailable."""
    components = []
    for t in _ANNOTATION_TOOLS:
        if t in ready_tools:
            components.append(
                ComponentStatusResponse.ready(
                    t,
                    source="downloaded",
                    version=_TOOL_METADATA[t]["version"],
                    path=_TOOL_METADATA[t]["path"],
                )
            )
        else:
            components.append(
                ComponentStatusResponse.unavailable(t, source="downloaded")
            )
    db_ready = set(_ANNOTATION_TOOLS).issubset(set(ready_tools))
    if db_ready and "databases" in ready_tools:
        components.append(
            ComponentStatusResponse.ready(
                "databases",
                label="Annotation Databases",
                source="downloaded",
                version=_TOOL_METADATA["databases"]["version"],
                path=_TOOL_METADATA["databases"]["path"],
            )
        )
    else:
        components.append(
            ComponentStatusResponse.unavailable(
                "databases", label="Annotation Databases", source="downloaded"
            )
        )

    status = derive_capability_status([c.status for c in components])

    return ToolboxStatusResponse(
        capabilities=[
            CapabilityStatusResponse(
                id="annotation",
                label="Annotation Engine",
                status=status,
                source="builtin",
                tier="base",
                auto_install=True,
                components=components,
            ),
            *_builtin_capabilities(),
        ]
    )


def mixed_component_status() -> ToolboxStatusResponse:
    """blastn ready, diamond downloading — mixed component states."""
    components = [
        ComponentStatusResponse.ready(
            "blastn",
            source="downloaded",
            version=_TOOL_METADATA["blastn"]["version"],
            path=_TOOL_METADATA["blastn"]["path"],
        ),
        ComponentStatusResponse.downloading(
            "diamond",
            percent=45,
            source="downloaded",
            size_mb=_TOOL_SIZES["diamond"],
        ),
        ComponentStatusResponse.unavailable("cmscan", source="downloaded"),
        ComponentStatusResponse.unavailable(
            "databases", label="Annotation Databases", source="downloaded"
        ),
    ]
    return ToolboxStatusResponse(
        capabilities=[
            CapabilityStatusResponse(
                id="annotation",
                label="Annotation Engine",
                status=derive_capability_status([c.status for c in components]),
                source="builtin",
                tier="base",
                auto_install=True,
                components=components,
            ),
            *_builtin_capabilities(),
        ]
    )


def with_mafft(scenario: ToolboxStatusResponse) -> ToolboxStatusResponse:
    """Ensure MAFFT is ready in the alignment capability."""
    caps = []
    for cap in scenario.capabilities:
        if cap.id == "alignment":
            caps.append(
                cap.model_copy(
                    update={
                        "status": "ready",
                        "components": [
                            ComponentStatusResponse.ready(
                                "mafft", label="MAFFT", source="system"
                            )
                        ],
                    }
                )
            )
        else:
            caps.append(cap)
    return scenario.model_copy(update={"capabilities": caps})


def with_plugin(
    scenario: ToolboxStatusResponse,
    plugin_id: str,
    *,
    label: str | None = None,
    status: str = "ready",
    url: str = "http://localhost:9000",
) -> ToolboxStatusResponse:
    """Add a plugin capability to the scenario."""
    plugin_cap = CapabilityStatusResponse(
        id=plugin_id,
        label=label or plugin_id,
        status=status,
        source="plugin",
        tier="optional",
        auto_install=False,
        components=[
            ComponentStatusResponse(
                id=plugin_id,
                label=label or plugin_id,
                status=status,
                source="plugin",
                path=url,
            )
        ],
    )
    return scenario.model_copy(
        update={"capabilities": [*scenario.capabilities, plugin_cap]}
    )
