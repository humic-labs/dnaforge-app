// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function componentSourcePath(fileName: string): string {
  const metaUrl = import.meta.url;
  if (metaUrl.startsWith('file:')) {
    return join(dirname(fileURLToPath(metaUrl)), fileName);
  }
  return join(process.cwd(), 'src/features/sequence/components', fileName);
}

describe('IndexedGenomeTab FindBar import', () => {
  it('does not import the workspace-editor package root', () => {
    const tabSource = readFileSync(componentSourcePath('IndexedGenomeTab.tsx'), 'utf8');
    const runtimeSource = readFileSync(componentSourcePath('IndexedGenomeTabRuntime.tsx'), 'utf8');
    expect(tabSource).not.toMatch(/from '@waypoint\/workspace-editor['"]/);
    expect(runtimeSource).not.toMatch(/from '@waypoint\/workspace-editor['"]/);
    expect(runtimeSource).toMatch(/from '@waypoint\/workspace-editor\/find-bar['"]/);
  });
});
