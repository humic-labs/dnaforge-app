"""Regression coverage for fail-closed sidecar architecture labeling."""

import importlib.util
from pathlib import Path

import pytest

MODULE_PATH = (
    Path(__file__).parent.parent / "scripts" / "verify_sidecar_architecture.py"
)


def load_module():
    spec = importlib.util.spec_from_file_location(
        "verify_sidecar_architecture", MODULE_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_arm64_target_rejects_x86_runtime_before_compilation():
    architecture = load_module()

    with pytest.raises(ValueError, match="aarch64-apple-darwin.*x86_64"):
        architecture.validate_runtime_architecture("aarch64-apple-darwin", "x86_64")


@pytest.mark.parametrize("runtime_machine", ["arm64", "aarch64"])
def test_arm64_target_accepts_native_arm_runtime(runtime_machine):
    architecture = load_module()

    assert (
        architecture.validate_runtime_architecture(
            "aarch64-apple-darwin", runtime_machine
        )
        == "arm64"
    )


def test_arm64_target_rejects_mislabeled_x86_binary():
    architecture = load_module()

    with pytest.raises(ValueError, match="aarch64-apple-darwin.*x86_64"):
        architecture.validate_binary_architecture_output(
            "aarch64-apple-darwin",
            "waypoint-api: Mach-O 64-bit executable x86_64",
        )


def test_arm64_target_accepts_arm64_slice_in_universal_binary():
    architecture = load_module()

    assert architecture.validate_binary_architecture_output(
        "aarch64-apple-darwin",
        (
            "waypoint-api: Mach-O universal binary with 2 architectures: "
            "[x86_64:Mach-O 64-bit executable x86_64] "
            "[arm64:Mach-O 64-bit executable arm64]"
        ),
    ) == {"arm64", "x86_64"}


def test_windows_x64_target_accepts_file_hyphenated_architecture():
    architecture = load_module()

    assert architecture.validate_binary_architecture_output(
        "x86_64-pc-windows-msvc",
        "waypoint-api.exe: PE32+ executable (console) x86-64, for MS Windows",
    ) == {"x86_64"}
