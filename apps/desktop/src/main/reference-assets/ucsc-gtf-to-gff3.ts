import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { createGunzip } from 'node:zlib';

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const ATTRIBUTE_KEY = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;
const MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;
const MAX_EXPANDED_GTF_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_GTF_LINE_BYTES = 16 * 1024 * 1024;
const MAX_GTF_FEATURE_ROWS = 5_000_000;

export interface UcscGtfContigAuthority {
  readonly sourceSeqId: string;
  readonly lengthBp: number;
}

export interface ConvertUcscGtfToGff3Input {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly contigs: readonly UcscGtfContigAuthority[];
  readonly limits?: Readonly<{
    maxExpandedBytes?: number;
    maxLineBytes?: number;
    maxFeatureRows?: number;
  }>;
}

export interface UcscGtfToGff3Receipt {
  readonly sha256: string;
  readonly byteLength: number;
  readonly sourceRows: number;
  readonly admittedSourceRows: number;
  readonly omittedSourceRows: number;
  readonly omittedSourceSeqIds: readonly string[];
  readonly featureRows: number;
  readonly geneRows: number;
  readonly transcriptRows: number;
}

interface ParsedGtfRow {
  readonly lineNumber: number;
  readonly seqId: string;
  readonly source: string;
  readonly featureType: string;
  readonly start: number;
  readonly end: number;
  readonly score: string;
  readonly strand: string;
  readonly phase: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly geneId: string;
  readonly transcriptId?: string;
}

interface AggregateFeature {
  readonly id: string;
  readonly seqId: string;
  readonly source: string;
  readonly strand: string;
  readonly geneId: string;
  readonly geneName?: string;
  start: number;
  end: number;
}

interface AggregateTranscript extends AggregateFeature {
  readonly transcriptId: string;
  readonly parentGeneId: string;
}

export async function convertUcscGtfToGff3(
  input: ConvertUcscGtfToGff3Input
): Promise<UcscGtfToGff3Receipt> {
  const contigs = admitContigs(input.contigs);
  const limits = admitLimits(input.limits);
  const contigById = new Map(contigs.map((contig) => [contig.sourceSeqId, contig]));
  const genes = new Map<string, AggregateFeature>();
  const transcripts = new Map<string, AggregateTranscript>();
  const omittedSourceSeqIds = new Set<string>();
  let sourceRows = 0;
  let admittedSourceRows = 0;
  let omittedSourceRows = 0;

  for await (const { line, lineNumber } of readSourceLines(input.sourcePath, limits)) {
    const row = parseGtfRow(line, lineNumber, contigById);
    if (!row) continue;
    sourceRows += 1;
    if (sourceRows > limits.maxFeatureRows) {
      throw new Error('UCSC GTF exceeded the feature-row bound.');
    }
    if (!contigById.has(row.seqId)) {
      omittedSourceRows += 1;
      omittedSourceSeqIds.add(row.seqId);
      continue;
    }
    admittedSourceRows += 1;
    aggregateRow(row, genes, transcripts);
  }
  if (sourceRows === 0) throw new Error('UCSC GTF contains no feature rows.');
  if (admittedSourceRows === 0) {
    throw new Error('UCSC GTF contains no feature rows on the admitted UCSC contigs.');
  }

  const destination = await open(input.destinationPath, 'wx', 0o600);
  const writer = createHashedWriter(destination);
  let featureRows = 0;
  try {
    await writer.append('##gff-version 3\n');
    for (const contig of contigs) {
      await writer.append(`##sequence-region ${contig.sourceSeqId} 1 ${contig.lengthBp}\n`);
    }
    for (const contig of contigs) {
      await writer.append(
        gff3Line({
          seqId: contig.sourceSeqId,
          source: 'UCSC',
          featureType: 'region',
          start: 1,
          end: contig.lengthBp,
          score: '.',
          strand: '.',
          phase: '.',
          attributes: [
            ['ID', stableId('region', contig.sourceSeqId)],
            ['Name', contig.sourceSeqId],
          ],
        })
      );
    }
    for (const gene of genes.values()) {
      await writer.append(
        gff3Line({
          ...gene,
          featureType: 'gene',
          score: '.',
          phase: '.',
          attributes: [
            ['ID', gene.id],
            ['Name', gene.geneName ?? gene.geneId],
            ['gene_id', gene.geneId],
          ],
        })
      );
    }
    for (const transcript of transcripts.values()) {
      await writer.append(
        gff3Line({
          ...transcript,
          featureType: 'mRNA',
          score: '.',
          phase: '.',
          attributes: [
            ['ID', transcript.id],
            ['Parent', transcript.parentGeneId],
            ['Name', transcript.transcriptId],
            ['gene_id', transcript.geneId],
            ['transcript_id', transcript.transcriptId],
          ],
        })
      );
    }

    for await (const { line, lineNumber } of readSourceLines(input.sourcePath, limits)) {
      const row = parseGtfRow(line, lineNumber, contigById);
      if (
        !row ||
        !contigById.has(row.seqId) ||
        row.featureType === 'gene' ||
        isTranscriptFeature(row.featureType)
      ) {
        continue;
      }
      if (!row.transcriptId) {
        throw new Error(`UCSC GTF line ${row.lineNumber} has no transcript_id attribute.`);
      }
      const transcript = transcripts.get(transcriptKey(row));
      if (!transcript) {
        throw new Error(`UCSC GTF line ${row.lineNumber} has no admitted transcript parent.`);
      }
      const copiedAttributes = [...row.attributes].filter(
        ([key]) => key !== 'ID' && key !== 'Parent'
      );
      await writer.append(
        gff3Line({
          ...row,
          attributes: [
            ['ID', `ucsc-row-${row.lineNumber}`],
            ['Parent', transcript.id],
            ...copiedAttributes,
          ],
        })
      );
      featureRows += 1;
    }
    if (featureRows === 0) {
      throw new Error('UCSC GTF contains no child feature rows.');
    }
    const identity = await writer.finish();
    return {
      ...identity,
      sourceRows,
      admittedSourceRows,
      omittedSourceRows,
      omittedSourceSeqIds: [...omittedSourceSeqIds].sort(),
      featureRows,
      geneRows: genes.size,
      transcriptRows: transcripts.size,
    };
  } catch (error) {
    await destination.close().catch(() => undefined);
    await rm(input.destinationPath, { force: true });
    throw error;
  }
}

interface AdmittedLimits {
  readonly maxExpandedBytes: number;
  readonly maxLineBytes: number;
  readonly maxFeatureRows: number;
}

function admitLimits(limits: ConvertUcscGtfToGff3Input['limits']): AdmittedLimits {
  const admit = (value: number | undefined, maximum: number, label: string): number => {
    const admitted = value ?? maximum;
    if (!Number.isSafeInteger(admitted) || admitted < 1 || admitted > maximum) {
      throw new Error(`UCSC GTF ${label} must be a positive safe integer within the hard limit.`);
    }
    return admitted;
  };
  return {
    maxExpandedBytes: admit(
      limits?.maxExpandedBytes,
      MAX_EXPANDED_GTF_BYTES,
      'expanded byte bound'
    ),
    maxLineBytes: admit(limits?.maxLineBytes, MAX_GTF_LINE_BYTES, 'line byte bound'),
    maxFeatureRows: admit(limits?.maxFeatureRows, MAX_GTF_FEATURE_ROWS, 'feature-row bound'),
  };
}

function admitContigs(
  rawContigs: readonly UcscGtfContigAuthority[]
): readonly UcscGtfContigAuthority[] {
  if (!Array.isArray(rawContigs) || rawContigs.length === 0) {
    throw new Error('UCSC GTF conversion requires a non-empty chromosome-size authority.');
  }
  const seen = new Set<string>();
  return rawContigs.map((contig, index) => {
    if (
      !contig ||
      typeof contig.sourceSeqId !== 'string' ||
      contig.sourceSeqId.length === 0 ||
      /[\s\t\r\n]/u.test(contig.sourceSeqId)
    ) {
      throw new Error(`UCSC chromosome size ${index} has an invalid sequence ID.`);
    }
    if (!Number.isSafeInteger(contig.lengthBp) || contig.lengthBp < 1) {
      throw new Error(`UCSC chromosome size ${contig.sourceSeqId} has an invalid length.`);
    }
    if (seen.has(contig.sourceSeqId)) {
      throw new Error(`UCSC chromosome sizes duplicate ${contig.sourceSeqId}.`);
    }
    seen.add(contig.sourceSeqId);
    return Object.freeze({ sourceSeqId: contig.sourceSeqId, lengthBp: contig.lengthBp });
  });
}

async function* readSourceLines(
  path: string,
  limits: AdmittedLimits
): AsyncGenerator<{ readonly line: string; readonly lineNumber: number }> {
  const file = await open(path, 'r');
  const magic = Buffer.alloc(2);
  try {
    await file.read(magic, 0, magic.byteLength, 0);
  } finally {
    await file.close();
  }
  const raw = createReadStream(path);
  const decoded: Readable = magic.equals(GZIP_MAGIC) ? raw.pipe(createGunzip()) : raw;
  const input = decoded.pipe(createInputLimiter(limits));
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      yield { line, lineNumber };
    }
  } finally {
    lines.close();
    input.destroy();
    decoded.destroy();
    raw.destroy();
  }
}

function createInputLimiter(limits: AdmittedLimits): Transform {
  let expandedBytes = 0;
  let lineBytes = 0;
  return new Transform({
    transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      expandedBytes += bytes.byteLength;
      if (expandedBytes > limits.maxExpandedBytes) {
        callback(new Error('UCSC GTF exceeded the expanded byte bound.'));
        return;
      }
      for (const byte of bytes) {
        if (byte === 0x0a) {
          lineBytes = 0;
        } else {
          lineBytes += 1;
          if (lineBytes > limits.maxLineBytes) {
            callback(new Error('UCSC GTF exceeded the line byte bound.'));
            return;
          }
        }
      }
      callback(null, bytes);
    },
  });
}

function parseGtfRow(
  line: string,
  lineNumber: number,
  contigById: ReadonlyMap<string, UcscGtfContigAuthority>
): ParsedGtfRow | null {
  if (line.length === 0 || line.startsWith('#')) return null;
  const fields = line.split('\t');
  if (fields.length !== 9) {
    throw new Error(`UCSC GTF line ${lineNumber} must contain exactly 9 tab-delimited fields.`);
  }
  const [seqId, source, featureType, startRaw, endRaw, score, strand, phase, attributesRaw] =
    fields;
  if (seqId.length === 0 || seqId.length > 255 || /\s/u.test(seqId)) {
    throw new Error(`UCSC GTF line ${lineNumber} has an invalid sequence ID.`);
  }
  const contig = contigById.get(seqId);
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new Error(`UCSC GTF line ${lineNumber} has invalid coordinates ${startRaw}..${endRaw}.`);
  }
  if (contig && end > contig.lengthBp) {
    throw new Error(
      `UCSC GTF line ${lineNumber} coordinates ${startRaw}..${endRaw} exceed ${seqId} length ${contig.lengthBp}.`
    );
  }
  if (!source || !featureType || /[\t\r\n]/u.test(source + featureType)) {
    throw new Error(`UCSC GTF line ${lineNumber} has an invalid source or feature type.`);
  }
  if (score !== '.' && !Number.isFinite(Number(score))) {
    throw new Error(`UCSC GTF line ${lineNumber} has an invalid score.`);
  }
  if (!['+', '-', '.', '?'].includes(strand)) {
    throw new Error(`UCSC GTF line ${lineNumber} has an invalid strand.`);
  }
  if (!['0', '1', '2', '.'].includes(phase)) {
    throw new Error(`UCSC GTF line ${lineNumber} has an invalid phase.`);
  }
  const attributes = parseGtfAttributes(attributesRaw, lineNumber);
  const geneId = attributes.get('gene_id');
  if (!geneId) throw new Error(`UCSC GTF line ${lineNumber} has no gene_id attribute.`);
  const transcriptId = attributes.get('transcript_id');
  if (featureType !== 'gene' && !transcriptId) {
    throw new Error(`UCSC GTF line ${lineNumber} has no transcript_id attribute.`);
  }
  return {
    lineNumber,
    seqId,
    source,
    featureType,
    start,
    end,
    score,
    strand,
    phase,
    attributes,
    geneId,
    ...(transcriptId ? { transcriptId } : {}),
  };
}

function parseGtfAttributes(raw: string, lineNumber: number): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  let cursor = 0;
  const skipSpaceAndSemicolons = (): void => {
    while (cursor < raw.length && (raw[cursor] === ' ' || raw[cursor] === ';')) cursor += 1;
  };
  while (cursor < raw.length) {
    skipSpaceAndSemicolons();
    if (cursor >= raw.length) break;
    const keyStart = cursor;
    while (cursor < raw.length && !/[\s;]/u.test(raw[cursor])) cursor += 1;
    const key = raw.slice(keyStart, cursor);
    if (!ATTRIBUTE_KEY.test(key)) {
      throw new Error(`UCSC GTF line ${lineNumber} has an invalid attribute key.`);
    }
    while (cursor < raw.length && /\s/u.test(raw[cursor])) cursor += 1;
    if (cursor >= raw.length) {
      throw new Error(`UCSC GTF line ${lineNumber} attribute ${key} has no value.`);
    }
    let value = '';
    if (raw[cursor] === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < raw.length) {
        const character = raw[cursor];
        cursor += 1;
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === '\\') {
          if (cursor >= raw.length) break;
          value += raw[cursor];
          cursor += 1;
        } else {
          value += character;
        }
      }
      if (!closed) {
        throw new Error(`UCSC GTF line ${lineNumber} attribute ${key} has an unterminated quote.`);
      }
    } else {
      const valueStart = cursor;
      while (cursor < raw.length && raw[cursor] !== ';') cursor += 1;
      value = raw.slice(valueStart, cursor).trim();
    }
    while (cursor < raw.length && /\s/u.test(raw[cursor])) cursor += 1;
    if (cursor < raw.length && raw[cursor] !== ';') {
      throw new Error(`UCSC GTF line ${lineNumber} attribute ${key} is malformed.`);
    }
    if (cursor < raw.length) cursor += 1;
    if (value.length === 0) {
      throw new Error(`UCSC GTF line ${lineNumber} attribute ${key} is empty.`);
    }
    if (attributes.has(key)) {
      throw new Error(`UCSC GTF line ${lineNumber} duplicates attribute ${key}.`);
    }
    attributes.set(key, value);
  }
  return attributes;
}

function aggregateRow(
  row: ParsedGtfRow,
  genes: Map<string, AggregateFeature>,
  transcripts: Map<string, AggregateTranscript>
): void {
  const geneKey = aggregateKey(row.seqId, row.strand, row.geneId);
  const gene = genes.get(geneKey);
  if (gene) {
    gene.start = Math.min(gene.start, row.start);
    gene.end = Math.max(gene.end, row.end);
  } else {
    genes.set(geneKey, {
      id: stableId('gene', geneKey),
      seqId: row.seqId,
      source: row.source,
      strand: row.strand,
      geneId: row.geneId,
      ...(row.attributes.get('gene_name') ? { geneName: row.attributes.get('gene_name') } : {}),
      start: row.start,
      end: row.end,
    });
  }
  if (!row.transcriptId) return;
  const key = transcriptKey(row);
  const transcript = transcripts.get(key);
  const parentGeneId = stableId('gene', geneKey);
  if (transcript) {
    if (transcript.parentGeneId !== parentGeneId) {
      throw new Error(
        `UCSC GTF transcript ${row.transcriptId} changes gene identity at line ${row.lineNumber}.`
      );
    }
    transcript.start = Math.min(transcript.start, row.start);
    transcript.end = Math.max(transcript.end, row.end);
  } else {
    transcripts.set(key, {
      id: stableId('transcript', key),
      parentGeneId,
      transcriptId: row.transcriptId,
      seqId: row.seqId,
      source: row.source,
      strand: row.strand,
      geneId: row.geneId,
      ...(row.attributes.get('gene_name') ? { geneName: row.attributes.get('gene_name') } : {}),
      start: row.start,
      end: row.end,
    });
  }
}

function transcriptKey(row: ParsedGtfRow): string {
  if (!row.transcriptId) throw new Error('Cannot build a transcript key without transcript_id.');
  return aggregateKey(row.seqId, row.strand, row.transcriptId);
}

function aggregateKey(seqId: string, strand: string, sourceId: string): string {
  return `${seqId}\u0000${strand}\u0000${sourceId}`;
}

function stableId(kind: string, identity: string): string {
  return `ucsc-${kind}-${createHash('sha256').update(identity).digest('hex')}`;
}

function isTranscriptFeature(featureType: string): boolean {
  return featureType === 'transcript' || featureType === 'mRNA';
}

function gff3Line(input: {
  readonly seqId: string;
  readonly source: string;
  readonly featureType: string;
  readonly start: number;
  readonly end: number;
  readonly score: string;
  readonly strand: string;
  readonly phase: string;
  readonly attributes: ReadonlyArray<readonly [string, string]>;
}): string {
  const attributes = input.attributes
    .map(([key, value]) => `${key}=${encodeGff3Attribute(value)}`)
    .join(';');
  return (
    [
      input.seqId,
      input.source,
      input.featureType,
      input.start,
      input.end,
      input.score,
      input.strand,
      input.phase,
      attributes,
    ].join('\t') + '\n'
  );
}

function encodeGff3Attribute(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function createHashedWriter(destination: Awaited<ReturnType<typeof open>>): {
  readonly append: (text: string) => Promise<void>;
  readonly finish: () => Promise<{ readonly sha256: string; readonly byteLength: number }>;
} {
  const hash = createHash('sha256');
  let byteLength = 0;
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;
  let finished = false;
  const flush = async (): Promise<void> => {
    if (bufferedBytes === 0) return;
    const bytes = Buffer.concat(buffered, bufferedBytes);
    await destination.writeFile(bytes);
    hash.update(bytes);
    byteLength += bytes.byteLength;
    buffered = [];
    bufferedBytes = 0;
  };
  return {
    append: async (text: string): Promise<void> => {
      if (finished) throw new Error('Cannot append to a finished GFF3 writer.');
      const bytes = Buffer.from(text);
      buffered.push(bytes);
      bufferedBytes += bytes.byteLength;
      if (bufferedBytes >= MAX_BUFFERED_OUTPUT_BYTES) await flush();
    },
    finish: async (): Promise<{ readonly sha256: string; readonly byteLength: number }> => {
      if (finished) throw new Error('Cannot finish a GFF3 writer twice.');
      finished = true;
      await flush();
      await destination.sync();
      await destination.close();
      return { sha256: hash.digest('hex'), byteLength };
    },
  };
}
