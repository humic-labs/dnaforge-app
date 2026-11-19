import { sequenceFileTypeForPath } from '@waypoint/sequence-utils/sequence-file-types';
import { sha256Hex } from './sha256';

export const PRESERVED_FASTA_MARKER_PREFIX = '.dnaforge-fasta-';

export function isFastaSource(path: string): boolean {
  return sequenceFileTypeForPath(path)?.format === 'fasta';
}

export async function preservedFastaMarkerPath(path: string): Promise<string> {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const name = path.slice(separator + 1);
  return path.slice(0, separator + 1) + PRESERVED_FASTA_MARKER_PREFIX + (await sha256Hex(name));
}

export async function isPreservedFasta(
  path: string,
  fs: {
    exists: (path: string) => Promise<boolean>;
    readFileBounded: (path: string, maxBytes: number) => Promise<Uint8Array>;
  }
): Promise<boolean> {
  const marker = await preservedFastaMarkerPath(path);
  return (
    (await fs.exists(marker)) &&
    /^[a-f0-9]{64}\n?$/.test(new TextDecoder().decode(await fs.readFileBounded(marker, 65)))
  );
}
