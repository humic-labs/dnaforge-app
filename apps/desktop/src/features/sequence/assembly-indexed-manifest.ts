import type { IndexedGenomeManifest } from '../../shared/indexed-genome';

const GFF3_GZ_SUFFIXES = ['.gff3.gz', '.gff.gz'];

export function completeManifestFromIndexedGff3Source(
  manifest: IndexedGenomeManifest
): IndexedGenomeManifest {
  const gffPath = manifest.gffPath ?? null;
  if (!gffPath) return manifest;

  const suffix = GFF3_GZ_SUFFIXES.find((candidate) => gffPath.toLowerCase().endsWith(candidate));
  if (!suffix) return manifest;

  const basePath = gffPath.slice(0, gffPath.length - suffix.length);
  return {
    ...manifest,
    fastaPath: manifest.fastaPath || `${basePath}.fa`,
    faiPath: manifest.faiPath || `${basePath}.fa.fai`,
    tbiPath: manifest.tbiPath || `${gffPath}.tbi`,
  };
}
