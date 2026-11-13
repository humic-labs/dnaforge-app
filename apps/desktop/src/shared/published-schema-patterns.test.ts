import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_ID_PATTERN,
  DNA_WITH_N_PATTERN,
  HEX_COLOR_PATTERN,
  IUPAC_BASES_PATTERN,
  OPTIONAL_IUPAC_BASES_PATTERN,
} from './published-schema-patterns';

const MANIFEST = resolve(
  __dirname,
  '../../../../packages/core/agent-tools/renderer-tool-manifest.json'
);

function publishedInputPatterns(): string[] {
  const found: string[] = [];
  const collect = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'pattern' && typeof value === 'string') found.push(value);
      else collect(value);
    }
  };
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'inputSchema') collect(value);
      else walk(value);
    }
  };
  walk(JSON.parse(readFileSync(MANIFEST, 'utf8')));
  return found;
}

describe('agent tool input patterns', () => {
  it('accepts the letter case the app itself hands back', () => {
    expect(IUPAC_BASES_PATTERN.test('agaggagaaatacta')).toBe(true);
    expect(IUPAC_BASES_PATTERN.test('AGAGGAGAAATACTA')).toBe(true);
    expect(IUPAC_BASES_PATTERN.test('AgAgGaGaAaTaCtA')).toBe(true);
    expect(OPTIONAL_IUPAC_BASES_PATTERN.test('')).toBe(true);
    expect(OPTIONAL_IUPAC_BASES_PATTERN.test('acgtn')).toBe(true);
    expect(DNA_WITH_N_PATTERN.test('acgtn')).toBe(true);
    expect(CATALOG_ID_PATTERN.test('Kit-A_1')).toBe(true);
    expect(CATALOG_ID_PATTERN.test('kit-a_1')).toBe(true);
    expect(HEX_COLOR_PATTERN.test('#AABBCC')).toBe(true);
    expect(HEX_COLOR_PATTERN.test('#aabbcc')).toBe(true);
  });

  it('still refuses letters that are not bases', () => {
    expect(IUPAC_BASES_PATTERN.test('acgtx')).toBe(false);
    expect(IUPAC_BASES_PATTERN.test('')).toBe(false);
    expect(DNA_WITH_N_PATTERN.test('acgtr')).toBe(false);
    expect(CATALOG_ID_PATTERN.test('-leading-dash')).toBe(false);
    expect(HEX_COLOR_PATTERN.test('#ABC')).toBe(false);
  });

  it('carries no case-insensitive flag, which a published pattern cannot express', () => {
    for (const pattern of [
      IUPAC_BASES_PATTERN,
      OPTIONAL_IUPAC_BASES_PATTERN,
      DNA_WITH_N_PATTERN,
      CATALOG_ID_PATTERN,
      HEX_COLOR_PATTERN,
    ]) {
      expect(pattern.flags).not.toContain('i');
    }
  });

  it('validates agent input against patterns that accept either case', () => {
    const patterns = publishedInputPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    const bases = patterns.filter((pattern) => /ACGT/.test(pattern));
    expect(bases.length).toBeGreaterThan(0);
    for (const pattern of bases) {
      expect(new RegExp(pattern).test('acgt'), `${pattern} rejects lower-case bases`).toBe(true);
    }
    const colours = patterns.filter((pattern) => pattern.startsWith('^#'));
    expect(colours.length).toBeGreaterThan(0);
    for (const pattern of colours) {
      expect(new RegExp(pattern).test('#AABBCC'), `${pattern} rejects upper-case hex`).toBe(true);
    }
  });
});
