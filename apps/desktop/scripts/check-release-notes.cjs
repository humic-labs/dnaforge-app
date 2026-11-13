#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

function compareStable(left, right) {
  const a = STABLE.exec(left).slice(1).map(Number);
  const b = STABLE.exec(right).slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function checkReleaseNotes(
  version,
  { RELEASE_NOTES, VERSION_HISTORY },
  { releaseBuild = false } = {}
) {
  const errors = [];
  if (!version || typeof version !== 'string') {
    return {
      skipped: null,
      errors: ['apps/desktop/package.json does not define a string version.'],
    };
  }

  const keys = Object.keys(RELEASE_NOTES);
  if (
    VERSION_HISTORY.length !== keys.length ||
    new Set(VERSION_HISTORY).size !== keys.length ||
    keys.some((key) => !VERSION_HISTORY.includes(key))
  ) {
    errors.push('VERSION_HISTORY must include every release note exactly once.');
  }

  if (/^\d+\.\d+\.\d+-nightly\.\d+$/.test(version)) {
    return { skipped: `nightly prerelease ${version}`, errors };
  }
  const firstVersion = VERSION_HISTORY[0];
  if (
    !releaseBuild &&
    STABLE.test(version) &&
    firstVersion &&
    STABLE.test(firstVersion) &&
    compareStable(version, firstVersion) < 0
  ) {
    return {
      skipped: `unstamped development version ${version} (newest listed release ${firstVersion})`,
      errors,
    };
  }

  if (!RELEASE_NOTES[version]) errors.push(`Missing release notes for ${version}.`);
  if (firstVersion !== version) {
    errors.push(
      `Release version must be first. Expected ${version}, got ${firstVersion ?? 'none'}.`
    );
  }
  return { skipped: null, errors };
}

module.exports = { checkReleaseNotes };

async function main() {
  const desktopRoot = path.resolve(__dirname, '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  const registry = await import(
    pathToFileURL(path.join(desktopRoot, 'src/lib/release-notes.ts')).href
  );
  const { skipped, errors } = checkReleaseNotes(version, registry, {
    releaseBuild: process.env.DNAFORGE_RELEASE_BUILD === '1',
  });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    `[check-release-notes] ${Object.keys(registry.RELEASE_NOTES).length} releases are reachable; latest notes ${registry.VERSION_HISTORY[0]}.` +
      (skipped ? ` Skipped version coverage for ${skipped}.` : '')
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[check-release-notes]', error.message);
    process.exitCode = 1;
  });
}
