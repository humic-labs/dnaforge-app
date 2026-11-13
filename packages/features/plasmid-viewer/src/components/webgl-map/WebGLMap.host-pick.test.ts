import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function sourceOf(name: string): string {
  const metaUrl = import.meta.url;
  if (metaUrl.startsWith('file:')) {
    return readFileSync(join(dirname(fileURLToPath(metaUrl)), name), 'utf8');
  }
  return readFileSync(join(process.cwd(), `src/components/webgl-map/${name}`), 'utf8');
}

describe('WebGLMap host pick', () => {
  it('does not request the indexed annotation host', () => {
    expect(sourceOf('WebGLMap.tsx')).not.toMatch(/annotationHost/);
  });
});
