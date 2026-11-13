import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_IMPORTS = [
  /from\s+['"]node:[a-z/_-]+['"]/,
  /from\s+['"](fs|path|crypto|os|child_process|stream|http|https|net|tls|dns|cluster|worker_threads|fs\/promises|path\/posix|path\/win32)['"]/,
];

function extractImports(source: string): string[] {
  const out: string[] = [];
  const re = /from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out.push(match[1]);
  }
  return out;
}

function collectReachableSources(entry: string): Set<string> {
  const visited = new Set<string>();
  const stack = [resolve(entry)];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    visited.add(file);

    const imports = extractImports(source);
    for (const spec of imports) {
      if (!spec.startsWith('.')) continue;
      const baseDir = dirname(file);
      const candidates = [join(baseDir, `${spec}.ts`), join(baseDir, spec, 'index.ts')];
      for (const c of candidates) {
        try {
          readFileSync(c, 'utf8');
          stack.push(c);
          break;
        } catch {}
      }
    }
  }
  return visited;
}

describe('@waypoint/genome-data — main entry browser safety', () => {
  it('does not transitively import any node: built-in from src/index.ts', () => {
    const entry = resolve(__dirname, 'index.ts');
    const reachable = collectReachableSources(entry);

    const violations: Array<{ file: string; line: number; offender: string }> = [];
    for (const file of reachable) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const re of FORBIDDEN_IMPORTS) {
          if (re.test(line)) {
            const match = line.match(/from\s+['"]([^'"]+)['"]/);
            violations.push({
              file: file.replace(resolve(__dirname, '..'), '<genome-data>'),
              line: i + 1,
              offender: match?.[1] ?? line.trim(),
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const msg = violations.map((v) => `  ${v.file}:${v.line} imports '${v.offender}'`).join('\n');
      throw new Error(
        `Renderer-bundle hazard: the main @waypoint/genome-data entry transitively imports Node-only modules. Move the offending file behind a /node subpath (see ./node.ts for the pattern).\n${msg}`
      );
    }

    expect(violations).toEqual([]);
  });

  it('reachable set is non-trivial (sanity: the trace actually walked imports)', () => {
    const entry = resolve(__dirname, 'index.ts');
    const reachable = collectReachableSources(entry);
    expect(reachable.size).toBeGreaterThan(3);
  });

  it('isolates the Node-only path under /node.ts', () => {
    const nodeEntry = resolve(__dirname, 'node.ts');
    const reachable = collectReachableSources(nodeEntry);
    let foundNodeImport = false;
    for (const file of reachable) {
      const source = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN_IMPORTS) {
        if (re.test(source)) {
          foundNodeImport = true;
          break;
        }
      }
      if (foundNodeImport) break;
    }
    expect(foundNodeImport).toBe(true);
  });
});
