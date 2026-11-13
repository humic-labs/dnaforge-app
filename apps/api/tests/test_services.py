"""
Tests for service infrastructure.

- ServiceDefinition discovery description (INPUT_TYPES/RETURN_TYPES derived
  from the Pydantic models that own each built-in wire contract)
- ServiceRegistry for discovery
- /services/ API routes (listing, schema, plugin execution)
"""

import pytest

from tests.sidecar_test_client import AuthenticatedSidecarTestClient as TestClient


class TestServiceDefinition:
    """Tests for the ServiceDefinition discovery description."""

    def test_service_definition_describes_inputs_from_its_request_model(self):
        """A built-in service derives INPUT_TYPES from its request model."""
        from pydantic import BaseModel, Field

        from src.services.base import ServiceDefinition, describe_model_fields

        class EchoRequest(BaseModel):
            message: str = Field(..., description="Message to echo")
            repeat: int | None = None

        class EchoService(ServiceDefinition):
            INPUT_TYPES = describe_model_fields(EchoRequest)
            RETURN_TYPES = {"echo": {"type": "string"}}

        service = EchoService()
        assert service.INPUT_TYPES["message"] == {
            "type": "string",
            "description": "Message to echo",
            "required": True,
        }
        assert service.INPUT_TYPES["repeat"] == {
            "type": "integer",
            "default": None,
            "required": False,
        }

    def test_describe_model_fields_inlines_nested_models(self):
        """Nested result models are listed in full, not as schema references."""
        from pydantic import BaseModel

        from src.services.base import describe_model_fields

        class Hit(BaseModel):
            name: str
            score: float

        class Result(BaseModel):
            hits: list[Hit]

        described = describe_model_fields(Result)
        assert described["hits"]["type"] == "array"
        assert described["hits"]["items"]["properties"]["score"] == {"type": "number"}
        assert described["hits"]["items"]["required"] == ["name", "score"]
        assert "$ref" not in str(described)

    def test_describe_model_fields_keeps_a_field_named_title(self):
        """Schema titles are dropped, but a field literally named title survives."""
        from pydantic import BaseModel

        from src.services.base import describe_model_fields

        class Citation(BaseModel):
            title: str
            year: int

        class Result(BaseModel):
            title: str
            citations: list[Citation]

        described = describe_model_fields(Result)
        assert described["title"] == {"type": "string", "required": True}
        assert described["citations"]["items"]["properties"]["title"] == {
            "type": "string"
        }

    def test_describe_model_fields_keeps_a_true_union(self):
        """A field with several concrete alternatives keeps its anyOf listing."""
        from pydantic import BaseModel

        from src.services.base import describe_model_fields

        class Request(BaseModel):
            identifier: int | str | None = None

        described = describe_model_fields(Request)
        assert described["identifier"]["required"] is False
        assert {alt["type"] for alt in described["identifier"]["anyOf"]} == {
            "integer",
            "string",
            "null",
        }

    def test_describe_model_fields_survives_a_recursive_model(self):
        """A self-referential model is described once; the loop stays a $ref."""
        from pydantic import BaseModel

        from src.services.base import describe_model_fields

        class Node(BaseModel):
            label: str
            child: "Node | None" = None

        class Root(BaseModel):
            node: Node

        described = describe_model_fields(Root)
        assert described["node"]["properties"]["label"] == {"type": "string"}
        child = described["node"]["properties"]["child"]
        assert any(alt.get("$ref") == "#/$defs/Node" for alt in child["anyOf"])

    def test_service_definition_has_name(self):
        """A service has a name derived from class name by default."""
        from src.services.base import ServiceDefinition

        class MyAwesomeService(ServiceDefinition):
            INPUT_TYPES = {"x": {"type": "string"}}
            RETURN_TYPES = {"y": {"type": "string"}}

        service = MyAwesomeService()
        assert service.name == "my_awesome_service"

    def test_service_definition_has_no_untyped_execute(self):
        """Execution belongs to a typed route, not a keyword-argument method."""
        from src.services.base import ServiceDefinition

        assert not hasattr(ServiceDefinition, "execute")

    def test_service_definition_get_schema(self):
        """A service can return its full schema for discovery."""
        from src.services.base import ServiceDefinition

        class EchoService(ServiceDefinition):
            """Echoes input back."""

            INPUT_TYPES = {
                "message": {
                    "type": "string",
                    "description": "Message to echo",
                    "required": True,
                }
            }
            RETURN_TYPES = {"echo": {"type": "string", "description": "Echoed message"}}

        service = EchoService()
        schema = service.get_schema()

        assert schema["name"] == "echo_service"
        assert schema["description"] == "Echoes input back."
        assert schema["input_types"] == service.INPUT_TYPES
        assert schema["return_types"] == service.RETURN_TYPES


class TestServiceRegistry:
    """Tests for the ServiceRegistry discovery system."""

    def test_registry_register_service(self):
        """Can register a service with the registry."""
        from src.services.base import ServiceDefinition
        from src.services.registry import ServiceRegistry

        class TestService(ServiceDefinition):
            INPUT_TYPES = {"x": {"type": "string"}}
            RETURN_TYPES = {"y": {"type": "string"}}

        registry = ServiceRegistry()
        registry.register(TestService)

        assert "test_service" in registry.list_services()

    def test_registry_get_service(self):
        """Can retrieve a registered service by name."""
        from src.services.base import ServiceDefinition
        from src.services.registry import ServiceRegistry

        class MyService(ServiceDefinition):
            INPUT_TYPES = {"x": {"type": "string"}}
            RETURN_TYPES = {"y": {"type": "string"}}

        registry = ServiceRegistry()
        registry.register(MyService)

        service = registry.get("my_service")
        assert service is not None
        assert isinstance(service, MyService)

    def test_registry_get_unknown_service_returns_none(self):
        """Getting an unregistered service returns None."""
        from src.services.registry import ServiceRegistry

        registry = ServiceRegistry()
        assert registry.get("nonexistent") is None

    def test_registry_list_schemas(self):
        """Can list schemas for all registered services."""
        from src.services.base import ServiceDefinition
        from src.services.registry import ServiceRegistry

        class ServiceA(ServiceDefinition):
            """Service A description."""

            INPUT_TYPES = {"a": {"type": "string"}}
            RETURN_TYPES = {"result_a": {"type": "string"}}

        class ServiceB(ServiceDefinition):
            """Service B description."""

            INPUT_TYPES = {"b": {"type": "number"}}
            RETURN_TYPES = {"result_b": {"type": "number"}}

        registry = ServiceRegistry()
        registry.register(ServiceA)
        registry.register(ServiceB)

        schemas = registry.list_schemas()
        assert len(schemas) == 2
        names = [s["name"] for s in schemas]
        assert "service_a" in names
        assert "service_b" in names


class TestServicesAPI:
    """Tests for the /services/ API routes."""

    @pytest.fixture
    def client(self):
        """Create a test client with services routes."""
        from src.main import app

        return TestClient(app)

    def test_list_services_endpoint(self, client):
        """GET /services/ returns list of available services."""
        response = client.get("/services/")
        assert response.status_code == 200
        data = response.json()
        assert "services" in data
        assert isinstance(data["services"], list)

    def test_get_service_schema_endpoint(self, client):
        """GET /services/{name}/schema returns service schema."""
        response = client.get("/services/plannotate/schema")
        assert response.status_code in [200, 404]

    def test_execute_service_endpoint_is_plugin_only(self, client):
        """POST /services/{name}/execute proxies plugins; unknown names are 404."""
        response = client.post("/services/echo/execute", json={"message": "hello"})
        assert response.status_code == 404

    def test_execute_unknown_service_returns_404(self, client):
        """POST /services/{unknown}/execute returns 404."""
        response = client.post("/services/nonexistent_service_xyz/execute", json={})
        assert response.status_code == 404
