import json
import subprocess
import sys
import unittest
from pathlib import Path


class NgsPackageNamespaceTests(unittest.TestCase):
    def check_namespace(self, namespace: str, directory: Path):
        code = f"""
import importlib
import importlib.util
import json
import os
import sys
namespace = {namespace!r}
if namespace == 'src.services':
    assert importlib.util.find_spec('services') is None
identity = importlib.import_module(namespace + '.app_owned_tool_identity')
runtime = importlib.import_module(namespace + '.ngs_tool_runtime')
assert identity.resolve_app_owned_executable.__module__ == namespace + '.app_owned_tool_identity'
assert runtime.resolve_app_owned_ngs_tools.__module__ == namespace + '.ngs_tool_runtime'
assert issubclass(runtime.VerifiedNgsTool, identity.AppOwnedExecutableIdentity)
os.environ.pop('DNAFORGE_HELPERS_DIR', None)
try:
    runtime.resolve_app_owned_ngs_tools()
except runtime.NgsToolRuntimeError as error:
    assert error.code in ('NGS_TOOLS_UNAVAILABLE', 'NGS_TOOLS_PLATFORM_UNSUPPORTED')
else:
    raise AssertionError('Unconfigured tools must not execute')
if namespace == 'src.services':
    assert 'services' not in sys.modules
print(json.dumps({{'namespace': namespace, 'imports': 'passed', 'unconfiguredAvailabilityGuard': 'passed'}}))
"""
        result = subprocess.run(
            [sys.executable, "-E", "-S", "-c", code],
            cwd=directory,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["namespace"], namespace)

    def test_production_src_namespace_without_top_level_services_alias(self):
        self.check_namespace("src.services", Path(__file__).resolve().parents[2])

    def test_standalone_services_namespace_keeps_relative_module_identity(self):
        self.check_namespace("services", Path(__file__).resolve().parents[2] / "src")


if __name__ == "__main__":
    unittest.main()
