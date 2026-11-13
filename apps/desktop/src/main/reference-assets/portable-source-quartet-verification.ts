import { open, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  parsePortablePreparedReferenceSourceReceiptV2,
  type PortablePreparedReferenceSourceReceiptV2,
} from './portable-prepared-reference-source-receipt';
import {
  LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE,
  samePreparedSourceFileIdentity,
} from './prepared-reference-source-receipt';
import { verifyOptionalSha256 } from './reference-preparation-file-integrity';

export type IndexedSourceQuartet = readonly [string, string, string, string];

export async function verifyPortableSourceQuartet(input: {
  readonly chrom: string;
  readonly paths: IndexedSourceQuartet;
  readonly expectedReceipt: PortablePreparedReferenceSourceReceiptV2;
  readonly assertSafePath: (path: string) => Promise<void>;
}): Promise<boolean> {
  const handles: FileHandle[] = [];
  const receiptPath = join(dirname(input.paths[0]), LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE);
  const paths = [...input.paths, receiptPath];
  try {
    for (const path of paths) await input.assertSafePath(path);
    for (const path of paths) handles.push(await open(path, 'r'));
    const before = await Promise.all(handles.map((handle) => handle.stat({ bigint: true })));
    if (before.some((metadata) => !metadata.isFile() || metadata.size <= 0n)) return false;
    const receipt = parsePortablePreparedReferenceSourceReceiptV2(
      JSON.parse(await handles[4].readFile('utf8')) as unknown
    );
    const expected = parsePortablePreparedReferenceSourceReceiptV2(input.expectedReceipt);
    if (
      !receipt ||
      !expected ||
      receipt.chrom !== input.chrom ||
      JSON.stringify(receipt) !== JSON.stringify(expected)
    )
      return false;
    const kinds = ['fasta', 'fai', 'gff', 'tbi'] as const;
    for (const [index, kind] of kinds.entries()) {
      const metadata = await handles[index].stat();
      const identity = expected.output[kind];
      if (
        metadata.size !== identity.byteLength ||
        !samePreparedSourceFileIdentity(identity.continuity, metadata)
      )
        return false;
      await verifyOptionalSha256(input.paths[index], identity.sha256, `${input.chrom} ${kind}`);
    }
    const after = await Promise.all(paths.map((path) => stat(path, { bigint: true })));
    return before.every((metadata, index) => sameStableFile(metadata, after[index]));
  } catch {
    return false;
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
}

function sameStableFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}
