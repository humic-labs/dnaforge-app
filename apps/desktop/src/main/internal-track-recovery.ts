import { existsSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

export async function missingInternalTrackPath(
  path: string,
  relativePath: string
): Promise<boolean> {
  if (!isAbsolute(path) || !resolve(path).endsWith(`${sep}${relativePath.split('/').join(sep)}`))
    throw new Error('The former source does not identify this internal track fixture.');
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

export function internalTrackFixturePath(starts: string[], relativePath: string): string {
  for (const start of starts) {
    let directory = resolve(start);
    for (let depth = 0; depth < 8; depth++) {
      if (existsSync(resolve(directory, '.git')) || existsSync(resolve(directory, 'Cargo.toml')))
        return resolve(directory, relativePath);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error('The internal track fixture checkout is unavailable.');
}
