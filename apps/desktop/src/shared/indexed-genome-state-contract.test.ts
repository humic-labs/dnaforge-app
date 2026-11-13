// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  GENOME_TRACK_STATE_BY_TILE_STATE,
  GENOME_TRACK_USER_STATE_BY_MACHINE,
  assemblyReferenceAssetGenerationForThemeV1,
  type GenomeTileState,
  type GenomeTrackState,
  trackStateForGenomeTileState,
  userStateForGenomeTrackState,
} from './indexed-genome';

const TRACK_STATES: GenomeTrackState[] = [
  'source_accepted',
  'metadata_pending',
  'coordinate_ready',
  'index_required',
  'building_cache',
  'validation_pending',
  'ready',
  'degraded',
  'error',
];

const TILE_STATES: GenomeTileState[] = [
  'missing',
  'queued',
  'loading',
  'building_summary',
  'retained',
  'ready',
  'empty',
  'stale',
  'error',
];

describe('indexed genome state contract', () => {
  it('selects the authenticated per-theme generation over the legacy session envelope', () => {
    const light = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      themeMode: 'light' as const,
    };
    const dark = {
      contract: 'assembly-reference-asset-generation.v1' as const,
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'c'.repeat(64),
      themeMode: 'dark' as const,
    };

    expect(
      assemblyReferenceAssetGenerationForThemeV1(
        {
          assemblyAssetGeneration: light,
          assemblyAssetGenerationsByTheme: { light, dark },
        },
        'dark'
      )
    ).toBe(dark);
    expect(
      assemblyReferenceAssetGenerationForThemeV1({ assemblyAssetGeneration: light }, 'dark')
    ).toBeUndefined();
  });

  it('maps every machine track state to stable user-facing copy', () => {
    expect(Object.keys(GENOME_TRACK_USER_STATE_BY_MACHINE).sort()).toEqual(
      [...TRACK_STATES].sort()
    );
    expect(TRACK_STATES.map((state) => [state, userStateForGenomeTrackState(state)])).toEqual([
      ['source_accepted', 'Preparing'],
      ['metadata_pending', 'Preparing'],
      ['coordinate_ready', 'Showing overview'],
      ['index_required', 'Updating'],
      ['building_cache', 'Updating'],
      ['validation_pending', 'Updating'],
      ['ready', 'Showing overview'],
      ['degraded', 'Details limited'],
      ['error', 'Needs attention'],
    ]);
  });

  it('maps every tile state to a stable track state for shell scenes', () => {
    expect(Object.keys(GENOME_TRACK_STATE_BY_TILE_STATE).sort()).toEqual([...TILE_STATES].sort());
    expect(TILE_STATES.map((state) => [state, trackStateForGenomeTileState(state)])).toEqual([
      ['missing', 'building_cache'],
      ['queued', 'building_cache'],
      ['loading', 'building_cache'],
      ['building_summary', 'building_cache'],
      ['retained', 'validation_pending'],
      ['ready', 'ready'],
      ['empty', 'ready'],
      ['stale', 'validation_pending'],
      ['error', 'error'],
    ]);
  });
});
