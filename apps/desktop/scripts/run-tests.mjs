import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FULL_ASSEMBLY_CATALOG_TESTS, assemblyCatalogBase } from './assembly-catalog-tests.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const COORDINATOR_HEAP = '--max-old-space-size=4096';

function withCoordinatorHeap(nodeOptions = '') {
  return /--max-old-space-size=/u.test(nodeOptions)
    ? nodeOptions
    : `${nodeOptions} ${COORDINATOR_HEAP}`.trim();
}

export async function runDesktopTests(args, { spawnImpl = spawnSync } = {}) {
  let fullCatalog = false;
  const focused = args.some((arg) => !arg.startsWith('-') && /(?:\.test\.|src\/)/u.test(arg));
  if (!focused) {
    const base = spawnImpl('git', ['merge-base', 'HEAD', 'origin/dev'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const baseSha = base.status === 0 ? String(base.stdout).trim() : undefined;
    const changed = baseSha
      ? spawnImpl('git', ['diff', '--name-only', baseSha], { cwd: repoRoot, encoding: 'utf8' })
      : null;
    if (changed && changed.status !== 0) throw new Error('Cannot determine assembly test inputs');
    const catalogBase = assemblyCatalogBase(
      baseSha,
      String(changed?.stdout ?? '')
        .split('\n')
        .filter(Boolean)
    );
    if (catalogBase !== undefined && !/^[0-9a-f]{40}$/iu.test(catalogBase)) {
      throw new Error('Assembly test base must be an exact 40-character SHA');
    }
    const listed = spawnImpl(
      'pnpm',
      [
        'exec',
        'vitest',
        'list',
        '--filesOnly',
        ...(catalogBase === undefined ? [] : [`--changed=${catalogBase}`]),
        ...FULL_ASSEMBLY_CATALOG_TESTS,
        '--no-color',
      ],
      { cwd: desktopRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    if (listed.error || listed.signal || listed.status !== 0) {
      throw new Error(
        `Assembly test discovery failed: ${String(listed.stderr ?? listed.error?.message ?? listed.signal ?? listed.status)}`
      );
    }
    const selected = String(listed.stdout ?? '')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const allowed = new Set(
      FULL_ASSEMBLY_CATALOG_TESTS.map((file) => path.resolve(desktopRoot, file))
    );
    if (selected.some((file) => !allowed.has(path.resolve(desktopRoot, file)))) {
      throw new Error('Assembly test discovery returned an unexpected file');
    }
    fullCatalog = selected.length > 0;
  }
  const result = spawnImpl('pnpm', ['exec', 'vitest', 'run', ...args], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: withCoordinatorHeap(process.env.NODE_OPTIONS),
      ...(fullCatalog ? { DNAFORGE_FULL_ASSEMBLY_CATALOG_TESTS: '1' } : {}),
    },
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runDesktopTests(process.argv.slice(2).filter((arg) => arg !== '--'))
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
