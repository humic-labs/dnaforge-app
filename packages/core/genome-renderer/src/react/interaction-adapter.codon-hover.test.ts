// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { Genome, RenderState } from '@waypoint/genome-renderer';
import { attachPixiInteractionAdapter } from './interaction-adapter';
import type { UsePixiMapOptions } from './types';

function makeState(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 800,
    height: 220,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

const genome: Genome = {
  name: 'codon-hover-fixture',
  length: 1000,
  circular: false,
  features: [],
};

describe('attachPixiInteractionAdapter codon hover bridge', () => {
  it('forwards renderer codon-hover transitions to the WebGLMap options callback', () => {
    const canvasEl = document.createElement('canvas');
    document.body.appendChild(canvasEl);
    const onCodonHover = vi.fn();
    const optionsRef = {
      current: {
        genome,
        circular: false,
        width: 800,
        height: 220,
        onCodonHover,
      } satisfies UsePixiMapOptions,
    };
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: makeState() },
      optionsRef,
      renderer: {
        screenToBp: () => 300,
        getOverlayRegistry: () => null,
        getCurrentPathMapper: () => null,
      } as never,
      activeGenome: genome,
      circular: false,
    });

    interaction.onCodonHover?.({ start: 300, end: 302, strand: -1 });
    interaction.onCodonHover?.(null);

    expect(onCodonHover).toHaveBeenNthCalledWith(1, { start: 300, end: 302, strand: -1 });
    expect(onCodonHover).toHaveBeenNthCalledWith(2, null);

    interaction.cleanup();
  });

  it('prioritizes read evidence, attaches the same aggregate column, and forwards column-only hover', () => {
    const canvasEl = document.createElement('canvas');
    canvasEl.width = 800;
    canvasEl.height = 220;
    canvasEl.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 220 }) as DOMRect;
    document.body.appendChild(canvasEl);
    const onPileupColumnHoverChange = vi.fn();
    const column = {
      globalPosition: 144,
      chrom: 'chr7',
      position: 144,
      kind: 'sub' as const,
      length: 1,
      refBase: 'C',
      readBase: 'T',
      coveringReadCount: 80,
      supportingReadCount: 31,
      weightedDepth: 76,
      weightedSupport: 29,
      weightedFraction: 29 / 76,
      screenX: 144,
      screenY: 100,
    };
    const read = {
      trackId: 'hg002',
      readId: 'read-42',
      chrom: 'chr7',
      referenceStart: 120,
      start: 120,
      end: 170,
      strand: '+' as const,
      mapq: 60,
      event: { pos: 144, kind: 'sub' as const, refBase: 'C', readBase: 'T' },
      screenX: 144,
      screenY: 100,
    };
    let returnRead = true;
    const optionsRef = {
      current: {
        genome,
        circular: false,
        width: 800,
        height: 220,
        onPileupColumnHoverChange,
      } satisfies UsePixiMapOptions,
    };
    const interaction = attachPixiInteractionAdapter({
      canvasEl,
      stateRef: { current: makeState() },
      optionsRef,
      renderer: {
        screenToBp: () => 144,
        hitTestReadEvent: () => (returnRead ? read : null),
        hitTestPileupColumn: () => column,
        getOverlayRegistry: () => null,
        getCurrentPathMapper: () => null,
      } as never,
      activeGenome: genome,
      circular: false,
    });

    expect(interaction.hitTestFn?.(144, 100)).toEqual({
      kind: 'read',
      payload: { ...read, column },
    });
    returnRead = false;
    expect(interaction.hitTestFn?.(144, 100)).toEqual({
      kind: 'pileup-column',
      payload: column,
    });

    interaction.onPileupColumnHover?.(column);
    interaction.onPileupColumnHover?.(null);
    expect(onPileupColumnHoverChange).toHaveBeenNthCalledWith(1, column);
    expect(onPileupColumnHoverChange).toHaveBeenNthCalledWith(2, null);
    interaction.cleanup();
  });
});
