import { stat as statFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type {
  GenomeComparisonLayout,
  GenomeComparisonSide,
  GenomeFeature,
  IndexedGenomeManifest,
} from '@waypoint/genome-data';
import { LocalIndexedGenomeDataSource } from '@waypoint/genome-data/node';
import type { ComparisonAnnotation } from '@waypoint/genome-renderer/pure';
import type { PreparedReferenceAssemblyEntryV1 } from '../shared/reference-assets-ipc';
import {
  MAX_COMPARISON_SOURCE_WINDOWS,
  MAX_COMPARISON_WINDOW_BASES,
  MAX_COMPARISON_WINDOW_FEATURES,
  type ComparisonPreparedSource,
  type ComparisonSourceWindowRequest,
  type ComparisonSourceWindowResult,
} from '../shared/comparison-source';

const SEQUENCE_BLOCK_BASES = 256;
type Interval = Readonly<{ start: number; end: number }>;
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
export interface ComparisonWindowDependencies {
  withReference<T>(
    referenceId: string,
    use: (entry: PreparedReferenceAssemblyEntryV1) => Promise<T>
  ): Promise<T>;
  readonly createSource?: (manifest: IndexedGenomeManifest) => IndexedSource;
  readonly stat?: (path: string) => Promise<SourceStat>;
}

export function comparisonSourceIntervals(
  layout: GenomeComparisonLayout,
  side: GenomeComparisonSide,
  startColumn: number,
  endColumn: number
): readonly Interval[] {
  const intervals: Interval[] = [];
  for (const entry of layout.entries) {
    if (entry.columnStart >= endColumn) break;
    if (entry.kind !== 'block' || entry.columnEnd <= startColumn) continue;
    const from = Math.max(0, Math.floor(startColumn - entry.columnStart));
    const to = Math.min(entry.block.columnLength, Math.ceil(endColumn - entry.columnStart));
    for (const segment of entry.block.segments) {
      if (segment.columnStart >= to) break;
      if (segment.columnEnd <= from) continue;
      const start = side === 'target' ? segment.targetStart : segment.queryStart;
      const end = side === 'target' ? segment.targetEnd : segment.queryEnd;
      if (start === end) continue;
      const first = Math.max(from, segment.columnStart) - segment.columnStart;
      const last = Math.min(to, segment.columnEnd) - segment.columnStart;
      intervals.push(
        side === 'query' && entry.block.strand === '-'
          ? { start: end - last, end: end - first }
          : { start: start + first, end: start + last }
      );
    }
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function stamp(value: SourceStat): string {
  return JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs]);
}

function annotation(
  feature: GenomeFeature,
  chrom: string,
  length: number
): ComparisonAnnotation | null {
  if (feature.type === 'source' || feature.type === 'region') return null;
  if (
    feature.chrom !== chrom ||
    !Number.isSafeInteger(feature.start) ||
    !Number.isSafeInteger(feature.end) ||
    feature.start < 0 ||
    feature.end <= feature.start ||
    feature.end > length
  )
    throw new Error('The prepared comparison annotation has invalid source coordinates.');
  const id = feature.attributes.ID?.[0] ?? feature.attributes.locus_tag?.[0];
  if (!id) return null;
  return {
    id,
    start: feature.start,
    end: feature.end,
    label:
      feature.attributes.Name?.[0] ??
      feature.attributes.label?.[0] ??
      feature.attributes.gene?.[0] ??
      feature.attributes.locus_tag?.[0] ??
      id,
    ...(feature.strand === '+' || feature.strand === '-' ? { strand: feature.strand } : {}),
  };
}

export async function readComparisonSourceWindow(
  request: ComparisonSourceWindowRequest,
  layout: GenomeComparisonLayout,
  dependencies: ComparisonWindowDependencies,
  assertCurrent: () => void
): Promise<ComparisonSourceWindowResult> {
  if (request.camera.endColumn > layout.columnLength)
    throw new Error('The comparison window exceeds its exact alignment columns.');
  const sides = ['target', 'query'] as const;
  const intervals = Object.fromEntries(
    sides.map((side) => [
      side,
      comparisonSourceIntervals(layout, side, request.camera.startColumn, request.camera.endColumn),
    ])
  ) as Record<GenomeComparisonSide, readonly Interval[]>;
  const binding = (side: GenomeComparisonSide): ComparisonPreparedSource | undefined =>
    side === 'target' ? request.source.targetSource : request.source.querySource;
  const sourceWindows = sides.reduce(
    (count, side) => count + (binding(side) ? intervals[side].length : 0),
    0
  );
  const baseCount = sides.reduce(
    (count, side) =>
      count +
      (binding(side)
        ? intervals[side].reduce(
            (sum, interval) =>
              sum +
              (Math.ceil(interval.end / SEQUENCE_BLOCK_BASES) -
                Math.floor(interval.start / SEQUENCE_BLOCK_BASES)) *
                SEQUENCE_BLOCK_BASES,
            0
          )
        : 0),
    0
  );
  const basesReady =
    sourceWindows <= MAX_COMPARISON_SOURCE_WINDOWS && baseCount <= MAX_COMPARISON_WINDOW_BASES;
  const result: {
    -readonly [K in keyof ComparisonSourceWindowResult]: ComparisonSourceWindowResult[K];
  } = {
    projectionId: request.camera.projectionId,
    camera: request.camera,
    basesStatus: basesReady ? 'ready' : 'zoom-in',
    annotationsStatus: { target: 'unbound', query: 'unbound' },
    targetSequenceWindows: [],
    querySequenceWindows: [],
    annotations: { target: [], query: [] },
  };
  let featureCount = 0;
  const useSide = async (index: number): Promise<void> => {
    if (index === sides.length) return;
    const side = sides[index];
    const pinned = binding(side);
    if (!pinned) return useSide(index + 1);
    await dependencies.withReference(pinned.referenceId, async (entry) => {
      assertCurrent();
      if (
        entry.id !== pinned.referenceId ||
        entry.referenceIdentity?.sequenceIdentity !== pinned.sequenceIdentity ||
        entry.referenceIdentity?.annotationIdentity !== pinned.annotationIdentity
      )
        throw new Error('The pinned comparison reference content has changed.');
      const reference =
        side === 'target' ? request.source.targetReference : request.source.queryReference;
      const members = entry.members.filter((member) => member.chrom === reference.chrom);
      if (members.length !== 1 || members[0].lengthBp !== reference.length)
        throw new Error('The comparison axis must match its exact prepared chromosome and length.');
      const member = members[0];
      if (!member.manifest)
        throw new Error('The comparison reference has no prepared indexed source.');
      const manifest: IndexedGenomeManifest = {
        ...member.manifest,
        chrom: reference.chrom,
        length: reference.length,
      };
      if (Boolean(manifest.gffPath) !== Boolean(manifest.tbiPath))
        throw new Error('The comparison reference has an incomplete annotation index.');
      const paths = [
        manifest.fastaPath,
        manifest.faiPath,
        ...(manifest.fastaPath.toLowerCase().endsWith('.gz')
          ? [manifest.gziPath ?? `${manifest.fastaPath}.gzi`]
          : []),
        ...(manifest.gffPath ? [manifest.gffPath, manifest.tbiPath!] : []),
      ];
      if (paths.some((path) => !path || !isAbsolute(path) || path.includes('\0')))
        throw new Error('The prepared comparison reference contains an invalid source path.');
      const stat = dependencies.stat ?? statFile;
      const before = await Promise.all(paths.map((path) => stat(path)));
      if (before.some((value) => !value.isFile()))
        throw new Error('Prepared comparison sources must be regular files.');
      assertCurrent();
      const source =
        dependencies.createSource?.(manifest) ??
        new LocalIndexedGenomeDataSource(manifest, {
          sequenceBlockSize: SEQUENCE_BLOCK_BASES,
          sequenceCacheEntries: 4,
          featureBucketSize: 1,
          featureCacheEntries: 1,
        });
      try {
        if ((await source.getChromosomeLength(reference.chrom)) !== reference.length)
          throw new Error('The prepared comparison chromosome length has changed.');
        const windows: Array<{ start: number; sequence: string }> = [];
        const annotations = new Map<string, ComparisonAnnotation>();
        let annotationsStatus: ComparisonSourceWindowResult['annotationsStatus']['target'] =
          manifest.gffPath ? 'ready' : 'unavailable';
        if (sourceWindows > MAX_COMPARISON_SOURCE_WINDOWS) annotationsStatus = 'zoom-in';
        for (const interval of intervals[side]) {
          assertCurrent();
          if (basesReady) {
            const sequence = await source.getSequence(
              reference.chrom,
              interval.start,
              interval.end
            );
            if (sequence.length !== interval.end - interval.start)
              throw new Error('The prepared comparison sequence window is incomplete.');
            windows.push({ start: interval.start, sequence });
          }
          if (annotationsStatus === 'ready') {
            const features = await source.getFeatures(
              reference.chrom,
              interval.start,
              interval.end,
              1
            );
            featureCount += features.length;
            if (featureCount > MAX_COMPARISON_WINDOW_FEATURES) {
              annotationsStatus = 'zoom-in';
              annotations.clear();
            } else {
              const parents = new Set(
                features
                  .filter((value) => value.type === 'gene' || value.type === 'pseudogene')
                  .flatMap((value) => value.attributes.ID ?? [])
              );
              for (const feature of features) {
                if ((feature.attributes.Parent ?? []).some((id) => parents.has(id))) continue;
                const value = annotation(feature, reference.chrom, reference.length);
                if (!value) continue;
                const previous = annotations.get(value.id);
                if (previous && JSON.stringify(previous) !== JSON.stringify(value))
                  throw new Error(
                    'The comparison source annotation ID has conflicting coordinates.'
                  );
                annotations.set(value.id, value);
              }
            }
          }
          assertCurrent();
        }
        result[side === 'target' ? 'targetSequenceWindows' : 'querySequenceWindows'] = windows;
        result.annotations = { ...result.annotations, [side]: [...annotations.values()] };
        result.annotationsStatus = { ...result.annotationsStatus, [side]: annotationsStatus };
        await useSide(index + 1);
      } finally {
        await source.close();
      }
      assertCurrent();
      const after = await Promise.all(paths.map((path) => stat(path)));
      if (before.some((value, position) => stamp(value) !== stamp(after[position])))
        throw new Error('The prepared comparison sources changed during the window read.');
      assertCurrent();
    });
    assertCurrent();
  };
  await useSide(0);
  assertCurrent();
  return result;
}
