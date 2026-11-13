import { defineConfig } from 'vitest/config';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import {
  createRendererDefines,
  testRendererDefineValues,
} from './src/shared/renderer-build-defines';

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function looksLikeRealKey(key: string): boolean {
  if (!key || key.length < 10) return false;
  const lower = key.toLowerCase();
  return !lower.includes('your-') && !lower.includes('paste-') && !lower.includes('-here');
}

const API_KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
] as const;

export default defineConfig(() => {
  const monorepoRoot = path.resolve(__dirname, '../..');

  const envFiles = [
    path.resolve(monorepoRoot, '.env.local'),
    path.resolve(monorepoRoot, '.env'),
    path.resolve(monorepoRoot, '..', 'waypoint', '.env.local'),
    path.resolve(monorepoRoot, '..', 'waypoint', '.env'),
  ];

  const testEnv: Record<string, string> = {};
  for (const key of API_KEY_VARS) {
    for (const file of envFiles) {
      const env = parseEnvFile(file);
      if (env[key] && looksLikeRealKey(env[key])) {
        testEnv[key] = env[key];
        break;
      }
    }
    if (!testEnv[key]) {
      const fromProcess = process.env[key];
      if (fromProcess && looksLikeRealKey(fromProcess)) {
        testEnv[key] = fromProcess;
      } else {
        testEnv[key] = '';
      }
    }
  }

  return {
    define: createRendererDefines(testRendererDefineValues()),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    test: {
      include: ['src/features/ai/__tests__/integration/**/*.test.ts'],
      testTimeout: 30000,
      hookTimeout: 30000,
      env: testEnv,
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
    },
  };
});
