import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import type { Plugin, ResolvedConfig } from 'vite';

export const ELECTRON_MODULE_GRAPH_SCHEMA_VERSION = 1;

export type ElectronModuleGraphTarget = 'main' | 'preload' | 'renderer' | 'renderer-worker';

export function repositoryModulePaths(moduleIds: Iterable<string>, repoRoot: string): string[] {
  const paths = new Set<string>();
  for (const id of moduleIds) {
    if (id.startsWith('\0')) continue;
    const file = id.split('?')[0];
    const repoPath = relative(repoRoot, file).split(sep).join('/');
    if (!repoPath || repoPath.startsWith('..') || repoPath.startsWith('/')) continue;
    if (repoPath.split('/').includes('node_modules')) continue;
    paths.add(repoPath);
  }
  return [...paths].sort();
}

export function createElectronModuleGraph({
  repoRoot,
  outDir,
  mode,
}: {
  repoRoot: string;
  outDir: string;
  mode: string;
}): (target: ElectronModuleGraphTarget) => Plugin {
  const modulesByTarget = new Map<ElectronModuleGraphTarget, Set<string>>();
  let configurationInputs: Promise<string[]> | undefined;
  const configurationFiles = () => {
    configurationInputs ??= (async () => {
      const configFile = join(repoRoot, 'apps/desktop/electron.vite.config.ts');
      if (mode !== 'development' || !existsSync(configFile)) return [];
      const { loadConfigFromFile } = await import('electron-vite');
      const loaded = await loadConfigFromFile(
        { command: 'serve', mode },
        configFile,
        join(repoRoot, 'apps/desktop'),
        'silent'
      );
      const require = createRequire(configFile);
      const commonJsInputs = Object.keys(require.cache).filter(
        (file) =>
          file.startsWith(repoRoot + sep) &&
          !relative(repoRoot, file).split(sep).includes('node_modules')
      );
      return [loaded.path, ...loaded.dependencies.map((file) => resolve(file)), ...commonJsInputs];
    })();
    return configurationInputs;
  };
  return (target) => {
    let config: ResolvedConfig;
    let compiledSourceCommit: string;
    let configurationDependencies: string[];
    return {
      name: `dnaforge-electron-module-graph:${target}`,
      apply: (_config, env) =>
        env.command === 'build' &&
        (env.mode === 'test' ||
          (env.mode === 'development' && ['main', 'preload'].includes(target))),
      async configResolved(resolved) {
        config = resolved;
        configurationDependencies = await configurationFiles();
        compiledSourceCommit = execFileSync(
          process.platform === 'win32' ? 'git.exe' : '/usr/bin/git',
          ['-c', `core.worktree=${repoRoot}`, '-C', repoRoot, 'rev-parse', 'HEAD'],
          { encoding: 'utf8' }
        ).trim();
      },
      generateBundle() {
        const modules = modulesByTarget.get(target) ?? new Set<string>();
        const bundled = [...this.getModuleIds()].filter(
          (id) => !this.getModuleInfo(id)?.isExternal
        );
        for (const repoPath of repositoryModulePaths(bundled, repoRoot)) modules.add(repoPath);
        modulesByTarget.set(target, modules);
        const inputFiles = [
          ...new Set([
            ...bundled.filter((id) => !id.startsWith('\0')).map((id) => id.split('?')[0]),
            ...(config.configFile ? [config.configFile] : []),
            ...config.configFileDependencies,
            ...configurationDependencies,
          ]),
        ]
          .filter((file) => existsSync(file) && statSync(file).isFile())
          .sort();
        const inputs = inputFiles.map((file) => [
          file,
          createHash('sha256').update(readFileSync(file)).digest('hex'),
        ]);
        const defined = (key: string) => {
          try {
            return JSON.parse(config.define?.[key] ?? 'null');
          } catch {
            return null;
          }
        };
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          join(outDir, `${target}.json`),
          `${JSON.stringify(
            {
              schemaVersion: ELECTRON_MODULE_GRAPH_SCHEMA_VERSION,
              target,
              mode,
              modules: [...modules].sort(),
              inputs,
              compiledSourceCommit,
              buildSourceFingerprint: defined('__WAYPOINT_BUILD_SOURCE_FINGERPRINT__'),
              sidecarSourceFingerprint: defined('__WAYPOINT_SIDECAR_SOURCE_FINGERPRINT__'),
            },
            null,
            2
          )}\n`
        );
      },
    };
  };
}
