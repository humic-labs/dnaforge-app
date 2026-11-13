import { createReadStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import type { NcbiSequenceReportRecordV1 } from './ncbi-reference-package-acquisition';

export interface NormalizeNcbiExternalAnnotationResult {
  readonly sourceSeqIds: ReadonlySet<string>;
  readonly featureRows: number;
}

export async function normalizeNcbiExternalAnnotationGff3(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sequenceReport: ReadonlyArray<NcbiSequenceReportRecordV1>;
  readonly targetSourceSeqIds: ReadonlySet<string>;
}): Promise<NormalizeNcbiExternalAnnotationResult> {
  const { aliases, lengths } = buildSequenceAliasAuthority(
    input.sequenceReport,
    input.targetSourceSeqIds
  );
  const destination = await open(input.destinationPath, 'wx', 0o600);
  const sourceSeqIds = new Set<string>();
  let featureRows = 0;
  try {
    await destination.writeFile('##gff-version 3\n', 'utf8');
    const lines = createInterface({
      input: createReadStream(input.sourcePath),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (line === '' || line === '##gff-version 3') continue;
      if (line === '##FASTA') {
        throw new Error('External annotation GFF3 cannot contain an embedded FASTA section.');
      }
      if (line.startsWith('##sequence-region ')) {
        const fields = line.split(/\s+/u);
        if (fields.length !== 4) {
          throw new Error('External annotation contains a malformed sequence-region directive.');
        }
        const target = requireAlias(aliases, fields[1]);
        const start = positiveCoordinate(fields[2], 'sequence-region start');
        const end = positiveCoordinate(fields[3], 'sequence-region end');
        if (start !== 1 || end !== lengths.get(target)) {
          throw new Error(
            `External annotation sequence-region ${fields[1]} does not match NCBI sequence length.`
          );
        }
        await destination.writeFile(`##sequence-region ${target} ${start} ${end}\n`, 'utf8');
        continue;
      }
      if (line.startsWith('#')) {
        await destination.writeFile(`${line}\n`, 'utf8');
        continue;
      }
      const fields = line.split('\t');
      if (fields.length !== 9) {
        throw new Error('External annotation contains a malformed GFF3 feature row.');
      }
      const target = requireAlias(aliases, fields[0]);
      const start = positiveCoordinate(fields[3], 'feature start');
      const end = positiveCoordinate(fields[4], 'feature end');
      const sequenceLength = lengths.get(target);
      if (end < start || sequenceLength === undefined || end > sequenceLength) {
        throw new Error(
          `External annotation feature on ${fields[0]} exceeds the exact NCBI sequence boundary.`
        );
      }
      fields[0] = target;
      sourceSeqIds.add(target);
      featureRows += 1;
      await destination.writeFile(`${fields.join('\t')}\n`, 'utf8');
    }
    if (featureRows === 0) {
      throw new Error('External annotation contains no GFF3 feature rows.');
    }
    await destination.sync();
  } catch (error) {
    await destination.close().catch(() => undefined);
    await rm(input.destinationPath, { force: true });
    throw error;
  }
  await destination.close();
  return { sourceSeqIds, featureRows };
}

function buildSequenceAliasAuthority(
  records: ReadonlyArray<NcbiSequenceReportRecordV1>,
  targetSourceSeqIds: ReadonlySet<string>
): Readonly<{
  aliases: ReadonlyMap<string, string>;
  lengths: ReadonlyMap<string, number>;
}> {
  const aliases = new Map<string, string>();
  const ambiguous = new Set<string>();
  const lengths = new Map<string, number>();
  for (const record of records) {
    const targets = [record.refseqAccession, record.genbankAccession].filter(
      (accession): accession is string =>
        accession !== undefined && targetSourceSeqIds.has(accession)
    );
    if (targets.length === 0) continue;
    if (targets.length !== 1) {
      throw new Error('NCBI sequence report maps one record to multiple package FASTA IDs.');
    }
    const target = targets[0];
    lengths.set(target, record.length);
    for (const alias of [
      record.genbankAccession,
      record.refseqAccession,
      record.sequenceName,
      record.chrName,
      record.ucscStyleName,
    ]) {
      if (!alias) continue;
      if (ambiguous.has(alias)) continue;
      const existing = aliases.get(alias);
      if (existing && existing !== target) {
        aliases.delete(alias);
        ambiguous.add(alias);
        continue;
      }
      aliases.set(alias, target);
    }
  }
  return { aliases, lengths };
}

function requireAlias(aliases: ReadonlyMap<string, string>, sourceSeqId: string): string {
  const target = aliases.get(sourceSeqId);
  if (!target) {
    throw new Error(
      `External annotation sequence ${sourceSeqId} is absent from the exact NCBI sequence report.`
    );
  }
  return target;
}

function positiveCoordinate(value: string, label: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new Error(`External annotation ${label} must be a positive integer.`);
  }
  const coordinate = Number(value);
  if (!Number.isSafeInteger(coordinate) || coordinate < 1) {
    throw new Error(`External annotation ${label} must be a positive safe integer.`);
  }
  return coordinate;
}
