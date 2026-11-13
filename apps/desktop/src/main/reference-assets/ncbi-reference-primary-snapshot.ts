import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';

export interface ContentReceipt {
  readonly sha256: string;
  readonly byteLength: number;
}

interface FastaRecordRange {
  readonly start: number;
  readonly end: number;
}

const GT = 0x3e;
const NEWLINE = 0x0a;
const HASH = 0x23;
const TAB = 0x09;

export async function writePrimaryFastaSnapshot(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly orderedSourceSeqIds: readonly string[];
}): Promise<ContentReceipt> {
  const wanted = uniqueOrderedIds(input.orderedSourceSeqIds);
  const records = await indexFastaRecords(input.sourcePath);
  const destination = await open(input.destinationPath, 'wx', 0o600);
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    for (const sourceSeqId of wanted) {
      const range = records.get(sourceSeqId);
      if (!range) {
        throw new Error(`Primary FASTA snapshot is missing sequence ${sourceSeqId}.`);
      }
      const source = createReadStream(input.sourcePath, {
        start: range.start,
        end: range.end - 1,
      });
      try {
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(bytes);
          byteLength += bytes.byteLength;
          await destination.write(bytes);
        }
      } finally {
        source.destroy();
      }
    }
    if (byteLength === 0) throw new Error('Primary FASTA snapshot is empty.');
    await destination.sync();
  } finally {
    await destination.close();
  }
  return { sha256: hash.digest('hex'), byteLength };
}

export async function writePrimaryGff3Snapshot(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly orderedContigs: ReadonlyArray<{
    readonly sourceSeqId: string;
    readonly lengthBp: number;
  }>;
}): Promise<ContentReceipt> {
  const wanted = uniqueOrderedIds(input.orderedContigs.map((contig) => contig.sourceSeqId));
  const wantedSet = new Set(wanted);
  const header = Buffer.from(
    [
      '##gff-version 3',
      ...input.orderedContigs.map(
        (contig) => `##sequence-region ${contig.sourceSeqId} 1 ${contig.lengthBp}`
      ),
    ].join('\n') + '\n'
  );
  const destination = await open(input.destinationPath, 'wx', 0o600);
  const hash = createHash('sha256');
  let byteLength = 0;
  const write = async (bytes: Buffer): Promise<void> => {
    hash.update(bytes);
    byteLength += bytes.byteLength;
    await destination.write(bytes);
  };
  try {
    await write(header);
    let sawFasta = false;
    let carry = Buffer.alloc(0);
    for await (const chunk of createReadStream(input.sourcePath)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const combined = carry.byteLength === 0 ? bytes : Buffer.concat([carry, bytes]);
      let offset = 0;
      while (offset < combined.byteLength) {
        const newline = combined.indexOf(NEWLINE, offset);
        if (newline < 0) break;
        const line = combined.subarray(offset, newline);
        offset = newline + 1;
        const result = classifyGff3Line(line, wantedSet);
        if (result === 'fasta') {
          sawFasta = true;
          break;
        }
        if (result === 'feature') {
          await write(Buffer.concat([line, Buffer.from('\n')]));
        }
      }
      carry = combined.subarray(offset);
      if (sawFasta) break;
    }
    if (sawFasta) {
      throw new Error(
        'GFF3 with an embedded ##FASTA section cannot be admitted as a primary snapshot.'
      );
    }
    if (carry.byteLength > 0) {
      const result = classifyGff3Line(carry, wantedSet);
      if (result === 'fasta') {
        throw new Error(
          'GFF3 with an embedded ##FASTA section cannot be admitted as a primary snapshot.'
        );
      }
      if (result === 'feature') {
        await write(Buffer.concat([carry, Buffer.from('\n')]));
      }
    }
    if (byteLength === header.byteLength) {
      throw new Error('Primary GFF3 snapshot contains no feature rows for the selected contigs.');
    }
    await destination.sync();
  } finally {
    await destination.close();
  }
  return { sha256: hash.digest('hex'), byteLength };
}

function classifyGff3Line(line: Buffer, wanted: ReadonlySet<string>): 'skip' | 'feature' | 'fasta' {
  if (line.byteLength === 0) return 'skip';
  if (line[0] === HASH) {
    const text = line.toString('utf8').replace(/\r$/u, '');
    if (text === '##FASTA') return 'fasta';
    return 'skip';
  }
  const tab = line.indexOf(TAB);
  const seqId = (tab < 0 ? line : line.subarray(0, tab)).toString('utf8').replace(/\r$/u, '');
  return wanted.has(seqId) ? 'feature' : 'skip';
}

async function indexFastaRecords(path: string): Promise<ReadonlyMap<string, FastaRecordRange>> {
  const records = new Map<string, FastaRecordRange>();
  let offset = 0;
  let atLineStart = true;
  let recordStart = -1;
  let header = '';
  let inHeader = false;
  let currentId: string | undefined;

  const finish = (end: number): void => {
    if (currentId === undefined || recordStart < 0) return;
    if (records.has(currentId)) {
      throw new Error(`FASTA contains duplicate sequence ID "${currentId}".`);
    }
    records.set(currentId, { start: recordStart, end });
    currentId = undefined;
    recordStart = -1;
  };

  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (let i = 0; i < bytes.byteLength; i += 1) {
      const byte = bytes[i];
      if (atLineStart && byte === GT) {
        finish(offset + i);
        recordStart = offset + i;
        inHeader = true;
        header = '';
        atLineStart = false;
        continue;
      }
      if (byte === NEWLINE) {
        if (inHeader) {
          currentId = fastaId(header);
          inHeader = false;
        }
        atLineStart = true;
      } else {
        atLineStart = false;
        if (inHeader) header += String.fromCharCode(byte);
      }
    }
    offset += bytes.byteLength;
  }
  if (inHeader) currentId = fastaId(header);
  finish(offset);
  if (records.size === 0) throw new Error('FASTA contains no records.');
  return records;
}

function fastaId(header: string): string {
  const sourceSeqId = header.replace(/\r$/u, '').split(/\s+/u, 1)[0]?.trim();
  if (!sourceSeqId) throw new Error('FASTA header has no sequence ID.');
  return sourceSeqId;
}

function uniqueOrderedIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id.trim().length === 0) throw new Error('Primary snapshot contig IDs must be non-empty.');
    if (seen.has(id)) throw new Error(`Primary snapshot contig ID is duplicated: ${id}`);
    seen.add(id);
  }
  return ids;
}
