import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const RELEASE_SOURCES_SCHEMA = 'dnaforge.release-bundle-sources.v1';
export const RELEASE_SOURCES_TARGETS = ['main', 'preload', 'renderer', 'renderer-worker'];
export const RELEASE_POLICY = 'release';
export const INTERNAL_POLICY = 'internal';
export const INTERNAL_MODES = ['development', 'test'];

export function boundaryPolicyForMode(mode) {
  return INTERNAL_MODES.includes(mode) ? INTERNAL_POLICY : RELEASE_POLICY;
}

const SHIPPABLE_ROOTS = [
  /^apps\/desktop\/(?:src|resources)\//u,
  /^apps\/desktop\/[^/]+\.html$/u,
  /^packages\//u,
];
export const SHIPPED_DESKTOP_SCRIPTS = [
  'apps/desktop/scripts/background-window-policy.cjs',
  'apps/desktop/scripts/native-abi-patterns.cjs',
];
export const SHIPPED_EXCEPTIONS = ['apps/desktop/src/test/assembly-annotation-policy-bridge.ts'];
export const SHIPPED_EXCEPTIONS_TICKET = 'public-release-assets';
const UNSHIPPABLE_SEGMENTS =
  /(?:^|\/)(?:__fixtures__|__tests__|__mocks__|fixtures|test-fixtures|e2e|test|tests|testing)\//u;
const UNSHIPPABLE_FILES = /\.(?:test|spec|e2e|stories)\.[cm]?[jt]sx?$/u;
const TEXT_FILES = /\.(?:md|markdown|mdx|txt|log|csv|tsv|jsonl|ndjson)$/iu;
const NEVER_IMPORTABLE = /^(?:docs|\.evidence|\.claude|\.agents|\.codex|skills|supabase)\//u;

function relativeBundlePath(id, repoRoot, baseDir) {
  if (typeof id !== 'string' || id.startsWith('\0')) return null;
  const bare = id.split('?')[0].split('#')[0];
  if (!isAbsolute(bare) && !baseDir) return null;
  const file = isAbsolute(bare) ? bare : resolve(baseDir, bare);
  return relative(repoRoot, file).split(sep).join('/') || null;
}

export function bundleSourcePath(id, repoRoot, baseDir) {
  const path = relativeBundlePath(id, repoRoot, baseDir);
  return path?.split('/').includes('node_modules') ? null : path;
}

export function isDependencySourcePath(path) {
  if (typeof path !== 'string' || path.includes('\\') || /^[A-Za-z]:/u.test(path)) return false;
  const segments = path.split('/');
  const dependency = segments.indexOf('node_modules');
  return (
    dependency >= 0 &&
    dependency < segments.length - 1 &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

export function releaseSourceViolation(path, { shippedTextFiles = [] } = {}) {
  if (path.startsWith('../')) return 'outside the repository';
  if (SHIPPED_DESKTOP_SCRIPTS.includes(path) || SHIPPED_EXCEPTIONS.includes(path)) return null;
  if (!SHIPPABLE_ROOTS.some((root) => root.test(path))) {
    return 'outside apps/desktop/src, apps/desktop/resources and packages';
  }
  if (UNSHIPPABLE_SEGMENTS.test(path) || UNSHIPPABLE_FILES.test(path))
    return 'test or fixture file';
  if (TEXT_FILES.test(path) && !shippedTextFiles.includes(path)) {
    return 'text file not on the shipped text-file list';
  }
  return null;
}

export function neverImportableViolation(path) {
  return NEVER_IMPORTABLE.test(path) ? 'never importable by a desktop bundle' : null;
}

export function releaseBundleReport({
  target,
  loadedIds,
  chunks,
  repoRoot,
  viteRoot = repoRoot,
  shippedTextFiles = [],
  policy = RELEASE_POLICY,
}) {
  const shipped = new Set();
  const dependencies = new Set();
  const recordSource = (id, baseDir) => {
    const dependency = relativeBundlePath(id, repoRoot, baseDir);
    if (isDependencySourcePath(dependency)) dependencies.add(dependency);
    const source = bundleSourcePath(id, repoRoot, baseDir);
    if (source) shipped.add(source);
  };
  for (const chunk of chunks) {
    if (chunk.type === 'chunk') {
      for (const [id, info] of Object.entries(chunk.modules)) {
        if (info.renderedLength > 0) {
          recordSource(id);
        }
      }
    } else {
      for (const name of chunk.originalFileNames ?? []) {
        recordSource(name, viteRoot);
      }
    }
  }
  const violations = [];
  for (const path of [...shipped].sort()) {
    const reason =
      policy === RELEASE_POLICY
        ? releaseSourceViolation(path, { shippedTextFiles })
        : neverImportableViolation(path);
    if (reason) violations.push({ path, reason, shipped: true });
  }
  for (const id of loadedIds) {
    const path = bundleSourcePath(id, repoRoot);
    const reason = path && !shipped.has(path) && neverImportableViolation(path);
    if (reason) violations.push({ path, reason, shipped: false });
  }
  return {
    schema: RELEASE_SOURCES_SCHEMA,
    policy,
    target,
    sources: [...shipped].sort(),
    dependencySources: [...dependencies].sort(),
    exceptions: [...shipped].filter((path) => SHIPPED_EXCEPTIONS.includes(path)).sort(),
    violations,
  };
}

export function formatReleaseBundleViolations(report) {
  return [
    `Release bundle boundary failed for ${report.target}: ${report.violations.length} source(s) may not ship.`,
    ...report.violations.map(
      ({ path, reason, shipped }) =>
        `  ${path} — ${reason}${shipped ? '' : ' (imported, tree-shaken)'}`
    ),
    'Only application, workspace-package and dependency code may enter a desktop bundle.',
  ].join('\n');
}

export function createReleaseBundleBoundary({ repoRoot: givenRoot, shippedTextFiles = [] }) {
  const repoRoot = realpathSync(givenRoot);
  return (target) => {
    let viteRoot = repoRoot;
    let policy = RELEASE_POLICY;
    const accumulated = new Set();
    const accumulatedDependencies = new Set();
    return {
      name: `dnaforge-release-bundle-boundary:${target}`,
      apply: 'build',
      enforce: 'post',
      configResolved(config) {
        viteRoot = realpathSync(config.root);
        policy = boundaryPolicyForMode(config.mode);
      },
      generateBundle(_options, bundle) {
        const loadedIds = [...this.getModuleIds()].filter(
          (id) => !this.getModuleInfo(id)?.isExternal
        );
        const report = releaseBundleReport({
          target,
          loadedIds,
          chunks: Object.values(bundle),
          repoRoot,
          viteRoot,
          shippedTextFiles,
          policy,
        });
        if (report.violations.length > 0) this.error(formatReleaseBundleViolations(report));
        for (const source of report.sources) accumulated.add(source);
        for (const source of report.dependencySources) accumulatedDependencies.add(source);
        const sources = [...accumulated].sort();
        const receipt = {
          ...report,
          sources,
          dependencySources: [...accumulatedDependencies].sort(),
          exceptions: sources.filter((path) => SHIPPED_EXCEPTIONS.includes(path)),
        };
        const entry = Object.values(bundle).find((item) => item.type === 'chunk' && item.isEntry);
        const suffix = target === 'renderer-worker' && entry ? `.${entry.name}` : '';
        this.emitFile({
          type: 'asset',
          fileName: `release-sources.${target}${suffix}.json`,
          source: `${JSON.stringify(receipt, null, 2)}\n`,
        });
      },
    };
  };
}
