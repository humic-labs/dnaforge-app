import type { FilesystemStat } from '../../shared/filesystem-stat';
import {
  ALIGNED_READ_REFERENCE_GENERATION_V1,
  ALIGNED_READ_SOURCE_GENERATION_V1,
  type AlignedReadFileGenerationV1,
  type AlignedReadReferenceGenerationV1,
  type AlignedReadSourceGenerationV1,
} from '../../shared/aligned-read-source-generation';

export {
  ALIGNED_READ_REFERENCE_GENERATION_V1,
  ALIGNED_READ_SOURCE_GENERATION_V1,
  alignedReadReferenceGenerationKey,
  alignedReadReferenceGenerationsEqual,
  alignedReadSourceGenerationKey,
  alignedReadSourceGenerationsEqual,
  isAlignedReadReferenceGeneration,
  isAlignedReadSourceGeneration,
  type AlignedReadFileGenerationV1,
  type AlignedReadReferenceGenerationV1,
  type AlignedReadSourceGenerationV1,
} from '../../shared/aligned-read-source-generation';

export interface AlignedReadSourcePaths {
  readonly bamPath: string;
  readonly indexPath?: string;
  readonly referencePath?: string;
}

type StatFile = (path: string) => Promise<FilesystemStat>;

export async function captureAlignedReadSourceGeneration(
  source: AlignedReadSourcePaths,
  statFile: StatFile
): Promise<AlignedReadSourceGenerationV1> {
  const isCram = source.bamPath.split(/[?#]/, 1)[0]?.toLowerCase().endsWith('.cram') === true;
  const indexPath = source.indexPath?.trim();
  if (!indexPath) {
    throw new Error(`${isCram ? 'CRAM' : 'BAM'} index path is required.`);
  }
  const referencePath = source.referencePath?.trim();
  if (isCram && !referencePath) {
    throw new Error('CRAM reference FASTA path is required.');
  }

  const alignment = await captureFileGeneration(
    source.bamPath,
    `${isCram ? 'CRAM' : 'BAM'} file`,
    statFile
  );
  const index = await captureFileGeneration(
    indexPath,
    `${isCram ? 'CRAM' : 'BAM'} index`,
    statFile
  );
  if (!isCram || !referencePath) {
    return { contract: ALIGNED_READ_SOURCE_GENERATION_V1, alignment, index };
  }

  const reference = await captureFileGeneration(referencePath, 'reference FASTA', statFile);
  const referenceIndex = await captureFileGeneration(
    `${referencePath}.fai`,
    'reference FASTA index',
    statFile
  );
  return {
    contract: ALIGNED_READ_SOURCE_GENERATION_V1,
    alignment,
    index,
    reference,
    referenceIndex,
  };
}

export async function captureAlignedReadReferenceGeneration(
  referencePath: string,
  statFile: StatFile
): Promise<AlignedReadReferenceGenerationV1> {
  const reference = await captureFileGeneration(referencePath, 'reference FASTA', statFile);
  const referenceIndex = await captureFileGeneration(
    `${reference.canonicalPath}.fai`,
    'reference FASTA index',
    statFile
  );
  return {
    contract: ALIGNED_READ_REFERENCE_GENERATION_V1,
    reference,
    referenceIndex,
  };
}

async function captureFileGeneration(
  path: string,
  label: string,
  statFile: StatFile
): Promise<AlignedReadFileGenerationV1> {
  let stat: FilesystemStat;
  try {
    stat = await statFile(path);
  } catch {
    throw new Error(
      `${label} was moved or is unavailable: ${path}. Re-add it from its new location.`
    );
  }
  if (!stat.isFile) {
    throw new Error(`${label} is not a file: ${path}.`);
  }
  return {
    canonicalPath: stat.canonicalPath,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    ...(stat.device ? { device: stat.device } : {}),
    ...(stat.inode ? { inode: stat.inode } : {}),
  };
}
