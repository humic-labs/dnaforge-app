const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_RELATIVE_PATH = path.join('third-party', 'manifest.json');
const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md';
const CHROMIUM_LICENSES_FILE = 'LICENSES.chromium.html';
const NOTICES_HEADING = '# Third-party notices for DNAForge ';
const WINDOWS_GIT_BUNDLE_HEADING = '## Packages in the Windows Git bundle (';

function shipPatternMatches(pattern, relativePath) {
  const expression = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')}$`
  );
  return expression.test(relativePath);
}

function uncoveredShippedEntries(manifest, entries) {
  const patterns = manifest.components.flatMap((component) => component.ships);
  return entries.filter((entry) => !patterns.some((pattern) => shipPatternMatches(pattern, entry)));
}

function readThirdPartyManifest(desktopRoot) {
  return JSON.parse(fs.readFileSync(path.join(desktopRoot, MANIFEST_RELATIVE_PATH), 'utf8'));
}

function topLevelEntries(directory, prefix) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .map((name) => `${prefix}/${name}`);
}

function shippedEntries({ resourcesDir, helpersDir }) {
  return [
    ...topLevelEntries(path.join(resourcesDir, 'binaries'), 'binaries'),
    ...topLevelEntries(helpersDir, 'Helpers'),
  ];
}

function noticesProblems({ resourcesDir, appVersion, windowsGitBundle = false }) {
  const problems = [];
  const noticesPath = path.join(resourcesDir, NOTICES_FILE);
  if (!fs.existsSync(noticesPath)) {
    problems.push(`${NOTICES_FILE} is missing from Resources`);
  } else {
    const notices = fs.readFileSync(noticesPath, 'utf8');
    const expectedHeading = `${NOTICES_HEADING}${appVersion ?? ''}`;
    if (!notices.startsWith(appVersion ? `${expectedHeading}\n` : NOTICES_HEADING)) {
      problems.push(`${NOTICES_FILE} does not start with "${expectedHeading}"`);
    }
    for (const section of [
      '## Source code for copyleft components',
      '## npm packages (',
      '## Python packages in the DNAForge sidecar (',
      '## Rust crates in DNAForge helpers (',
      WINDOWS_GIT_BUNDLE_HEADING,
      '## License texts',
    ]) {
      if (!notices.includes(section)) problems.push(`${NOTICES_FILE} lacks "${section}"`);
    }
    if (
      windowsGitBundle &&
      notices.includes(`${WINDOWS_GIT_BUNDLE_HEADING}not part of this build)`)
    ) {
      problems.push(`${NOTICES_FILE} does not list the packages of the bundled Windows Git`);
    }
  }
  if (!fs.existsSync(path.join(resourcesDir, CHROMIUM_LICENSES_FILE))) {
    problems.push(`${CHROMIUM_LICENSES_FILE} is missing from Resources`);
  }
  return problems;
}

module.exports = {
  CHROMIUM_LICENSES_FILE,
  NOTICES_FILE,
  NOTICES_HEADING,
  WINDOWS_GIT_BUNDLE_HEADING,
  noticesProblems,
  readThirdPartyManifest,
  shipPatternMatches,
  shippedEntries,
  uncoveredShippedEntries,
};
