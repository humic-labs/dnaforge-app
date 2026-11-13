"""Tests for Pydantic toolbox response models.

Verifies:
- Models validate correctly from factory methods
- Dataclass → Pydantic conversion works
- Round-trip serialization (model → JSON → model)
- Invalid data is rejected
"""

import pytest
from pydantic import ValidationError

from src.models.toolbox import (
    CapabilityStatusResponse,
    ComponentStatusResponse,
    ProgressInfo,
    ToolboxHealthResponse,
    ToolboxRetryResponse,
    ToolboxStatusResponse,
)
from src.toolbox.registry import Capability, Component


class TestProgressInfo:
    def test_defaults(self):
        p = ProgressInfo(phase="downloading")
        assert p.phase == "downloading"
        assert p.percent == 0
        assert p.detail == ""

    def test_full(self):
        p = ProgressInfo(phase="extracting", percent=75.5, detail="blast databases")
        assert p.percent == 75.5
        assert p.detail == "blast databases"


class TestComponentStatusResponse:
    def test_ready_factory(self):
        c = ComponentStatusResponse.ready("blastn", version="2.13.0")
        assert c.id == "blastn"
        assert c.label == "blastn"
        assert c.status == "ready"
        assert c.source == "downloaded"
        assert c.version == "2.13.0"
        assert c.progress is None

    def test_ready_factory_custom_label(self):
        c = ComponentStatusResponse.ready("blastn", label="BLAST+ nucleotide")
        assert c.label == "BLAST+ nucleotide"

    def test_downloading_factory(self):
        c = ComponentStatusResponse.downloading(
            "databases", percent=45.0, detail="nr database"
        )
        assert c.status == "downloading"
        assert c.progress is not None
        assert c.progress.percent == 45.0
        assert c.progress.detail == "nr database"

    def test_error_factory(self):
        c = ComponentStatusResponse.error("diamond")
        assert c.status == "error"

    def test_unavailable_factory(self):
        c = ComponentStatusResponse.unavailable("cmscan")
        assert c.status == "unavailable"

    def test_invalid_status_rejected(self):
        with pytest.raises(ValidationError):
            ComponentStatusResponse(
                id="x", label="x", status="bogus", source="downloaded"
            )

    def test_from_dataclass(self):
        dc = Component(
            id="blastn",
            label="blastn",
            status="ready",
            source="downloaded",
            version="2.13.0",
            path="/usr/local/bin/blastn",
        )
        model = ComponentStatusResponse.from_dataclass(dc)
        assert model.id == "blastn"
        assert model.version == "2.13.0"
        assert model.path == "/usr/local/bin/blastn"

    def test_from_dataclass_with_progress(self):
        dc = Component(
            id="databases",
            label="BLAST databases",
            status="downloading",
            source="downloaded",
            progress={"phase": "downloading", "percent": 50, "detail": "nr"},
        )
        model = ComponentStatusResponse.from_dataclass(dc)
        assert model.progress is not None
        assert model.progress.percent == 50

    def test_roundtrip_serialization(self):
        original = ComponentStatusResponse.downloading("blastn", percent=30.0)
        json_data = original.model_dump()
        restored = ComponentStatusResponse.model_validate(json_data)
        assert restored == original


class TestCapabilityStatusResponse:
    def test_from_dataclass(self):
        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(
                    id="blastn", label="blastn", status="ready", source="downloaded"
                ),
                Component(
                    id="databases",
                    label="databases",
                    status="ready",
                    source="downloaded",
                ),
            ],
        )
        model = CapabilityStatusResponse.from_dataclass(cap)
        assert model.id == "annotation"
        assert model.status == "ready"
        assert len(model.components) == 2

    def test_invalid_tier_rejected(self):
        with pytest.raises(ValidationError):
            CapabilityStatusResponse(
                id="x",
                label="x",
                status="ready",
                source="builtin",
                tier="premium",
                auto_install=False,
                components=[],
            )


class TestToolboxStatusResponse:
    def test_from_registry_dict(self):
        """Simulate what toolbox_registry.to_dict() produces."""
        raw = {
            "capabilities": [
                {
                    "id": "annotation",
                    "label": "Annotation Engine",
                    "status": "ready",
                    "source": "builtin",
                    "tier": "base",
                    "auto_install": True,
                    "components": [
                        {
                            "id": "blastn",
                            "label": "blastn",
                            "status": "ready",
                            "source": "downloaded",
                            "version": "2.13.0",
                        }
                    ],
                }
            ]
        }
        model = ToolboxStatusResponse.from_registry_dict(raw)
        assert len(model.capabilities) == 1
        assert model.capabilities[0].components[0].version == "2.13.0"

    def test_roundtrip(self):
        model = ToolboxStatusResponse(
            capabilities=[
                CapabilityStatusResponse(
                    id="alignment",
                    label="Sequence Alignment",
                    status="ready",
                    source="builtin",
                    tier="base",
                    auto_install=True,
                    components=[
                        ComponentStatusResponse.ready("mafft", version="7.520")
                    ],
                )
            ]
        )
        json_str = model.model_dump_json()
        restored = ToolboxStatusResponse.model_validate_json(json_str)
        assert restored == model

    def test_empty_capabilities(self):
        model = ToolboxStatusResponse(capabilities=[])
        assert model.capabilities == []


class TestScenarioCompatibility:
    """Verify scenarios produce responses that validate against models."""

    def test_fully_ready_validates(self):
        from .scenarios import fully_ready

        scenario = fully_ready()
        json_data = scenario.model_dump()
        restored = ToolboxStatusResponse.model_validate(json_data)
        assert restored == scenario

    def test_registry_dict_matches_scenario_shape(self):
        """A real registry dict should validate against the same model."""
        from src.toolbox.registry import Capability, Component

        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(
                    id="blastn", label="blastn", status="ready", source="downloaded"
                ),
            ],
        )
        raw = {"capabilities": [cap.to_dict()]}
        model = ToolboxStatusResponse.from_registry_dict(raw)
        assert model.capabilities[0].id == "annotation"
        assert model.capabilities[0].components[0].status == "ready"


class TestProductionBridge:
    """Verify from_dataclass() output matches factory-built scenarios."""

    def test_ready_component_bridge(self):
        """Registry Component → from_dataclass should match factory .ready()."""
        dc = Component(
            id="blastn",
            label="blastn",
            status="ready",
            source="downloaded",
            version="2.13.0",
            path="/usr/local/bin/blastn",
        )
        from_dc = ComponentStatusResponse.from_dataclass(dc)
        from_factory = ComponentStatusResponse.ready(
            "blastn",
            version="2.13.0",
            path="/usr/local/bin/blastn",
        )
        assert from_dc == from_factory

    def test_downloading_component_bridge(self):
        dc = Component(
            id="databases",
            label="databases",
            status="downloading",
            source="downloaded",
            progress={"phase": "downloading", "percent": 45, "detail": "nr"},
            size_mb=1200,
        )
        from_dc = ComponentStatusResponse.from_dataclass(dc)
        from_factory = ComponentStatusResponse.downloading(
            "databases",
            percent=45,
            detail="nr",
            size_mb=1200,
        )
        assert from_dc == from_factory

    def test_error_component_bridge(self):
        dc = Component(
            id="diamond",
            label="diamond",
            status="error",
            source="downloaded",
        )
        from_dc = ComponentStatusResponse.from_dataclass(dc)
        from_factory = ComponentStatusResponse.error("diamond")
        assert from_dc == from_factory

    def test_full_capability_bridge(self):
        """Full capability roundtrip: registry → from_dataclass → model_dump → model_validate."""
        cap = Capability(
            id="annotation",
            label="Annotation Engine",
            source="builtin",
            tier="base",
            auto_install=True,
            components=[
                Component(
                    id="blastn",
                    label="blastn",
                    status="ready",
                    source="downloaded",
                    version="2.13.0",
                ),
                Component(
                    id="diamond", label="diamond", status="ready", source="downloaded"
                ),
                Component(
                    id="databases",
                    label="databases",
                    status="downloading",
                    source="downloaded",
                    progress={"phase": "downloading", "percent": 30, "detail": ""},
                ),
            ],
        )
        model = CapabilityStatusResponse.from_dataclass(cap)
        assert model.status == "downloading"
        json_data = model.model_dump()
        restored = CapabilityStatusResponse.model_validate(json_data)
        assert restored == model


class TestRetryAndHealthResponses:
    def test_retry_response(self):
        r = ToolboxRetryResponse(
            retrying=True,
            capability="annotation",
            operation_id="0199a4f1-1111-7000-8000-000000000001",
            state="queued",
        )
        assert r.retrying is True
        assert r.operation_id == "0199a4f1-1111-7000-8000-000000000001"
        assert r.state == "queued"

    def test_health_response(self):
        h = ToolboxHealthResponse(
            capability="mafft_plugin", status="ready", url="http://localhost:9000"
        )
        assert h.url == "http://localhost:9000"
