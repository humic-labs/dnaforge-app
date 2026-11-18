import { createHash } from 'node:crypto';
import { stat as statFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { GenomeFeature, IndexedGenomeManifest } from '@waypoint/genome-data';
import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import type { PreparedReferenceAssemblyEntryV1 } from '../shared/reference-assets-ipc';
import type { SequenceDataLayerTargetSnapshot } from '../shared/sequence-data-layer';
import { fingerprintSequenceDataLayerAnnotations } from '../shared/sequence-data-layer-annotations';
import {
  sequenceDataLayerIndexedTargetId,
  MAX_INDEXED_SEQUENCE_DATA_LAYER_CONTIG_BASES,
  type SequenceDataLayerIndexedTarget,
} from '../shared/sequence-data-layer-indexed-target';

const MAX_GFF_BYTES = 32 * 1024 * 1024;
const MAX_FEATURES = 100_000;

type IndexedSource = Pick<
  LocalIndexedGenomeDataSource,
  'getChromosomeLength' | 'getSequence' | 'getFeatures' | 'close'
>;
interface SourceStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
  readonly dev: number;
  isFile(): boolean;
}
export interface IndexedSequenceDataLayerTargetDependencies {
  withReference<T>(
    referenceId: string,
    use: (entry: PreparedReferenceAssemblyEntryV1) => Promise<T>
  ): Promise<T>;
  readonly createSource?: (manifest: IndexedGenomeManifest) => IndexedSource;
  readonly stat?: (path: string) => Promise<SourceStat>;
}

function sourceStamp(value: SourceStat): string {
  return JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs]);
}

function annotationsFromFeatures(
  features: readonly GenomeFeature[],
  chrom: string,
  length: number
) {
  if (features.length > MAX_FEATURES)
    throw new Error('Indexed data layers support at most 100000 source annotations.');
  return features.flatMap((feature) => {
    if (
      feature.chrom !== chrom ||
      !Number.isSafeInteger(feature.start) ||
      !Number.isSafeInteger(feature.end) ||
      feature.start < 0 ||
      feature.start >= feature.end ||
      feature.end > length
    )
      throw new Error('The prepared reference contains an invalid annotation interval.');
    const id = feature.attributes.ID?.[0] ?? feature.attributes.locus_tag?.[0];
    return id
      ? [{ id, start0: feature.start, end0: feature.end, qualifiers: feature.attributes }]
      : [];
  });
}

export async function indexedSequenceDataLayerTarget(
  documentId: string,
  target: SequenceDataLayerIndexedTarget,
  dependencies: IndexedSequenceDataLayerTargetDependencies
): Promise<SequenceDataLayerTargetSnapshot> {
  if (sequenceDataLayerIndexedTargetId(target) !== documentId)
    throw new Error('Indexed reference target identity does not match its descriptor.');
  return dependencies.withReference(target.referenceId, async (entry) => {
    if (
      entry.id !== target.referenceId ||
      entry.referenceIdentity?.sequenceIdentity !== target.sequenceIdentity ||
      entry.referenceIdentity?.annotationIdentity !== target.annotationIdentity
    )
      throw new Error('The displayed reference content has changed. Reopen it before mapping.');
    const members = entry.members.filter((member) => member.chrom === target.chrom);
    if (members.length !== 1) throw new Error('Choose an exact prepared reference chromosome.');
    const member = members[0];
    const length = member.lengthBp;
    if (
      !Number.isSafeInteger(length) ||
      !length ||
      length < 1 ||
      length > MAX_INDEXED_SEQUENCE_DATA_LAYER_CONTIG_BASES
    )
      throw new Error(
        'Indexed data layers currently require a prepared contig of at most 6000000 bases.'
      );
    if (!member.manifest)
      throw new Error('The reference chromosome has no prepared indexed source.');
    if (Boolean(member.manifest.gffPath) !== Boolean(member.manifest.tbiPath))
      throw new Error('The reference chromosome has an incomplete annotation index.');
    const manifest: IndexedGenomeManifest = { ...member.manifest, chrom: target.chrom, length };
    const paths = [
      manifest.fastaPath,
      manifest.faiPath,
      ...(manifest.fastaPath.toLowerCase().endsWith('.gz') ? [`${manifest.fastaPath}.gzi`] : []),
      ...(manifest.gffPath ? [manifest.gffPath, manifest.tbiPath!] : []),
    ];
    if (paths.some((path) => !path || !isAbsolute(path) || path.includes('\0')))
      throw new Error('The prepared reference contains an invalid source path.');
    const stat = dependencies.stat ?? statFile;
    const before = await Promise.all(paths.map((path) => stat(path)));
    if (before.some((value) => !value.isFile()))
      throw new Error('Prepared reference sources must be regular files.');
    if (manifest.gffPath && before[paths.indexOf(manifest.gffPath)].size > MAX_GFF_BYTES)
      throw new Error(
        'Indexed data layers currently require an annotation source of at most 32 MiB.'
      );
    const source =
      dependencies.createSource?.(manifest) ??
      new LocalIndexedGenomeDataSource(manifest, {
        featureCacheEntries: 1,
        sequenceCacheEntries: 1,
      });
    try {
      if ((await source.getChromosomeLength(target.chrom)) !== length)
        throw new Error('The prepared reference chromosome length has changed.');
      const sequence = await source.getSequence(target.chrom, 0, length);
      if (sequence.length !== length)
        throw new Error('The indexed reference sequence is incomplete.');
      const features = manifest.gffPath ? await source.getFeatures(target.chrom, 0, length, 0) : [];
      const annotations = annotationsFromFeatures(features, target.chrom, length);
      const annotationFingerprint = await fingerprintSequenceDataLayerAnnotations(annotations);
      const after = await Promise.all(paths.map((path) => stat(path)));
      if (before.some((value, index) => sourceStamp(value) !== sourceStamp(after[index])))
        throw new Error('The indexed reference changed while resolving the data layer target.');
      return {
        documentId,
        length,
        sequenceFingerprint: `sha256:${createHash('sha256').update(sequence.toUpperCase()).digest('hex')}`,
        annotationFingerprint,
        annotations,
      };
    } finally {
      await source.close();
    }
  });
}
