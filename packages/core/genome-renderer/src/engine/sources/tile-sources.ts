import type { AlignedReadSourceGenerationV1 } from '@waypoint/genome-data';
import type { AssemblySegment } from '../../assembly-layout';
import { binBp, tileSpanBp } from '../constants';
import type { TileSource } from '../tile-source';
import {
  BaseTileSource,
  type BaseTileSourceOptions,
  type TileSourceShape,
} from './base-tile-source';

export const FINE_BIN_BP_MAX = 256;
export const READ_ALIGNMENT_BIN_BP_MAX = 4;
export const ALTERNATE_GUIDE_BIN_BP_MAX = 8;
export const BOUNDED_FOREGROUND_COVERAGE_MAX_BP = 1_100_000;
const COVERAGE_CRITICAL_HANDOFF_LEVEL = 17;
const COVERAGE_CRITICAL_HANDOFF_PREFETCH_LEVELS = 3;
const COVERAGE_CRITICAL_HANDOFF_MAX_CURRENT_LEVEL = 21;
const COVERAGE_FINE_PREFETCH_WINDOW_BP = 256_000;
const COVERAGE_READ_BRIDGE_HANDOFF_LEVEL = 3;
const COVERAGE_READ_HANDOFF_LEVEL = 2;
const COVERAGE_READ_HANDOFF_PREFETCH_LEVELS = 1;
const COVERAGE_READ_HANDOFF_MIN_CURRENT_LEVEL = 7;
const COVERAGE_READ_HANDOFF_MAX_CURRENT_LEVEL = 9;
const COVERAGE_READ_HANDOFF_WINDOW_BP = 32_000;
const COVERAGE_SAME_LEVEL_MARGIN_TILES = 64;
const COVERAGE_SAME_LEVEL_MARGIN_MIN_LEVEL = 0;
const ALIGNMENT_CRITICAL_HANDOFF_LEVEL = maxReadAlignmentLevel();
const ALIGNMENT_CRITICAL_HANDOFF_PREFETCH_LEVELS = 2;
const ALIGNMENT_CRITICAL_HANDOFF_MAX_CURRENT_LEVEL = 7;
const ALIGNMENT_FINE_PREFETCH_WINDOW_BP = 32_000;
const ALIGNMENT_SAME_LEVEL_MARGIN_TILES = 16;

export function maxFineLevel(): number {
  let level = 0;
  while (binBp(level + 1) <= FINE_BIN_BP_MAX) level += 1;
  return level;
}

export function maxBoundedForegroundCoverageLevel(): number {
  let level = 0;
  while (tileSpanBp(level + 1) <= BOUNDED_FOREGROUND_COVERAGE_MAX_BP) level += 1;
  return level;
}

export function maxReadAlignmentLevel(): number {
  let level = 0;
  while (binBp(level + 1) <= READ_ALIGNMENT_BIN_BP_MAX) level += 1;
  return level;
}

export function maxAlternateGuideLevel(): number {
  let level = 0;
  while (binBp(level + 1) <= ALTERNATE_GUIDE_BIN_BP_MAX) level += 1;
  return level;
}

export interface AlignmentFileSource {
  readonly bamPath: string;
  readonly indexPath?: string;
  readonly referencePath?: string;
  readonly sourceGeneration?: AlignedReadSourceGenerationV1;
  readonly htsget?: {
    readonly sourceToken: string;
    readonly sourceIdentity: string;
    readonly format: 'BAM' | 'CRAM';
  };
}

export interface AnnotationFileSource {
  readonly gffPath: string;
}

function chromOf(segments: AssemblySegment[]): { chrom: string; globalStart: number } {
  const seg = segments[0];
  if (!seg?.chrom) throw new Error('tile-source: no segment for tile (empty segments[])');
  return { chrom: seg.chrom, globalStart: seg.globalStart ?? 0 };
}

function alignmentBody(
  file: AlignmentFileSource,
  chrom: string,
  chromGlobalStart: number
): Record<string, unknown> {
  const body: Record<string, unknown> = file.htsget
    ? {
        htsgetToken: file.htsget.sourceToken,
        htsgetSourceIdentity: file.htsget.sourceIdentity,
        htsgetFormat: file.htsget.format,
        chrom,
        chromGlobalStart,
      }
    : { bamPath: file.bamPath, chrom, chromGlobalStart };
  if (!file.htsget && file.indexPath) body.indexPath = file.indexPath;
  if (file.referencePath) body.referencePath = file.referencePath;
  if (file.sourceGeneration) body.sourceGeneration = file.sourceGeneration;
  return body;
}

function jsonByteSize(payload: unknown): number {
  try {
    return JSON.stringify(payload)?.length ?? 0;
  } catch {
    return 0;
  }
}

function coverageShape(file: AlignmentFileSource): TileSourceShape {
  return {
    id: `cov:${file.bamPath}`,
    kind: 'coverage',
    levelRange: [0, Number.MAX_SAFE_INTEGER],
    prefetch: {
      sameLevelMarginTiles: COVERAGE_SAME_LEVEL_MARGIN_TILES,
      sameLevelMarginMinLevel: COVERAGE_SAME_LEVEL_MARGIN_MIN_LEVEL,
      criticalFinerLevel: COVERAGE_CRITICAL_HANDOFF_LEVEL,
      criticalFinerPrefetchLevels: COVERAGE_CRITICAL_HANDOFF_PREFETCH_LEVELS,
      criticalFinerMaxCurrentLevel: COVERAGE_CRITICAL_HANDOFF_MAX_CURRENT_LEVEL,
      finerLookaheadWindowBp: COVERAGE_FINE_PREFETCH_WINDOW_BP,
      additionalCriticalFinerHandoffs: [
        {
          level: COVERAGE_READ_BRIDGE_HANDOFF_LEVEL,
          prefetchLevels: COVERAGE_READ_HANDOFF_PREFETCH_LEVELS,
          minCurrentLevel: COVERAGE_READ_HANDOFF_MIN_CURRENT_LEVEL,
          maxCurrentLevel: COVERAGE_READ_HANDOFF_MAX_CURRENT_LEVEL,
          lookaheadWindowBp: COVERAGE_READ_HANDOFF_WINDOW_BP,
        },
        {
          level: COVERAGE_READ_HANDOFF_LEVEL,
          prefetchLevels: COVERAGE_READ_HANDOFF_PREFETCH_LEVELS,
          minCurrentLevel: COVERAGE_READ_HANDOFF_MIN_CURRENT_LEVEL,
          maxCurrentLevel: COVERAGE_READ_HANDOFF_MAX_CURRENT_LEVEL,
          lookaheadWindowBp: COVERAGE_READ_HANDOFF_WINDOW_BP,
        },
      ],
    },
    buildBody: (_level, _index, segments) => {
      const c = chromOf(segments);
      return alignmentBody(file, c.chrom, c.globalStart);
    },
    countOf: (payload) => {
      const p = payload as { bins?: number[]; provenance?: { exact?: boolean } };
      if (p?.provenance?.exact !== true) return 0;
      const bins = p?.bins;
      if (!Array.isArray(bins)) return 0;
      let nonEmpty = 0;
      for (const v of bins) if (v > 0) nonEmpty += 1;
      return nonEmpty;
    },
    byteSizeOf: (payload) => {
      const bins = (payload as { bins?: number[] })?.bins;
      return Array.isArray(bins) ? bins.length * 4 : 0;
    },
  };
}

export function createCoverageTileSource(
  file: AlignmentFileSource,
  opts: BaseTileSourceOptions
): TileSource {
  return new BaseTileSource(coverageShape(file), opts);
}

function assemblyCoverageShape(file: AlignmentFileSource): TileSourceShape {
  return {
    id: `covasm:${file.bamPath}`,
    kind: 'coverage-assembly',
    levelRange: [0, Number.MAX_SAFE_INTEGER],
    prefetch: {
      sameLevelMarginTiles: COVERAGE_SAME_LEVEL_MARGIN_TILES,
      sameLevelMarginMinLevel: COVERAGE_SAME_LEVEL_MARGIN_MIN_LEVEL,
      criticalFinerLevel: COVERAGE_CRITICAL_HANDOFF_LEVEL,
      criticalFinerPrefetchLevels: COVERAGE_CRITICAL_HANDOFF_PREFETCH_LEVELS,
      criticalFinerMaxCurrentLevel: COVERAGE_CRITICAL_HANDOFF_MAX_CURRENT_LEVEL,
      finerLookaheadWindowBp: COVERAGE_FINE_PREFETCH_WINDOW_BP,
      additionalCriticalFinerHandoffs: [
        {
          level: COVERAGE_READ_BRIDGE_HANDOFF_LEVEL,
          prefetchLevels: COVERAGE_READ_HANDOFF_PREFETCH_LEVELS,
          minCurrentLevel: COVERAGE_READ_HANDOFF_MIN_CURRENT_LEVEL,
          maxCurrentLevel: COVERAGE_READ_HANDOFF_MAX_CURRENT_LEVEL,
          lookaheadWindowBp: COVERAGE_READ_HANDOFF_WINDOW_BP,
        },
        {
          level: COVERAGE_READ_HANDOFF_LEVEL,
          prefetchLevels: COVERAGE_READ_HANDOFF_PREFETCH_LEVELS,
          minCurrentLevel: COVERAGE_READ_HANDOFF_MIN_CURRENT_LEVEL,
          maxCurrentLevel: COVERAGE_READ_HANDOFF_MAX_CURRENT_LEVEL,
          lookaheadWindowBp: COVERAGE_READ_HANDOFF_WINDOW_BP,
        },
      ],
    },
    buildBody: (_level, _index, segments) => {
      const body: Record<string, unknown> = {
        segments: segments.map((segment) => ({
          chrom: segment.chrom,
          start: segment.localStart,
          end: segment.localEnd,
          chromGlobalStart: segment.globalStart,
        })),
      };
      if (file.htsget) {
        body.htsgetToken = file.htsget.sourceToken;
        body.htsgetSourceIdentity = file.htsget.sourceIdentity;
        body.htsgetFormat = file.htsget.format;
      } else {
        body.bamPath = file.bamPath;
      }
      if (!file.htsget && file.indexPath) body.indexPath = file.indexPath;
      if (file.referencePath) body.referencePath = file.referencePath;
      if (file.sourceGeneration) body.sourceGeneration = file.sourceGeneration;
      return body;
    },
    countOf: (payload) => {
      const p = payload as {
        segments?: Array<{ bins?: number[]; provenance?: { exact?: boolean } }>;
        provenance?: { exact?: boolean };
      };
      if (p?.provenance?.exact !== true || !Array.isArray(p.segments)) return 0;
      let nonEmpty = 0;
      for (const segment of p.segments) {
        if (segment?.provenance?.exact !== true || !Array.isArray(segment.bins)) continue;
        for (const v of segment.bins) if (v > 0) nonEmpty += 1;
      }
      return nonEmpty;
    },
    byteSizeOf: (payload) => {
      const segments = (payload as { segments?: Array<{ bins?: number[] }> })?.segments;
      if (!Array.isArray(segments)) return 0;
      return segments.reduce(
        (sum, segment) => sum + (Array.isArray(segment.bins) ? segment.bins.length * 4 : 0),
        0
      );
    },
  };
}

export function createAssemblyCoverageTileSource(
  file: AlignmentFileSource,
  opts: BaseTileSourceOptions,
  availability: 'prepared-pyramid' | 'bounded-foreground' = 'prepared-pyramid'
): TileSource {
  const shape = assemblyCoverageShape(file);
  const boundedForeground = availability === 'bounded-foreground';
  return new BaseTileSource(
    {
      ...shape,
      levelRange: boundedForeground
        ? ([shape.levelRange[0], maxBoundedForegroundCoverageLevel()] as const)
        : shape.levelRange,
      prefetch: boundedForeground
        ? {
            ...shape.prefetch,
            wholeGenomeResident: false,
            coverageWorkingSetMarginTiles: 0,
          }
        : shape.prefetch,
    },
    opts
  );
}

function alignmentShape(file: AlignmentFileSource): TileSourceShape {
  return {
    id: `aln:${file.bamPath}`,
    kind: 'alignment',
    levelRange: [0, maxAlternateGuideLevel()],
    prefetch: {
      sameLevelMarginTiles: ALIGNMENT_SAME_LEVEL_MARGIN_TILES,
      sameLevelMarginMinLevel: 0,
      criticalFinerLevel: ALIGNMENT_CRITICAL_HANDOFF_LEVEL,
      criticalFinerPrefetchLevels: ALIGNMENT_CRITICAL_HANDOFF_PREFETCH_LEVELS,
      criticalFinerMaxCurrentLevel: ALIGNMENT_CRITICAL_HANDOFF_MAX_CURRENT_LEVEL,
      finerLookaheadWindowBp: ALIGNMENT_FINE_PREFETCH_WINDOW_BP,
    },
    buildBody: (level, _index, segments) => {
      const c = chromOf(segments);
      const body = alignmentBody(file, c.chrom, c.globalStart);
      if (level > maxReadAlignmentLevel()) body.guidesOnly = true;
      return body;
    },
    countOf: (payload) => {
      const typed = payload as {
        reads?: unknown[];
        alternateColumns?: unknown[];
        count?: number;
      };
      const readCount = Array.isArray(typed?.reads) ? typed.reads.length : 0;
      const columnCount = Array.isArray(typed?.alternateColumns)
        ? typed.alternateColumns.length
        : 0;
      if (readCount > 0 || columnCount > 0) return Math.max(readCount, columnCount);
      return Number(typed?.count ?? 0);
    },
    byteSizeOf: jsonByteSize,
  };
}

export function createAlignmentTileSource(
  file: AlignmentFileSource,
  opts: BaseTileSourceOptions,
  availability: 'local' | 'bounded-network' = 'local'
): TileSource {
  const shape = alignmentShape(file);
  return new BaseTileSource(
    availability === 'bounded-network'
      ? {
          ...shape,
          prefetch: {
            ...shape.prefetch,
            sameLevelMarginTiles: 1,
          },
        }
      : shape,
    opts
  );
}

function annotationShape(file: AnnotationFileSource): TileSourceShape {
  return {
    id: `ann:${file.gffPath}`,
    kind: 'annotation',
    levelRange: [0, Number.MAX_SAFE_INTEGER],
    buildBody: (_level, _index, segments) => {
      const c = chromOf(segments);
      return { gffPath: file.gffPath, chrom: c.chrom, chromGlobalStart: c.globalStart };
    },
    countOf: (payload) => {
      const p = payload as { transcripts?: unknown[]; markCount?: number };
      if (Array.isArray(p?.transcripts) && p.transcripts.length > 0) return p.transcripts.length;
      return typeof p?.markCount === 'number' ? p.markCount : 0;
    },
    byteSizeOf: jsonByteSize,
  };
}

export function createAnnotationTileSource(
  file: AnnotationFileSource,
  opts: BaseTileSourceOptions
): TileSource {
  return new BaseTileSource(annotationShape(file), opts);
}
