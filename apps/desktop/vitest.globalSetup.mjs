import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default async function setup(project) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, 'scripts', 'install-test-sqlite.cjs');
  try {
    execFileSync(process.execPath, [script], { stdio: 'inherit' });
  } catch (err) {
    console.warn(
      '\n[vitest globalSetup] Could not prepare the locked better-sqlite3 test binding; ' +
        'DB-backed tests will fail until it is installed.\n' +
        '  Fix: node apps/desktop/scripts/install-test-sqlite.cjs\n' +
        `  Cause: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
  const corpusSidecar = path.join(here, 'scripts', 'assembly-corpus-sidecar.mjs');
  if (!existsSync(corpusSidecar)) return undefined;
  const { setupAssemblyCorpusSidecar } = await import(pathToFileURL(corpusSidecar).href);
  return setupAssemblyCorpusSidecar(project, here);
}
