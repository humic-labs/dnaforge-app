// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

describe('imported notebook presentation', () => {
  it('lets inline ordered-list styles preserve alpha and Roman markers', () => {
    expect(stylesheet).toMatch(/\.ProseMirror ol\s*{[^}]*list-style-type:\s*decimal;/s);
    expect(stylesheet).not.toMatch(
      /\.ProseMirror ol(?:\s+li)?\s*{[^}]*list-style-type:\s*decimal\s*!important;/s
    );
    expect(stylesheet).toMatch(/\.ProseMirror ol\s*>\s*li\s*{[^}]*list-style-type:\s*inherit;/s);
  });

  it('shows protocol completion without replacing ordered-list markers', () => {
    expect(stylesheet).toMatch(
      /li\.protocol-step\[data-checked='true'\][^{]*{[^}]*content:\s*'✓';/s
    );
    expect(stylesheet).toMatch(/li\.protocol-step\s*>\s*p:first-child::before/);
  });

  it('does not force nested task items back to list-item layout', () => {
    expect(stylesheet).not.toMatch(
      /\.ProseMirror ol li\s*{[^}]*display:\s*list-item\s*!important;/s
    );
    expect(stylesheet).toMatch(
      /\.ProseMirror ul\[data-type='taskList'\] li\s*{[^}]*display:\s*flex;/s
    );
  });
});
