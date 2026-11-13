// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  convertTwoBitToFasta,
  hasTwoBitSignature,
  readTwoBitSummary,
  TwoBitFormatError,
} from './twobit';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const MIXED_FASTA = join(PROJECT_ROOT, 'test-fixtures/twobit/mixed.fa');
const MIXED_TWOBIT = join(PROJECT_ROOT, 'test-fixtures/twobit/mixed.2bit');
const CHRIV_FASTA_SHA256 = '24558646324f6b0c3ed81fd8a0c336ce998cd62bcda7e36a5cab84f648366ab0';
const CHRIV_TWOBIT = join(PROJECT_ROOT, 'test-fixtures/indexed/yeast-chrIV/chrIV.2bit');

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-twobit-'));
  temporaryRoots.push(root);
  return root;
}

interface TwoBitRecord {
  readonly name: string;
  readonly sequence: string;
}

interface WriteTwoBitOptions {
  readonly littleEndian?: boolean;
  readonly version?: 0 | 1;
  readonly reserved?: number;
  readonly recordReserved?: number;
  readonly declaredSequenceCount?: number;
  readonly nBlocks?: (record: TwoBitRecord) => ReadonlyArray<readonly [number, number]>;
  readonly maskBlocks?: (record: TwoBitRecord) => ReadonlyArray<readonly [number, number]>;
  readonly offsetOf?: (name: string, offset: number) => number;
}

function runs(sequence: string, matches: (base: string) => boolean): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  let start = -1;
  for (let index = 0; index <= sequence.length; index += 1) {
    const inRun = index < sequence.length && matches(sequence[index]!);
    if (inRun && start < 0) start = index;
    if (!inRun && start >= 0) {
      blocks.push([start, index - start]);
      start = -1;
    }
  }
  return blocks;
}

function writeTwoBit(
  records: ReadonlyArray<TwoBitRecord>,
  options: WriteTwoBitOptions = {}
): Buffer {
  const littleEndian = options.littleEndian ?? true;
  const version = options.version ?? 0;
  const u32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    if (littleEndian) out.writeUInt32LE(value, 0);
    else out.writeUInt32BE(value, 0);
    return out;
  };
  const offsetBytes = (value: number): Buffer => {
    if (version === 0) return u32(value);
    const out = Buffer.alloc(8);
    if (littleEndian) out.writeBigUInt64LE(BigInt(value), 0);
    else out.writeBigUInt64BE(BigInt(value), 0);
    return out;
  };
  const header = Buffer.concat([
    u32(0x1a412743),
    u32(version),
    u32(options.declaredSequenceCount ?? records.length),
    u32(options.reserved ?? 0),
  ]);
  const indexSize = records.reduce(
    (total, record) =>
      total + 1 + Buffer.byteLength(record.name, 'latin1') + (version === 1 ? 8 : 4),
    0
  );
  const bodies: Buffer[] = [];
  const offsets: number[] = [];
  let cursor = header.length + indexSize;
  for (const record of records) {
    offsets.push(cursor);
    const nBlocks = options.nBlocks?.(record) ?? runs(record.sequence, (base) => /n/iu.test(base));
    const maskBlocks =
      options.maskBlocks?.(record) ?? runs(record.sequence, (base) => /[a-z]/u.test(base));
    const packed = Buffer.alloc(Math.ceil(record.sequence.length / 4));
    for (let index = 0; index < record.sequence.length; index += 1) {
      const code = { T: 0, C: 1, A: 2, G: 3 }[record.sequence[index]!.toUpperCase()] ?? 0;
      packed[index >> 2] = packed[index >> 2]! | (code << (6 - 2 * (index & 3)));
    }
    const body = Buffer.concat([
      u32(record.sequence.length),
      u32(nBlocks.length),
      ...nBlocks.map(([start]) => u32(start)),
      ...nBlocks.map(([, size]) => u32(size)),
      u32(maskBlocks.length),
      ...maskBlocks.map(([start]) => u32(start)),
      ...maskBlocks.map(([, size]) => u32(size)),
      u32(options.recordReserved ?? 0),
      packed,
    ]);
    bodies.push(body);
    cursor += body.length;
  }
  const index = Buffer.concat(
    records.flatMap((record, position) => [
      Buffer.from([Buffer.byteLength(record.name, 'latin1')]),
      Buffer.from(record.name, 'latin1'),
      offsetBytes(options.offsetOf?.(record.name, offsets[position]!) ?? offsets[position]!),
    ])
  );
  return Buffer.concat([header, index, ...bodies]);
}

function parseFasta(text: string): TwoBitRecord[] {
  const records: TwoBitRecord[] = [];
  for (const block of text.split('>').slice(1)) {
    const [name, ...lines] = block.split('\n');
    records.push({ name: name!.trim(), sequence: lines.join('') });
  }
  return records;
}

async function convertToString(
  twoBit: Buffer,
  options: { lineWidth?: number; maxSequences?: number; maxTotalBases?: number } = {}
): Promise<string> {
  const root = await temporaryRoot();
  const twoBitPath = join(root, 'input.2bit');
  const fastaPath = join(root, 'output.fa');
  await writeFile(twoBitPath, twoBit);
  await convertTwoBitToFasta({ twoBitPath, fastaPath, ...options });
  return readFile(fastaPath, 'utf8');
}

async function rejectsWith(twoBit: Buffer, message: string | RegExp): Promise<void> {
  const root = await temporaryRoot();
  const twoBitPath = join(root, 'input.2bit');
  const fastaPath = join(root, 'output.fa');
  await writeFile(twoBitPath, twoBit);
  await expect(convertTwoBitToFasta({ twoBitPath, fastaPath })).rejects.toThrow(message);
  await expect(stat(fastaPath)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('convertTwoBitToFasta', () => {
  it('reproduces the FASTA that UCSC faToTwoBit packed, including N runs and soft masking', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'mixed.fa');
    const progress: number[] = [];
    const result = await convertTwoBitToFasta({
      twoBitPath: MIXED_TWOBIT,
      fastaPath,
      lineWidth: 60,
      onProgress: (update) => progress.push(update.basesWritten),
    });

    expect(result).toEqual({
      sequences: [
        { name: 'one', length: 231 },
        { name: 'two.2', length: 141 },
        { name: 'three-x', length: 1 },
        { name: 'four_n', length: 17 },
      ],
      totalBases: 390,
    });
    await expect(readFile(fastaPath, 'utf8')).resolves.toBe(await readFile(MIXED_FASTA, 'utf8'));
    expect(progress).toEqual([231, 372, 373, 390]);
    await expect(stat(fastaPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    expect((await stat(fastaPath)).mode & 0o777).toBe(0o600);
  });

  it('unpacks a whole yeast chromosome byte for byte', async () => {
    const root = await temporaryRoot();
    const fastaPath = join(root, 'chrIV.fa');
    const result = await convertTwoBitToFasta({
      twoBitPath: CHRIV_TWOBIT,
      fastaPath,
      lineWidth: 80,
    });
    expect(result).toEqual({
      sequences: [{ name: 'chrIV', length: 1_531_933 }],
      totalBases: 1_531_933,
    });
    const digest = async (path: string) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    expect(await digest(fastaPath)).toBe(CHRIV_FASTA_SHA256);
  });

  it('reads big-endian files and version 1 sixty-four bit indexes the same way', async () => {
    const records = parseFasta(await readFile(MIXED_FASTA, 'utf8'));
    const expected = await readFile(MIXED_FASTA, 'utf8');
    for (const options of [
      { littleEndian: true, version: 0 },
      { littleEndian: false, version: 0 },
      { littleEndian: true, version: 1 },
      { littleEndian: false, version: 1 },
    ] as const) {
      await expect(convertToString(writeTwoBit(records, options), { lineWidth: 60 })).resolves.toBe(
        expected
      );
    }
  });

  it('folds lines at the requested width across chunk boundaries', async () => {
    const sequence = 'ACGT'.repeat(37) + 'acg';
    const fasta = await convertToString(writeTwoBit([{ name: 'seq', sequence }]), { lineWidth: 7 });
    const lines = fasta.split('\n');
    expect(lines[0]).toBe('>seq');
    expect(lines.slice(1, -1).every((line) => line.length <= 7)).toBe(true);
    expect(lines.slice(1).join('')).toBe(sequence);
    expect(fasta.endsWith('\n')).toBe(true);
  });

  it('lists sequences without decoding bases', async () => {
    await expect(readTwoBitSummary(MIXED_TWOBIT)).resolves.toEqual([
      { name: 'one', length: 231 },
      { name: 'two.2', length: 141 },
      { name: 'three-x', length: 1 },
      { name: 'four_n', length: 17 },
    ]);
  });

  it('recognizes the signature in either byte order and nothing else', () => {
    expect(hasTwoBitSignature(Buffer.from([0x43, 0x27, 0x41, 0x1a, 0x00]))).toBe(true);
    expect(hasTwoBitSignature(Buffer.from([0x1a, 0x41, 0x27, 0x43]))).toBe(true);
    expect(hasTwoBitSignature(Buffer.from('>chr1\nACGT'))).toBe(false);
    expect(hasTwoBitSignature(Buffer.from([0x43, 0x27, 0x41]))).toBe(false);
  });

  it('refuses files that are not 2bit, unsupported versions, and nonzero reserved fields', async () => {
    const records = [{ name: 'a', sequence: 'ACGT' }];
    await rejectsWith(Buffer.from('>a\nACGTACGTACGTACGTACGT\n'), 'not a UCSC 2bit sequence file');
    await rejectsWith(Buffer.from([0x43, 0x27]), 'truncated');
    const badVersion = writeTwoBit(records);
    badVersion.writeUInt32LE(2, 4);
    await rejectsWith(badVersion, 'Unsupported 2bit version 2');
    await rejectsWith(writeTwoBit(records, { reserved: 1 }), 'reserved field is not zero');
    await rejectsWith(writeTwoBit(records, { recordReserved: 7 }), 'nonzero reserved field');
  });

  it('refuses an index that points outside the file, repeated or empty names', async () => {
    await rejectsWith(
      writeTwoBit([{ name: 'a', sequence: 'ACGT' }], { offsetOf: () => 4096 }),
      'points sequence a outside the file'
    );
    await rejectsWith(
      writeTwoBit([
        { name: 'dup', sequence: 'ACGT' },
        { name: 'dup', sequence: 'TTTT' },
      ]),
      'repeats sequence dup'
    );
    await rejectsWith(writeTwoBit([{ name: '', sequence: 'ACGT' }]), 'empty name');
    await rejectsWith(writeTwoBit([{ name: 'bad name', sequence: 'ACGT' }]), 'is invalid');
    await rejectsWith(writeTwoBit([], { declaredSequenceCount: 0 }), 'declares no sequences');
  });

  it('refuses malformed N and mask blocks', async () => {
    const record = { name: 'a', sequence: 'ACGTACGTACGT' };
    await rejectsWith(
      writeTwoBit([record], {
        nBlocks: () => [
          [0, 4],
          [2, 4],
        ],
      }),
      'invalid N block at position 2'
    );
    await rejectsWith(
      writeTwoBit([record], { maskBlocks: () => [[8, 8]] }),
      'invalid mask block at position 8'
    );
    await rejectsWith(writeTwoBit([record], { nBlocks: () => [[3, 0]] }), 'invalid N block');
  });

  it('refuses truncated packed data', async () => {
    const whole = writeTwoBit([{ name: 'a', sequence: 'ACGTACGTACGTACGTACGT' }]);
    await rejectsWith(whole.subarray(0, whole.length - 2), 'is truncated');
  });

  it('bounds the sequence count and total bases', async () => {
    const twoBit = writeTwoBit([
      { name: 'a', sequence: 'ACGTACGT' },
      { name: 'b', sequence: 'ACGTACGT' },
    ]);
    await expect(convertToString(twoBit, { maxSequences: 1 })).rejects.toThrow(
      'declares 2 sequences; at most 1 are supported'
    );
    await expect(convertToString(twoBit, { maxTotalBases: 15 })).rejects.toThrow(
      'holds more than 15 bases'
    );
    await expect(convertToString(twoBit, { maxTotalBases: 16 })).resolves.toContain('>b');
  });

  it('typed failures carry a stable code', async () => {
    const root = await temporaryRoot();
    const twoBitPath = join(root, 'input.2bit');
    await writeFile(twoBitPath, Buffer.from('nope'));
    await expect(
      convertTwoBitToFasta({ twoBitPath, fastaPath: join(root, 'out.fa') })
    ).rejects.toBeInstanceOf(TwoBitFormatError);
    await expect(
      convertTwoBitToFasta({ twoBitPath, fastaPath: join(root, 'out.fa') })
    ).rejects.toMatchObject({ code: 'TWOBIT_INVALID' });
  });

  it('never overwrites an existing FASTA and leaves it intact on refusal', async () => {
    const root = await temporaryRoot();
    const twoBitPath = join(root, 'input.2bit');
    const fastaPath = join(root, 'existing.fa');
    await writeFile(twoBitPath, writeTwoBit([{ name: 'a', sequence: 'ACGT' }]));
    await writeFile(fastaPath, '>keep\nAAAA\n');
    await expect(convertTwoBitToFasta({ twoBitPath, fastaPath })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(readFile(fastaPath, 'utf8')).resolves.toBe('>keep\nAAAA\n');
  });

  it('stops on cancellation and removes the partial FASTA', async () => {
    const root = await temporaryRoot();
    const twoBitPath = join(root, 'input.2bit');
    const fastaPath = join(root, 'out.fa');
    await writeFile(
      twoBitPath,
      writeTwoBit([
        { name: 'a', sequence: 'ACGT'.repeat(100) },
        { name: 'b', sequence: 'ACGT'.repeat(100) },
      ])
    );
    const controller = new AbortController();
    await expect(
      convertTwoBitToFasta({
        twoBitPath,
        fastaPath,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(fastaPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
