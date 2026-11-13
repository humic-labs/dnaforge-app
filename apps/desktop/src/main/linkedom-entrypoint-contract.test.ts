import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN_SOURCE_ROOT = join(process.cwd(), 'src', 'main');
const DESKTOP_BUILD_CONFIG = join(process.cwd(), 'electron.vite.config.ts');

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe('linkedom entrypoint contract', () => {
  it('loads DOMParser through the CommonJS-compatible package root', () => {
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        "const { DOMParser } = require('linkedom'); const document = new DOMParser().parseFromString('<p>ok</p>', 'text/html'); process.stdout.write(document.querySelector('p').textContent);",
      ],
      { cwd: MAIN_SOURCE_ROOT, encoding: 'utf8' }
    );

    expect(output).toBe('ok');
  });

  it('rejects the ESM-only worker subpath from privileged source', () => {
    const incompatibleSpecifier = ['linkedom', 'worker'].join('/');
    const offenders = collectTypeScriptFiles(MAIN_SOURCE_ROOT)
      .filter((path) => readFileSync(path, 'utf8').includes(incompatibleSpecifier))
      .map((path) => relative(MAIN_SOURCE_ROOT, path));

    expect(offenders).toEqual([]);
  });

  it('keeps the package external so its optional canvas fallback runs in Node', () => {
    const config = readFileSync(DESKTOP_BUILD_CONFIG, 'utf8');
    const externals = config.match(/const MAIN_EXTERNALS:[^=]+\s*=\s*\[([\s\S]*?)\n\];/u)?.[1];

    expect(externals).toContain("'linkedom'");
  });
});
