#!/usr/bin/env node

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const archIdx = args.indexOf('--arch');
const archArg = archIdx !== -1 ? args[archIdx + 1] : null;

const hwArch = (() => {
  try {
    const result = spawnSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' });
    return result.stdout.trim() === '1' ? 'arm64' : 'x64';
  } catch {
    return process.arch === 'arm64' ? 'arm64' : 'x64';
  }
})();

const targetArch = archArg || hwArch;
const builderDirSuffix = targetArch === 'arm64' ? '-arm64' : '';

const DIST = path.join(__dirname, '..', 'dist-electron');
const APP_DIR = path.join(DIST, `mac${builderDirSuffix}`, 'DNAForge.app', 'Contents', 'Resources');
const ASAR = path.join(APP_DIR, 'app.asar');
const MONOREPO_ROOT = path.join(__dirname, '..', '..', '..');
const BASELINE_FILE = path.join(__dirname, 'asar-packages-baseline.json');

if (!fs.existsSync(ASAR)) {
  console.error(`[update-baseline] FATAL: app.asar not found at ${ASAR}`);
  console.error('  Run `npm run package` first.');
  process.exit(1);
}

const asarBin = fs.existsSync(path.join(MONOREPO_ROOT, 'node_modules/.bin/asar'))
  ? path.join(MONOREPO_ROOT, 'node_modules/.bin/asar')
  : 'asar';

const asarList = execFileSync(asarBin, ['list', ASAR], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

const packageJsonRe = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/;
const packages = [];
for (const line of asarList.split('\n')) {
  const m = line.trim().match(packageJsonRe);
  if (m) packages.push(m[1]);
}
packages.sort();

let oldCount = 0;
if (fs.existsSync(BASELINE_FILE)) {
  try {
    const old = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    oldCount = old.count;
  } catch {}
}

const data = { count: packages.length, packages };
fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2) + '\n');

console.log(`\n[update-baseline] ✅ Baseline updated (arch: ${targetArch})`);
console.log(`  ${oldCount} → ${packages.length} packages`);
if (packages.length < oldCount) {
  console.warn(
    `  ⚠️  Package count DECREASED by ${oldCount - packages.length} — verify this is intentional.`
  );
}
console.log(
  `\n  Next: git add scripts/asar-packages-baseline.json && git commit -m "chore: update asar baseline"\n`
);
