
from src.external_mcp import AppOwnedMcpClient, installed_app_command


def test_mcp_launch_uses_nonactivating_macos_open(tmp_path, monkeypatch):
    contents = tmp_path / "DNAForge.app" / "Contents"
    executable = contents / "Resources" / "binaries" / "waypoint-api"
    app = contents / "MacOS" / "DNAForge"
    executable.parent.mkdir(parents=True)
    app.parent.mkdir(parents=True)
    executable.touch()
    app.touch()
    launched = []
    monkeypatch.setattr(
        "src.external_mcp.installed_app_command",
        lambda binary: installed_app_command(binary, platform_name="darwin"),
    )
    monkeypatch.setattr(
        "src.external_mcp.subprocess.Popen",
        lambda command, **kwargs: launched.append(command),
    )
    AppOwnedMcpClient(
        packaged_executable=executable, requested_workspace=None
    )._launch_installed_app()
    assert launched == [
        [
            "/usr/bin/open",
            "-g",
            "-a",
            str(contents.parent),
            "--args",
            "--launched-by=mcp",
        ]
    ]
