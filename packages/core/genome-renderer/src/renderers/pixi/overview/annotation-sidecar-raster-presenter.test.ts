import { describe, expect, it, vi } from 'vitest';
import { Container, Sprite, type Renderer } from 'pixi.js';
import {
  AnnotationSidecarRasterPresenter,
  type AnnotationSidecarRasterChromosome,
  type AnnotationSidecarRasterTile,
  type AnnotationSidecarRasterTileFetchRequest,
} from './annotation-sidecar-raster-presenter';

const TILE_PX = 1024;

function fakeTile(laneCount = 1): AnnotationSidecarRasterTile {
  return {
    lanes: Array.from({ length: laneCount }, () => ({
      exonRaster: new Array(TILE_PX).fill(0.5),
      cdsRaster: new Array(TILE_PX).fill(0.25),
    })),
  };
}

const CHROM_A: AnnotationSidecarRasterChromosome = {
  chrom: 'chrA',
  globalStart: 0,
  length: 50_000_000,
};
const CHROM_B: AnnotationSidecarRasterChromosome = {
  chrom: 'chrB',
  globalStart: CHROM_A.length,
  length: 200_000_000,
};
const GENOME_LENGTH = CHROM_A.length + CHROM_B.length;

const WHOLE_GENOME_CAMERA = {
  visibleStartBp: 0,
  visibleEndBp: GENOME_LENGTH,
  pixelsPerBp: 8e-6,
  genomeLength: GENOME_LENGTH,
  visibleTypes: ['mRNA'] as const,
};

describe('AnnotationSidecarRasterPresenter (multi-chromosome)', () => {
  it('does not fetch or allocate anything until first composite() call', () => {
    const fetchCoarseTile = vi.fn();
    new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => null,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    expect(fetchCoarseTile).not.toHaveBeenCalled();
  });

  it('fetches one tile per visible chromosome that fits in a single covering tile', () => {
    const fetchCoarseTile = vi.fn(() => new Promise<AnnotationSidecarRasterTile>(() => {}));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    const calls = fetchCoarseTile.mock.calls as unknown as [
      AnnotationSidecarRasterTileFetchRequest,
    ][];
    const calledChroms = new Set(calls.map(([req]) => req.chrom.chrom));
    expect(calledChroms).toEqual(new Set(['chrA', 'chrB']));
    expect(fetchCoarseTile.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('only fetches chromosomes that overlap the visible span, not the whole genome', () => {
    const fetchCoarseTile = vi.fn(() => new Promise<AnnotationSidecarRasterTile>(() => {}));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite({
      ...WHOLE_GENOME_CAMERA,
      visibleStartBp: 1_000_000,
      visibleEndBp: 2_000_000,
    });
    const calls = fetchCoarseTile.mock.calls as unknown as [
      AnnotationSidecarRasterTileFetchRequest,
    ][];
    const calledChroms = new Set(calls.map(([req]) => req.chrom.chrom));
    expect(calledChroms).toEqual(new Set(['chrA']));
  });

  it('does not re-fire a fetch for a (chrom, level, tileIndex) already pending', () => {
    const fetchCoarseTile = vi.fn(() => new Promise<AnnotationSidecarRasterTile>(() => {}));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    const firstCallCount = fetchCoarseTile.mock.calls.length;
    presenter.composite(WHOLE_GENOME_CAMERA);
    presenter.composite(WHOLE_GENOME_CAMERA);
    expect(fetchCoarseTile.mock.calls.length).toBe(firstCallCount);
  });

  it('takes ownership only once EVERY visible chromosome tile has resolved and is eligible', async () => {
    const fetchCoarseTile = vi.fn(() => Promise.resolve(fakeTile()));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const owned = presenter.composite(WHOLE_GENOME_CAMERA);
    expect(owned).toBe(true);
  });

  it('positions resident sprites using BOTH projectX and projectY (never left at Pixi default y=0)', async () => {
    const fetchCoarseTile = vi.fn(() => Promise.resolve(fakeTile()));
    const container = new Container();
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: container,
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    const projectY = vi.fn((offsetPx: number) => 240 + offsetPx);
    const cameraWithY = { ...WHOLE_GENOME_CAMERA, projectX: (bp: number) => bp * 1e-7, projectY };
    presenter.composite(cameraWithY);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(presenter.composite(cameraWithY)).toBe(true);

    const sprites = container.children.filter((c) => c.visible);
    expect(sprites.length).toBeGreaterThan(0);
    for (const sprite of sprites) {
      expect(sprite.y).toBe(240);
    }
    expect(projectY).toHaveBeenCalled();
  });

  it('threads camera.laneLimit into the fetch request (defaults to 1 when unset)', async () => {
    const fetchCoarseTile = vi.fn(() => new Promise<AnnotationSidecarRasterTile>(() => {}));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    const calls = fetchCoarseTile.mock.calls as unknown as [
      AnnotationSidecarRasterTileFetchRequest,
    ][];
    expect(calls.every(([req]) => req.laneLimit === 1)).toBe(true);
  });

  it('a laneLimit change re-fetches instead of reusing a resident tile built for a different cap', async () => {
    const fetchCoarseTile = vi.fn(() => Promise.resolve(fakeTile()));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const callCountAtLane1 = fetchCoarseTile.mock.calls.length;
    expect(presenter.composite(WHOLE_GENOME_CAMERA)).toBe(true);

    const laneLimit4Camera = { ...WHOLE_GENOME_CAMERA, laneLimit: 4 };
    presenter.composite(laneLimit4Camera);
    expect(fetchCoarseTile.mock.calls.length).toBeGreaterThan(callCountAtLane1);
  });

  it('adds a new per-track tile without refetching or hiding an already-resident track', async () => {
    const fetchCoarseTile = vi.fn((_request: AnnotationSidecarRasterTileFetchRequest) =>
      Promise.resolve(fakeTile())
    );
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const mrnaCallCount = fetchCoarseTile.mock.calls.length;
    expect(presenter.composite(WHOLE_GENOME_CAMERA)).toBe(true);

    const mixedCamera = { ...WHOLE_GENOME_CAMERA, visibleTypes: ['transcript', 'mRNA'] };
    expect(presenter.composite(mixedCamera)).toBe(false);
    expect(presenter.isPresenting).toBe(true);
    expect(presenter.visibleTrackTypes).toEqual(['mRNA']);
    expect(fetchCoarseTile.mock.calls.length).toBeGreaterThan(mrnaCallCount);
    expect(
      fetchCoarseTile.mock.calls
        .slice(mrnaCallCount)
        .every(([request]) => request.visibleTypes.join(',') === 'transcript')
    ).toBe(true);
    expect(
      fetchCoarseTile.mock.calls
        .slice(mrnaCallCount)
        .some(([request]) => request.visibleTypes.join(',') === 'mRNA')
    ).toBe(false);
  });

  it('builds a taller texture (one row block per lane) for a multi-lane tile', async () => {
    const fetchCoarseTile = vi.fn(() => Promise.resolve(fakeTile(3)));
    const container = new Container();
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: container,
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    const laneLimit4Camera = { ...WHOLE_GENOME_CAMERA, laneLimit: 4 };
    presenter.composite(laneLimit4Camera);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(presenter.composite(laneLimit4Camera)).toBe(true);

    const sprites = container.children.filter((c): c is Sprite => c instanceof Sprite && c.visible);
    expect(sprites.length).toBeGreaterThan(0);
    for (const sprite of sprites) {
      expect(sprite.texture.height).toBe(3 * 16);
    }
  });

  it('getAvailableTypes() starts empty and accumulates the union across every resolved tile', async () => {
    let call = 0;
    const fetchCoarseTile = vi.fn((req: { chrom: AnnotationSidecarRasterChromosome }) => {
      call += 1;
      const tile = fakeTile();
      return Promise.resolve({
        ...tile,
        availableTypes: req.chrom.chrom === 'chrA' ? ['mRNA', 'gene'] : ['mRNA', 'lncRNA'],
      });
    });
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    expect(presenter.getAvailableTypes()).toEqual([]);
    presenter.composite(WHOLE_GENOME_CAMERA);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(call).toBeGreaterThan(0);
    expect(presenter.getAvailableTypes()).toEqual(['gene', 'lncRNA', 'mRNA']);
  });

  it('getAvailableTypes() retains previously-discovered types after a chromosome scrolls out of view', async () => {
    const fetchCoarseTile = vi.fn(() =>
      Promise.resolve({ ...fakeTile(), availableTypes: ['enhancer'] })
    );
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(presenter.getAvailableTypes()).toEqual(['enhancer']);

    presenter.composite({ ...WHOLE_GENOME_CAMERA, visibleStartBp: 0, visibleEndBp: 500 });
    expect(presenter.getAvailableTypes()).toEqual(['enhancer']);
  });

  it('does NOT take ownership if only some visible chromosomes have resolved (never a partial-coverage owner)', async () => {
    let resolveA: (v: AnnotationSidecarRasterTile) => void = () => {};
    const fetchCoarseTile = vi.fn((req: { chrom: AnnotationSidecarRasterChromosome }) => {
      if (req.chrom.chrom === 'chrA') {
        return new Promise<AnnotationSidecarRasterTile>((r) => {
          resolveA = r;
        });
      }
      return Promise.resolve(fakeTile());
    });
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(presenter.composite(WHOLE_GENOME_CAMERA)).toBe(false);
    resolveA(fakeTile());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(presenter.composite(WHOLE_GENOME_CAMERA)).toBe(true);
  });

  it('reset() hides presentation without discarding resident tiles (no re-fetch)', async () => {
    const fetchCoarseTile = vi.fn(() => Promise.resolve(fakeTile()));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const callCountBeforeReset = fetchCoarseTile.mock.calls.length;
    presenter.reset();
    expect(presenter.composite(WHOLE_GENOME_CAMERA)).toBe(true);
    expect(fetchCoarseTile.mock.calls.length).toBe(callCountBeforeReset);
  });

  it('requests the SAME level for every visible chromosome (uniform resolution, not per-chromosome-length)', () => {
    const fetchCoarseTile = vi.fn(() => new Promise<AnnotationSidecarRasterTile>(() => {}));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite(WHOLE_GENOME_CAMERA);
    const calls = fetchCoarseTile.mock.calls as unknown as [
      AnnotationSidecarRasterTileFetchRequest,
    ][];
    const levels = new Set(calls.map(([req]) => req.level));
    expect(levels.size).toBe(1);
  });

  it('refuses ownership (too-many-tiles) when zooming in this far while the WHOLE genome is still nominally visible', async () => {
    const fetchCoarseTile = vi.fn(() => Promise.resolve(fakeTile()));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    const zoomedInCamera = { ...WHOLE_GENOME_CAMERA, pixelsPerBp: 10 };
    presenter.composite(zoomedInCamera);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(presenter.composite(zoomedInCamera)).toBe(false);
    expect(presenter.eligibilityReason).toBe('too-many-tiles');
    expect(fetchCoarseTile).not.toHaveBeenCalled();
  });

  it('hands fine LODs to the vector/detail path without issuing a raster fetch', async () => {
    const fetchCoarseTile = vi.fn(() => Promise.resolve(fakeTile()));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    const zoomedInCamera = {
      ...WHOLE_GENOME_CAMERA,
      visibleStartBp: 1_000_000,
      visibleEndBp: 1_002_000,
      pixelsPerBp: 10,
    };
    presenter.composite(zoomedInCamera);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(presenter.composite(zoomedInCamera)).toBe(false);
    expect(presenter.eligibilityReason).toBe('fine-vector-required');
    expect(fetchCoarseTile).not.toHaveBeenCalled();
  });

  it('only requires tiles covering the VISIBLE WINDOW of a chromosome, not the whole chromosome', () => {
    const fetchCoarseTile = vi.fn(() => new Promise<AnnotationSidecarRasterTile>(() => {}));
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => ({}) as Renderer,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile,
    });
    presenter.composite({
      ...WHOLE_GENOME_CAMERA,
      visibleStartBp: CHROM_B.globalStart + 5_000_000,
      visibleEndBp: CHROM_B.globalStart + 5_020_000,
      pixelsPerBp: 1 / 512,
    });
    expect(fetchCoarseTile.mock.calls.length).toBeGreaterThan(0);
    expect(fetchCoarseTile.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('hide() and destroy() are safe to call before any composite()', () => {
    const presenter = new AnnotationSidecarRasterPresenter({
      parentContainer: new Container(),
      readRenderer: () => null,
      readGenomeLength: () => GENOME_LENGTH,
      readChromosomes: () => [CHROM_A, CHROM_B],
      fetchCoarseTile: vi.fn(),
    });
    expect(() => presenter.hide()).not.toThrow();
    expect(() => presenter.destroy()).not.toThrow();
  });
});
