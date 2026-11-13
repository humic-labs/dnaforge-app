// @vitest-environment node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('LivePreviewArchitectureContract', () => {
  it('keeps registered viewport handle drags off semantic preview APIs', () => {
    const source = readFileSync(resolve(here(), 'RegisteredAssemblyViewport.tsx'), 'utf8');

    expect(source).not.toContain('onFieldPreviewImmediate');
    expect(source).not.toContain('runPreviewFieldCommand');
    expect(source).not.toContain('applyWorkbenchCommand');
    expect(source).not.toContain('setPreviewState');
  });
});

function here(): string {
  return dirname(fileURLToPath(import.meta.url));
}
