#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const EXPECTED_SHA256 = '4e55acfdc32825a22e87670e9056a3bf94ad7c5400065778e9e10f8314372bcf';
const SOURCE_URL = 'https://www.unicode.org/Public/15.1.0/ucd/CaseFolding.txt';
const [inputArgument, outputArgument] = process.argv.slice(2);

if (!inputArgument || !outputArgument) {
  process.stderr.write(
    'Usage: node scripts/generate-unicode-case-fold.mjs <CaseFolding-15.1.0.txt> <output.ts>\n'
  );
  process.exitCode = 1;
} else {
  await generate(resolve(inputArgument), resolve(outputArgument));
}

async function generate(inputPath, outputPath) {
  const source = await readFile(inputPath);
  const actualSha256 = createHash('sha256').update(source).digest('hex');
  if (actualSha256 !== EXPECTED_SHA256) {
    throw new Error(`Unicode case-fold source checksum mismatch: ${actualSha256}`);
  }

  const mappings = [];
  for (const line of source.toString('utf8').split('\n')) {
    const data = line.split('#', 1)[0]?.trim();
    if (!data) continue;
    const [codePointText, status, mappingText] = data.split(';').map((part) => part.trim());
    if (!codePointText || !status || !mappingText || (status !== 'C' && status !== 'F')) {
      continue;
    }
    const codePoint = Number.parseInt(codePointText, 16);
    const mapping = mappingText.split(/\s+/u).map((value) => Number.parseInt(value, 16));
    mappings.push({ codePoint, mapping });
  }
  mappings.sort((left, right) => left.codePoint - right.codePoint);

  const lines = [
    '/**',
    ' * Generated Unicode full case-fold table.',
    ' *',
    ` * Source: ${SOURCE_URL}`,
    ' * Unicode version: 15.1.0',
    ` * Source SHA-256: ${EXPECTED_SHA256}`,
    ' * Statuses included: C (common) and F (full). S and T are intentionally excluded.',
    ' * Regenerate with scripts/generate-unicode-case-fold.mjs; do not hand-edit.',
    ' */',
    '',
    "export const UNICODE_CASE_FOLD_VERSION = '15.1.0';",
    `export const UNICODE_CASE_FOLD_SOURCE_SHA256 = '${EXPECTED_SHA256}';`,
    '',
    'const FULL_CASE_FOLD: Readonly<Record<number, string>> = {',
  ];
  for (const { codePoint, mapping } of mappings) {
    lines.push(`  0x${codePoint.toString(16).toUpperCase()}: "${unicodeEscapes(mapping)}",`);
  }
  lines.push(
    '};',
    '',
    'export function unicodeFullCaseFoldV15_1(value: string): string {',
    "  let folded = '';",
    '  for (const character of value) {',
    '    const codePoint = character.codePointAt(0);',
    '    if (codePoint === undefined) continue;',
    '    folded += FULL_CASE_FOLD[codePoint] ?? character;',
    '  }',
    "  return folded.normalize('NFC');",
    '}',
    ''
  );
  await writeFile(outputPath, lines.join('\n'), 'utf8');
}

function unicodeEscapes(codePoints) {
  return codePoints.map((codePoint) => `\\u{${codePoint.toString(16).toUpperCase()}}`).join('');
}
