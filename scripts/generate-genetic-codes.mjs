#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(REPO_ROOT, 'packages/core/sequence-utils/vendor/ncbi-gc.prt');
const OUTPUT = path.join(
  REPO_ROOT,
  'packages/core/sequence-utils/src/genetic-codes.generated.ts'
);

const BASES = ['T', 'C', 'A', 'G'];

function codonOrder() {
  const codons = [];
  for (const b1 of BASES) {
    for (const b2 of BASES) {
      for (const b3 of BASES) codons.push(`${b1}${b2}${b3}`);
    }
  }
  return codons;
}

function baseRow(index) {
  return codonOrder()
    .map((codon) => codon[index])
    .join('');
}

export function parseGeneticCodeTables(text) {
  const codons = codonOrder();
  const tables = [];
  const blocks = text.split(/\n\s*\{\s*\n/).slice(1);
  for (const block of blocks) {
    const names = [...block.matchAll(/^\s*name\s+"((?:[^"]|\n)*)"\s*,?\s*$/gm)].map((m) =>
      m[1].replace(/\s+/g, ' ').trim()
    );
    const idMatch = block.match(/^\s*id\s+(\d+)\s*,?\s*$/m);
    const aaMatch = block.match(/^\s*ncbieaa\s+"([^"]+)"/m);
    const startMatch = block.match(/^\s*sncbieaa\s+"([^"]+)"/m);
    if (!idMatch || !aaMatch || !startMatch) continue;

    const id = Number.parseInt(idMatch[1], 10);
    const aminoAcids = aaMatch[1];
    const starts = startMatch[1];
    if (aminoAcids.length !== 64) {
      throw new Error(`Genetic code ${id}: ncbieaa is ${aminoAcids.length} chars, expected 64`);
    }
    if (starts.length !== 64) {
      throw new Error(`Genetic code ${id}: sncbieaa is ${starts.length} chars, expected 64`);
    }

    for (const [row, index] of [
      ['Base1', 0],
      ['Base2', 1],
      ['Base3', 2],
    ]) {
      const rowMatch = block.match(new RegExp(`^\\s*--\\s*${row}\\s+([TCAG]{64})\\s*$`, 'm'));
      if (!rowMatch) throw new Error(`Genetic code ${id}: missing the ${row} comment row`);
      if (rowMatch[1] !== baseRow(index)) {
        throw new Error(
          `Genetic code ${id}: ${row} row does not match the assumed codon order. ` +
            `Upstream reordered the table; fix codonOrder() before regenerating.`
        );
      }
    }

    if (!/^[A-Z*]+$/.test(aminoAcids)) {
      throw new Error(`Genetic code ${id}: unexpected character in ncbieaa`);
    }
    if (!/^[M*\-]+$/.test(starts)) {
      throw new Error(`Genetic code ${id}: unexpected character in sncbieaa`);
    }

    tables.push({
      id,
      name: names[0] ?? `Genetic code ${id}`,
      shortName: names[1],
      aminoAcids,
      starts,
      startCodons: codons.filter((_, i) => starts[i] !== '-'),
    });
  }
  if (tables.length === 0) throw new Error('No genetic code tables found in the vendored file');
  return tables.sort((a, b) => a.id - b.id);
}

function render(tables, sourceHash) {
  const entries = tables
    .map(
      (table) => `  {
    id: ${table.id},
    name: ${JSON.stringify(table.name)},${
      table.shortName ? `\n    shortName: ${JSON.stringify(table.shortName)},` : ''
    }
    aminoAcids: ${JSON.stringify(table.aminoAcids)},
    starts: ${JSON.stringify(table.starts)},
  },`
    )
    .join('\n');

  return `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: packages/core/sequence-utils/vendor/ncbi-gc.prt (NCBI genetic code table)
 * sha256: ${sourceHash}
 * Regenerate: node scripts/generate-genetic-codes.mjs
 *
 * \`aminoAcids\` and \`starts\` are 64-character strings in NCBI codon order —
 * base 1 cycles slowest, base 3 fastest, each through T, C, A, G. Position i of
 * \`starts\` is '-' when that codon cannot initiate translation under this code.
 */

export interface RawGeneticCodeTable {
  readonly id: number;
  readonly name: string;
  readonly shortName?: string;
  /** One amino-acid letter per codon, '*' for stop. */
  readonly aminoAcids: string;
  /** 'M' or '*' where the codon may initiate, '-' otherwise. */
  readonly starts: string;
}

/** Base order NCBI uses for each codon position, slowest-varying first. */
export const NCBI_CODON_BASE_ORDER = ${JSON.stringify(BASES)} as const;

export const RAW_GENETIC_CODE_TABLES: readonly RawGeneticCodeTable[] = [
${entries}
];
`;
}

function main() {
  const raw = readFileSync(SOURCE);
  const sourceHash = createHash('sha256').update(raw).digest('hex');
  const tables = parseGeneticCodeTables(raw.toString('utf8'));
  const rendered = render(tables, sourceHash);

  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT, 'utf8');
    } catch {
    }
    if (current !== rendered) {
      console.error(
        'genetic-codes.generated.ts is stale. Run: node scripts/generate-genetic-codes.mjs'
      );
      process.exit(1);
    }
    console.log(`genetic-codes.generated.ts is current (${tables.length} tables).`);
    return;
  }

  writeFileSync(OUTPUT, rendered);
  console.log(`Wrote ${tables.length} genetic code tables to ${path.relative(REPO_ROOT, OUTPUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
