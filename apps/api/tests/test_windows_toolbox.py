"""Windows toolbox regression tests .

These pin the platform suffix / os.name explicitly so they run DETERMINISTICALLY
on every CI host (macOS/Linux included) — they are the regression net for the
Windows bugs that, by definition, don't reproduce on the dev Mac:

1. TOOL_REGISTRY had no Windows entries → empty toolbox.
2. cmscan and cmpress (Infernal) are built natively for Windows  and
   must stay required for annotation parity.
3. get_binary_path / validate_tools didn't know Windows executables carry a
   .exe/.bat suffix.
4. PATH was joined with a hardcoded ":" instead of os.pathsep.
5. annotate()'s per-database loop crashed the whole run when a tool was absent.

Sibling proof: the real end-to-end run (real win64 BLAST+/Diamond + real
databases → pUC19 features) is exercised by test_plannotate.py's integration
tests when run ON Windows; this file guarantees the platform-aware LOGIC can't
regress regardless of the CI OS.
"""

import json
from pathlib import Path

from src.toolbox import executable_paths

WIN = "x86_64-pc-windows-msvc"
MAC = "aarch64-apple-darwin"


class TestWindowsRegistry:
    def test_bundled_tools_declare_windows_builds(self):
        from src.annotation.tools import TOOL_REGISTRY

        for tool in ("blast", "diamond", "infernal", "mafft"):
            assert (
                WIN in TOOL_REGISTRY[tool]["platforms"]
            ), f"{tool} is missing an {WIN} build"

    def test_infernal_declares_native_windows_cmscan(self):
        from src.annotation.tools import TOOL_REGISTRY

        infernal = TOOL_REGISTRY["infernal"]["platforms"][WIN]
        assert infernal["url"].endswith("infernal-1.1.5.tar.gz")
        assert infernal["sha256"] == (
            "ad4ddae02f924ca7c85bc8c4a79c9f875af8df96aeb726702fa985cbe752497f"
        )
        assert infernal["binaries"]["cmscan"].endswith("cmscan.exe")
        assert infernal["binaries"]["cmpress"].endswith("cmpress.exe")

    def test_windows_binaries_use_exe_and_bat(self):
        from src.annotation.tools import TOOL_REGISTRY

        blast = TOOL_REGISTRY["blast"]["platforms"][WIN]["binaries"]
        assert blast["blastn"].endswith("blastn.exe")
        assert blast["makeblastdb"].endswith("makeblastdb.exe")
        assert TOOL_REGISTRY["diamond"]["platforms"][WIN]["binaries"][
            "diamond"
        ].endswith("diamond.exe")
        assert TOOL_REGISTRY["mafft"]["platforms"][WIN]["binaries"]["mafft"].endswith(
            "mafft.bat"
        )
        assert TOOL_REGISTRY["infernal"]["platforms"][WIN]["binaries"][
            "cmscan"
        ].endswith("cmscan.exe")
        assert TOOL_REGISTRY["infernal"]["platforms"][WIN]["binaries"][
            "cmpress"
        ].endswith("cmpress.exe")

    def test_windows_registry_matches_packaging_script(self):
        """The lock is the SSOT for both runtime and Windows packaging."""
        from src.annotation.tools import TOOL_REGISTRY

        repo_root = Path(__file__).resolve().parents[3]
        lock = json.loads(
            (repo_root / ".ci" / "release-assets.lock.json").read_text(encoding="utf-8")
        )
        ps1 = (
            repo_root
            / "apps"
            / "desktop"
            / "scripts"
            / "prepare-windows-bioinformatics-tools.ps1"
        )
        text = ps1.read_text(encoding="utf-8")

        assert "release-assets.lock.json" in text
        assert "Get-LockedWindowsTool" in text
        assert "mafft.cbrc.jp" not in text

        for tool in ("blast", "diamond", "infernal", "mafft"):
            reg = TOOL_REGISTRY[tool]["platforms"][WIN]
            locked = lock["tools"][tool]["platforms"][WIN]
            assert reg["url"] == f"{lock['publicBaseUrl']}/{locked['key']}"
            assert reg["sha256"] == locked["sha256"]


class TestBundleResolver:
    """Cross-platform bundling parity  follow-up).

    These are the durable "both OSs have the right things" gate: the 
    root cause was a tool bundled for one OS but absent from the registry for
    another. This class makes that class of drift a CI failure.
    """

    def test_every_tool_ships_on_every_platform_or_is_documented(self):
        from src.annotation.tools import (
            PLATFORM_TOOL_EXCEPTIONS,
            SUPPORTED_PLATFORMS,
            TOOL_REGISTRY,
        )

        for suffix in SUPPORTED_PLATFORMS:
            exceptions = PLATFORM_TOOL_EXCEPTIONS.get(suffix, frozenset())
            for tool, entry in TOOL_REGISTRY.items():
                if tool in exceptions:
                    continue
                assert suffix in entry["platforms"], (
                    f"'{tool}' has no {suffix} build. Add one to TOOL_REGISTRY, "
                    f"OR declare it in PLATFORM_TOOL_EXCEPTIONS with a reason. "
                    f" class of bug: bundled for one OS, forgotten on "
                    f"another.)"
                )

    def test_declared_exceptions_are_real_not_stale(self):
        from src.annotation.tools import PLATFORM_TOOL_EXCEPTIONS, TOOL_REGISTRY

        for suffix, tools in PLATFORM_TOOL_EXCEPTIONS.items():
            for tool in tools:
                assert (
                    suffix not in TOOL_REGISTRY[tool]["platforms"]
                ), f"'{tool}' HAS a {suffix} build — remove the stale exception"

    def test_bundle_manifest_windows(self):
        from src.annotation.tools import get_bundle_manifest

        manifest = get_bundle_manifest(WIN)
        assert manifest["blast"]["available"] is True
        assert manifest["diamond"]["available"] is True
        assert manifest["infernal"]["available"] is True
        assert manifest["mafft"]["available"] is True
        assert manifest["blast"]["url"].endswith("x64-win64.tar.gz")
        assert manifest["blast"]["binaries"]["blastn"].endswith("blastn.exe")
        assert manifest["infernal"]["binaries"]["cmscan"].endswith("cmscan.exe")
        assert manifest["infernal"]["binaries"]["cmpress"].endswith("cmpress.exe")

    def test_bundle_manifest_macos_is_complete(self):
        from src.annotation.tools import TOOL_REGISTRY, get_bundle_manifest

        manifest = get_bundle_manifest(MAC)
        for tool in TOOL_REGISTRY:
            assert manifest[tool][
                "available"
            ], f"{tool} should be available on macOS arm64"

    def test_tools_expected_for_platform_includes_windows_infernal(self):
        from src.annotation.tools import tools_expected_for_platform

        assert "infernal" in tools_expected_for_platform(WIN)
        assert "infernal" in tools_expected_for_platform(MAC)
        assert "blast" in tools_expected_for_platform(WIN)

    def test_verify_package_expected_binaries_match_registry(self):
        """verify-package.cjs (the Node CI package gate) keeps its OWN per-OS
        bundled-tool list. Bind it to the registry so the two can't drift — the
        exact class of cross-OS mismatch behind ."""
        import re

        from src.annotation.tools import get_platform_binary_names

        cjs = (
            Path(__file__).resolve().parents[2]
            / "desktop"
            / "scripts"
            / "verify-package.cjs"
        )
        text = cjs.read_text(encoding="utf-8")

        m = re.search(
            r"const EXPECTED_BINARIES\s*=\s*targetPlatform === 'win32'\s*\?\s*"
            r"\[([^\]]*)\]\s*:\s*\[([^\]]*)\]",
            text,
            flags=re.DOTALL,
        )
        assert m is not None, (
            "Could not locate EXPECTED_BINARIES in verify-package.cjs — its shape "
            "changed; re-verify the registry parity by hand and update this test."
        )
        win_list = set(re.findall(r"'([^']+)'", m.group(1)))
        posix_list = set(re.findall(r"'([^']+)'", m.group(2)))

        expected_win = set(
            get_platform_binary_names(required_by="plannotate", suffix=WIN)
        ) | {"mafft"}
        expected_posix = set(
            get_platform_binary_names(required_by="plannotate", suffix=MAC)
        ) | {"mafft"}

        assert (
            win_list == expected_win
        ), f"verify-package.cjs win32 tools {win_list} != registry {expected_win}"
        assert (
            posix_list == expected_posix
        ), f"verify-package.cjs posix tools {posix_list} != registry {expected_posix}"


class TestPlatformAwareBinaryNames:
    def test_windows_includes_cmscan(self):
        from src.annotation.tools import get_platform_binary_names

        names = get_platform_binary_names(required_by="plannotate", suffix=WIN)
        assert set(names) == {
            "blastn",
            "makeblastdb",
            "diamond",
            "cmscan",
            "cmpress",
        }

    def test_macos_includes_cmscan(self):
        from src.annotation.tools import get_platform_binary_names

        names = get_platform_binary_names(required_by="plannotate", suffix=MAC)
        assert "cmscan" in names
        assert "blastn" in names and "diamond" in names

    def test_versions_are_platform_filtered(self):
        from src.annotation.tools import get_platform_binary_versions

        win = get_platform_binary_versions(required_by="plannotate", suffix=WIN)
        assert win["cmscan"] == "1.1.5"
        assert win["blastn"] == "2.16.0"


class TestExecutableVariants:
    def test_windows_probes_exe_bat_then_bare(self, monkeypatch):
        import src.services.plannotate as pm

        monkeypatch.setattr(executable_paths.platform, "system", lambda: "Windows")
        variants = [str(p) for p in pm.executable_variants(Path("d") / "blastn")]
        assert variants[0].endswith("blastn.exe")
        assert any(v.endswith("blastn.bat") for v in variants)
        assert variants[-1].endswith("blastn")

    def test_posix_uses_bare_name_only(self, monkeypatch):
        import src.services.plannotate as pm

        monkeypatch.setattr(executable_paths.platform, "system", lambda: "Darwin")
        variants = pm.executable_variants(Path("d") / "blastn")
        assert len(variants) == 1
        assert str(variants[0]).endswith("blastn")

    def test_get_binary_path_finds_exe_on_windows(self, tmp_path, monkeypatch):
        import src.services.plannotate as pm

        monkeypatch.setattr(executable_paths.platform, "system", lambda: "Windows")
        monkeypatch.setattr(executable_paths, "_platform_suffix_cache", None)
        monkeypatch.setattr(pm, "get_platform_suffix", lambda: WIN)

        exe = tmp_path / "blastn.exe"
        exe.write_bytes(b"MZ" + b"\x00" * 128)

        assert pm.get_binary_path("blastn", tmp_path) == str(exe)
        assert pm.get_binary_path("makeblastdb", tmp_path) is None


class TestCheckRequiredBinariesWindows:
    def test_includes_cmscan_on_windows(self, monkeypatch):
        import src.services.plannotate as pm

        monkeypatch.setattr(executable_paths, "_platform_suffix_cache", None)
        monkeypatch.setattr(executable_paths, "get_platform_suffix", lambda: WIN)

        result = pm.check_required_binaries(None)
        assert set(result.keys()) == {
            "blastn",
            "makeblastdb",
            "diamond",
            "cmscan",
            "cmpress",
        }

    def test_includes_cmscan_on_macos(self, monkeypatch):
        import src.services.plannotate as pm

        monkeypatch.setattr(executable_paths, "_platform_suffix_cache", None)
        monkeypatch.setattr(executable_paths, "get_platform_suffix", lambda: MAC)

        result = pm.check_required_binaries(None)
        assert "cmscan" in result


class TestPathSeparator:
    def test_env_path_uses_os_pathsep_not_hardcoded_colon(self):
        import os

        from src.services.plannotate import PlannotateService

        svc = PlannotateService()
        svc._binaries_dir = Path("C:/Users/x/binaries")
        env = svc._get_env_with_binaries()
        assert env["PATH"].startswith(f"{svc._binaries_dir}{os.pathsep}")
        if os.pathsep == ";":
            assert not env["PATH"].startswith(f"{svc._binaries_dir}:")

    def test_env_preserves_windows_path_key_casing(self, monkeypatch):
        import os

        from src.services.plannotate import PlannotateService

        monkeypatch.delenv("PATH", raising=False)
        monkeypatch.setenv("Path", "C:/Windows/System32")

        svc = PlannotateService()
        svc._binaries_dir = Path("C:/Users/x/binaries")
        env = svc._get_env_with_binaries()

        assert "Path" in env
        assert "PATH" not in env
        assert env["Path"] == (f"{svc._binaries_dir}{os.pathsep}C:/Windows/System32")


class TestAnnotateDegradesWhenToolMissing:
    def test_get_raw_hits_skips_database_whose_tool_is_absent(self, monkeypatch):
        """A missing CLI for ONE database (e.g. cmscan on Windows) must skip just
        that database, not crash the whole annotation. Removing the try/except in
        get_raw_hits turns this green→red."""
        import importlib

        import pandas as pd

        ann = importlib.import_module("src.annotation.annotate")

        fake_dbs = {
            "snapgene": {"method": "blastn", "priority": 1},
            "Rfam": {"method": "infernal", "priority": 2},
        }
        monkeypatch.setattr(ann, "get_yaml", lambda loc: fake_dbs)

        def fake_blast(seq, db, env=None, drop_rfam=False):
            if db.get("method") == "infernal":
                raise FileNotFoundError("[WinError 2] cmscan not found")
            return pd.DataFrame(columns=["sseqid"])

        monkeypatch.setattr(ann, "BLAST", fake_blast)

        result = ann.get_raw_hits("ACGT", linear=True, yaml_file_loc="ignored")
        assert result.empty


class TestSidecarStartupNumpyDeferred:
    """ keystone regression: the Nuitka Windows sidecar segfaulted because
    numpy/pandas/BioPython were loaded during the asyncio lifespan STARTUP (via
    PlannotateService being instantiated at import, whose _check_plannotate
    imported the annotate engine). Startup must stay numpy-free; the heavy stack
    loads on the first real annotation instead. Checked in a FRESH interpreter so
    other tests' numpy imports don't pollute sys.modules."""

    def test_startup_imports_do_not_load_numpy(self):
        import subprocess
        import sys

        code = (
            "import src.services\n"
            "import src.toolbox.annotation, src.toolbox.builtins\n"
            "import src.annotation.setup, src.annotation.tools\n"
            "import src.main\n"
            "import sys\n"
            "loaded = [m for m in ('numpy', 'pandas') if m in sys.modules]\n"
            "assert not loaded, 'startup eagerly imported: ' + ','.join(loaded)\n"
            "print('startup-numpy-free-OK')\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        assert result.returncode == 0, (
            "sidecar startup path eagerly imported numpy/pandas (would reload the "
            "Nuitka lifespan segfault on Windows):\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert "startup-numpy-free-OK" in result.stdout

    def test_startup_without_pysam_keeps_health_alive_and_tiles_explicit(self):
        """A Windows-style runtime without the optional genome extra must boot.

        The tile surface remains registered so callers get a defined 503 instead
        of a startup crash or a misleading 404. Run this in a fresh interpreter:
        the development environment intentionally has pysam installed.
        """
        import subprocess
        import sys

        code = r"""
import importlib.abc
import os
import sys

class BlockPysam(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "pysam" or fullname.startswith("pysam."):
            raise ModuleNotFoundError("No module named 'pysam'", name="pysam")
        return None

sys.meta_path.insert(0, BlockPysam())

import os

from fastapi.testclient import TestClient
from src.main import app

assert "pysam" not in sys.modules
assert "numpy" not in sys.modules
os.environ["DNAFORGE_MCP_SESSION_TOKEN"] = "windows-startup-boundary-test"
client = TestClient(app, headers={"X-DNAForge-Session": "windows-startup-boundary-test"})
health = client.get("/health")
assert health.status_code == 200, health.text
requests = [
    (
        "/tiles/alignment/header",
        {"bamPath": "C:/not-present/example.bam"},
    ),
    (
        "/tiles/coverage/readiness",
        {"bamPath": "C:/not-present/example.bam", "chroms": ["chr1"]},
    ),
    (
        "/tiles/annotation/pyramid/readiness",
        {
            "sources": [
                {
                    "gffPath": "C:/not-present/example.gff3.gz",
                    "chrom": "chr1",
                    "chromLength": 1,
                }
            ]
        },
    ),
]
for path, body in requests:
    tile = client.post(path, json=body)
    assert tile.status_code == 503, (path, tile.text)
    assert tile.json()["detail"] == (
        "Genome tiles are unavailable in this build because the optional "
        "pysam/htslib dependency is not installed."
    )
print("startup-without-pysam-OK")
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        assert result.returncode == 0, (
            "sidecar failed its optional-genome dependency boundary:\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert "startup-without-pysam-OK" in result.stdout

    def test_annotate_still_importable_on_demand(self):
        from src.annotation.annotate import annotate

        assert callable(annotate)
