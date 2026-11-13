import { dirname, resolve } from 'path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { hostedOfflinePlugin } from './scripts/hosted-offline-plugin';
import { resolveDevAiEnvKey } from './src/shared/dev-ai-env-keys';
import {
  createRendererDefines,
  macTeamIdCutoverRendererMarker,
  testRendererDefineValues,
} from './src/shared/renderer-build-defines';
import { INDEXED_TRACK_DEV_OPTIMIZE_DEPS } from './src/shared/indexed-track-dev-optimization';

function isTruthyEnv(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

function normalizeHostedPublicBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/gu, '')}/`;
}

export function hostedElectronSessionAlias(mode: string) {
  const hostedSession = resolve(__dirname, 'src/features/workspace-session/hosted-session.ts');
  const isElectronSession = (id: string) => {
    const normalized = id.replace(/\\/gu, '/');
    return /workspace-session\/(?:public\/)?electron-session(?:\.ts)?$/u.test(normalized);
  };
  return {
    name: 'hosted-electron-session-alias',
    enforce: 'pre' as const,
    resolveId(id: string, importer?: string) {
      if (mode !== 'hosted') return null;
      const normalized = id.replace(/\\/gu, '/');
      const resolvedId =
        importer && normalized.startsWith('.')
          ? resolve(dirname(importer.replace(/\\/gu, '/')), normalized)
          : normalized;
      if (!isElectronSession(resolvedId)) return null;
      return hostedSession;
    },
    generateBundle(_options: unknown, bundle: Record<string, { type: string; code?: string }>) {
      if (mode !== 'hosted') return;
      const leaked = Object.values(bundle).some(
        (chunk) =>
          chunk.type === 'chunk' &&
          typeof chunk.code === 'string' &&
          chunk.code.includes('Workspace resource identity conflicts at')
      );
      if (leaked) {
        throw new Error(
          'Hosted build included the Electron workspace runtime. electron-session must resolve to hosted-session.ts.'
        );
      }
    },
  };
}

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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackHttpOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return origin.protocol === 'http:' && LOOPBACK_HOSTS.has(origin.hostname);
  } catch {
    return false;
  }
}

function localNextOrigin(webOrigin: string): string | null {
  if (!isLoopbackHttpOrigin(webOrigin)) return null;
  const target = new URL(webOrigin);
  return `http://localhost${target.port ? `:${target.port}` : ''}`;
}

function configureLocalNextOrigin(
  webOrigin: string
): NonNullable<ProxyOptions['configure']> | undefined {
  const targetOrigin = localNextOrigin(webOrigin);
  if (!targetOrigin) return undefined;
  return (proxy) => {
    proxy.on('proxyReq', (proxyReq, request) => {
      const browserOrigin = request.headers.origin;
      if (typeof browserOrigin !== 'string' || !isLoopbackHttpOrigin(browserOrigin)) return;
      proxyReq.setHeader('origin', targetOrigin);
    });
  };
}

export default defineConfig(({ mode, command }) => {
  const hostedProductionBuild = mode === 'hosted' && command === 'build';
  if (hostedProductionBuild) {
    process.env.NODE_ENV = 'production';
  }
  const env = loadEnv(mode, resolve(__dirname, '../..'), '');
  const hostedPublicBasePath = normalizeHostedPublicBasePath(process.env.HOSTED_RENDERER_BASE_PATH);
  const hostedOutputDirectory = process.env.HOSTED_RENDERER_OUT_DIR || 'out/hosted';
  const webOrigin =
    env.WAYPOINT_WEB_ORIGIN ||
    process.env.WAYPOINT_WEB_ORIGIN ||
    `http://127.0.0.1:${env.WEB_DEV_PORT || process.env.WEB_DEV_PORT || '3108'}`;
  const enableDevAIEnvKeys =
    mode !== 'production' &&
    !hostedProductionBuild &&
    isTruthyEnv(
      env.VITE_DNAFORGE_ENABLE_DEV_AI_ENV_KEYS || process.env.VITE_DNAFORGE_ENABLE_DEV_AI_ENV_KEYS
    );
  const macTeamIdCutoverEnabled = isTruthyEnv(
    env.DNAFORGE_MAC_TEAM_ID_CUTOVER || process.env.DNAFORGE_MAC_TEAM_ID_CUTOVER
  );
  const readDevAIEnvKey = (name: string, fallback = '') =>
    resolveDevAiEnvKey(
      name,
      { enabled: enableDevAIEnvKeys, fileEnv: env, processEnv: process.env },
      fallback
    );
  const configureNextOrigin = configureLocalNextOrigin(webOrigin);
  const nextProxy = () => ({
    target: webOrigin,
    changeOrigin: false,
    ...(configureNextOrigin ? { configure: configureNextOrigin } : {}),
  });
  const hostedProxy = {
    '/api': nextProxy(),
    '/auth': nextProxy(),
    '/login': nextProxy(),
    '/register': nextProxy(),
    '/onboarding': nextProxy(),
    '/try': nextProxy(),
    '/demo-projects': nextProxy(),
    '/v1': {
      target: process.env.DNAFORGE_HOSTED_AI_GATEWAY_URL || webOrigin,
      changeOrigin: true,
      timeout: 4_000,
    },
    '/_next': { target: webOrigin, changeOrigin: true, ws: true },
    '/reference-genomes': {
      target: process.env.DNAFORGE_HOSTED_REFERENCE_ORIGIN || 'https://references.dnaforge.com',
      changeOrigin: true,
    },
  };

  return {
    root: __dirname,
    base: mode === 'hosted' ? hostedPublicBasePath : '/',
    define: {
      ...createRendererDefines(
        testRendererDefineValues({
          enableDevAiEnvKeys: enableDevAIEnvKeys,
          anthropicApiKey: readDevAIEnvKey(
            'ANTHROPIC_API_KEY',
            process.env.CI ? 'sk-ant-e2e-test-key-not-real' : ''
          ),
          openaiApiKey: readDevAIEnvKey('OPENAI_API_KEY'),
          googleApiKey: readDevAIEnvKey('GOOGLE_API_KEY'),
          xaiApiKey: readDevAIEnvKey('XAI_API_KEY'),
          deepseekApiKey: readDevAIEnvKey('DEEPSEEK_API_KEY'),
          buildSourceFingerprint: 'standalone-renderer-config',
          proteinWorkerSourceSha256: createHash('sha256')
            .update(readFileSync(resolve(__dirname, 'src/main/protein-experiment-workers.ts')))
            .digest('hex'),
          macTeamIdCutoverEnabled,
          macTeamIdCutoverMarker: macTeamIdCutoverRendererMarker(macTeamIdCutoverEnabled),
        })
      ),
      ...(hostedProductionBuild
        ? {
            'import.meta.env.DEV': 'false',
            'import.meta.env.PROD': 'true',
            'process.env.NODE_ENV': '"production"',
          }
        : {}),
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@waypoint/sequence-utils': resolve(__dirname, '../../packages/core/sequence-utils/src'),
        '@waypoint/genome-renderer/react': resolve(
          __dirname,
          '../../packages/core/genome-renderer/src/react/index.ts'
        ),
        '@waypoint/genome-renderer': resolve(__dirname, '../../packages/core/genome-renderer/src'),
        '@waypoint/workspace-editor/shift-click-range': resolve(
          __dirname,
          '../../packages/core/workspace-editor/src/selection-model.ts'
        ),
        '@waypoint/workspace-editor/find-bar': resolve(
          __dirname,
          '../../packages/core/workspace-editor/src/FindBar.tsx'
        ),
        '@waypoint/plasmid-viewer': resolve(
          __dirname,
          '../../packages/features/plasmid-viewer/src'
        ),
        '@waypoint/ui-components': resolve(__dirname, '../../packages/ui/components/src'),
        ...(mode === 'hosted'
          ? {
              [resolve(__dirname, 'src/features/workspace-session/electron-session.ts')]: resolve(
                __dirname,
                'src/features/workspace-session/hosted-session.ts'
              ),
              [resolve(__dirname, 'src/features/workspace-session/electron-session')]: resolve(
                __dirname,
                'src/features/workspace-session/hosted-session.ts'
              ),
            }
          : {}),
      },
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      include:
        mode === 'hosted' ? [] : [...MOLSTAR_OPTIMIZE_DEPS, ...INDEXED_TRACK_DEV_OPTIMIZE_DEPS],
    },
    build:
      mode === 'hosted'
        ? {
            outDir: hostedOutputDirectory,
            emptyOutDir: true,
            rollupOptions: { input: resolve(__dirname, 'hosted.html') },
          }
        : undefined,
    server: {
      proxy: hostedProxy,
    },
    preview: {
      proxy: hostedProxy,
      ...(mode === 'hosted' ? { headers: { 'Service-Worker-Allowed': '/' } } : {}),
    },
    plugins: [
      hostedElectronSessionAlias(mode),
      react(),
      ...(mode === 'hosted' ? [hostedOfflinePlugin(hostedPublicBasePath)] : []),
    ],
  };
});
