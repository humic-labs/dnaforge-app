import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeSequenceFingerprint } from '@waypoint/sequence-utils/sequence-fingerprint';
import { SEQUENCE_PACKAGE_FILE_KIND } from '../db/sequence-package-contract';
import { convertTreeToPlasmidPackages } from './workspace-git/convert-tree-to-packages';
import { fingerprintSequenceSource } from './sequence-source-fingerprint';

const INSERT = 'ATGACCATGATTACGGATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTG';

function genbank(name: string, bases: string, topology: 'linear' | 'circular'): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bases.length; offset += 60) {
    const chunk = bases.slice(offset, offset + 60).toLowerCase();
    const groups = chunk.match(/.{1,10}/g)!.join(' ');
    lines.push(`${String(offset + 1).padStart(9)} ${groups}`);
  }
  return [
    `LOCUS       ${name.padEnd(16)} ${String(bases.length).padStart(11)} bp    DNA     ${topology.padEnd(8)} SYN 01-JAN-2026`,
    'FEATURES             Location/Qualifiers',
    'ORIGIN',
    ...lines,
    '//',
    '',
  ].join('\n');
}

describe('fingerprintSequenceSource', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fixture-fingerprint-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function file(relPath: string, content: string): Promise<string> {
    const full = join(root, relPath);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
    return full;
  }

  it('gives a plain FASTA and the package it converts into the same fingerprint', async () => {
    const loose = await file('data/clone-1.fasta', `>clone-1\n${INSERT}\n`);
    const before = await fingerprintSequenceSource(loose, 'fasta');

    expect((await convertTreeToPlasmidPackages(root)).converted).toBe(1);
    const after = await fingerprintSequenceSource(
      join(root, 'data', 'clone-1'),
      SEQUENCE_PACKAGE_FILE_KIND
    );

    expect(before).toBe(
      await computeSequenceFingerprint({ kind: 'dna', topology: 'linear', residues: INSERT })
    );
    expect(after).toBe(before);
  });

  it('matches circular GenBank files that start at different positions', async () => {
    const rotated = INSERT.slice(17) + INSERT.slice(0, 17);
    const first = await file('a.gb', genbank('pA', INSERT, 'circular'));
    const second = await file('b.gb', genbank('pB', rotated, 'circular'));

    const fingerprint = await fingerprintSequenceSource(first, 'genbank');
    expect(fingerprint).toMatch(/^seq-v1:dna:circular:sha256:/);
    expect(await fingerprintSequenceSource(second, 'genbank')).toBe(fingerprint);
  });

  it('leaves files it cannot identify unfingerprinted', async () => {
    const multi = await file('multi.fasta', `>one\n${INSERT}\n>two\n${INSERT}A\n`);
    const ambiguous = await file('probe.fasta', '>probe\nATGTCCGGTGAA\n');
    const garbage = await file('broken.gb', 'not a sequence file');

    expect(await fingerprintSequenceSource(multi, 'fasta')).toBeNull();
    expect(await fingerprintSequenceSource(ambiguous, 'fasta')).toBeNull();
    expect(await fingerprintSequenceSource(garbage, 'genbank')).toBeNull();
    expect(await fingerprintSequenceSource(join(root, 'absent.fasta'), 'fasta')).toBeNull();
    expect(await fingerprintSequenceSource(multi, 'notebook')).toBeNull();
  });

  it('refuses a named pipe without waiting for a writer', async () => {
    const pipe = join(root, 'pipe.fasta');
    execFileSync('mkfifo', [pipe]);

    expect(await fingerprintSequenceSource(pipe, 'fasta')).toBeNull();
  });
});
