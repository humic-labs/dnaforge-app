import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fileIntegrity from './reference-preparation-file-integrity';
import {
  PORTABLE_PREPARED_REFERENCE_SOURCE_RECEIPT_V2,
  type PortablePreparedReferenceSourceReceiptV2,
} from './portable-prepared-reference-source-receipt';
import { LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE } from './prepared-reference-source-receipt';
import { inspectIndexedSourceQuartets } from './create-assembly-reference-asset-service';
import {
  verifyPortableSourceQuartet,
  type IndexedSourceQuartet,
} from './portable-source-quartet-verification';
import type { AssemblyAnnotationSceneReadRequest } from '../../shared/indexed-genome';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'portable-source-quartet-'));
  roots.push(root);
  const paths: IndexedSourceQuartet = [
    join(root, 'chr1.fa.gz'),
    join(root, 'chr1.fa.gz.fai'),
    join(root, 'chr1.gff3.gz'),
    join(root, 'chr1.gff3.gz.tbi'),
  ];
  const bgzf = Buffer.from([
    31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0, 27, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  await writeFile(paths[0], bgzf);
  await writeFile(paths[1], 'chr1\t100\t6\t80\t81\n');
  await writeFile(paths[2], bgzf);
  await writeFile(paths[3], 'index-bytes');
  const now = Date.now() / 1000;
  await utimes(paths[2], now, now);
  await utimes(paths[3], now - 1, now - 1);
  const keys = ['fasta', 'fai', 'gff', 'tbi'] as const;
  const output = {} as PortablePreparedReferenceSourceReceiptV2['output'];
  for (const [index, key] of keys.entries()) {
    const metadata = await stat(paths[index]);
    Object.assign(output, {
      [key]: {
        sha256: createHash('sha256')
          .update(await readFile(paths[index]))
          .digest('hex'),
        byteLength: metadata.size,
        continuity: { size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs },
      },
    });
  }
  const receipt: PortablePreparedReferenceSourceReceiptV2 = {
    contract: PORTABLE_PREPARED_REFERENCE_SOURCE_RECEIPT_V2,
    chrom: 'chr1',
    pipelineRevision: 1,
    bundleFingerprint: 'a'.repeat(64),
    indexerContractToken: 'test-indexer',
    source: { fastaSha256: 'b'.repeat(64), gffSha256: 'c'.repeat(64) },
    output,
  };
  const receiptPath = join(root, LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE);
  await writeFile(receiptPath, JSON.stringify(receipt));
  const input = {
    chrom: 'chr1',
    paths,
    expectedReceipt: receipt,
    assertSafePath: async (path: string) => {
      if (!path.startsWith(root + '/')) throw new Error('unsafe path');
    },
  };
  return { root, paths, receipt, receiptPath, input };
}

describe('published source quartet integrity', () => {
  it('verifies an authenticated quartet even when publication preserved an older index date', async () => {
    const f = await fixture();
    expect(await verifyPortableSourceQuartet(f.input)).toBe(true);
  });

  it.each(['missing', 'malformed', 'chromosome', 'generation', 'continuity', 'hash'] as const)(
    'rejects a %s receipt',
    async (kind) => {
      const f = await fixture();
      if (kind === 'missing') await rm(f.receiptPath);
      else if (kind === 'malformed') await writeFile(f.receiptPath, '{}');
      else {
        const changed = structuredClone(f.receipt);
        if (kind === 'chromosome') Object.assign(changed, { chrom: 'chr2' });
        if (kind === 'generation') Object.assign(changed, { bundleFingerprint: 'd'.repeat(64) });
        if (kind === 'continuity') Object.assign(changed.output.gff.continuity, { mtimeMs: 0 });
        if (kind === 'hash') Object.assign(changed.output.tbi, { sha256: 'e'.repeat(64) });
        await writeFile(f.receiptPath, JSON.stringify(changed));
      }
      expect(await verifyPortableSourceQuartet(f.input)).toBe(false);
    }
  );

  it('rejects changed bytes even when the file length stays the same', async () => {
    const f = await fixture();
    await writeFile(f.paths[3], 'other-bytes');
    expect(await verifyPortableSourceQuartet(f.input)).toBe(false);
  });

  it('checks actual hashes even when recorded continuity describes the current files', async () => {
    const f = await fixture();
    await writeFile(f.paths[3], 'other-bytes');
    const metadata = await stat(f.paths[3]);
    Object.assign(f.receipt.output.tbi.continuity, {
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ctimeMs: metadata.ctimeMs,
    });
    await writeFile(f.receiptPath, JSON.stringify(f.receipt));
    expect(await verifyPortableSourceQuartet(f.input)).toBe(false);
  });

  it.each(['mutation', 'replacement', 'receipt'] as const)(
    'rejects a late %s after the first family member was verified',
    async (kind) => {
      const f = await fixture();
      const verifyHash = fileIntegrity.verifyOptionalSha256;
      vi.spyOn(fileIntegrity, 'verifyOptionalSha256').mockImplementation(async (...args) => {
        await verifyHash(...args);
        if (args[0] !== f.paths[3]) return;
        if (kind === 'mutation') await writeFile(f.paths[0], 'changed-first-family-member');
        else if (kind === 'receipt') await writeFile(f.receiptPath, JSON.stringify(f.receipt));
        else {
          const replacement = join(f.root, 'replacement');
          await writeFile(replacement, await readFile(f.paths[0]));
          await rename(replacement, f.paths[0]);
        }
      });
      expect(await verifyPortableSourceQuartet(f.input)).toBe(false);
    }
  );

  it('guards the receipt as well as every source path', async () => {
    const f = await fixture();
    expect(
      await verifyPortableSourceQuartet({
        ...f.input,
        assertSafePath: async (path: string) => {
          if (path === f.receiptPath) throw new Error('unsafe receipt');
        },
      })
    ).toBe(false);
  });

  it('retains the stale-index rule without an authenticated publication owner', async () => {
    const f = await fixture();
    const request = {
      chromosomes: [
        {
          chrom: 'chr1',
          manifest: {
            fastaPath: f.paths[0],
            faiPath: f.paths[1],
            gffPath: f.paths[2],
            tbiPath: f.paths[3],
          },
        },
      ],
      scope: { placements: [{ annotationCoverage: 'sourced' }] },
    } as unknown as AssemblyAnnotationSceneReadRequest;
    expect(
      await inspectIndexedSourceQuartets(request, { assertSafePath: f.input.assertSafePath })
    ).toEqual({ status: 'stale', message: 'chr1 source index predates its source file.' });
    expect(
      await inspectIndexedSourceQuartets(request, {
        assertSafePath: f.input.assertSafePath,
        verifyPublishedSourceQuartet: (chrom, paths) =>
          verifyPortableSourceQuartet({ ...f.input, chrom, paths }),
      })
    ).toEqual({ status: 'ready' });
  });
});
