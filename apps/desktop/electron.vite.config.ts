import { basename, dirname, resolve } from 'path';
import { createHash } from 'node:crypto';
import {
  createAppBuildIdentity,
  readDesktopSourceDescription,
} from './src/main/create-app-build-identity';
import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import MagicString from 'magic-string';
import { normalizePath, type Plugin } from 'vite';
import {
  BUILD_SOURCE_GIT_EXECUTABLE,
  getRuntimeSourceFingerprint,
  RUNTIME_SOURCE_FINGERPRINT_GIT_PATHS,
  RUNTIME_SOURCE_FINGERPRINT_FILE_PATHS,
} from './src/main/build-source-fingerprint';
import { resolveDevAiEnvKey } from './src/shared/dev-ai-env-keys';
import {
  createRendererDefines,
  macTeamIdCutoverRendererMarker,
} from './src/shared/renderer-build-defines';
import {
  releaseBHostedAuthorityFromEnv,
  qualificationEphemeralAuthStampFromEnv,
  releaseBuildStampFromEnv,
  sourceCommitStamp,
  telemetryBuildTagStampFromEnv,
} from './src/main/release-stamp';
import { formatDevAppBarChip, normalizeDevInstanceLabel } from './src/shared/dev-window-identity';
import { resolveHostedAiBuildPolicy } from './src/shared/hosted-ai-build-policy';
import {
  communityRendererEnvDefaults,
  resolveBuildDistribution,
} from './src/shared/build-distribution';
import { resolveElectronViteBuildEnvironment } from './src/shared/vite-build-environment';
import { sealTelemetryActorAssertionPublicKey } from '@waypoint/analytics-policy/telemetry-actor-assertion';
import { INDEXED_TRACK_DEV_OPTIMIZE_DEPS } from './src/shared/indexed-track-dev-optimization';
import { createElectronModuleGraph } from './scripts/lib/electron-module-graph';
import { createReleaseBundleBoundary } from './scripts/lib/release-bundle-boundary.mjs';

const requireForBuild = createRequire(import.meta.url);
const { nativeBuildCachePlugin } = requireForBuild('./scripts/dev-native-build-cache.cjs') as {
  nativeBuildCachePlugin(options: { appDir: string; repoRoot: string }): Plugin;
};
const { devServerNetwork } = requireForBuild('./scripts/lib/dev-server-network.cjs') as {
  devServerNetwork(
    devPort?: string,
    hmrPort?: string
  ): {
    host?: string;
    port?: number;
    hmr?: { host?: string; port?: number };
  };
};
const { appBuildIdentityPlugin } = requireForBuild(
  './scripts/lib/app-build-identity-artifact.cjs'
) as { appBuildIdentityPlugin(identity: unknown): Plugin };
const { buildSequenceWheel } = requireForBuild('./scripts/build-sequence-wheel.cjs') as {
  buildSequenceWheel(): string | null;
};

function sequenceWheelNative(): Plugin {
  let binary: string | null = null;
  return {
    name: 'sequence-wheel-native',
    buildStart() {
      binary = buildSequenceWheel();
    },
    generateBundle() {
      if (binary)
        this.emitFile({
          type: 'asset',
          fileName: `binaries/${basename(binary)}`,
          source: readFileSync(binary),
        });
    },
  };
}

function fixtureEnzymeModule(): Plugin {
  const source = resolve(__dirname, 'public/data/rebase/merged-enzymes.json');
  const moduleId = '\0dnaforge-fixture-enzymes';
  return {
    name: 'fixture-enzyme-module',
    enforce: 'pre',
    resolveId(id, importer) {
      if (importer && resolve(dirname(importer), id) === source) return moduleId;
    },
    load(id) {
      if (id === moduleId) return `export default ${readFileSync(source, 'utf8')};`;
    },
  };
}
const { computeSidecarSourceHash } = requireForBuild('../../scripts/sidecar-build-receipt.cjs') as {
  computeSidecarSourceHash(repoRoot: string): { sourceHash: string; inputCount: number };
};
const { assertBackgroundElectronLaunchProtected } = requireForBuild(
  './scripts/background-electron-launch.cjs'
) as {
  assertBackgroundElectronLaunchProtected(env: NodeJS.ProcessEnv): void;
};

const MOLSTAR_OPTIMIZE_DEPS = [
  'molstar/lib/mol-data/int',
  'molstar/lib/mol-math/linear-algebra/3d',
  'molstar/lib/mol-model/loci',
  'molstar/lib/mol-model/structure',
  'molstar/lib/mol-model/structure/structure/element/bundle',
  'molstar/lib/mol-plugin-state/helpers/structure-representation-params',
  'molstar/lib/mol-plugin-state/transforms',
  'molstar/lib/mol-plugin/context',
  'molstar/lib/mol-plugin/spec',
  'molstar/lib/mol-script/language/builder',
  'molstar/lib/mol-script/language/expression',
  'molstar/lib/mol-script/script',
  'molstar/lib/mol-script/transpilers/pymol/parser',
  'molstar/lib/mol-util/color',
];

const MAIN_EXTERNALS: (string | RegExp)[] = [
  '@xterm/headless',
  'node-pty',
  'better-sqlite3',
  'dugite',
  'linkedom',
];

function injectDirnameShim(): Plugin {
  return {
    name: 'inject-dirname-shim',
    renderChunk(code: string, _chunk, outputOptions) {
      const shim = `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`;
      if (
        !code.includes('// -- CommonJS Shims --') &&
        /__filename|__dirname|require\(|require\.resolve\(/.test(code)
      ) {
        const transformed = new MagicString(code).prepend(shim);
        return {
          code: transformed.toString(),
          map: outputOptions.sourcemap
            ? transformed.generateMap({ hires: true, includeContent: true })
            : null,
        };
      }
      return null;
    },
  };
}

function disableInternalFixtureMainIpc(): Plugin {
  const target = normalizePath(resolve(__dirname, 'src/main/ipc/internal-fixtures.ts'));

  return {
    name: 'disable-internal-fixture-main-ipc',
    enforce: 'pre',
    load(id: string) {
      const moduleId = normalizePath(id.split('?')[0] ?? id);
      if (moduleId !== target) return null;

      return `
import { ipcMain } from 'electron';

const unavailable = async (): Promise<never> => {
  throw new Error('Internal assembly fixture loaders are only available in development.');
};

export function registerInternalFixtureHandlers(): void {
  ipcMain.handle('internal-fixtures:materialize', unavailable);
  ipcMain.handle('internal-fixtures:status', unavailable);
}
`;
    },
  };
}

function patchSentryRITM() {
  return {
    name: 'patch-sentry-ritm',
    transform(code: string, id: string) {
      if (id.includes('@sentry/electron') && code.includes('nativeNodeFetchIntegration')) {
        const patched = code.replace(
          /(?:node\.)?nativeNodeFetchIntegration\(\),?\s*/g,
          '/* nativeNodeFetchIntegration removed at build time: uses RITM, incompatible with ESM bundle */ '
        );
        if (patched === code) return null;
        return { code: patched, map: null };
      }
      return null;
    },
  };
}

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const updateAuthority = JSON.parse(
  readFileSync(resolve(__dirname, 'update-authority.json'), 'utf-8')
) as {
  schemaVersion: number;
  stableFeedBases: string[];
};

function isCanonicalAnonymousHttpsBase(base: string): boolean {
  try {
    const url = new URL(base);
    const canonicalPath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      base === `${url.origin}${canonicalPath}`
    );
  } catch {
    return false;
  }
}

if (
  updateAuthority.schemaVersion !== 2 ||
  !Array.isArray(updateAuthority.stableFeedBases) ||
  updateAuthority.stableFeedBases.length < 2 ||
  new Set(updateAuthority.stableFeedBases).size !== updateAuthority.stableFeedBases.length ||
  updateAuthority.stableFeedBases.some((base) => !isCanonicalAnonymousHttpsBase(base))
) {
  throw new Error(
    'update-authority.json must declare at least two unique canonical anonymous HTTPS bases at schemaVersion 2'
  );
}

const canonicalUpdateFeedBase = updateAuthority.stableFeedBases[0];
const requestedUpdateFeedBase = process.env.WAYPOINT_UPDATE_FEED_BASE?.replace(/\/+$/, '');
const isReleaseBuild = process.env.DNAFORGE_RELEASE_BUILD === '1';
const buildDistribution = resolveBuildDistribution({
  file: readFileSync(resolve(__dirname, 'distribution.json'), 'utf-8'),
  override: process.env.DNAFORGE_DISTRIBUTION,
  releaseBuild: isReleaseBuild,
});
for (const [key, value] of Object.entries(communityRendererEnvDefaults(buildDistribution))) {
  process.env[key] ??= value;
}
if (
  isReleaseBuild &&
  requestedUpdateFeedBase !== undefined &&
  requestedUpdateFeedBase !== canonicalUpdateFeedBase
) {
  throw new Error('release builds cannot override the checked-in desktop update authority');
}
const compiledUpdateFeedBase = requestedUpdateFeedBase ?? canonicalUpdateFeedBase;
const compiledUpdateFeedBases = requestedUpdateFeedBase
  ? [requestedUpdateFeedBase]
  : updateAuthority.stableFeedBases;
const compiledUpdateAuthorityStamp = `DNAFORGE_UPDATE_AUTHORITIES=${Buffer.from(
  JSON.stringify(compiledUpdateFeedBases),
  'utf8'
).toString('base64url')}::UPDATE_AUTHORITY_V2::END`;

function resolveWpAssetsPath(): string {
  const explicit = process.env.VITE_WP_ASSETS_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const repoRoot = resolve(__dirname, '../..');

  const sibling = resolve(repoRoot, '..', 'wp-assets');
  if (existsSync(sibling)) return sibling;

  const home = process.env.HOME || '';
  if (home) {
    const projects = resolve(home, 'projects', 'wp-assets');
    if (existsSync(projects)) return projects;
  }

  return '';
}

function getDevBranchLabel(envPort?: string): string {
  try {
    const branch = execFileSync(
      BUILD_SOURCE_GIT_EXECUTABLE,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf-8' }
    ).trim();
    let shortSha = '';
    try {
      shortSha = execFileSync(BUILD_SOURCE_GIT_EXECUTABLE, ['rev-parse', '--short=7', 'HEAD'], {
        encoding: 'utf-8',
      }).trim();
    } catch {
      shortSha = '';
    }
    const port = process.env.DESKTOP_DEV_PORT || envPort || '';
    const worktreeBase = basename(resolve(__dirname, '../..'));
    const label = normalizeDevInstanceLabel(branch, worktreeBase);
    return formatDevAppBarChip({ label, port: port || null, shortSha });
  } catch {
    return '';
  }
}

function getDevBadgeLabel(mode: string): string {
  if (mode === 'test' || process.env.DNAFORGE_RELEASE_BUILD === '1') return '';
  try {
    const branch = execFileSync(
      BUILD_SOURCE_GIT_EXECUTABLE,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf-8' }
    ).trim();
    const worktreeBase = basename(resolve(__dirname, '../..'));
    return normalizeDevInstanceLabel(branch, worktreeBase, 64);
  } catch {
    return '';
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

export default defineConfig(({ mode, command }) => {
  process.env.VITE_DNAFORGE_AUTOMATION_ISOLATED = process.env.DNAFORGE_AUTOMATION_CONTEXT
    ? '1'
    : '0';
  if (command === 'serve') {
    assertBackgroundElectronLaunchProtected(process.env);
  }
  if (command === 'build') {
    execFileSync(
      process.execPath,
      [resolve(__dirname, 'scripts/dev-single-instance-guard.cjs'), '--assert-stopped'],
      { cwd: __dirname, stdio: 'inherit' }
    );
  }
  const repoRoot = resolve(__dirname, '../..');
  const { env, envDir } = resolveElectronViteBuildEnvironment({
    mode,
    repoRoot,
    qualification: process.env.DNAFORGE_TAB_MEMORY_QUALIFICATION === '1',
    processEnvironment: process.env,
  });
  const sourceCommit = execFileSync(BUILD_SOURCE_GIT_EXECUTABLE, ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const appBuildIdentity = createAppBuildIdentity({
    command,
    mode,
    version: pkg.version,
    sourceCommit,
    sourceDescription:
      process.env.DNAFORGE_RELEASE_BUILD === '1'
        ? null
        : readDesktopSourceDescription(repoRoot, sourceCommit),
    sourceModified:
      execFileSync(
        BUILD_SOURCE_GIT_EXECUTABLE,
        [
          'status',
          '--porcelain=v1',
          '--untracked-files=normal',
          '--',
          ...RUNTIME_SOURCE_FINGERPRINT_GIT_PATHS,
          ...RUNTIME_SOURCE_FINGERPRINT_FILE_PATHS,
        ],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
      ).trim().length > 0,
    releaseBuild: process.env.DNAFORGE_RELEASE_BUILD,
    buildTag: process.env.DNAFORGE_BUILD_TAG,
  });
  const runtimeSourceFingerprint = getRuntimeSourceFingerprint(repoRoot, mode);
  const sidecarSourceFingerprint = computeSidecarSourceHash(repoRoot).sourceHash;
  const enableDevAIEnvKeys =
    mode !== 'production' &&
    isTruthyEnv(
      env.VITE_DNAFORGE_ENABLE_DEV_AI_ENV_KEYS || process.env.VITE_DNAFORGE_ENABLE_DEV_AI_ENV_KEYS
    );
  const readDevAIEnvKey = (name: string) =>
    resolveDevAiEnvKey(name, {
      enabled: enableDevAIEnvKeys,
      fileEnv: env,
      processEnv: process.env,
    });

  const wpAssetsPath =
    mode === 'development' || mode === 'test'
      ? env.VITE_WP_ASSETS_PATH || resolveWpAssetsPath()
      : '';
  const testFixturesPath =
    mode === 'development' || mode === 'test' ? resolve(repoRoot, 'test-fixtures') : '';
  const humanFixturesPath =
    mode === 'development' || mode === 'test'
      ? resolve(repoRoot, 'test-fixtures/genomes/human')
      : '';
  const macTeamIdCutoverEnabled = isTruthyEnv(
    env.DNAFORGE_MAC_TEAM_ID_CUTOVER || process.env.DNAFORGE_MAC_TEAM_ID_CUTOVER
  );
  const releaseBHostedAuthority = releaseBHostedAuthorityFromEnv(
    process.env.DNAFORGE_RELEASE_B_HOSTED,
    process.env.DNAFORGE_HOSTED_AI_GATEWAY_URL
  );
  const hostedAiBuildPolicy = resolveHostedAiBuildPolicy({
    mode,
    releaseBuild: process.env.DNAFORGE_RELEASE_BUILD,
    releaseADisabledAcknowledgement: process.env.DNAFORGE_HOSTED_AI_RELEASE_A_DISABLED,
    releaseBHosted: releaseBHostedAuthority.enabled,
    configuredGatewayUrl: releaseBHostedAuthority.enabled
      ? releaseBHostedAuthority.gatewayOrigin
      : process.env.DNAFORGE_HOSTED_AI_GATEWAY_URL,
  });

  const moduleGraph = createElectronModuleGraph({
    repoRoot,
    outDir: resolve(__dirname, 'out/module-graph'),
    mode,
  });
  const releaseBoundary = createReleaseBundleBoundary({ repoRoot });

  return {
    main: {
      envDir,
      define: {
        __DEV_WP_ASSETS_PATH__: JSON.stringify(wpAssetsPath),
        __DEV_TEST_FIXTURES_PATH__: JSON.stringify(
          testFixturesPath && existsSync(testFixturesPath) ? testFixturesPath : ''
        ),
        __DEV_HUMAN_FIXTURES_PATH__: JSON.stringify(
          humanFixturesPath && existsSync(humanFixturesPath) ? humanFixturesPath : ''
        ),
        __APP_VERSION__: JSON.stringify(appBuildIdentity.version ?? 'unknown'),
        __DNAFORGE_APP_BUILD__: JSON.stringify(appBuildIdentity),
        __DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID__: JSON.stringify(
          process.env.DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_ID ?? ''
        ),
        __DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_SECRET__: JSON.stringify(
          process.env.DNAFORGE_GOOGLE_SHEETS_DESKTOP_CLIENT_SECRET ?? ''
        ),
        __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN ?? ''),
        __DNAFORGE_DEV_BADGE_LABEL__: JSON.stringify(getDevBadgeLabel(mode)),
        __WAYPOINT_BUILD_SOURCE_FINGERPRINT__: JSON.stringify(runtimeSourceFingerprint),
        __WAYPOINT_SIDECAR_SOURCE_FINGERPRINT__: JSON.stringify(sidecarSourceFingerprint),
        __DNAFORGE_MAC_TEAM_ID_CUTOVER__: JSON.stringify(macTeamIdCutoverEnabled),
        __DNAFORGE_RELEASE_BUILD__: JSON.stringify(
          releaseBuildStampFromEnv(process.env.DNAFORGE_RELEASE_BUILD)
        ),
        __DNAFORGE_DISTRIBUTION__: JSON.stringify(buildDistribution),
        __DNAFORGE_SOURCE_COMMIT__: JSON.stringify(
          mode === 'test' ? '' : sourceCommitStamp(sourceCommit)
        ),
        __DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH__: JSON.stringify(
          mode === 'test'
            ? ''
            : qualificationEphemeralAuthStampFromEnv(
                process.env.DNAFORGE_QUALIFICATION_EPHEMERAL_AUTH,
                sourceCommit,
                releaseBHostedAuthority
              )
        ),
        __POSTHOG_API_KEY__: JSON.stringify(process.env.POSTHOG_API_KEY ?? ''),
        __POSTHOG_HOST__: JSON.stringify(process.env.POSTHOG_HOST ?? ''),
        __DNAFORGE_RELEASE_CHANNEL__: JSON.stringify(process.env.DNAFORGE_RELEASE_CHANNEL ?? ''),
        __DNAFORGE_BUILD_TAG__: JSON.stringify(
          telemetryBuildTagStampFromEnv(process.env.DNAFORGE_BUILD_TAG)
        ),
        __DNAFORGE_TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY__: JSON.stringify(
          sealTelemetryActorAssertionPublicKey(process.env.TELEMETRY_ACTOR_ASSERTION_PUBLIC_KEY)
        ),
        __UPDATE_FEED_BASE__: JSON.stringify(compiledUpdateFeedBase),
        __UPDATE_FEED_BASES__: JSON.stringify(compiledUpdateFeedBases),
        __UPDATE_FEED_AUTHORITY_STAMP__: JSON.stringify(compiledUpdateAuthorityStamp),
        __DNAFORGE_RELEASE_B_HOSTED__: JSON.stringify(releaseBHostedAuthority.stamp),
        __DNAFORGE_HOSTED_AI_GATEWAY_URL__: JSON.stringify(hostedAiBuildPolicy.gatewayUrl),
        __DNAFORGE_HOSTED_AI_GATEWAY_MARKER__: JSON.stringify(hostedAiBuildPolicy.gatewayMarker),
        __DNAFORGE_HOSTED_AI_RELEASE_A_MARKER__: JSON.stringify(hostedAiBuildPolicy.mainMarker),
        __DNAFORGE_PACKAGED_AUTH_ORIGIN__: JSON.stringify(hostedAiBuildPolicy.packagedAuthOrigin),
        __DNAFORGE_PACKAGED_AUTH_MARKER__: JSON.stringify(hostedAiBuildPolicy.packagedAuthMarker),
        __INTERNAL_FIXTURES_ENABLED__: JSON.stringify(mode === 'development' || mode === 'test'),
      },
      plugins: [
        appBuildIdentityPlugin(appBuildIdentity),
        sequenceWheelNative(),
        patchSentryRITM(),
        injectDirnameShim(),
        ...(mode === 'development' || mode === 'test' ? [] : [disableInternalFixtureMainIpc()]),
        moduleGraph('main'),
        releaseBoundary('main'),
      ],
      build: {
        externalizeDeps: false,
        sourcemap: process.env.DNAFORGE_POSTHOG_SOURCE_MAPS === '1',
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/bootstrap.ts'),
          },
          external: MAIN_EXTERNALS,
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: (chunk) => {
              const ids = [
                chunk.facadeModuleId,
                ...(('moduleIds' in chunk ? chunk.moduleIds : []) ?? []),
              ];
              const isProductMain = ids.some(
                (id) =>
                  String(id ?? '').replaceAll('\\', '/') ===
                  resolve(__dirname, 'src/main/index.ts').replaceAll('\\', '/')
              );
              return isProductMain ? 'product-[hash].js' : 'chunks/[name]-[hash].js';
            },
          },
        },
      },
    },
    preload: {
      envDir,
      plugins: [
        ...(command === 'serve' && mode === 'development'
          ? [nativeBuildCachePlugin({ appDir: __dirname, repoRoot: resolve(__dirname, '../..') })]
          : []),
        externalizeDepsPlugin({
          exclude: [
            '@waypoint/domain-services',
            '@waypoint/scientific-artifacts',
            '@waypoint/sequence-utils',
            '@waypoint/user-messages',
          ],
        }),
        moduleGraph('preload'),
        releaseBoundary('preload'),
      ],
      build: {
        sourcemap: process.env.DNAFORGE_POSTHOG_SOURCE_MAPS === '1',
        rollupOptions: {
          output: {
            format: 'cjs',
            entryFileNames: '[name].js',
          },
        },
      },
    },
    renderer: {
      envDir,
      root: '.',
      worker: {
        format: 'iife',
        plugins: () => [moduleGraph('renderer-worker'), releaseBoundary('renderer-worker')],
      },
      server: devServerNetwork(env.DESKTOP_DEV_PORT, env.DESKTOP_HMR_PORT),
      build: {
        outDir: resolve(__dirname, 'out/renderer'),
        sourcemap: process.env.DNAFORGE_POSTHOG_SOURCE_MAPS === '1',
        rollupOptions: {
          input: resolve(__dirname, 'index.html'),
        },
      },
      define: createRendererDefines({
        enableDevAiEnvKeys: enableDevAIEnvKeys,
        anthropicApiKey: readDevAIEnvKey('ANTHROPIC_API_KEY'),
        openaiApiKey: readDevAIEnvKey('OPENAI_API_KEY'),
        googleApiKey: readDevAIEnvKey('GOOGLE_API_KEY'),
        xaiApiKey: readDevAIEnvKey('XAI_API_KEY'),
        deepseekApiKey: readDevAIEnvKey('DEEPSEEK_API_KEY'),
        devBranchLabel:
          mode === 'development' || mode === 'test'
            ? getDevBranchLabel(env.DESKTOP_DEV_PORT || process.env.DESKTOP_DEV_PORT)
            : '',
        wpAssetsPath,
        testFixturesPath: testFixturesPath && existsSync(testFixturesPath) ? testFixturesPath : '',
        humanFixturesPath:
          humanFixturesPath && existsSync(humanFixturesPath) ? humanFixturesPath : '',
        appVersion: appBuildIdentity.version ?? 'unknown',
        appBuildIdentity,
        buildSourceFingerprint: runtimeSourceFingerprint,
        proteinWorkerSourceSha256: createHash('sha256')
          .update(readFileSync(resolve(__dirname, 'src/main/protein-experiment-workers.ts')))
          .digest('hex'),
        macTeamIdCutoverEnabled,
        macTeamIdCutoverMarker: macTeamIdCutoverRendererMarker(macTeamIdCutoverEnabled),
        hostedAiEnabled: hostedAiBuildPolicy.enabled,
        hostedAiMarker: hostedAiBuildPolicy.rendererMarker,
      }),
      resolve: {
        alias: {
          '@': resolve('src'),
          '@waypoint/platform': resolve('../../packages/core/platform/src'),
          '@waypoint/sequence-utils': resolve('../../packages/core/sequence-utils/src'),
          '@waypoint/genome-renderer/react': resolve(
            '../../packages/core/genome-renderer/src/react/index.ts'
          ),
          '@waypoint/genome-renderer': resolve('../../packages/core/genome-renderer/src'),
          '@waypoint/workspace-editor/shift-click-range': resolve(
            '../../packages/core/workspace-editor/src/selection-model.ts'
          ),
          '@waypoint/workspace-editor/find-bar': resolve(
            '../../packages/core/workspace-editor/src/FindBar.tsx'
          ),
          '@waypoint/plasmid-viewer': resolve('../../packages/features/plasmid-viewer/src'),
          '@waypoint/ui-components': resolve('../../packages/ui/components/src'),
        },
        dedupe: ['react', 'react-dom'],
      },
      optimizeDeps: {
        include: [...MOLSTAR_OPTIMIZE_DEPS, ...INDEXED_TRACK_DEV_OPTIMIZE_DEPS],
      },
      plugins: [
        fixtureEnzymeModule(),
        react(),
        moduleGraph('renderer'),
        releaseBoundary('renderer'),
      ],
    },
  };
});
