// @vitest-environment node
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

const SRC = readFileSync(join(__dirname, 'TextViewerTab.tsx'), 'utf-8');

describe('TextViewerTab → CodeEditor lazy boundary ', () => {
  it('loads CodeEditor via a dynamic lazy() import, not a static import', () => {
    expect(SRC).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(\s*['"]\.\/CodeEditor['"]\s*\)\s*\)/);
  });

  it('does NOT statically import CodeEditor (that would re-bloat startup)', () => {
    expect(SRC).not.toMatch(/^\s*import\s+[^;]*from\s+['"]\.\/CodeEditor['"]/m);
  });

  it('renders the lazy editor inside a Suspense boundary', () => {
    expect(SRC).toContain('Suspense');
  });
});
