import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

import { resolveBuildDistribution } from '../../shared/build-distribution';
import { HOSTED_REFERENCE_BUILD_CATALOG_V1 } from '../reference-assets/hosted-reference-build-catalog';
import { HOSTED_REFERENCE_CATALOG_V1 } from '../reference-assets/hosted-reference-catalog';

const MAIN_BUNDLE = resolve(__dirname, '../../../out/main/index.js');
const MAIN_OUTPUT = resolve(__dirname, '../../../out/main');
const builtDistribution = resolveBuildDistribution({
  file: readFileSync(resolve(__dirname, '../../../distribution.json'), 'utf8'),
  override: process.env.DNAFORGE_DISTRIBUTION,
  releaseBuild: process.env.DNAFORGE_RELEASE_BUILD === '1',
});

function emittedMainJavaScript(): string {
  return readdirSync(MAIN_OUTPUT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => readFileSync(resolve(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
}

const REQUIRED_EXTERNALS = new Set([
  'better-sqlite3',
  '@xterm/headless',
  'node-pty',
  'dugite',
  'linkedom',
]);

const bundleExists = existsSync(MAIN_BUNDLE);
const bundleRequired = process.env.DNAFORGE_REQUIRE_MAIN_BUNDLE === '1';

describe('main process bundle precondition', () => {
  it('fails closed when the authoritative builder requires the artifact', () => {
    expect(bundleRequired && !bundleExists).toBe(false);
  });
});

describe('dynamically loaded product resource paths', () => {
  it('resolves renderer and preload from the emitted product-chunk layout', () => {
    const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
    expect(source).toContain("join(__dirname, '../renderer/index.html')");
    expect(source).toContain("join(__dirname, '../preload/index.js')");
    expect(source).not.toContain("join(__dirname, '../../renderer/index.html')");
    expect(source).not.toContain("join(__dirname, '../../preload/index.js')");
  });

  it('retains the runtime source fingerprint in the bootstrap entry', () => {
    const source = readFileSync(resolve(__dirname, '../bootstrap.ts'), 'utf8');
    expect(source).toContain('sourceBuildFingerprint: __WAYPOINT_BUILD_SOURCE_FINGERPRINT__');
    expect(source).toContain('const sourceCommitStamp = __DNAFORGE_SOURCE_COMMIT__;');
    expect(source).toContain('test(bootstrapBuildIdentity.sourceBuildFingerprint)');
    expect(source).toMatch(
      /SOURCE_COMMIT_PROVENANCE_V1::END\$\/u\.test\(\s*sourceCommitStamp\s*\)/
    );
  });
});

describe.skipIf(!bundleExists)('main process bundle (out/main/index.js)', () => {
  it('exists after build', () => {
    expect(existsSync(MAIN_BUNDLE)).toBe(true);
  });

  it('ships a complete reachable main-process module graph', () => {
    const require = createRequire(import.meta.url);
    const { verifyBuiltMainGraph } = require('../../../scripts/lib/verify-package-helpers.cjs') as {
      verifyBuiltMainGraph(root: string): { paths: string[] };
    };
    const graph = verifyBuiltMainGraph(resolve(__dirname, '../../..'));
    expect(graph.paths).toContain('out/main/index.js');
  });

  it('keeps the thin bootstrap entry independent from the dynamically loaded product graph', () => {
    const content = readFileSync(MAIN_BUNDLE, 'utf8');
    const productImport = content.match(/import\("\.\/(product-[^"]+\.js)"\)/);
    expect(
      productImport,
      'main entry must dynamically import the product main chunk'
    ).not.toBeNull();
    expect(existsSync(resolve(__dirname, '../../../out/main', productImport![1]))).toBe(true);
    expect(content).not.toMatch(/from "better-sqlite3"|from "dugite"|from "linkedom"/);
    expect(content).toContain('Startup failed');
    expect(content).not.toContain('startBootRecoveryUpdater');
    expect(content).not.toContain('boot-recovery.json');
    expect(content).not.toContain('startSchemaUpdateRecovery');
    expect(content).toMatch(
      /sourceCommitStamp = "(?:DNAFORGE_SOURCE_COMMIT=[0-9a-f]{40}::SOURCE_COMMIT_PROVENANCE_V1::END)?"/
    );
  });

  it.runIf(builtDistribution === 'official')(
    'ships schema-only automatic update recovery inside the product chunk',
    () => {
      const content = emittedMainJavaScript();
      expect(content).toContain('schema_update_recovery_started');
      expect(content).toContain('Schema recovery checking authority');
      expect(content).not.toContain('restore-compatible-backup');
    }
  );

  it.runIf(builtDistribution === 'community')(
    'leaves automatic update recovery out of community builds',
    () => {
      const content = emittedMainJavaScript();
      expect(content).toContain('schema_update_recovery_started');
      expect(content).toContain('Community builds do not install updates');
      expect(content).not.toContain('Schema recovery checking authority');
      expect(content).not.toContain('restore-compatible-backup');
    }
  );

  it('excludes build-only hosted-reference definitions from Electron main', () => {
    const content = emittedMainJavaScript();
    const runtimeIds = new Set(HOSTED_REFERENCE_CATALOG_V1.map(({ id }) => id));
    const buildOnlyIds = HOSTED_REFERENCE_BUILD_CATALOG_V1.filter(
      ({ id }) => !runtimeIds.has(id)
    ).map(({ id }) => id);

    expect(HOSTED_REFERENCE_CATALOG_V1).toHaveLength(65);
    expect(HOSTED_REFERENCE_BUILD_CATALOG_V1).toHaveLength(65);
    expect(buildOnlyIds).toEqual([]);
    expect(content).toContain('hs1');
    expect(content).toContain('nibenKlab');
    for (const id of buildOnlyIds) {
      expect(content, `${id} must stay outside the Electron runtime bundle`).not.toContain(id);
    }
  });

  describe('external imports', () => {
    let npmExternals: string[] = [];

    beforeAll(() => {
      const content = emittedMainJavaScript();
      const importRe = /^import\s+.*?\s+from\s+"([^"]+)";/gm;
      let m: RegExpExecArray | null;
      const all: string[] = [];
      while ((m = importRe.exec(content)) !== null) {
        all.push(m[1]);
      }
      const nodeRequire = createRequire(import.meta.url);
      const { builtinModules: nodeMods } = nodeRequire('module') as { builtinModules: string[] };
      const builtins = new Set([...nodeMods, ...nodeMods.map((m) => `node:${m}`), 'fs/promises']);
      npmExternals = all.filter((id) => {
        if (id === 'electron' || id.startsWith('electron/')) return false;
        if (id.startsWith('node:')) return false;
        if (builtins.has(id)) return false;
        if (id.startsWith('./') || id.startsWith('../')) return false;
        return true;
      });
    });

    it('only externalizes packages declared unsafe to bundle', () => {
      const unexpected = npmExternals.filter((id) => {
        const pkg = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
        return !REQUIRED_EXTERNALS.has(id) && !REQUIRED_EXTERNALS.has(pkg);
      });
      expect(unexpected).toEqual([]);
    });

    it('bundles posthog-node (not in external imports)', () => {
      expect(npmExternals).not.toContain('posthog-node');
    });

    it('bundles electron-updater (not in external imports)', () => {
      expect(npmExternals).not.toContain('electron-updater');
    });

    it('bundles @electron-toolkit/utils (not in external imports)', () => {
      expect(npmExternals).not.toContain('@electron-toolkit/utils');
    });

    it('bundles @sentry/electron (nativeNodeFetchIntegration patched out at build time)', () => {
      const sentryPresent =
        npmExternals.includes('@sentry/electron') || npmExternals.includes('@sentry/electron/main');
      expect(sentryPresent).toBe(false);
    });
  });
});
