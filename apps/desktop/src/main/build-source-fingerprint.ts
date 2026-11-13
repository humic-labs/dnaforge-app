import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BuildSourceFingerprintDeps {
  gitOutput(repoRoot: string, args: string[]): string;
  readText(repoRoot: string, relativePath: string): string | null;
}

export const BUILD_SOURCE_GIT_EXECUTABLE =
  process.platform === 'win32' ? 'git.exe' : '/usr/bin/git';

export const RUNTIME_SOURCE_FINGERPRINT_GIT_PATHS = [
  'apps/api/src',
  'apps/api/run_server.py',
  'apps/desktop/src',
  'apps/desktop/native',
  'apps/desktop/electron.vite.config.ts',
  'apps/desktop/vite.renderer.config.ts',
  'apps/desktop/tsconfig.json',
  'apps/desktop/tsconfig.node.json',
  'packages/core/genome-data/src',
  'packages/core/genome-renderer/src',
  'packages/core/sequence-utils/src',
  'packages/core/workspace-editor/src',
  'packages/features/plasmid-viewer/src',
  'packages/ui/components/src',
] as const;

export const RUNTIME_SOURCE_FINGERPRINT_FILE_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'apps/desktop/package.json',
  'apps/desktop/scripts/build-sequence-wheel.cjs',
  'apps/api/pyproject.toml',
  'apps/api/uv.lock',
  'apps/desktop/resources/sample-workspaces/standard-samples/workspace/sequences/plasmids/pUC19/pUC19.gb',
  'test-fixtures/demo-workspace/assembly-demo/README.md',
  'test-fixtures/demo-workspace/assembly-demo/plasmids/pEGFP-N1.gb',
  'test-fixtures/demo-workspace/assembly-demo/plasmids/pTRE.gb',
  'test-fixtures/demo-workspace/assembly-demo/plasmids/pUC19-DsRed.gb',
  'test-fixtures/demo-workspace/assembly-demo/plasmids/pACYC177.gb',
  'test-fixtures/demo-workspace/assembly-demo/plasmids/pUC19.gb',
  'test-fixtures/import-formats/S288C_YBR160W_CDC28_coding.dnas',
  'test-fixtures/sequences/circular/homing-endo-targets-synthetic.gb',
  'test-fixtures/sequences/circular/pUC19.gb',
  'test-fixtures/sequences/linear/ecoli-mg1655-region.gb',
  'test-fixtures/sequences/linear/mg1655-thrL-multi-xref-synthetic.gb',
  'packages/core/genome-data/package.json',
  'packages/core/genome-renderer/package.json',
  'packages/core/sequence-utils/package.json',
  'packages/core/workspace-editor/package.json',
  'packages/features/plasmid-viewer/package.json',
  'packages/ui/components/package.json',
] as const;

const DEFAULT_DEPS: BuildSourceFingerprintDeps = {
  gitOutput(repoRoot, args) {
    return execFileSync(BUILD_SOURCE_GIT_EXECUTABLE, args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
  },
  readText(repoRoot, relativePath) {
    try {
      return readFileSync(resolve(repoRoot, relativePath), 'utf-8');
    } catch {
      return null;
    }
  },
};

function chunk(kind: string, key: string, value: string | null): string {
  return JSON.stringify([kind, key, value]);
}

export function computeRuntimeSourceFingerprint(input: {
  repoRoot: string;
  mode: string;
  deps?: BuildSourceFingerprintDeps;
}): string {
  const deps = input.deps ?? DEFAULT_DEPS;
  const gitPaths = [...RUNTIME_SOURCE_FINGERPRINT_GIT_PATHS];
  const contentAddressedTestBuild = input.mode === 'test';
  const chunks = [
    chunk('schema', 'runtime-source-fingerprint', '5'),
    chunk('mode', 'electron-vite', input.mode),
    chunk(
      'git',
      'tracked-tree',
      deps.gitOutput(input.repoRoot, ['ls-files', '--stage', '--', ...gitPaths])
    ),
    chunk(
      'git',
      'worktree-diff',
      deps.gitOutput(input.repoRoot, [
        'diff',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--',
        ...gitPaths,
      ])
    ),
    chunk(
      'git',
      'staged-diff',
      deps.gitOutput(input.repoRoot, [
        'diff',
        '--cached',
        '--binary',
        '--full-index',
        '--no-ext-diff',
        '--',
        ...gitPaths,
      ])
    ),
  ];
  if (!contentAddressedTestBuild) {
    chunks.push(chunk('git', 'HEAD', deps.gitOutput(input.repoRoot, ['rev-parse', 'HEAD'])));
  }

  const untrackedRuntimePaths = deps
    .gitOutput(input.repoRoot, ['ls-files', '--others', '--exclude-standard', '--', ...gitPaths])
    .split(/\r?\n/)
    .map((relativePath) => relativePath.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  for (const relativePath of untrackedRuntimePaths) {
    chunks.push(
      chunk('untracked-runtime-source', relativePath, deps.readText(input.repoRoot, relativePath))
    );
  }

  for (const relativePath of RUNTIME_SOURCE_FINGERPRINT_FILE_PATHS) {
    chunks.push(chunk('file', relativePath, deps.readText(input.repoRoot, relativePath)));
  }

  return createHash('sha256').update(chunks.join('\0')).digest('hex');
}

export function getRuntimeSourceFingerprint(repoRoot: string, mode: string): string {
  return computeRuntimeSourceFingerprint({ repoRoot, mode });
}
