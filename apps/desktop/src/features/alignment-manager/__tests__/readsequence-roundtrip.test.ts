// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { parseGenBankFull, serializeGenBank } from '@waypoint/sequence-utils';

describe('GenBank serialize → parse round-trip', () => {
  it('preserves sequence through serialize then parse', () => {
    const originalSequence = 'ATCGATCGATCGATCGATCG'.repeat(50);
    const seq = {
      name: 'test-seq',
      sequence: originalSequence,
      length: originalSequence.length,
      annotations: [],
      circular: false,
    };

    const genbank = serializeGenBank(seq as any);

    const parsed = parseGenBankFull(genbank);

    console.log(`[ROUNDTRIP] Original: ${originalSequence.length} bp`);
    console.log(`[ROUNDTRIP] Serialized GenBank length: ${genbank.length} chars`);
    console.log(`[ROUNDTRIP] Parsed: ${parsed.sequence.length} bp`);

    expect(parsed.sequence.length).toBe(originalSequence.length);
    expect(parsed.sequence.toUpperCase()).toBe(originalSequence.toUpperCase());
  });

  it('preserves INSERTED bases through round-trip', () => {
    const baseSequence = 'ATCGATCGATCGATCGATCG'.repeat(50);
    const insertedBases = 'AAAAAAAAAAAAAAA';
    const editedSequence = baseSequence.slice(0, 500) + insertedBases + baseSequence.slice(500);

    expect(editedSequence.length).toBe(1015);

    const seq = {
      name: 'test-seq-edited',
      sequence: editedSequence,
      length: editedSequence.length,
      annotations: [],
      circular: false,
    };

    const genbank = serializeGenBank(seq as any);
    const parsed = parseGenBankFull(genbank);

    console.log(`[ROUNDTRIP-EDIT] Original: 1000bp, After insert: ${editedSequence.length}bp`);
    console.log(`[ROUNDTRIP-EDIT] Parsed: ${parsed.sequence.length}bp`);

    expect(parsed.sequence.length).toBe(editedSequence.length);
    expect(parsed.sequence.toUpperCase()).toBe(editedSequence.toUpperCase());
  });

  it('round-trips a realistic 78kb GenBank file', () => {
    const originalLen = 78354;
    const seq = 'ATCG'.repeat(Math.ceil(originalLen / 4)).slice(0, originalLen);
    expect(seq.length).toBe(originalLen);

    const genbankObj = {
      name: 'rubisco70-kb-region-cleaned',
      sequence: seq,
      length: seq.length,
      annotations: [],
      circular: false,
    };

    const genbank = serializeGenBank(genbankObj as any);
    const parsed = parseGenBankFull(genbank);

    console.log(`[ROUNDTRIP-78K] Original: ${seq.length}bp`);
    console.log(`[ROUNDTRIP-78K] Parsed: ${parsed.sequence.length}bp`);

    expect(parsed.sequence.length).toBe(seq.length);
  });

  it('reads the actual rubisco file from disk correctly', async () => {
    const fs = await import('node:fs/promises');
    const { homedir } = await import('node:os');
    const filePath = `${homedir()}/Downloads/replasmidgenotyping/data/plasmid-variants/rubisco70-kb-region-cleaned.gb`;

    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      console.log('[ROUNDTRIP-ACTUAL] File not found, skipping');
      return;
    }

    const parsed = parseGenBankFull(content);
    console.log(`[ROUNDTRIP-ACTUAL] File size: ${content.length} chars`);
    console.log(`[ROUNDTRIP-ACTUAL] Parsed sequence: ${parsed.sequence.length} bp`);

    const locusMatch = content.match(/LOCUS\s+\S+\s+(\d+)\s+bp/);
    const locusLength = locusMatch ? parseInt(locusMatch[1]) : -1;
    console.log(`[ROUNDTRIP-ACTUAL] LOCUS header says: ${locusLength} bp`);

    expect(parsed.sequence.length).toBe(locusLength);

    const reserialized = serializeGenBank({
      name: parsed.name || 'test',
      sequence: parsed.sequence,
      length: parsed.sequence.length,
      annotations: [],
      isCircular: parsed.circular || false,
    } as any);

    const reparsed = parseGenBankFull(reserialized);
    console.log(`[ROUNDTRIP-ACTUAL] After re-serialize+re-parse: ${reparsed.sequence.length} bp`);
    expect(reparsed.sequence.length).toBe(parsed.sequence.length);
  });
});
