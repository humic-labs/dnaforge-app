import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERERS_DIR = join(__dirname, '../renderers');

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFilesUnder(full);
    if (!full.endsWith('.ts') || full.endsWith('.test.ts')) return [];
    return [full];
  });
}

function translateCdsCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = 'translateCDS(';
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) return calls;
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(at + marker.length, i));
    from = i;
  }
}

describe('translateCDS call sites in the renderers', () => {
  it('every one names the genetic code the record reads by', () => {
    const offenders: string[] = [];
    for (const file of sourceFilesUnder(RENDERERS_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const args of translateCdsCalls(source)) {
        if (!args.includes('sequenceGeneticCode')) {
          offenders.push(file.slice(file.indexOf('src/')));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds the call sites at all, so an empty pass means something', () => {
    const found = sourceFilesUnder(RENDERERS_DIR).flatMap((file) =>
      translateCdsCalls(readFileSync(file, 'utf8'))
    );
    expect(found.length).toBeGreaterThanOrEqual(3);
  });
});
