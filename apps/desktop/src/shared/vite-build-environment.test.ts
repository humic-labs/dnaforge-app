// @vitest-environment node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveElectronViteBuildEnvironment } from './vite-build-environment';

const temporaryRoots: string[] = [];

function createEnvironmentRoot(): string {
  const root = path.join(
    tmpdir(),
    `dnaforge-vite-build-environment-${process.pid}-${temporaryRoots.length}`
  );
  mkdirSync(root, { recursive: false });
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveElectronViteBuildEnvironment', () => {
  it('wires the resolved environment directory into all three Electron build targets', () => {
    const configSource = readFileSync(
      path.resolve(import.meta.dirname, '../../electron.vite.config.ts'),
      'utf8'
    );

    expect(configSource).toContain('resolveElectronViteBuildEnvironment');
    expect(configSource.match(/^\s+envDir,\s*$/gmu)).toHaveLength(3);
  });

  it('loads ordinary mode files outside memory qualification', () => {
    const root = createEnvironmentRoot();
    writeFileSync(path.join(root, '.env.test.local'), 'VITE_UNSEALED_CANARY=loaded\n');

    const result = resolveElectronViteBuildEnvironment({
      mode: 'test',
      repoRoot: root,
      qualification: false,
      processEnvironment: {},
    });

    expect(result.envDir).toBe(root);
    expect(result.env.VITE_UNSEALED_CANARY).toBe('loaded');
  });

  it('disables every environment file and uses only controller values during qualification', () => {
    const root = createEnvironmentRoot();
    writeFileSync(path.join(root, '.env'), 'VITE_UNSEALED_CANARY=base\n');
    writeFileSync(path.join(root, '.env.test.local'), 'VITE_UNSEALED_CANARY=mode-local\n');

    const result = resolveElectronViteBuildEnvironment({
      mode: 'test',
      repoRoot: root,
      qualification: true,
      processEnvironment: {
        API_PORT: '8030',
        VITE_API_URL: 'http://127.0.0.1:8030',
      },
    });

    expect(result.envDir).toBe(false);
    expect(result.env).toEqual({
      API_PORT: '8030',
      VITE_API_URL: 'http://127.0.0.1:8030',
    });
    expect(result.env.VITE_UNSEALED_CANARY).toBeUndefined();
  });
});
