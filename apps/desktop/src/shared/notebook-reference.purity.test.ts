// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENTRY = resolve(__dirname, 'notebook-reference.ts');

const FORBIDDEN = [
  { pattern: /(^|\/)db(\/|$)/, why: 'db access is unavailable in the main process' },
  { pattern: /(^|\/)platform(\/|$)/, why: 'platform() is renderer-only' },
  { pattern: /(^|\/)features(\/|$)/, why: 'feature modules pull in renderer state' },
  { pattern: /(^|\/)stores(\/|$)/, why: 'zustand stores are renderer-only' },
  { pattern: /^react/, why: 'React must not be reachable from a main-process module' },
  { pattern: /^@tiptap/, why: 'TipTap must not be reachable from a main-process module' },
];

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) specifiers.push(m[1]);
  const sideEffect = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while ((m = sideEffect.exec(src)) !== null) specifiers.push(m[1]);
  return specifiers;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function transitiveGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (graph.has(file)) continue;
    const specs = importsOf(file);
    graph.set(file, specs);
    for (const spec of specs) {
      const next = resolveRelative(file, spec);
      if (next && !graph.has(next)) queue.push(next);
    }
  }
  return graph;
}

describe('notebook-reference is main-process safe', () => {
  it('has no forbidden import anywhere in its transitive graph', () => {
    const graph = transitiveGraph(ENTRY);
    const violations: string[] = [];

    for (const [file, specs] of graph) {
      for (const spec of specs) {
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(spec)) {
            violations.push(`${file} imports "${spec}" — ${why}`);
          }
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('does not reach outside src/shared', () => {
    const graph = transitiveGraph(ENTRY);
    const escapes = [...graph.keys()].filter((f) => !f.includes('/src/shared/'));
    expect(escapes, `left src/shared: ${escapes.join(', ')}`).toEqual([]);
  });

  it('actually walked the entry file (guards against a silent zero-file scan)', () => {
    const graph = transitiveGraph(ENTRY);
    expect(graph.has(ENTRY)).toBe(true);
  });
});
