// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import type {
  Genome,
  PixiLinearRenderer,
  PixiStadiumRenderer,
  RenderState,
} from '@waypoint/genome-renderer';
import {
  clearWebGLTestHooks,
  exposeWebGLTestHooks,
  updateWebGLTestHookGenome,
} from './webgl-test-hooks';

declare global {
  interface Window {
    __webglExposeForTests?: boolean;
    __webglRenderer?: PixiLinearRenderer | PixiStadiumRenderer;
    __webglRendererByProduct?: Partial<
      Record<'sequence' | 'indexed', PixiLinearRenderer | PixiStadiumRenderer>
    >;
    __webglState?: RenderState;
    __webglGenome?: Genome;
    __webglSetZoom?: (zoom: number) => void;
    __webglSetViewOffset?: (viewOffset: number) => void;
    __webglSetMorph?: (morph: number) => void;
    __webglRenderNowForTests?: () => void;
    __webglReady?: boolean;
  }
}

afterEach(() => {
  delete window.__webglExposeForTests;
  delete window.__webglRenderer;
  delete window.__webglRendererByProduct;
  delete window.__webglState;
  delete window.__webglGenome;
  delete window.__webglSetZoom;
  delete window.__webglSetViewOffset;
  delete window.__webglSetMorph;
  delete window.__webglRenderNowForTests;
  delete window.__webglReady;
});

function genome(name: string, featureCount: number): Genome {
  return {
    name,
    length: 1000,
    circular: false,
    sequence: '',
    features: Array.from({ length: featureCount }, (_, id) => ({
      id,
      type: 'mRNA',
      start: id * 10 + 1,
      end: id * 10 + 5,
      direction: 'forward',
      displayName: `feature-${id}`,
      lane: id,
      color: 0x3b82f6,
    })),
    primers: [],
  };
}

function genomeFeatures(genome: Genome) {
  return genome.features ?? [];
}

function renderer(id: string): PixiLinearRenderer {
  return { id } as unknown as PixiLinearRenderer;
}

function state(): RenderState {
  return {
    zoom: 1,
    viewOffset: 0,
    morph: 0,
  } as RenderState;
}

const renderNow = () => {};

describe('WebGL test hooks', () => {
  it('keeps __webglGenome in sync after in-place renderer genome reloads', () => {
    const first = genome('first', 1);
    const second = genome('second', 3);
    const owner = renderer('owner');
    window.__webglExposeForTests = true;
    exposeWebGLTestHooks({ renderer: owner, state: state(), genome: first, renderNow });

    updateWebGLTestHookGenome(owner, second);

    expect(window.__webglGenome).toBe(second);
    expect(window.__webglGenome ? genomeFeatures(window.__webglGenome) : []).toHaveLength(3);
  });

  it('does not expose reload state unless tests explicitly opt in', () => {
    const next = genome('hidden', 2);

    updateWebGLTestHookGenome(renderer('hidden'), next);

    expect(window.__webglGenome).toBeUndefined();
  });

  it('clears every renderer-owned hook when the active renderer is released', () => {
    const owner = renderer('owner');
    window.__webglExposeForTests = true;
    exposeWebGLTestHooks({
      renderer: owner,
      state: state(),
      genome: genome('owner', 1),
      renderNow,
    });

    clearWebGLTestHooks(owner);

    expect(window.__webglRenderer).toBeUndefined();
    expect(window.__webglState).toBeUndefined();
    expect(window.__webglGenome).toBeUndefined();
    expect(window.__webglSetZoom).toBeUndefined();
    expect(window.__webglSetViewOffset).toBeUndefined();
    expect(window.__webglSetMorph).toBeUndefined();
    expect(window.__webglRenderNowForTests).toBeUndefined();
    expect(window.__webglReady).toBeUndefined();
  });

  it('does not let a retired renderer overwrite or clear a newer renderer owner', () => {
    const retired = renderer('retired');
    const current = renderer('current');
    const currentGenome = genome('current', 2);
    window.__webglExposeForTests = true;
    exposeWebGLTestHooks({
      renderer: retired,
      state: state(),
      genome: genome('retired', 1),
      renderNow,
    });
    exposeWebGLTestHooks({ renderer: current, state: state(), genome: currentGenome, renderNow });

    updateWebGLTestHookGenome(retired, genome('stale-update', 4));
    clearWebGLTestHooks(retired);

    expect(window.__webglRenderer).toBe(current);
    expect(window.__webglGenome).toBe(currentGenome);
    expect(window.__webglReady).toBe(true);
  });

  it('clears a retired product renderer without erasing the newer singleton owner', () => {
    const retiredIndexed = renderer('retired-indexed');
    const currentSequence = renderer('current-sequence');
    const currentGenome = genome('current', 2);
    window.__webglExposeForTests = true;
    exposeWebGLTestHooks({
      renderer: retiredIndexed,
      state: state(),
      genome: genome('indexed', 1),
      renderNow,
      product: 'indexed',
    });
    exposeWebGLTestHooks({
      renderer: currentSequence,
      state: state(),
      genome: currentGenome,
      renderNow,
      product: 'sequence',
    });

    clearWebGLTestHooks(retiredIndexed);

    expect(window.__webglRendererByProduct?.indexed).toBeUndefined();
    expect(window.__webglRendererByProduct?.sequence).toBe(currentSequence);
    expect(window.__webglRenderer).toBe(currentSequence);
    expect(window.__webglGenome).toBe(currentGenome);
    expect(window.__webglReady).toBe(true);
  });

  it('keeps sequence and indexed renderers on separate product hooks', () => {
    const sequence = renderer('sequence');
    const indexed = renderer('indexed');
    window.__webglExposeForTests = true;
    exposeWebGLTestHooks({
      renderer: sequence,
      state: state(),
      genome: genome('seq', 1),
      renderNow,
      product: 'sequence',
    });
    exposeWebGLTestHooks({
      renderer: indexed,
      state: state(),
      genome: genome('idx', 2),
      renderNow,
      product: 'indexed',
    });

    expect(window.__webglRendererByProduct?.sequence).toBe(sequence);
    expect(window.__webglRendererByProduct?.indexed).toBe(indexed);
    expect(window.__webglRenderer).toBe(indexed);
  });

  it('exposes a real-frame request only after tests opt in', () => {
    let renders = 0;
    const requestRender = () => {
      renders += 1;
    };
    const owner = renderer('owner');

    exposeWebGLTestHooks({
      renderer: owner,
      state: state(),
      genome: genome('hidden', 1),
      renderNow: requestRender,
    });
    expect(window.__webglRenderNowForTests).toBeUndefined();

    window.__webglExposeForTests = true;
    exposeWebGLTestHooks({
      renderer: owner,
      state: state(),
      genome: genome('visible', 1),
      renderNow: requestRender,
    });
    window.__webglRenderNowForTests?.();

    expect(renders).toBe(1);
  });
});
