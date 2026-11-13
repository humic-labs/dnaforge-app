"""Contract tests for the service registry interface.

These tests freeze the public API of ServiceRegistry and ServiceDefinition.
Any change that breaks these tests requires a migration plan.  moved
execution off ServiceDefinition onto typed routes; discovery is unchanged.

Assertion IDs reference: PLAN.md (Architecture Hardening)
"""

from src.services.base import ServiceDefinition
from src.services.registry import ServiceRegistry


class StubService(ServiceDefinition):
    """A minimal stub for contract testing."""

    INPUT_TYPES = {"input_field": {"type": "string", "required": True}}
    RETURN_TYPES = {"output_field": {"type": "string"}}


class AnotherStubService(ServiceDefinition):
    """A second stub to test multi-service scenarios."""

    INPUT_TYPES = {}
    RETURN_TYPES = {}


class TestRegistryGet:
    """A-1: registry.get(name) returns a ServiceDefinition for a registered
    service and None for an unregistered name."""

    def test_a1_get_returns_service_definition(self):
        reg = ServiceRegistry()
        reg.register(StubService)
        result = reg.get("stub_service")
        assert isinstance(result, ServiceDefinition)

    def test_a1_get_returns_none_for_unregistered(self):
        reg = ServiceRegistry()
        result = reg.get("nonexistent")
        assert result is None


class TestRegistrySingleton:
    """A-2: registry.get(name) returns the same instance on repeated calls."""

    def test_a2_get_returns_same_instance(self):
        reg = ServiceRegistry()
        reg.register(StubService)
        first = reg.get("stub_service")
        second = reg.get("stub_service")
        assert first is second


class TestRegistryRegister:
    """A-3: registry.register(cls) makes the service discoverable
    and handles re-registration."""

    def test_a3_register_makes_service_discoverable(self):
        reg = ServiceRegistry()
        reg.register(StubService)
        assert reg.get("stub_service") is not None

    def test_a3_re_registration_does_not_raise(self):
        reg = ServiceRegistry()
        reg.register(StubService)
        reg.register(StubService)
        assert reg.get("stub_service") is not None


class TestRegistryListServices:
    """A-4: registry.list_services() returns names of all registered services."""

    def test_a4_empty_registry_returns_empty_list(self):
        reg = ServiceRegistry()
        assert reg.list_services() == []

    def test_a4_returns_all_registered_names(self):
        reg = ServiceRegistry()
        reg.register(StubService)
        reg.register(AnotherStubService)
        names = reg.list_services()
        assert "stub_service" in names
        assert "another_stub_service" in names


class TestRegistryListSchemas:
    """A-5: registry.list_schemas() returns schema dicts with name,
    input_types, return_types, and description."""

    def test_a5_schema_dict_has_required_keys(self):
        reg = ServiceRegistry()
        reg.register(StubService)
        schemas = reg.list_schemas()
        assert len(schemas) == 1
        schema = schemas[0]
        assert "name" in schema
        assert "input_types" in schema
        assert "return_types" in schema
        assert "description" in schema
        assert schema["name"] == "stub_service"


class TestServiceDefinitionName:
    """A-6: ServiceDefinition.name derives snake_case from class name."""

    def test_a6_stub_service_name(self):
        assert StubService().name == "stub_service"

    def test_a6_another_stub_service_name(self):
        assert AnotherStubService().name == "another_stub_service"
