#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import buildIdentity from './lib/app-build-identity-artifact.cjs';
import coverage from './third-party-coverage.cjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const MANIFEST_PATH = 'apps/desktop/third-party/manifest.json';
export const SPDX_TEXTS = 'apps/desktop/third-party/spdx';
export const DEFAULT_OUTPUT = 'apps/desktop/resources/THIRD_PARTY_NOTICES.md';
export const DESKTOP_PACKAGE = '@waypoint/desktop';
export const SIDECAR_LICENSE_INVENTORY = 'python-licenses.json';
const SIDECAR_LICENSE_INVENTORY_SCHEMA = 'dnaforge.sidecar-python-licenses.v1';
const SIDECAR_PREFIX = 'waypoint-api-';
const RESOURCES = 'apps/desktop/resources';
export const SHIPPED_RUST_CRATES = [
  'dna-indexer',
  'dna-coverage',
  'dna-process-guardian',
  'broad-raster',
];
const LICENSE_FILE_NAME = /^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[._-].*)?$/i;
const MAX_LICENSE_FILE_BYTES = 1024 * 1024;
const SAMPLE_WORKSPACES = 'apps/desktop/resources/sample-workspaces';
const TRACKS = 'apps/desktop/resources/tracks';
export const WINDOWS_TOOLS_METADATA = 'apps/desktop/resources/binaries/cmscan-build-metadata.json';
export const BLAST_DLL_VERSIONS = 'apps/desktop/resources/binaries/blast-dll-versions.json';
const WINDOWS_RUNTIME_VERSION = 'windows-runtime:';

const WINDOWS_SHELL_COMMANDS = new Set(['pnpm']);

export function commandOptions(command, cwd, platform = process.platform) {
  return {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: platform === 'win32' && WINDOWS_SHELL_COMMANDS.has(command),
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

export function runCommand(command, args, cwd) {
  return execFileSync(command, args, commandOptions(command, cwd));
}

export function normalizeLicenseText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readLicenseText(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  if (statSync(file).size > MAX_LICENSE_FILE_BYTES) return null;
  const text = normalizeLicenseText(readFileSync(file, 'utf8'));
  return text ? { file: path.basename(file), text } : null;
}

export function licenseFilesIn(directory) {
  if (!directory || !existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .map((name) => readLicenseText(path.join(directory, name)))
    .filter(Boolean);
}

export function readManifest(repoRoot = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, MANIFEST_PATH), 'utf8'));
  if (manifest.schemaVersion !== 1) throw new Error(`${MANIFEST_PATH}: schemaVersion must be 1`);
  for (const key of ['distributor', 'sourceRequestContact']) {
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) {
      throw new Error(`${MANIFEST_PATH}: ${key} is required`);
    }
  }
  const ids = new Set();
  for (const component of manifest.components) {
    for (const key of ['id', 'kind', 'name', 'version', 'license']) {
      if (typeof component[key] !== 'string' || !component[key].trim()) {
        throw new Error(`${MANIFEST_PATH}: ${component.id ?? '(unnamed)'} needs ${key}`);
      }
    }
    if (ids.has(component.id)) throw new Error(`${MANIFEST_PATH}: duplicate id ${component.id}`);
    ids.add(component.id);
    if (!Array.isArray(component.licenseFiles) || !Array.isArray(component.ships)) {
      throw new Error(`${MANIFEST_PATH}: ${component.id} needs licenseFiles and ships arrays`);
    }
    if (component.kind !== 'first-party' && component.licenseFiles.length === 0) {
      if (!component.notes) {
        throw new Error(`${MANIFEST_PATH}: ${component.id} has no license file and no notes`);
      }
    }
  }
  for (const table of ['mingitPackages', 'mingitUcrtPackages']) {
    for (const [name, entry] of Object.entries(manifest[table] ?? {})) {
      if (typeof entry?.license !== 'string' || typeof entry?.source !== 'string') {
        throw new Error(`${MANIFEST_PATH}: ${table}.${name} needs license and source`);
      }
    }
  }
  return manifest;
}

export function spdxIdentifiers(expression) {
  return [...new Set(String(expression ?? '').match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [])].filter(
    (token) => !['AND', 'OR', 'WITH'].includes(token)
  );
}

export function standardLicenseTexts(expression, repoRoot = REPO_ROOT) {
  return spdxIdentifiers(expression)
    .map((identifier) => {
      const file = path.join(repoRoot, SPDX_TEXTS, `${identifier}.txt`);
      if (!existsSync(file)) return null;
      return {
        file: `standard ${identifier} text`,
        text: normalizeLicenseText(readFileSync(file, 'utf8')),
      };
    })
    .filter(Boolean);
}

function withFallbackLicenses(entry, repoRoot) {
  if (entry.licenses.length > 0) return entry;
  const licenses = standardLicenseTexts(entry.license, repoRoot);
  if (licenses.length === 0) return entry;
  return {
    ...entry,
    licenses,
    evidence: entry.evidence ?? 'the package includes no license file',
  };
}

function packageSetting(settings = {}, ecosystem, name) {
  const key = `${ecosystem}:${name}`;
  const pattern = Object.keys(settings).find((candidate) =>
    coverage.shipPatternMatches(candidate, key)
  );
  return pattern === undefined ? undefined : settings[pattern];
}

export function applyLicenseOverride(entry, ecosystem, overrides = {}) {
  const override = packageSetting(overrides, ecosystem, entry.name);
  return override ? { ...entry, license: override.license, evidence: override.evidence } : entry;
}

const COPYLEFT_LICENSE =
  /\b[AL]?GPL|\b(?:MPL|EPL|EUPL|CDDL)\b|General Public License|Mozilla Public License|Eclipse Public License/i;

export function isCopyleftLicense(license) {
  return COPYLEFT_LICENSE.test(String(license ?? ''));
}

export function packageSource(ecosystem, pkg, sources = {}) {
  const template = packageSetting(sources, ecosystem, pkg.name);
  if (template) return template.replaceAll('{version}', pkg.version);
  if (ecosystem === 'npm') {
    return `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').pop()}-${pkg.version}.tgz`;
  }
  if (ecosystem === 'python') return `https://pypi.org/project/${pkg.name}/${pkg.version}/`;
  return `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`;
}

function readRecord(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) : {};
}

export function windowsRuntimeLibraries(repoRoot = REPO_ROOT) {
  const { runtimeLibraries = [] } = readRecord(path.join(repoRoot, WINDOWS_TOOLS_METADATA));
  const { dlls = [] } = readRecord(path.join(repoRoot, BLAST_DLL_VERSIONS));
  return new Map([
    ...runtimeLibraries.map((library) => [library.file, library]),
    ...dlls.map((dll) => [dll.file, { ...dll, version: dll.productVersion || dll.fileVersion }]),
  ]);
}

function windowsRuntimeLibrary(component, { repoRoot, runtimeLibraries }) {
  const file = component.version.slice(WINDOWS_RUNTIME_VERSION.length);
  const library = runtimeLibraries.get(file);
  const ships = existsSync(path.join(repoRoot, RESOURCES, 'binaries', file));
  if (ships && !library?.version) {
    throw new Error(
      `${component.id}: ${file} ships without a recorded version in ${WINDOWS_TOOLS_METADATA} or ${BLAST_DLL_VERSIONS}; rebuild the Windows tools with apps/desktop/scripts/prepare-windows-bioinformatics-tools.ps1`
    );
  }
  return library ?? null;
}

function resolveComponentVersion(
  component,
  { repoRoot, appVersion, pythonRuntime, runtimeLibraries }
) {
  if (component.version === 'app') return appVersion;
  if (component.version === 'sidecar:python') return pythonRuntime?.version ?? null;
  if (component.version.startsWith(WINDOWS_RUNTIME_VERSION)) {
    return windowsRuntimeLibrary(component, { repoRoot, runtimeLibraries })?.version ?? null;
  }
  if (component.version.startsWith('npm:')) {
    const name = component.version.slice(4);
    const manifestFile = path.join(repoRoot, 'node_modules', name, 'package.json');
    return existsSync(manifestFile)
      ? JSON.parse(readFileSync(manifestFile, 'utf8')).version
      : 'unknown';
  }
  return component.version;
}

function resolveComponentSource(component, { repoRoot, appVersion, runtimeLibraries }) {
  if (component.source?.includes('{appVersion}')) {
    return component.source.replaceAll('{appVersion}', appVersion);
  }
  if (!component.source || !component.version.startsWith(WINDOWS_RUNTIME_VERSION)) {
    return component.source ?? null;
  }
  const library = windowsRuntimeLibrary(component, { repoRoot, runtimeLibraries });
  return library
    ? component.source.replaceAll('{base}', library.base).replaceAll('{version}', library.version)
    : null;
}

export function mingitSource(template, version) {
  const pkgver = version.replace(/-[^-]+$/, '');
  const [major, minor, patch, build = '1'] = pkgver.split('.');
  return template
    .replaceAll('{version}', version)
    .replaceAll('{pkgver}', pkgver)
    .replaceAll('{windowsTag}', `v${major}.${minor}.${patch}.windows.${build}`)
    .replaceAll('{commit}', pkgver.split('.').pop());
}

export function mingitPackageVersionsFile(repoRoot = REPO_ROOT) {
  let dugite;
  try {
    dugite = createRequire(path.join(repoRoot, 'apps/desktop/package.json')).resolve(
      'dugite/package.json'
    );
  } catch {
    return null;
  }
  return path.join(path.dirname(dugite), 'git', 'etc', 'package-versions.txt');
}

export function mingitPackages({ repoRoot = REPO_ROOT, known = {} } = {}) {
  const file = mingitPackageVersionsFile(repoRoot);
  if (!file || !existsSync(file)) return null;
  const listed = new Map();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/).filter(Boolean);
    if (fields.length === 0) continue;
    if (fields.length !== 2) {
      throw new Error(`${file}: cannot read the line "${line.trim()}"`);
    }
    const [name, version] = fields;
    listed.set(`${name}@${version}`, { name, version });
  }
  const unknown = [...new Set([...listed.values()].map(({ name }) => name))].filter(
    (name) => !known[name]
  );
  if (unknown.length > 0) {
    throw new Error(
      `${MANIFEST_PATH}: mingitPackages has no license or source for ${unknown.join(', ')}`
    );
  }
  return [...listed.values()]
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
    )
    .map((pkg) => {
      const { license, source, licenseFiles } = known[pkg.name];
      return {
        ...pkg,
        license,
        source: mingitSource(source, pkg.version),
        licenses: licenseFiles
          ? licenseFiles.map((relative) => {
              const text = readLicenseText(path.join(repoRoot, relative));
              if (!text)
                throw new Error(`${pkg.name}: license file missing or unreadable: ${relative}`);
              return text;
            })
          : standardLicenseTexts(license, repoRoot),
      };
    });
}

export function manifestComponents(
  manifest,
  {
    repoRoot = REPO_ROOT,
    appVersion,
    pythonRuntime = null,
    runtimeLibraries = windowsRuntimeLibraries(repoRoot),
  }
) {
  return manifest.components.map((component) => {
    const licenses = component.licenseFiles.map((relative) => {
      const license = readLicenseText(path.join(repoRoot, relative));
      if (!license)
        throw new Error(`${component.id}: license file missing or unreadable: ${relative}`);
      return license;
    });
    const context = { repoRoot, appVersion, pythonRuntime, runtimeLibraries };
    return {
      ...component,
      version: resolveComponentVersion(component, context),
      source: resolveComponentSource(component, context),
      includes: component.version === 'sidecar:python' ? (pythonRuntime?.includes ?? null) : null,
      licenses: licenses.length > 0 ? licenses : standardLicenseTexts(component.license, repoRoot),
    };
  });
}

const forwardSlashes = (filePath) => filePath.replaceAll('\\', '/');

function pnpmPathForVersion(entry, version, index) {
  const marker = `/${entry.name.replace('/', '+')}@${version}`;
  return (
    entry.paths?.find((candidate) => forwardSlashes(candidate).includes(marker)) ??
    entry.paths?.[index] ??
    entry.paths?.[0] ??
    null
  );
}

export function parsePnpmLicenses(json) {
  const packages = [];
  for (const [license, entries] of Object.entries(json)) {
    for (const entry of entries) {
      if (entry.name.startsWith('@waypoint/')) continue;
      entry.versions.forEach((version, index) => {
        const directory = pnpmPathForVersion(entry, version, index);
        if (directory && !forwardSlashes(directory).includes('/node_modules/')) return;
        packages.push({
          name: entry.name,
          version,
          license,
          homepage: entry.homepage ?? null,
          directory,
        });
      });
    }
  }
  return packages.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  );
}

export function indexInstalledPackages(roots) {
  const installed = new Map();
  const visit = (nodeModules) => {
    if (!existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const candidates = entry.name.startsWith('@')
        ? readdirSync(path.join(nodeModules, entry.name)).map((child) =>
            path.join(nodeModules, entry.name, child)
          )
        : [path.join(nodeModules, entry.name)];
      for (const directory of candidates) {
        const manifestFile = path.join(directory, 'package.json');
        if (!existsSync(manifestFile)) continue;
        try {
          const { name, version } = JSON.parse(readFileSync(manifestFile, 'utf8'));
          const key = `${name}@${version}`;
          if (name && version && !installed.has(key)) installed.set(key, directory);
        } catch {
          continue;
        }
        visit(path.join(directory, 'node_modules'));
      }
    }
  };
  for (const root of roots) visit(root);
  return installed;
}

export function npmPackages({ repoRoot = REPO_ROOT, run = runCommand, overrides = {} } = {}) {
  const json = JSON.parse(
    run('pnpm', ['--filter', DESKTOP_PACKAGE, 'licenses', 'list', '--prod', '--json'], repoRoot)
  );
  const installed = indexInstalledPackages([
    path.join(repoRoot, 'apps/desktop/node_modules'),
    path.join(repoRoot, 'node_modules'),
  ]);
  return parsePnpmLicenses(json).map((pkg) => {
    const directory =
      pkg.directory && existsSync(pkg.directory)
        ? pkg.directory
        : (installed.get(`${pkg.name}@${pkg.version}`) ?? null);
    return withFallbackLicenses(
      applyLicenseOverride(
        { ...pkg, directory, licenses: licenseFilesIn(directory) },
        'npm',
        overrides
      ),
      repoRoot
    );
  });
}

function hasEntryStartingWith(directory, prefix) {
  return existsSync(directory) && readdirSync(directory).some((name) => name.startsWith(prefix));
}

export function shippedPayloads(repoRoot = REPO_ROOT) {
  return {
    python: hasEntryStartingWith(path.join(repoRoot, RESOURCES, 'binaries'), SIDECAR_PREFIX),
    rust: hasEntryStartingWith(path.join(repoRoot, RESOURCES, 'helpers'), 'dna-'),
  };
}

export function sidecarInventories(repoRoot = REPO_ROOT) {
  const binaries = path.join(repoRoot, RESOURCES, 'binaries');
  if (!existsSync(binaries)) return [];
  return readdirSync(binaries)
    .filter((name) => name.startsWith(SIDECAR_PREFIX))
    .sort()
    .map((name) => {
      const file = path.join(binaries, name, SIDECAR_LICENSE_INVENTORY);
      if (!existsSync(file)) {
        throw new Error(
          `${name} has no ${SIDECAR_LICENSE_INVENTORY}; rebuild it with apps/api/scripts/build-sidecar.sh`
        );
      }
      const inventory = JSON.parse(readFileSync(file, 'utf8'));
      if (
        inventory.schema !== SIDECAR_LICENSE_INVENTORY_SCHEMA ||
        !Array.isArray(inventory.packages)
      ) {
        throw new Error(`${name}/${SIDECAR_LICENSE_INVENTORY} has an unknown format`);
      }
      return inventory;
    });
}

export function pythonPackages(inventories, repoRoot = REPO_ROOT) {
  const packages = new Map();
  for (const pkg of inventories.flatMap((inventory) => inventory.packages)) {
    const key = `${pkg.name.toLowerCase()}@${pkg.version}`;
    if (packages.has(key)) continue;
    const licenses = pkg.licenses
      .map((license) => ({ file: license.file, text: normalizeLicenseText(license.text) }))
      .filter((license) => license.text);
    packages.set(
      key,
      withFallbackLicenses(
        {
          name: pkg.name,
          version: pkg.version,
          license: pkg.license,
          homepage: pkg.homepage ?? null,
          licenses,
        },
        repoRoot
      )
    );
  }
  return [...packages.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  );
}

export function sidecarPythonRuntime(inventories) {
  if (inventories.length === 0) return null;
  const distinct = (values) => [...new Set(values)].join(' / ');
  const libraries = [
    ...new Set(inventories.flatMap((inventory) => Object.keys(inventory.python.libraries))),
  ];
  return {
    version: distinct(inventories.map((inventory) => inventory.python.version)),
    includes: libraries
      .map(
        (library) =>
          `${library} ${distinct(inventories.map((inventory) => inventory.python.libraries[library] ?? 'not included'))}`
      )
      .join(', '),
  };
}

export function shippedRustPackages(metadata, roots = SHIPPED_RUST_CRATES) {
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const workspace = new Set(metadata.workspace_members);
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const rootIds = roots.map((name) => {
    const pkg = metadata.packages.find(
      (candidate) => candidate.name === name && workspace.has(candidate.id)
    );
    if (!pkg) throw new Error(`Cargo workspace has no shipped crate named ${name}`);
    return pkg.id;
  });
  const seen = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length > 0) {
    const node = nodes.get(queue.shift());
    for (const dependency of node?.deps ?? []) {
      const normal = (dependency.dep_kinds ?? []).some((kind) => kind.kind === null);
      if (!normal || seen.has(dependency.pkg)) continue;
      seen.add(dependency.pkg);
      queue.push(dependency.pkg);
    }
  }
  return [...seen]
    .filter((id) => !workspace.has(id))
    .map((id) => packages.get(id))
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? (pkg.license_file ? `See ${pkg.license_file}` : 'UNKNOWN'),
      homepage: pkg.repository ?? pkg.homepage ?? null,
      directory: path.dirname(pkg.manifest_path),
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
    );
}

export function rustCrates({ repoRoot = REPO_ROOT, run = runCommand } = {}) {
  const args = ['metadata', '--format-version', '1', '--locked'];
  let output;
  try {
    output = run('cargo', [...args, '--offline'], repoRoot);
  } catch {
    output = run('cargo', args, repoRoot);
  }
  const metadata = JSON.parse(output);
  return shippedRustPackages(metadata).map((crate) =>
    withFallbackLicenses({ ...crate, licenses: licenseFilesIn(crate.directory) }, repoRoot)
  );
}

export function dataSources({ repoRoot = REPO_ROOT } = {}) {
  const groups = new Map();
  const workspaces = path.join(repoRoot, SAMPLE_WORKSPACES);
  for (const name of existsSync(workspaces) ? readdirSync(workspaces).sort() : []) {
    const provenanceFile = path.join(workspaces, name, 'workspace', 'PROVENANCE.json');
    if (!existsSync(provenanceFile)) continue;
    for (const entry of JSON.parse(readFileSync(provenanceFile, 'utf8')).entries) {
      const key = `${entry.source}\u0000${entry.license}`;
      const group = groups.get(key) ?? {
        source: entry.source,
        license: entry.license,
        files: 0,
        attributions: new Set(),
      };
      group.files += 1;
      if (entry.attribution) group.attributions.add(entry.attribution);
      groups.set(key, group);
    }
  }
  const tracks = [];
  const trackRoot = path.join(repoRoot, TRACKS);
  for (const assembly of existsSync(trackRoot) ? readdirSync(trackRoot).sort() : []) {
    for (const track of readdirSync(path.join(trackRoot, assembly)).sort()) {
      const currentFile = path.join(trackRoot, assembly, track, 'current.json');
      if (!existsSync(currentFile)) continue;
      const { version } = JSON.parse(readFileSync(currentFile, 'utf8'));
      const meta = JSON.parse(
        readFileSync(path.join(trackRoot, assembly, track, version, 'meta.json'), 'utf8')
      );
      tracks.push({
        assembly,
        track,
        label: meta.label,
        license: meta.license?.spdx ?? 'UNKNOWN',
        attribution: meta.license?.attribution ?? null,
        citation: meta.citation ?? null,
      });
    }
  }
  return {
    sampleData: [...groups.values()]
      .map((group) => ({ ...group, attributions: [...group.attributions].sort() }))
      .sort(
        (left, right) =>
          left.source.localeCompare(right.source) || left.license.localeCompare(right.license)
      ),
    tracks,
  };
}

class LicenseTextIndex {
  constructor() {
    this.byDigest = new Map();
  }

  reference(license) {
    const digest = createHash('sha256').update(license.text).digest('hex');
    let entry = this.byDigest.get(digest);
    if (!entry) {
      entry = { id: `text-${this.byDigest.size + 1}`, ...license };
      this.byDigest.set(digest, entry);
    }
    return entry.id;
  }

  entries() {
    return [...this.byDigest.values()];
  }
}

function escapeTableCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

function textLinks(index, licenses, evidence) {
  const links =
    licenses.length === 0
      ? 'no license text available'
      : licenses.map((license) => `[${license.file}](#${index.reference(license)})`).join(', ');
  return evidence ? `${links}; ${evidence}` : links;
}

function componentTitle(component) {
  return component.version ? `${component.name} ${component.version}` : component.name;
}

function packageTable(index, packages) {
  if (packages === null) return ['Not part of this build.'];
  const rows = packages.map(
    (pkg) =>
      `| ${escapeTableCell(pkg.name)} | ${escapeTableCell(pkg.version)} | ${escapeTableCell(pkg.license)} | ${escapeTableCell(textLinks(index, pkg.licenses, pkg.evidence))} |`
  );
  return ['| Package | Version | License | License text |', '| --- | --- | --- | --- |', ...rows];
}

export function buildNotices({
  appVersion,
  manifest,
  components,
  npm,
  python,
  rust,
  mingit = null,
  data,
}) {
  const index = new LicenseTextIndex();
  const lines = [
    `${coverage.NOTICES_HEADING}${appVersion}`,
    '',
    `DNAForge is distributed by ${manifest.distributor}. It includes the third-party programs, libraries and data listed below, each under its own license. The full license texts are at the end of this file.`,
    '',
    '## Source code for copyleft components',
    '',
    'The components below are licensed under the GNU General Public License or a similar license that requires source code to be available. Each link points to the exact source of the version DNAForge distributes.',
    '',
  ];
  for (const component of components.filter((entry) => entry.copyleft)) {
    lines.push(
      `- ${componentTitle(component)} (${component.license}): ${component.source ?? 'source available on request (see below)'}`
    );
  }
  for (const [ecosystem, kind, packages] of [
    ['npm', 'npm package', npm],
    ['python', 'Python package in the sidecar', python],
    ['rust', 'Rust crate', rust],
  ]) {
    for (const pkg of (packages ?? []).filter((entry) => isCopyleftLicense(entry.license))) {
      lines.push(
        `- ${pkg.name} ${pkg.version} (${pkg.license.replace(/^\((.*)\)$/, '$1')}), ${kind}: ${packageSource(ecosystem, pkg, manifest.packageSources)}`
      );
    }
  }
  for (const pkg of (mingit ?? []).filter((entry) => isCopyleftLicense(entry.license))) {
    lines.push(
      `- ${pkg.name} ${pkg.version} (${pkg.license}), package in the Windows Git bundle: ${pkg.source}`
    );
  }
  lines.push(
    '',
    `For at least three years after DNAForge last distributes a given version, and for as long as DNAForge offers support for it, anyone who received that version may ask ${manifest.distributor} for a complete machine-readable copy of the corresponding source code of these components, including the DNAForge sidecar, at no charge beyond the cost of physically providing it. Write to ${manifest.sourceRequestContact}.`,
    '',
    '## Programs, code and data bundled with the application',
    ''
  );
  for (const component of components) {
    lines.push(`### ${componentTitle(component)}`, '');
    if (!component.version) lines.push('- Not part of this build.');
    lines.push(`- License: ${component.license}`);
    if (component.includes) lines.push(`- Includes: ${component.includes}`);
    if (component.homepage) lines.push(`- Project: ${component.homepage}`);
    if (component.source) lines.push(`- Source: ${component.source}`);
    if (component.notes) lines.push(`- ${component.notes}`);
    if (component.licenses.length > 0)
      lines.push(`- License text: ${textLinks(index, component.licenses)}`);
    lines.push('');
  }
  const count = (packages) => (packages === null ? 'not part of this build' : packages.length);
  lines.push(`## npm packages (${count(npm)})`, '', ...packageTable(index, npm), '');
  lines.push(
    `## Python packages in the DNAForge sidecar (${count(python)})`,
    '',
    ...packageTable(index, python),
    ''
  );
  lines.push(
    `## Rust crates in DNAForge helpers (${count(rust)})`,
    '',
    ...packageTable(index, rust),
    ''
  );
  lines.push(`${coverage.WINDOWS_GIT_BUNDLE_HEADING}${count(mingit)})`, '');
  if (mingit !== null) {
    lines.push(
      'On Windows, DNAForge runs Git from MinGit, the Git for Windows build that dugite bundles. MinGit includes these MSYS2 and MinGW-w64 packages.',
      ''
    );
  }
  lines.push(...packageTable(index, mingit), '');
  lines.push('## Bundled data', '', '### Sample workspace files', '');
  for (const group of data.sampleData) {
    lines.push(
      `- ${group.source}, ${group.license}: ${group.files} file${group.files === 1 ? '' : 's'}`
    );
    if (/^CC-BY/i.test(group.license) || /^OpenMTA$/i.test(group.license)) {
      for (const attribution of group.attributions) lines.push(`  - ${attribution}`);
    }
  }
  lines.push('', '### Annotation tracks', '');
  for (const track of data.tracks) {
    lines.push(`- ${track.label} (${track.assembly}), ${track.license}`);
    if (track.attribution) lines.push(`  - ${track.attribution}`);
    if (track.citation) lines.push(`  - Citation: ${track.citation}`);
  }
  lines.push('', '## License texts', '');
  for (const entry of index.entries()) {
    const longestRun = Math.max(0, ...(entry.text.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    lines.push(
      `### ${entry.id}`,
      '',
      `<a id="${entry.id}"></a>`,
      '',
      `From ${entry.file}:`,
      '',
      `${fence}text`,
      entry.text,
      fence,
      ''
    );
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

export function collectPackages(label, required, producer) {
  let packages;
  try {
    packages = producer();
  } catch (error) {
    if (required) {
      const output = [error.stdout, error.stderr]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .join('\n')
        .slice(0, 8_192);
      throw new Error(`${label}: ${error.message}${output ? `\n${output}` : ''}`);
    }
    return null;
  }
  if (required && packages.length === 0) throw new Error(`${label}: no packages found`);
  return packages.length > 0 ? packages : null;
}

export function generateThirdPartyNotices({
  repoRoot = REPO_ROOT,
  appVersion,
  run = runCommand,
  require = shippedPayloads(repoRoot),
} = {}) {
  const manifest = readManifest(repoRoot);
  let inventories = [];
  const python = collectPackages('Python packages', require.python, () => {
    inventories = sidecarInventories(repoRoot);
    return pythonPackages(inventories, repoRoot);
  });
  const components = manifestComponents(manifest, {
    repoRoot,
    appVersion,
    pythonRuntime: sidecarPythonRuntime(inventories),
  });
  return buildNotices({
    appVersion,
    manifest,
    components,
    npm: collectPackages('npm packages', true, () =>
      npmPackages({ repoRoot, run, overrides: manifest.packageLicenseOverrides })
    ),
    python,
    rust: collectPackages('Rust crates', require.rust, () => rustCrates({ repoRoot, run })),
    mingit: mingitPackages({
      repoRoot,
      known: { ...manifest.mingitPackages, ...manifest.mingitUcrtPackages },
    }),
    data: dataSources({ repoRoot }),
  });
}

export function noticesAppVersion({ appVersion, mainOutDir }) {
  if (appVersion !== undefined) {
    if (typeof appVersion !== 'string' || !appVersion.trim()) {
      throw new Error('The notices need the app build version');
    }
    return appVersion;
  }
  return buildIdentity.appBuildVersionText(buildIdentity.readAppBuildIdentity(mainOutDir));
}

export function writeThirdPartyNotices({
  repoRoot = REPO_ROOT,
  output = DEFAULT_OUTPUT,
  appVersion,
  mainOutDir = path.join(repoRoot, 'apps/desktop/out/main'),
  require,
} = {}) {
  const version = noticesAppVersion({ appVersion, mainOutDir });
  const notices = generateThirdPartyNotices({ repoRoot, appVersion: version, require });
  const destination = path.resolve(repoRoot, output);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, notices);
  return { destination, bytes: Buffer.byteLength(notices) };
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const { destination, bytes } = writeThirdPartyNotices({
    output: option('--out') ?? DEFAULT_OUTPUT,
    appVersion: option('--app-version'),
  });
  process.stdout.write(`Wrote ${path.relative(REPO_ROOT, destination)} (${bytes} bytes)\n`);
}
