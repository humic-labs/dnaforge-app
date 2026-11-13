const fs = require('node:fs');
const path = require('node:path');

const targets = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'win32:x64': 'x86_64-pc-windows-msvc',
  'linux:x64': 'x86_64-unknown-linux-gnu',
};

function stageDesktopCli({ resourcesDir, platform, arch }) {
  const target = targets[`${platform}:${arch}`];
  if (!target) throw new Error(`Unsupported desktop CLI target: ${platform}:${arch}`);
  const windows = platform === 'win32';
  const executable = `waypoint-api${windows ? '.exe' : ''}`;
  const relativeBinary = `../binaries/waypoint-api-${target}/${executable}`;
  const binary = path.resolve(resourcesDir, 'cli', relativeBinary);
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) {
    throw new Error(`The desktop CLI executable is missing: ${binary}`);
  }
  const directory = path.join(resourcesDir, 'cli');
  fs.mkdirSync(directory, { recursive: true });
  const launcher = path.join(directory, windows ? 'dnaforge.cmd' : 'dnaforge');
  const content = windows
    ? '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' +
      'set "DNAFORGE_CLI_LAUNCHER=%~f0"\r\n' +
      `"%~dp0${relativeBinary.replaceAll('/', '\\')}" --cli %*\r\n` +
      'set "_DNAFORGE_CLI_STATUS=%errorlevel%"\r\n' +
      'if /i not "%~1"=="uninstall-cli" exit /b %_DNAFORGE_CLI_STATUS%\r\n' +
      'if not "%_DNAFORGE_CLI_STATUS%"=="75" exit /b %_DNAFORGE_CLI_STATUS%\r\n' +
      'rem DNAFORGE_WINDOWS_SELF_REMOVE\r\n' +
      '(\r\n' +
      '  endlocal\r\n' +
      '  del /f /q "%~f0"\r\n' +
      '  if exist "%~f0" exit /b 1\r\n' +
      '  exit /b 0\r\n' +
      ')\r\n'
    : `#!/bin/sh
set -eu
launcher="$0"
case "$launcher" in /*) ;; *) launcher="$PWD/$launcher" ;; esac
links=0
while [ -L "$launcher" ]; do
  links=$((links + 1))
  if [ "$links" -gt 32 ]; then
    printf '%s\\n' 'DNAForge command has too many symbolic links.' >&2
    exit 1
  fi
  directory=$(CDPATH= cd -P "$(dirname "$launcher")" && pwd)
  launcher=$(readlink "$launcher")
  case "$launcher" in /*) ;; *) launcher="$directory/$launcher" ;; esac
done
directory=$(CDPATH= cd -P "$(dirname "$launcher")" && pwd)
exec "$directory/${relativeBinary}" --cli "$@"
`;
  fs.writeFileSync(launcher, content, { mode: 0o755 });
  return launcher;
}

module.exports = { stageDesktopCli };
