import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import type { DnaforgeSkillPackDefinition } from './skill-catalog';

const FIXTURE_REVISION = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

export const E2E_BIOLOGY_SKILL_PACK: DnaforgeSkillPackDefinition = {
  id: 'fixture-biology',
  name: 'Fixture Biology',
  publisher: 'DNAForge E2E',
  description: 'Deterministic biology skills used only by the Electron acceptance suite.',
  repositoryOwner: 'dnaforge-e2e',
  repositoryName: 'biology-skills',
  ref: 'main',
  skillsRoot: 'skills',
  delivery: 'dnaforge',
  trust: 'publisher',
  repositoryLicense: 'MIT',
};

interface FixtureTreeEntry {
  path: string;
  mode: string;
  type: 'blob';
  sha: string;
  size: number;
}

async function collectFiles(root: string, directory = root): Promise<FixtureTreeEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: FixtureTreeEntry[] = [];
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('The E2E skill catalog fixture cannot use links.');
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) continue;
    const metadata = await lstat(absolutePath);
    files.push({
      path: relative(root, absolutePath).split(sep).join('/'),
      mode: metadata.mode & 0o111 ? '100755' : '100644',
      type: 'blob',
      sha: `fixture-${files.length}`,
      size: metadata.size,
    });
  }
  return files;
}

function response(body: string, status = 200, contentType = 'text/plain'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

export function createE2eSkillCatalogFetch(fixtureRoot: string): typeof globalThis.fetch {
  const canonicalRoot = resolve(fixtureRoot);
  return async (input) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const apiRoot = `/repos/${E2E_BIOLOGY_SKILL_PACK.repositoryOwner}/${E2E_BIOLOGY_SKILL_PACK.repositoryName}`;

    let revision = FIXTURE_REVISION;
    try {
      const marker = (await readFile(join(canonicalRoot, '.fixture-revision'), 'utf8')).trim();
      if (!/^[a-f0-9]{40}$/u.test(marker)) throw new Error('Invalid E2E catalog revision');
      revision = marker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (url.hostname === 'api.github.com' && url.pathname === `${apiRoot}/commits/main`) {
      return response(JSON.stringify({ sha: revision }), 200, 'application/json');
    }
    if (
      url.hostname === 'api.github.com' &&
      url.pathname === `${apiRoot}/git/trees/${revision}` &&
      url.searchParams.get('recursive') === '1'
    ) {
      return response(
        JSON.stringify({
          sha: revision,
          truncated: false,
          tree: await collectFiles(canonicalRoot),
        }),
        200,
        'application/json'
      );
    }
    const rawPrefix = `/${E2E_BIOLOGY_SKILL_PACK.repositoryOwner}/${E2E_BIOLOGY_SKILL_PACK.repositoryName}/${revision}/`;
    if (url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith(rawPrefix)) {
      const repositoryPath = decodeURIComponent(url.pathname.slice(rawPrefix.length));
      const absolutePath = resolve(canonicalRoot, repositoryPath);
      if (!absolutePath.startsWith(`${canonicalRoot}${sep}`)) return response('unsafe path', 400);
      try {
        return new Response(await readFile(absolutePath), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      } catch {
        return response('not found', 404);
      }
    }
    return response('not found', 404);
  };
}
