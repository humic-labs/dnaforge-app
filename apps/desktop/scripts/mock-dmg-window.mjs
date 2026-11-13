import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const layout = require('./lib/dmg-window-layout.cjs');

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const volumeName = 'DNAForge Mock';
const outDir = path.join(os.tmpdir(), 'dnaforge-dmg-mock');
const dmgPath = path.join(outDir, 'DNAForge-mock.dmg');

function findDmgbuild() {
  if (process.env.DMGBUILD && existsSync(process.env.DMGBUILD)) return process.env.DMGBUILD;
  const root = path.join(os.homedir(), 'Library/Caches/electron-builder/dmg-builder@1.2.0');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  if (!existsSync(root)) {
    throw new Error(`dmgbuild cache is missing at ${root}. Set DMGBUILD to the electron-builder dmgbuild binary.`);
  }
  const bundle = readdirSync(root).find((name) => name.startsWith(`dmgbuild-bundle-${arch}-`));
  if (!bundle) throw new Error(`no ${arch} dmgbuild bundle under ${root}`);
  return path.join(root, bundle, 'dmgbuild');
}

function writeStubApp(stage) {
  const appPath = path.join(stage, 'DNAForge.app');
  const contents = path.join(appPath, 'Contents');
  mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  copyFileSync(
    path.join(desktopRoot, 'resources', 'icon.icns'),
    path.join(contents, 'Resources', 'icon.icns')
  );
  writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>DNAForge</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>com.dnaforge.desktop.mock-dmg</string>
  <key>CFBundleName</key><string>DNAForge</string>
  <key>CFBundleDisplayName</key><string>DNAForge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
`
  );
  const executable = path.join(contents, 'MacOS', 'DNAForge');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  return appPath;
}

function detachQuietly() {
  const mount = path.join('/Volumes', volumeName);
  if (!existsSync(mount)) return;
  try {
    execFileSync('hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' });
  } catch {
  }
}

function settingsFor(appPath) {
  const { windowSize, iconSize, iconTextSize, app, applications } = layout;
  return {
    title: volumeName,
    'icon-size': iconSize,
    'text-size': iconTextSize,
    format: 'UDZO',
    filesystem: 'HFS+',
    'compression-level': 1,
    background: path.join(desktopRoot, 'resources', layout.backgroundFile),
    icon: path.join(desktopRoot, 'resources', 'icon.icns'),
    window: {
      position: { x: 400, y: Math.round((1440 - windowSize.height) / 2) },
      size: { width: windowSize.width, height: windowSize.height },
    },
    contents: [
      { x: app.x, y: app.y, type: 'file', path: appPath, name: 'DNAForge.app' },
      { x: applications.x, y: applications.y, type: 'link', path: '/Applications', name: 'Applications' },
    ],
  };
}

function revealInstallerWindow() {
  execFileSync('osascript', [
    '-e',
    'tell application "Finder"',
    '-e',
    `if exists window "${volumeName}" then close window "${volumeName}"`,
    '-e',
    'end tell',
  ]);
  execFileSync('open', [dmgPath]);
  execFileSync('osascript', [
    '-e',
    'delay 0.7',
    '-e',
    'tell application "Finder"',
    '-e',
    `set w to window "${volumeName}"`,
    '-e',
    'set toolbar visible of w to false',
    '-e',
    'set statusbar visible of w to false',
    '-e',
    'set pathbar visible of w to false',
    '-e',
    'set index of w to 1',
    '-e',
    'activate',
    '-e',
    'end tell',
  ]);
}

function screenshot(file) {
  revealInstallerWindow();
  const bounds = execFileSync(
    'osascript',
    ['-e', `tell application "Finder" to get bounds of window "${volumeName}"`],
    { encoding: 'utf8' }
  )
    .trim()
    .split(',')
    .map((part) => Number(part.trim()));
  const [x, y, right, bottom] = bounds;
  execFileSync('screencapture', ['-R', `${x},${y},${right - x},${bottom - y}`, '-o', file]);
  return { x, y, width: right - x, height: bottom - y, file };
}

function main() {
  const wantShot = process.argv.includes('--screenshot');
  detachQuietly();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const stage = path.join(outDir, 'stage');
  mkdirSync(stage, { recursive: true });
  const appPath = writeStubApp(stage);
  const settingsPath = path.join(outDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settingsFor(appPath), null, 2));
  execFileSync(findDmgbuild(), ['-s', settingsPath, volumeName, dmgPath], { stdio: 'inherit' });
  process.stdout.write(`${dmgPath}\n`);
  if (!wantShot) return;
  execFileSync('hdiutil', ['attach', dmgPath, '-nobrowse'], { stdio: 'inherit' });
  const shot = screenshot(path.join(outDir, 'finder.png'));
  process.stdout.write(`${shot.file} ${shot.width}x${shot.height}\n`);
}

main();
