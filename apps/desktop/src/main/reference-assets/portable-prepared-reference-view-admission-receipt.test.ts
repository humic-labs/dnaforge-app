import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RECEIPT_FILE_V1,
  readPortablePreparedReferenceViewAdmissionReceiptV1,
  writePortablePreparedReferenceViewAdmissionReceiptV1,
} from './portable-prepared-reference-view-admission-receipt';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('portable prepared-reference durable view admission', () => {
  it('survives a process restart only for the exact bundle, runtime, and payload identities', async () => {
    const fixture = await receiptFixture();

    await writePortablePreparedReferenceViewAdmissionReceiptV1(fixture.input);

    await expect(
      readPortablePreparedReferenceViewAdmissionReceiptV1(fixture.input)
    ).resolves.toEqual({ status: 'hit' });
    await expect(
      readPortablePreparedReferenceViewAdmissionReceiptV1({
        ...fixture.input,
        runtimeSourceFingerprint: 'runtime-build-b',
      })
    ).resolves.toMatchObject({ status: 'miss' });
    await expect(
      readPortablePreparedReferenceViewAdmissionReceiptV1({
        ...fixture.input,
        bundleFingerprint: 'b'.repeat(64),
      })
    ).resolves.toMatchObject({ status: 'miss' });
  });

  it('fails closed when an admitted payload changes without changing its length', async () => {
    const fixture = await receiptFixture();
    await writePortablePreparedReferenceViewAdmissionReceiptV1(fixture.input);

    await writeFile(fixture.annotationPath, 'annotation-search-payloae');

    await expect(
      readPortablePreparedReferenceViewAdmissionReceiptV1(fixture.input)
    ).resolves.toMatchObject({ status: 'miss' });
  });

  it('fails closed when the receipt body or cryptographic seal is altered', async () => {
    const fixture = await receiptFixture();
    await writePortablePreparedReferenceViewAdmissionReceiptV1(fixture.input);
    const receiptPath = join(
      fixture.input.generationRoot,
      '.readiness',
      PORTABLE_PREPARED_REFERENCE_VIEW_ADMISSION_RECEIPT_FILE_V1
    );
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...receipt, runtimeSourceFingerprint: 'forged' })}\n`
    );

    await expect(
      readPortablePreparedReferenceViewAdmissionReceiptV1(fixture.input)
    ).resolves.toMatchObject({ status: 'miss' });
  });
});

async function receiptFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-portable-view-admission-'));
  roots.push(root);
  const generationRoot = join(root, 'generation');
  await mkdir(generationRoot, { recursive: true });
  const annotationPath = join(generationRoot, 'annotation-search.bin');
  const proteinPath = join(generationRoot, 'protein-search.bin');
  const annotationBytes = Buffer.from('annotation-search-payload');
  const proteinBytes = Buffer.from('protein-search-payload');
  await Promise.all([
    writeFile(annotationPath, annotationBytes),
    writeFile(proteinPath, proteinBytes),
  ]);
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  return {
    annotationPath,
    input: {
      generationRoot,
      assemblyId: 'hs1',
      bundleFingerprint: 'a'.repeat(64),
      runtimeSourceFingerprint: 'runtime-build-a',
      payloads: [
        {
          kind: 'annotation' as const,
          objectId: 'annotation-search-payload',
          installPath: 'annotation-search.bin',
          path: annotationPath,
          byteLength: annotationBytes.byteLength,
          sha256: sha256(annotationBytes),
        },
        {
          kind: 'protein' as const,
          objectId: 'protein-search-payload',
          installPath: 'protein-search.bin',
          path: proteinPath,
          byteLength: proteinBytes.byteLength,
          sha256: sha256(proteinBytes),
        },
      ],
    },
  };
}
