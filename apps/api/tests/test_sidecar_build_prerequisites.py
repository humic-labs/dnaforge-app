import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


BUILD_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build-sidecar.sh"
COMPILER_SENTINEL = 77
HELPER_FAILURE = 63
TOOL_STUB = r'''
import json
import os
import sys
from pathlib import Path

name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["TEST_TRACE"], "a") as trace:
    trace.write(json.dumps({
        "tool": name,
        "args": args,
        "helpers": os.environ.get("DNAFORGE_HELPERS_DIR"),
    }) + "\n")

if name == "uname":
    print(os.environ["TEST_SYSTEM"] if args == ["-s"] else os.environ["TEST_ARCH"])
elif name == "sysctl":
    print("1" if os.environ["TEST_ARCH"] == "arm64" else "0")
elif name == "uv":
    if args == ["--version"]:
        print("uv 0.13.5")
    elif args[:2] == ["python", "find"]:
        print(Path(sys.argv[0]).parent / "python")
    else:
        raise SystemExit("unexpected uv invocation: " + repr(args))
elif name == "node":
    script = Path(args[0]).name if args else ""
    if script == "build-helpers.cjs":
        raise SystemExit(int(os.environ["TEST_HELPER_EXIT"]))
    if script == "python-runtime-security.cjs":
        if args[1] == "minimum":
            print("3.12.12")
        elif args[1] not in ("check", "check-uv"):
            raise SystemExit("unexpected security invocation: " + repr(args))
    elif script == "ci-setup-secure-python.mjs":
        print("cpython-3.12.12")
    elif script == "sidecar-build-receipt.cjs" and args[1] == "source-hash":
        print("a" * 64)
    else:
        raise SystemExit("unexpected node invocation: " + repr(args))
elif name == "python":
    if args[:2] == ["-m", "nuitka"]:
        raise SystemExit(77)
    if "-c" in args:
        code = args[args.index("-c") + 1]
        if "genome_extra_enabled_for_target" in code:
            print(str("windows" not in args[-1]).lower())
        elif "platform.python_version" in code:
            print("3.12.12")
        else:
            raise SystemExit("unexpected Python expression: " + repr(args))
    elif args and Path(args[0]).name == "verify_sidecar_architecture.py":
        pass
    else:
        raise SystemExit("unexpected Python invocation: " + repr(args))
else:
    raise SystemExit("unexpected tool: " + name)
'''


class TestSidecarBuildPrerequisites(unittest.TestCase):
    def drive_build(self, system="Darwin", arch="arm64", helper_exit=0):
        with tempfile.TemporaryDirectory(prefix="sidecar-prerequisites-") as temporary:
            root = Path(temporary).resolve()
            api = root / "apps" / "api"
            scripts = api / "scripts"
            scripts.mkdir(parents=True)
            (api / "src").mkdir()
            (api / ".venv" / "bin").mkdir(parents=True)
            (api / ".venv" / "bin" / "activate").write_text("")
            shutil.copyfile(BUILD_SCRIPT, scripts / "build-sidecar.sh")
            (scripts / "sync-python-dependencies.sh").write_text("exit 0\n")
            manifests = root / "packages" / "core" / "agent-tools"
            manifests.mkdir(parents=True)
            for filename in ("renderer-tool-manifest.json", "workflow-manifest.json"):
                (manifests / filename).write_text("{}")
            tools = root / "test-tools"
            tools.mkdir()
            for name in ("node", "uv", "python", "uname", "sysctl"):
                tool = tools / name
                tool.write_text(f"#!{sys.executable}\n" + TOOL_STUB)
                tool.chmod(0o755)
            trace = root / "trace.jsonl"
            environment = {
                "PATH": str(tools) + os.pathsep + os.defpath,
                "HOME": str(root / "home"),
                "TEST_TRACE": str(trace),
                "TEST_SYSTEM": system,
                "TEST_ARCH": arch,
                "TEST_HELPER_EXIT": str(helper_exit),
            }
            result = subprocess.run(
                ["/bin/bash", str(scripts / "build-sidecar.sh")],
                cwd=root,
                env=environment,
                capture_output=True,
                text=True,
                timeout=15,
            )
            events = [json.loads(line) for line in trace.read_text().splitlines()]
            return root, result, events

    @staticmethod
    def helper_calls(events):
        return [
            event
            for event in events
            if event["tool"] == "node"
            and event["args"]
            and Path(event["args"][0]).name == "build-helpers.cjs"
        ]

    @staticmethod
    def compiler_calls(events):
        return [
            event
            for event in events
            if event["tool"] == "python" and event["args"][:2] == ["-m", "nuitka"]
        ]

    def test_genome_builds_coverage_before_compiling(self):
        for system, arch in (
            ("Darwin", "arm64"),
            ("Darwin", "x86_64"),
            ("Linux", "x86_64"),
        ):
            with self.subTest(system=system, arch=arch):
                root, result, events = self.drive_build(system, arch)
                self.assertEqual(
                    result.returncode,
                    COMPILER_SENTINEL,
                    result.stdout + result.stderr,
                )
                helpers = self.helper_calls(events)
                compiler = self.compiler_calls(events)
                self.assertEqual(len(helpers), 1, events)
                self.assertEqual(
                    helpers[0]["args"],
                    [
                        str(root / "apps" / "desktop" / "scripts" / "build-helpers.cjs"),
                        "dna-coverage",
                    ],
                )
                self.assertEqual(len(compiler), 1, events)
                self.assertLess(events.index(helpers[0]), events.index(compiler[0]))
                self.assertEqual(
                    Path(compiler[0]["helpers"]).resolve(),
                    root / "apps" / "desktop" / "resources" / "helpers",
                )

    def test_coverage_build_failure_stops_before_compiling(self):
        _root, result, events = self.drive_build(helper_exit=HELPER_FAILURE)
        self.assertEqual(
            result.returncode, HELPER_FAILURE, result.stdout + result.stderr
        )
        self.assertEqual(len(self.helper_calls(events)), 1, events)
        self.assertEqual(self.compiler_calls(events), [], events)

    def test_windows_runtime_policy_does_not_build_coverage(self):
        _root, result, events = self.drive_build("MINGW64_NT-10.0", "x86_64")
        self.assertEqual(
            result.returncode, COMPILER_SENTINEL, result.stdout + result.stderr
        )
        self.assertEqual(self.helper_calls(events), [], events)
        self.assertEqual(len(self.compiler_calls(events)), 1, events)


if __name__ == "__main__":
    unittest.main()
