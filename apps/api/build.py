#!/usr/bin/env python3
"""
PyInstaller build script for Waypoint API sidecar.

Creates a standalone binary that can be bundled with the Electron desktop app.
Supports cross-platform builds for macOS (Intel/ARM), Windows, and Linux.

Usage:
    python build.py           # Build for current platform
    python build.py --clean   # Clean and rebuild
"""

import platform
import shutil
import subprocess
import sys
from pathlib import Path


def get_platform_suffix() -> str:
    """Get platform suffix for binary naming (e.g., 'macos-arm64')."""
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "darwin":
        os_name = "macos"
    elif system == "windows":
        os_name = "windows"
    else:
        os_name = "linux"

    if machine in ("arm64", "aarch64"):
        arch = "arm64"
    elif machine in ("x86_64", "amd64"):
        arch = "x64"
    else:
        arch = "x64"

    return f"{os_name}-{arch}"


def clean_build_dirs():
    """Clean build and dist directories."""
    root = Path(__file__).parent
    for dir_name in ["build", "dist"]:
        dir_path = root / dir_name
        if dir_path.exists():
            print(f"Cleaning {dir_path}")
            shutil.rmtree(dir_path)


def build(clean: bool = False) -> Path:
    """
    Build the API sidecar binary.

    Args:
        clean: If True, clean build directories before building

    Returns:
        Path to the built binary
    """
    root = Path(__file__).parent

    if clean:
        clean_build_dirs()

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("Installing PyInstaller...")
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "pyinstaller"],
            check=True,
        )

    spec_file = root / "waypoint-api.spec"
    print(f"Building with spec file: {spec_file}")

    result = subprocess.run(
        [sys.executable, "-m", "PyInstaller", str(spec_file), "--noconfirm"],
        cwd=str(root),
    )

    if result.returncode != 0:
        raise RuntimeError(f"PyInstaller failed with code {result.returncode}")

    dist_dir = root / "dist"
    suffix = get_platform_suffix()

    if platform.system() == "Windows":
        binary_name = "waypoint-api.exe"
        target_name = f"waypoint-api-{suffix}.exe"
    else:
        binary_name = "waypoint-api"
        target_name = f"waypoint-api-{suffix}"

    binary_path = dist_dir / binary_name
    target_path = dist_dir / target_name

    if binary_path.exists() and binary_path != target_path:
        print(f"Renaming {binary_name} -> {target_name}")
        binary_path.rename(target_path)
        binary_path = target_path

    print(f"Build complete: {binary_path}")
    return binary_path


def copy_to_electron(binary_path: Path) -> Path:
    """
    Copy binary to Electron binaries directory.

    Args:
        binary_path: Path to built binary

    Returns:
        Path to copied binary in Electron resources directory
    """
    root = Path(__file__).parent
    electron_binaries = root.parent / "desktop" / "resources" / "binaries"
    electron_binaries.mkdir(parents=True, exist_ok=True)

    target = electron_binaries / binary_path.name
    print(f"Copying to Electron: {target}")
    shutil.copy2(binary_path, target)

    return target


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Build Waypoint API sidecar")
    parser.add_argument("--clean", action="store_true", help="Clean before building")
    parser.add_argument(
        "--copy-to-electron", action="store_true", help="Copy to Electron binaries"
    )
    args = parser.parse_args()

    binary = build(clean=args.clean)

    if args.copy_to_electron:
        copy_to_electron(binary)
