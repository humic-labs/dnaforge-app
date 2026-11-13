// @vitest-environment node

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const BLOCKED_PLASMID_VIEWER_PARSER_IMPORTS = [
  'parseGenBank',
  'parseFastaAsPlasmid',
  'isGenBankFormat',
  'isFastaFormat',
];

describe('sequence parser import boundary', () => {
  it('does not import plasmid-viewer parser APIs from desktop source', () => {
    const srcRoot = desktopSrcRoot();
    const offenders: string[] = [];

    for (const filePath of walkTsFiles(srcRoot)) {
      if (isTestFile(filePath)) continue;
      const source = readFileSync(filePath, 'utf8');
      if (!source.includes('@waypoint/plasmid-viewer')) continue;

      for (const importBlock of source.matchAll(
        /import\s+(?:type\s+)?[^;]+?\s+from\s+['"]@waypoint\/plasmid-viewer['"]/g
      )) {
        const imported = importBlock[0];
        const blocked = BLOCKED_PLASMID_VIEWER_PARSER_IMPORTS.filter((name) =>
          imported.includes(name)
        );
        if (blocked.length > 0) {
          offenders.push(`${relativeToSrc(srcRoot, filePath)} imports ${blocked.join(', ')}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function desktopSrcRoot(): string {
  const candidates = [
    resolve(process.cwd(), 'src'),
    resolve(process.cwd(), 'apps/desktop/src'),
    resolve(process.cwd(), '../../apps/desktop/src'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Could not locate apps/desktop/src');
  return found;
}

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'dist-electron') continue;
      yield* walkTsFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield path;
    }
  }
}

function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.(ts|tsx)$/.test(filePath) || filePath.includes('/__tests__/');
}

function relativeToSrc(srcRoot: string, filePath: string): string {
  return filePath.slice(srcRoot.length + 1);
}
