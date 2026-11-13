"""
Tests for the sidecar build system.

Validates that the build infrastructure exists and is correctly configured:
- Nuitka build script (scripts/build-sidecar.sh) exists and is executable
- Legacy build.py exists and is valid Python (still used for platform detection)
- Built binary (if present) is functional
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


class TestBuildScriptExists:
    """Tests that build infrastructure exists."""

    def test_nuitka_build_script_exists(self):
        """Nuitka build script exists at expected location."""
        build_script = Path(__file__).parent.parent / "scripts" / "build-sidecar.sh"
        assert build_script.exists(), f"Build script not found at {build_script}"

    def test_nuitka_build_script_is_executable(self):
        """Nuitka build script is executable."""
        build_script = Path(__file__).parent.parent / "scripts" / "build-sidecar.sh"
        assert os.access(
            build_script, os.X_OK
        ), f"Build script not executable: {build_script}"

    def test_run_server_entry_point_exists(self):
        """run_server.py entry point exists (Nuitka entry point)."""
        entry_point = Path(__file__).parent.parent / "run_server.py"
        assert entry_point.exists(), f"Entry point not found at {entry_point}"

    def test_run_server_is_valid_python(self):
        """run_server.py is valid Python syntax."""
        entry_point = Path(__file__).parent.parent / "run_server.py"
        result = subprocess.run(
            [sys.executable, "-m", "py_compile", str(entry_point)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"Syntax error in run_server.py: {result.stderr}"

    def test_packaged_mcp_probe_is_wired_into_desktop_verification(self):
        """Full package verification runs protocol calls on the embedded binary."""
        api_dir = Path(__file__).parent.parent
        probe = api_dir / "scripts" / "verify_packaged_mcp.py"
        verifier = api_dir.parent / "desktop" / "scripts" / "verify-package.cjs"
        assert probe.exists()
        compile_result = subprocess.run(
            [sys.executable, "-m", "py_compile", str(probe)],
            capture_output=True,
            text=True,
        )
        assert compile_result.returncode == 0, compile_result.stderr
        verifier_source = verifier.read_text()
        assert "verify_packaged_mcp.py" in verifier_source
        assert "sidecarBundleProblem" in verifier_source

    def test_run_server_prints_the_active_native_coverage_contract(
        self, monkeypatch, capsys
    ):
        """The frozen-sidecar probe exits before starting Uvicorn."""
        import run_server
        from src.services import coverage_pyramid, dna_coverage_shellout

        engine_identity = f"dna-coverage:schema-1:sha256-{'a' * 64}"
        monkeypatch.setattr(
            dna_coverage_shellout,
            "coverage_engine_identity",
            lambda: engine_identity,
        )
        monkeypatch.setattr(
            sys,
            "argv",
            ["run_server.py", "--print-native-coverage-contract"],
        )

        assert run_server.main() == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload == {
            "schema": "dnaforge.native-coverage-contract.v1",
            "cacheContract": coverage_pyramid._CACHE_CONTRACT_TOKEN,
            "engineIdentity": engine_identity,
        }

    def test_run_server_verifies_the_native_genome_runtime(self, monkeypatch, capsys):
        """The packaged startup probe proves pysam imports before Uvicorn starts."""
        import run_server
        from src import runtime_capabilities

        monkeypatch.setattr(
            runtime_capabilities,
            "genome_runtime_status_receipt",
            lambda: {
                "schema": "dnaforge.genome-runtime-capability.v1",
                "capability": "genome.pysam-htslib.v1",
                "pysamVersion": "0.24.0",
                "coverageEngineIdentity": (f"dna-coverage:schema-1:sha256-{'a' * 64}"),
            },
        )
        monkeypatch.setattr(sys, "argv", ["run_server.py", "--verify-genome-runtime"])

        assert run_server.main() == 0
        assert json.loads(capsys.readouterr().out) == {
            "schema": "dnaforge.genome-runtime-capability.v1",
            "capability": "genome.pysam-htslib.v1",
            "pysamVersion": "0.24.0",
            "coverageEngineIdentity": f"dna-coverage:schema-1:sha256-{'a' * 64}",
        }

    def test_run_server_proves_intentional_windows_runtime_absence(
        self, monkeypatch, capsys
    ):
        """A Windows binary emits a positive policy receipt instead of skipping proof."""
        import run_server
        from src import runtime_capabilities

        monkeypatch.setattr(
            runtime_capabilities,
            "genome_runtime_status_receipt",
            lambda: {
                "schema": "dnaforge.genome-runtime-unavailable.v1",
                "capability": "genome.pysam-htslib.v1",
                "reason": "unsupported-on-target",
                "target": "win32",
            },
        )
        monkeypatch.setattr(sys, "argv", ["run_server.py", "--verify-genome-runtime"])

        assert run_server.main() == 0
        assert json.loads(capsys.readouterr().out) == {
            "schema": "dnaforge.genome-runtime-unavailable.v1",
            "capability": "genome.pysam-htslib.v1",
            "reason": "unsupported-on-target",
            "target": "win32",
        }

    def test_runtime_status_allows_absence_only_where_the_build_omits_the_extra(
        self, monkeypatch
    ):
        from src import runtime_capabilities

        def unavailable():
            raise ModuleNotFoundError("No module named 'pysam'")

        monkeypatch.setattr(runtime_capabilities, "genome_runtime_receipt", unavailable)

        assert runtime_capabilities.genome_runtime_status_receipt("win32") == {
            "schema": "dnaforge.genome-runtime-unavailable.v1",
            "capability": "genome.pysam-htslib.v1",
            "reason": "unsupported-on-target",
            "target": "win32",
        }
        with pytest.raises(ModuleNotFoundError, match="pysam"):
            runtime_capabilities.genome_runtime_status_receipt("darwin")

    def test_run_server_fails_the_genome_probe_when_pysam_is_unavailable(
        self, monkeypatch, capsys
    ):
        import run_server
        from src import runtime_capabilities

        def unavailable():
            raise ModuleNotFoundError("No module named 'pysam'")

        monkeypatch.setattr(
            runtime_capabilities, "genome_runtime_status_receipt", unavailable
        )
        monkeypatch.setattr(sys, "argv", ["run_server.py", "--verify-genome-runtime"])

        assert run_server.main() == 1
        assert "Required BAM/CRAM runtime is unavailable" in capsys.readouterr().err

    def test_run_server_dev_auth_mints_and_prints_a_usable_session(
        self, monkeypatch, capsys
    ):
        """Standalone development has an explicit authenticated launch path."""

        import secrets

        import uvicorn

        import run_server

        calls = []
        monkeypatch.delenv("DNAFORGE_MCP_SESSION_TOKEN", raising=False)
        monkeypatch.setattr(secrets, "token_urlsafe", lambda _bytes: "dev-token")
        monkeypatch.setattr(
            uvicorn, "run", lambda *args, **kwargs: calls.append((args, kwargs))
        )
        monkeypatch.setattr(
            sys,
            "argv",
            ["run_server.py", "--dev-auth", "--port", "8123"],
        )

        assert run_server.main() == 0
        assert os.environ["DNAFORGE_MCP_SESSION_TOKEN"] == "dev-token"
        output = capsys.readouterr().out
        assert "X-DNAForge-Session: dev-token" in output
        assert calls[0][1]["port"] == 8123

    def test_packaged_run_server_rejects_source_only_reload(self, monkeypatch, capsys):
        """Frozen binaries fail clearly instead of asking Uvicorn to re-import."""
        import run_server

        monkeypatch.setattr(run_server, "__compiled__", object(), raising=False)
        monkeypatch.setattr(sys, "argv", ["waypoint-api", "--reload"])

        with pytest.raises(SystemExit) as exc_info:
            run_server.main()

        assert exc_info.value.code == 2
        assert (
            "--reload is available only from the Python source entry point"
            in capsys.readouterr().err
        )

    @pytest.mark.parametrize("reload", [False, True])
    def test_application_import_belongs_to_the_serving_process(
        self, monkeypatch, reload
    ):
        import builtins
        from types import ModuleType

        import run_server

        application = object()
        imported = []
        calls = []
        native_import = builtins.__import__

        def import_module(name, *args, **kwargs):
            if name == "src.main":
                imported.append(name)
                module = ModuleType(name)
                module.app = application
                return module
            return native_import(name, *args, **kwargs)

        uvicorn = ModuleType("uvicorn")
        uvicorn.run = lambda *args, **kwargs: calls.append((args, kwargs))
        watchdog = ModuleType("src.sidecar_owner_watchdog")
        watchdog.start_owner_watchdog = lambda: None
        monkeypatch.setitem(sys.modules, "uvicorn", uvicorn)
        monkeypatch.setitem(sys.modules, "src.sidecar_owner_watchdog", watchdog)
        monkeypatch.setattr(builtins, "__import__", import_module)
        monkeypatch.setattr(
            sys,
            "argv",
            ["run_server.py", "--port", "9014", *(["--reload"] if reload else [])],
        )

        assert run_server.main() == 0
        assert imported == ([] if reload else ["src.main"])
        assert calls == [
            (
                ("src.main:app" if reload else application,),
                {
                    "host": "127.0.0.1",
                    "port": 9014,
                    "log_level": "info",
                    "reload": reload,
                },
            )
        ]

    def test_legacy_build_script_exists(self):
        """Legacy build.py exists (kept for platform detection utilities)."""
        build_script = Path(__file__).parent.parent / "build.py"
        assert build_script.exists(), f"Legacy build script not found at {build_script}"


class TestBuildConfiguration:
    """Tests for build configuration."""

    def test_legacy_build_script_has_required_functions(self):
        """Legacy build.py exports platform detection functions."""
        build_script = Path(__file__).parent.parent / "build.py"

        import importlib.util

        spec = importlib.util.spec_from_file_location("build", build_script)
        build_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build_module)

        assert hasattr(
            build_module, "get_platform_suffix"
        ), "get_platform_suffix() required"

    def test_platform_suffix_format(self):
        """Platform suffix follows expected format."""
        build_script = Path(__file__).parent.parent / "build.py"

        import importlib.util

        spec = importlib.util.spec_from_file_location("build", build_script)
        build_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build_module)

        suffix = build_module.get_platform_suffix()

        parts = suffix.split("-")
        assert len(parts) == 2, f"Expected format 'os-arch', got '{suffix}'"
        assert parts[0] in ["macos", "windows", "linux"], f"Unknown OS: {parts[0]}"
        assert parts[1] in ["arm64", "x64"], f"Unknown arch: {parts[1]}"

    def test_annotation_data_included_in_build(self):
        """Build includes the standalone package's canonical resource files."""
        build_script = Path(__file__).parent.parent / "scripts" / "build-sidecar.sh"
        content = build_script.read_text()
        assert (
            "--include-package-data=dnaforge_annotation" in content
        ), "Build script must include standalone annotation resources"

    def test_genome_extra_policy_omits_the_extra_only_on_windows(self):
        """One decision decides whether a target carries pysam/htslib."""
        from src.runtime_capabilities import genome_extra_enabled_for_target

        assert genome_extra_enabled_for_target("x86_64-pc-windows-msvc") is False
        assert genome_extra_enabled_for_target("win32") is False
        assert genome_extra_enabled_for_target("aarch64-apple-darwin") is True
        assert genome_extra_enabled_for_target("x86_64-apple-darwin") is True
        assert genome_extra_enabled_for_target("x86_64-unknown-linux-gnu") is True
        with pytest.raises(ValueError, match="target is required"):
            genome_extra_enabled_for_target("")

    def test_frozen_genome_probe_proves_presence_or_intentional_absence(self):
        """Every frozen build proves its exact target's runtime policy."""
        build_script = Path(__file__).parent.parent / "scripts" / "build-sidecar.sh"
        content = build_script.read_text()

        assert "genome_extra_enabled_for_target" in content

        probe_lines = [
            line for line in content.splitlines() if "--verify-genome-runtime" in line
        ]
        assert len(probe_lines) == 1, probe_lines

        assert "Frozen BAM/CRAM runtime policy passed" in content
        assert "Skipping frozen BAM/CRAM runtime check" not in content

    def test_mcp_sdk_runtime_is_explicitly_included_in_build(self):
        """The standalone sidecar contains both MCP SDK distributions."""
        build_script = Path(__file__).parent.parent / "scripts" / "build-sidecar.sh"
        content = build_script.read_text()
        assert "--include-package=mcp" in content
        assert "--include-package=mcp_types" in content

    def test_ijson_backends_are_explicitly_included_in_build(self):
        """Dynamic ijson backend imports must survive the frozen build."""
        build_script = Path(__file__).parent.parent / "scripts" / "build-sidecar.sh"
        content = build_script.read_text()
        assert "--include-package=ijson" in content

    def test_primer3_build_includes_runtime_data_without_compiler_sources(self):
        """The frozen sidecar carries Primer3 runtime assets, not its build tree."""
        build_script = Path(__file__).parent.parent / "scripts" / "build-sidecar.sh"
        options = {
            line.strip().removesuffix(" \\")
            for line in build_script.read_text().splitlines()
            if line.strip().startswith("--include-package-data=primer3")
        }

        assert "--include-package-data=primer3" not in options
        assert options == {
            "--include-package-data=primer3:src/libprimer3/primer3_config/*",
            "--include-package-data=primer3:src/libprimer3/humrep_and_simple.txt",
            "--include-package-data=primer3:src/libprimer3/ABOUT.txt",
            "--include-package-data=primer3:src/libprimer3/LICENSE.txt",
            "--include-package-data=primer3:src/libprimer3/gpl-2.0.txt",
        }

    def test_sidecar_dependencies_use_lock_without_pruning_dev_tools(self):
        """Builds consume uv.lock and preserve unrelated tools in the shared venv."""
        build_script = Path(__file__).parent.parent / "scripts" / "build-sidecar.sh"
        content = build_script.read_text()

        assert 'SIDECAR_PYTHON_VERSION="${SIDECAR_PYTHON_VERSION:-3.12}"' in content
        assert (
            'uv python find --managed-python --no-python-downloads "$PYTHON_TARGET"'
            in content
        )
        assert (
            '--python-downloads-json-url "$PYTHON_DOWNLOADS_URL" "$PYTHON_TARGET"'
            in content
        )
        assert (
            'UV_SYNC_ARGS=(--python "$PYTHON_BIN" --locked --inexact --extra sidecar)'
            in content
        )
        assert "UV_SYNC_ARGS+=(--extra genome)" in content
        helper = (build_script.parent / "sync-python-dependencies.sh").read_text()
        assert (
            'bash scripts/sync-python-dependencies.sh "$PYTHON_BIN" '
            '"$(command -v uv)" "${UV_SYNC_ARGS[@]}"' in content
        )
        assert '"$UV_BIN" sync "$@"' in helper
        assert (
            'node "$RUNTIME_SECURITY" check "$ACTIVE_PYTHON_VERSION" '
            '"$SIDECAR_PYTHON_VERSION"' in content
        )
        assert "uv pip install" not in content
        assert "python -m pip install" not in content
        assert "uv pip install" not in helper
        assert "python -m pip install" not in helper
        assert "ERROR: uv is required to build the sidecar" in content

    def test_macos_sidecar_strips_local_symbols_before_receipt_and_runtime_proof(
        self,
    ):
        """The package consumes and proves the optimized, re-signed Mach-O bytes."""
        build_script = Path(__file__).parent.parent / "scripts" / "build-sidecar.sh"
        content = build_script.read_text()

        strip_call = 'strip -x -no_code_signature_warning "$CANDIDATE"'
        copy_call = 'cp -R "$DIST_DIR" "$DESKTOP_BINARIES/$DEST_NAME"'
        receipt_call = 'sidecar-build-receipt.cjs" write'
        runtime_probe = (
            '"$DESKTOP_BINARIES/$DEST_NAME/$BINARY_NAME" --verify-genome-runtime'
        )

        assert 'if [[ "$TARGET_TRIPLE" == *-apple-darwin ]]' in content
        assert strip_call in content
        assert 'codesign --force --sign - "$CANDIDATE"' in content
        assert content.index(strip_call) < content.index(copy_call)
        assert content.index(strip_call) < content.index(receipt_call)
        assert content.index(strip_call) < content.index(runtime_probe)

    def test_windows_freshness_tracks_the_locked_build_inputs(self):
        """A lock or build-script edit invalidates an existing Windows binary."""
        api_dir = Path(__file__).parent.parent
        windows_builder = (
            api_dir.parent / "desktop" / "scripts" / "build-windows-sidecar.cjs"
        ).read_text()

        assert "path.join(apiDir, 'uv.lock')" in windows_builder
        assert "path.join(apiDir, 'src')" in windows_builder
        assert "path.join(apiDir, 'scripts', 'build-sidecar.sh')" in windows_builder


class TestBinaryOutput:
    """Tests for built binary (skipped if binary doesn't exist)."""

    @pytest.fixture
    def binary_path(self):
        """Get path to built binary if it exists."""
        dist_dir = Path(__file__).parent.parent / "dist"
        if not dist_dir.exists():
            pytest.skip("dist/ directory doesn't exist - run build first")

        binaries = list(dist_dir.glob("waypoint-api*"))
        if not binaries:
            pytest.skip("No binary found in dist/ - run build first")

        return binaries[0]

    def test_binary_is_executable(self, binary_path):
        """Built binary is executable."""
        assert os.access(binary_path, os.X_OK), f"Binary not executable: {binary_path}"

    def test_binary_responds_to_help(self, binary_path):
        """Binary responds to --help flag."""
        result = subprocess.run(
            [str(binary_path), "--help"],
            capture_output=True,
            text=True,
            timeout=30,
        )

        assert result.returncode in [
            0,
            1,
            2,
        ], f"Unexpected exit code: {result.returncode}"
