import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN,
  ANNOTATION_RESOLVED_TRACK_CONTRACT_TOKEN,
  ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS,
} from '../../features/sequence/annotation-layer-identity';
import { ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2 } from './assembly-annotation-search-cache';
import {
  ASSEMBLY_ANNOTATION_SCENE_COMPILER_CONTRACT,
  ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN,
} from './assembly-overview-texture-cache';
import { ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2 } from './assembly-protein-search-compiler';
import { OVERVIEW_CACHE_CONTRACT_TOKEN } from './genome-overview-tile-cache';

describe('annotation track identity scope', () => {
  it('rebuilds products of resolved features without re-summarizing chromosomes', () => {
    expect(OVERVIEW_CACHE_CONTRACT_TOKEN).toContain(ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN);
    expect(OVERVIEW_CACHE_CONTRACT_TOKEN).not.toContain(ANNOTATION_RESOLVED_TRACK_CONTRACT_TOKEN);
    for (const token of [
      ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN,
      ASSEMBLY_ANNOTATION_SCENE_COMPILER_CONTRACT,
      ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
      ASSEMBLY_PROTEIN_SEARCH_COMPILER_SEMANTICS_V2,
    ]) {
      expect(token).toContain(ANNOTATION_RESOLVED_TRACK_CONTRACT_TOKEN);
    }
    expect(ANNOTATION_TRACK_IDENTITY_PREVIOUS_CONTRACT_TOKENS).toEqual([
      `${ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN}|annotation-resolved-track.v1.pseudogene-own-track`,
      ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN,
    ]);
  });
});
