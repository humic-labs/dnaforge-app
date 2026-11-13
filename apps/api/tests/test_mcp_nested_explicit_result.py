from jsonschema import validate

from src.mcp_companion.projection import project_call_result


def test_nested_explicit_mcp_result_matches_its_declared_schema():
    result = {
        "content": [
            {"type": "text", "text": "packaged-fidelity"},
            {"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"},
            {
                "type": "resource",
                "resource": {
                    "uri": "waypoint://artifact/package-probe",
                    "mimeType": "application/json",
                    "text": '{"artifact":true}',
                },
            },
            {
                "type": "resource_link",
                "name": "Packaged probe artifact",
                "uri": "waypoint://artifact/package-probe",
                "mimeType": "application/json",
            },
        ],
        "structuredContent": {"echo": {"era": "modern"}},
    }
    actual = project_call_result(
        200,
        {
            "ok": True,
            "jobId": "package-probe-job",
            "status": "completed",
            "result": result,
        },
        tool_name="probe.echo",
    )

    assert actual.structured_content == {"echo": {"era": "modern"}}
    validate(actual.structured_content, {"type": "object", "required": ["echo"]})
    assert [item.type for item in actual.content] == [
        "text",
        "image",
        "resource",
        "resource_link",
    ]
    assert actual.content[0].text == "packaged-fidelity"
    assert actual.content[1].data == "iVBORw0KGgo="
    assert actual.content[2].resource.text == '{"artifact":true}'
    assert str(actual.content[3].uri) == "waypoint://artifact/package-probe"


def test_domain_content_field_remains_part_of_the_declared_domain_result():
    result = {"content": [{"type": "text", "text": "domain data"}], "label": "business"}
    actual = project_call_result(
        200,
        {"ok": True, "jobId": "domain-job", "status": "completed", "result": result},
    )
    assert actual.structured_content == result


def test_explicit_top_level_mcp_result_remains_authoritative():
    actual = project_call_result(
        200,
        {
            "content": [{"type": "text", "text": "top-level"}],
            "structuredContent": {"top": True},
            "result": {
                "content": [{"type": "text", "text": "nested"}],
                "structuredContent": {"nested": True},
            },
        },
    )
    assert actual.structured_content == {"top": True}
    assert actual.content[0].text == "top-level"
