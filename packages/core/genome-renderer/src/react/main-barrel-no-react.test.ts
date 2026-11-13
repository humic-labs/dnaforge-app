import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function barrelPath(name: string): string {
  const metaUrl = import.meta.url;
  const root = metaUrl.startsWith('file:')
    ? join(dirname(fileURLToPath(metaUrl)), '..')
    : join(process.cwd(), 'src');
  return join(root, name);
}

describe('genome-renderer main barrel stays React-free', () => {
  it('does not import the react entry or the react package', () => {
    const index = readFileSync(barrelPath('index.ts'), 'utf8');
    const pure = readFileSync(barrelPath('pure.ts'), 'utf8');
    expect(index).not.toMatch(/from ['"]react['"]/);
    expect(index).not.toMatch(/genome-renderer\/react/);
    expect(pure).not.toMatch(/from ['"]react['"]/);
    expect(pure).not.toMatch(/genome-renderer\/react/);
  });
});
