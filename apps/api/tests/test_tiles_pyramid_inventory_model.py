""": the pyramid readiness/precompute routes own a response model."""

from src.main import app
from src.routes.tiles import AnnotationPyramidInventoryResponse


def test_inventory_model_keeps_declared_fields_and_open_diagnostics():
    result = {
        "ready": True,
        "availableTypes": ["CDS", "gene"],
        "chroms": {
            "chr11": {
                "status": "ready",
                "ready": True,
                "availableTypes": ["CDS", "gene"],
                "banks": ["canonical", "all"],
                "missingArtifacts": [],
                "corruptArtifacts": [],
                "artifactCount": 96,
                "manifestPath": "/tmp/manifest.json",
            }
        },
    }

    body = AnnotationPyramidInventoryResponse.model_validate(result).model_dump(
        by_alias=True
    )

    assert body["ready"] is True
    assert body["availableTypes"] == ["CDS", "gene"]
    assert body["chroms"]["chr11"]["artifactCount"] == 96
    assert body["chroms"]["chr11"]["manifestPath"] == "/tmp/manifest.json"
    assert body["chroms"]["chr11"]["availableTypes"] == ["CDS", "gene"]


def test_openapi_declares_the_inventory_model_on_both_routes():
    spec = app.openapi()
    for path in (
        "/tiles/annotation/pyramid/readiness",
        "/tiles/annotation/pyramid/precompute",
    ):
        schema = spec["paths"][path]["post"]["responses"]["200"]["content"][
            "application/json"
        ]["schema"]
        assert schema == {
            "$ref": "#/components/schemas/AnnotationPyramidInventoryResponse"
        }, path
    chrom = spec["components"]["schemas"]["AnnotationPyramidChromStatus"]
    assert chrom["additionalProperties"] is True
    assert set(chrom["required"]) == {"status", "ready", "availableTypes", "banks"}
