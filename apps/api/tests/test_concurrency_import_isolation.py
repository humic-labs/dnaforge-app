import os
import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
API_ROOT = REPO_ROOT / "apps" / "api"


class ConcurrencyImportIsolationTest(unittest.TestCase):
    def run_isolated(self, source: str) -> None:
        environment = {
            key: os.environ[key]
            for key in ("PATH", "HOME", "SYSTEMROOT", "TMPDIR", "TEMP", "TMP", "LANG")
            if key in os.environ
        }
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                "-c",
                "import sys\nsys.path.insert(0, sys.argv[1])\n" + source,
                str(API_ROOT),
            ],
            cwd=REPO_ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_renderer_bridge_import_leaves_local_dispatch_dependencies_unloaded(
        self,
    ) -> None:
        self.run_isolated("""
import importlib
importlib.import_module("src.concurrency.renderer_bridge")
forbidden = (
    "src.concurrency.dispatcher",
    "src.concurrency.job_manager",
    "src.concurrency.tool_validation",
    "jsonschema",
)
loaded = sorted(
    name
    for name in sys.modules
    if any(name == root or name.startswith(root + ".") for root in forbidden)
)
assert not loaded, loaded
""")

    def test_public_exports_keep_owner_identity_and_unknown_attributes_fail(
        self,
    ) -> None:
        self.run_isolated("""
import importlib
concurrency = importlib.import_module("src.concurrency")
owners = (
    ("agent_tool_registry", "src.concurrency.tool_registry"),
    ("dispatch_tool", "src.concurrency.dispatcher"),
    ("get_job_manager", "src.concurrency.job_manager"),
    ("get_pool_manager", "src.concurrency.pools"),
)
for name, module_name in owners:
    actual = getattr(concurrency, name)
    expected = getattr(importlib.import_module(module_name), name)
    assert actual is expected, name
    assert getattr(concurrency, name) is actual, name
assert set(concurrency.__all__) == {
    *(name for name, _ in owners),
    "register_builtin_agent_tools",
}
assert callable(concurrency.register_builtin_agent_tools)
try:
    getattr(concurrency, "not_a_public_concurrency_export")
except AttributeError:
    pass
else:
    raise AssertionError("Unknown concurrency attributes must raise AttributeError")
""")


if __name__ == "__main__":
    unittest.main()
