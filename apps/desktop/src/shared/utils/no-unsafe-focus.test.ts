// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const SRC_DIR = join(__dirname, '..', '..');

function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, files);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function isSafeFocusCall(line: string): boolean {
  const trimmed = line.trim();

  if (trimmed.includes('safeFocus(')) return true;

  if (trimmed.includes('.chain().focus()')) return true;
  if (trimmed.includes('.commands.focus()')) return true;

  if (/autoFocus/.test(trimmed)) return true;

  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return true;

  if (/['"`].*\.focus\(.*['"`]/.test(trimmed)) return true;

  if (/\.current[?]?\.focus\(/.test(trimmed)) return false;

  if (/\.current\[.*\][?]?\.focus\(/.test(trimmed)) return false;

  if (/\w+\.focus\(\)/.test(trimmed)) {
    if (/editor/i.test(trimmed)) return true;
    if (trimmed.includes('window.focus')) return true;
    return false;
  }

  return true;
}

describe('codebase invariant: no unsafe .focus() calls', () => {
  it('all .focus() calls on DOM refs use safeFocus()', () => {
    const files = collectFiles(SRC_DIR);
    const violations: Array<{ file: string; line: number; code: string }> = [];

    for (const filePath of files) {
      const rel = relative(SRC_DIR, filePath).split(sep).join('/');

      if (rel.includes('.test.') || rel.includes('__tests__')) continue;
      if (rel.includes('safeFocus.ts')) continue;
      if (rel.startsWith('main/') || rel.startsWith(join('main') + '/')) continue;

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('.focus(')) continue;

        if (!isSafeFocusCall(line)) {
          violations.push({
            file: rel,
            line: i + 1,
            code: line.trim(),
          });
        }
      }
    }

    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line}\n    ${v.code}`).join('\n\n');

      expect.fail(
        `Found ${violations.length} unsafe .focus() call(s). ` +
          `Use safeFocus() from shared/utils/safeFocus instead:\n\n${report}\n\n` +
          `Fix: import { safeFocus } from '@/shared/utils/safeFocus' and replace el.focus() with safeFocus(el).`
      );
    }
  });
});
