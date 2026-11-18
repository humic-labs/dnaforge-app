import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('notebook chrome surfaces ', () => {
  const stylesheet = src('src/index.css');
  const toolbar = src('src/features/page/components/FormattingToolbar.tsx');
  const editor = src('src/features/page/components/PageEditor.tsx');

  it('paints tab chrome with --color-bg in both themes so it matches the active tab', () => {
    expect(stylesheet).toMatch(
      /\.tab-chrome-surface\s*\{[^}]*background-color:\s*hsl\(var\(--color-bg\)\);/s
    );
    expect(stylesheet).not.toMatch(/\.dark\s+\.tab-chrome-surface\s*\{/);
    expect(toolbar).toMatch(/className="tab-chrome-surface /);
  });

  it('paints the notebook with the shared document surface in both appearances', () => {
    expect(stylesheet).toMatch(
      /\.notebook-editor-body\s*\{[^}]*background-color:\s*hsl\(var\(--color-document-bg\)\);/s
    );
    expect(stylesheet).not.toMatch(/\.dark\s+\.notebook-editor-body\s*\{/);
    expect(editor).toMatch(/data-testid="notebook-editor-body"/);
    expect(editor).toMatch(/className="notebook-editor-body /);
  });
});
