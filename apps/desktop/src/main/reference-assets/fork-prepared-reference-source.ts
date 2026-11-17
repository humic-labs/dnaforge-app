import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ReferenceAssemblyEntry } from '../../features/sequence/reference-catalog';
import {
  LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE,
  localPreparedSourceReceiptMatches,
  samePreparedSourceFileIdentity,
  type PreparedOutputIdentitySet,
} from './prepared-reference-source-receipt';
import { PREPARED_REFERENCE_DEFINITION_FILE } from './reference-preparation-manifest';
import { parsePortablePreparedReferenceSourceReceiptV2 } from './portable-prepared-reference-source-receipt';
import { assertAtOrBelow, fileIdentity } from './reference-preparation-file-integrity';

export async function forkPreparedReferenceSourceGeneration(input: {
  readonly entry: ReferenceAssemblyEntry;
  readonly sourceGenerationRoot: string;
  readonly destinationGenerationRoot: string;
}): Promise<void> {
  const sourceRoot = await realpath(input.sourceGenerationRoot);
  const destinationRoot = await realpath(input.destinationGenerationRoot);
  if (sourceRoot === destinationRoot) throw new Error('Reference source fork must be independent.');
  const copy = async (relativePath: string): Promise<void> => {
    const source = resolve(sourceRoot, relativePath);
    const destination = resolve(destinationRoot, relativePath);
    assertAtOrBelow(sourceRoot, source, 'Inherited reference source');
    assertAtOrBelow(destinationRoot, destination, 'Owned reference source');
    assertAtOrBelow(sourceRoot, await realpath(source), 'Inherited reference source');
    const before = await fileIdentity(source);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
    if (
      !samePreparedSourceFileIdentity(before, await fileIdentity(source)) ||
      (await stat(destination)).size !== before.size
    ) {
      throw new Error('Inherited reference source changed while it was copied.');
    }
  };

  for (const member of input.entry.members) {
    const manifest = member.manifest;
    if (!manifest) throw new Error(`${member.chrom} has no prepared source manifest.`);
    const paths = {
      fasta: manifest.fastaPath,
      fai: manifest.faiPath,
      ...(manifest.gffPath && manifest.tbiPath
        ? { gff: manifest.gffPath, tbi: manifest.tbiPath }
        : {}),
    };
    if (Boolean(manifest.gffPath) !== Boolean(manifest.tbiPath)) {
      throw new Error(`${member.chrom} has a partial annotation manifest.`);
    }
    const receiptRelativePath = join(
      dirname(manifest.fastaPath),
      LOCAL_PREPARED_REFERENCE_SOURCE_RECEIPT_FILE
    );
    const receiptPath = resolve(sourceRoot, receiptRelativePath);
    assertAtOrBelow(sourceRoot, receiptPath, 'Inherited reference receipt');
    assertAtOrBelow(sourceRoot, await realpath(receiptPath), 'Inherited reference receipt');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as unknown;
    const portable = parsePortablePreparedReferenceSourceReceiptV2(receipt);
    const before = Object.fromEntries(
      await Promise.all(
        Object.entries(paths).map(async ([kind, path]) => [
          kind,
          await fileIdentity(resolve(sourceRoot, path)),
        ])
      )
    ) as unknown as PreparedOutputIdentitySet;
    const ready = portable
      ? portable.chrom === member.chrom &&
        Object.entries(paths).every(([kind]) =>
          samePreparedSourceFileIdentity(
            portable.output[kind as keyof typeof portable.output].continuity,
            before[kind as keyof typeof before]
          )
        )
      : localPreparedSourceReceiptMatches({
          value: receipt,
          chrom: member.chrom,
          source: null,
          output: before,
        });
    if (!ready) throw new Error(`${member.chrom} inherited reference receipt is stale.`);
    for (const path of Object.values(paths)) await copy(path);
    if (manifest.fastaPath.toLowerCase().endsWith('.gz')) await copy(`${manifest.fastaPath}.gzi`);
    for (const [kind, path] of Object.entries(paths)) {
      if (
        !samePreparedSourceFileIdentity(
          before[kind as keyof typeof before],
          await fileIdentity(resolve(sourceRoot, path))
        )
      ) {
        throw new Error(`${member.chrom} inherited reference source changed during the fork.`);
      }
    }
    const after = Object.fromEntries(
      await Promise.all(
        Object.entries(paths).map(async ([kind, path]) => [
          kind,
          await fileIdentity(resolve(destinationRoot, path)),
        ])
      )
    );
    const output = portable
      ? Object.fromEntries(
          Object.entries(portable.output).map(([kind, identity]) => [
            kind,
            { ...identity, continuity: after[kind] },
          ])
        )
      : after;
    await writeFile(
      resolve(destinationRoot, receiptRelativePath),
      `${JSON.stringify({ ...(receipt as object), output })}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
  }
  await copy(PREPARED_REFERENCE_DEFINITION_FILE);
}
