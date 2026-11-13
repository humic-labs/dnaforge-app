// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function sourcePath(): string {
  const metaUrl = import.meta.url;
  if (metaUrl.startsWith('file:')) {
    return join(dirname(fileURLToPath(metaUrl)), 'IndexedGenomeTileNativeMap.tsx');
  }
  return join(process.cwd(), 'src/features/sequence/components/IndexedGenomeTileNativeMap.tsx');
}

describe('IndexedGenomeTileNativeMap import cut', () => {
  it('does not import @waypoint/plasmid-viewer', () => {
    const source = readFileSync(sourcePath(), 'utf8');
    expect(source).not.toMatch(/@waypoint\/plasmid-viewer/);
  });
});
