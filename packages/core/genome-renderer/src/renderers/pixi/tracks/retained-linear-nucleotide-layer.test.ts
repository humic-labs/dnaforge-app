import { SEQUENCE_FONT_FAMILY } from '@waypoint/platform';
// @vitest-environment jsdom

import {
  Buffer as PixiBuffer,
  BufferImageSource,
  GlProgram,
  GL_FORMATS,
  GL_TARGETS,
  RendererType,
  type Renderer,
  type Shader,
  type TextureSource,
} from 'pixi.js';
import { IUPAC_COMPLEMENT } from '@waypoint/sequence-utils';
import { describe, expect, it, vi } from 'vitest';

import { bpCoordinateChunk, bpCoordinateDelta } from '../overview/bp-coordinate-packing';
import { webglThemeForMode } from '../shared/theme';
import {
  RETAINED_LINEAR_NUCLEOTIDE_OWNER,
  RetainedLinearNucleotideLayer,
  type LinearNucleotideGlyphAtlas,
} from './retained-linear-nucleotide-layer';

function gpuHarness(): {
  readonly renderer: Renderer;
  readonly updateBuffer: ReturnType<typeof vi.fn>;
  readonly initSource: ReturnType<typeof vi.fn>;
} {
  const rendererUid = 7;
  const updateBuffer = vi.fn((buffer: PixiBuffer) => {
    buffer._gpuData[rendererUid] = {
      buffer: {} as WebGLBuffer,
      updateID: buffer._updateID,
      byteLength: buffer.data.byteLength,
      type: 0,
      _lastBindBaseLocation: -1,
      _lastBindCallId: -1,
      destroy: vi.fn(),
    };
  });
  const initSource = vi.fn((source: TextureSource) => {
    source._gpuData[rendererUid] = {
      texture: {} as WebGLTexture,
      target: GL_TARGETS.TEXTURE_2D,
      _layerInitMask: 1,
      width: source.pixelWidth,
      height: source.pixelHeight,
      mipmap: false,
      type: 0,
      internalFormat: 0,
      samplerType: 0,
      format: GL_FORMATS.RGBA,
      destroy: vi.fn(),
    };
  });
  const renderer = {
    uid: rendererUid,
    type: RendererType.WEBGL,
    resolution: 2,
    width: 800,
    height: 220,
    screen: { width: 800, height: 220 },
    shader: {
      bind: vi.fn((_shader: Shader, _skipSync?: boolean) => undefined),
      resetState: vi.fn(),
    },
    texture: { initSource },
    buffer: { updateBuffer },
  } as unknown as Renderer;
  return { renderer, updateBuffer, initSource };
}

function testAtlas(dispose = vi.fn(), uniqueSignatures = true): LinearNucleotideGlyphAtlas {
  const source = new BufferImageSource({
    resource: new Uint8Array([255, 255, 255, 255]),
    width: 1,
    height: 1,
    format: 'rgba8unorm',
    autoGarbageCollect: false,
  });
  const characters = [
    ...new Set(
      Object.keys(IUPAC_COMPLEMENT)
        .filter((base) => base.trim().length > 0)
        .map((base) => base.toLowerCase())
    ),
  ].sort();
  const glyphs = new Map(
    characters.map((base, index) => [
      base,
      {
        localLeft: -4,
        localTop: -8,
        localRight: 4,
        localBottom: 8,
        uvLeft: uniqueSignatures ? index / 32 : 0,
        uvTop: 0,
        uvRight: uniqueSignatures ? (index + 1) / 32 : 1,
        uvBottom: 1,
      },
    ])
  );
  return {
    source,
    fontFamily: SEQUENCE_FONT_FAMILY,
    glyphs,
    glyphCoordinateScale: 1,
    glyphGeometryFontSizePx: 16,
    verticalMetrics: () => ({ top: -3, bottom: 9, strikeY: 3 }),
    atlasMeasurementFontSizePx: 16,
    dispose: () => {
      dispose();
      source.destroy();
    },
  };
}

describe('RetainedLinearNucleotideLayer', () => {
  it('uploads exact 2D markup colors and rebuilds when those ranges change', () => {
    const gpu = gpuHarness();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('light'),
      testAtlas()
    );
    const range = { startBp: 0, endBp: 4 };
    const presentation = {
      alignedQuery: 'ACGT',
      nucleotideChanges: [{ start: 1, end: 2, kind: 'deletion' as const, color: 0xef4444 }],
    };
    layer.prepare('ACGT', undefined, 0, 4, presentation);
    layer.presentPrepared('ACGT', undefined, range, presentation);
    const mesh = layer.container.children.find(
      (child) => (child as import('pixi.js').Mesh).geometry.instanceCount > 0
    ) as import('pixi.js').Mesh;
    const attribute = mesh.geometry.attributes.aMarkup;
    expect(attribute).toBeDefined();
    const buffer = mesh.geometry.getBuffer('aMarkup').data;
    if (attribute.stride === undefined || attribute.offset === undefined)
      throw new Error('Markup instance layout is missing');
    const stride = attribute.stride / 4;
    const offset = attribute.offset / 4;
    expect(Array.from(buffer.slice(2 * stride + offset, 2 * stride + offset + 4))).toEqual(
      [244 / 255, 67 / 255, 54 / 255, 0.6].map(Math.fround)
    );
    expect(layer.covers('ACGT', undefined, range, { ...presentation, nucleotideChanges: [] })).toBe(
      false
    );
    const cleared = { ...presentation, nucleotideChanges: [] };
    layer.prepare('ACGT', undefined, 0, 4, cleared);
    expect(layer.presentPrepared('ACGT', undefined, range, cleared)).toBe(true);
    expect(layer.diagnostics().contentBuildCount).toBe(2);
    layer.destroy();
  });

  it('retains exact gapped recorded rows and invalidates presentation when the secondary row changes', () => {
    const gpu = gpuHarness();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('light'),
      testAtlas()
    );
    const range = { startBp: 0, endBp: 4 };
    const presentation = { alignedQuery: 'ac-t' };
    layer.prepare('a-gt', undefined, 0, 4, presentation);
    expect(layer.presentPrepared('a-gt', undefined, range, presentation)).toBe(true);
    expect(
      layer
        .sample('forward')
        .map((glyph) => glyph.text)
        .join('')
    ).toBe('a-gt');
    expect(
      layer
        .sample('reverse')
        .map((glyph) => glyph.text)
        .join('')
    ).toBe('ac-t');
    expect(layer.covers('a-gt', undefined, range, { alignedQuery: 'ag-t' })).toBe(false);
    const single = { showReverseComplement: false };
    layer.prepare('a-gt', undefined, 0, 4, single);
    expect(layer.presentPrepared('a-gt', undefined, range, single)).toBe(true);
    expect(layer.diagnostics().instanceCount).toBe(4);
    expect(layer.sample('reverse')).toEqual([]);
    expect(layer.baseAt(2, 'forward')).toBe('g');
    layer.destroy();
  });
  it.each([4096, 1088606208])(
    'projects adjacent bases across coordinate block %i without a gap',
    (boundary) => {
      const gpu = gpuHarness();
      const layer = new RetainedLinearNucleotideLayer(
        gpu.renderer,
        webglThemeForMode('light'),
        testAtlas()
      );
      const window = { startBp: boundary - 1, bases: 'ac' };
      layer.prepare(undefined, window, boundary - 1, boundary + 1);
      layer.presentPrepared(undefined, window, { startBp: boundary - 1, endBp: boundary + 1 });
      layer.paint({
        viewStartBp: boundary - 1,
        pixelsPerBp: 8,
        forwardY: 80,
        reverseY: 94,
        displayFontSize: 12,
        viewportWidth: 1155,
        viewportHeight: 831,
        alpha: 1,
      });
      const mesh = layer.container.children.find((child) => child.visible) as unknown as {
        shader: Shader;
      };
      const source = mesh.shader.glProgram?.vertex ?? '';
      const shaderChunkSize = Number(/const float BP_CHUNK_SIZE = ([0-9.]+);/.exec(source)?.[1]);
      const origin = boundary - 1;
      for (const bp of [origin, boundary]) {
        const projectedDelta =
          (bpCoordinateChunk(bp) - bpCoordinateChunk(origin)) * shaderChunkSize +
          bpCoordinateDelta(bp) -
          bpCoordinateDelta(origin);
        expect(projectedDelta).toBe(bp - origin);
      }
      layer.destroy();
    }
  );

  it('projects against the renderer viewport when the transitional linear model has no height', () => {
    const gpu = gpuHarness();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('light'),
      testAtlas()
    );
    const window = { startBp: 350_307_429, bases: 'acgt' };

    layer.prepare(undefined, window, window.startBp, window.startBp + window.bases.length);
    layer.presentPrepared(undefined, window, {
      startBp: window.startBp,
      endBp: window.startBp + window.bases.length,
    });
    layer.paint({
      viewStartBp: window.startBp,
      pixelsPerBp: 4.4,
      forwardY: 83.5,
      reverseY: 92.5,
      displayFontSize: 7,
      viewportWidth: 800,
      viewportHeight: 0,
      alpha: 1,
    });

    const internals = layer as unknown as {
      readonly activeOwnerIndex: 0 | 1;
      readonly owners: readonly [
        { readonly viewportUniform: Float32Array },
        { readonly viewportUniform: Float32Array },
      ];
    };
    expect(Array.from(internals.owners[internals.activeOwnerIndex].viewportUniform)).toEqual([
      800, 220,
    ]);

    layer.destroy();
  });

  it('normalizes DynamicBitmapFont measurement-space quads to the 16px glyph raster', () => {
    const gpu = gpuHarness();
    const atlas = testAtlas() as LinearNucleotideGlyphAtlas & {
      glyphCoordinateScale: number;
      glyphGeometryFontSizePx: number;
      atlasMeasurementFontSizePx: number;
    };
    atlas.glyphCoordinateScale = 16 / 100;
    atlas.glyphGeometryFontSizePx = 16;
    atlas.atlasMeasurementFontSizePx = 100;
    for (const glyph of atlas.glyphs.values()) {
      Object.assign(glyph, {
        localLeft: -55.1025390625,
        localTop: -33,
        localRight: 57.3974609375,
        localBottom: 133.40625,
      });
    }
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('light'),
      atlas
    );

    layer.prepare('a', undefined, 0, 1);
    layer.presentPrepared('a', undefined, { startBp: 0, endBp: 1 });
    layer.paint({
      viewStartBp: 0,
      pixelsPerBp: 8,
      forwardY: 20,
      reverseY: 40,
      displayFontSize: 7,
      viewportWidth: 800,
      viewportHeight: 220,
      alpha: 1,
    });

    const internals = layer as unknown as {
      readonly activeOwnerIndex: 0 | 1;
      readonly owners: readonly [
        { readonly instanceData: Float32Array },
        { readonly instanceData: Float32Array },
      ];
    };
    expect(
      Array.from(internals.owners[internals.activeOwnerIndex].instanceData.slice(3, 7))
    ).toEqual(
      [-55.1025390625, -33, 57.3974609375, 133.40625].map((value) =>
        Math.fround(value * (16 / 100))
      )
    );
    expect(layer.gpuOwnershipAudit()).toMatchObject({
      projectionViewportWidthPx: 800,
      projectionViewportHeightPx: 220,
      rendererViewportWidthPx: 800,
      rendererViewportHeightPx: 220,
      glyphGeometryFontSizePx: 16,
      displayScale: 7 / 16,
      displayFontSizePx: 7,
    });

    layer.destroy();
  });

  it('uploads exact forward and IUPAC-complement content once, then moves only camera uniforms', () => {
    const gpu = gpuHarness();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('light'),
      testAtlas()
    );
    const bases = [...new Set(Object.keys(IUPAC_COMPLEMENT).map((base) => base.toLowerCase()))]
      .sort()
      .join('');
    const normalizedBases = [...bases]
      .map((base) => (base.trim().length > 0 ? base : 'n'))
      .join('');
    const window = { startBp: 100, bases };

    expect(layer.prepare(undefined, window, 100, 100 + bases.length)).toBe(true);
    expect(
      layer.presentPrepared(undefined, window, {
        startBp: 100,
        endBp: 100 + bases.length,
      })
    ).toBe(true);
    layer.paint({
      viewStartBp: 100,
      pixelsPerBp: 0.6,
      forwardY: 20,
      reverseY: 40,
      displayFontSize: 4,
      viewportWidth: 800,
      viewportHeight: 200,
      alpha: 1,
    });

    expect(gpu.initSource).toHaveBeenCalledTimes(1);
    expect(gpu.updateBuffer).toHaveBeenCalledTimes(1);
    expect(
      layer
        .sample('forward', bases.length)
        .map(({ text }) => text)
        .join('')
    ).toBe(normalizedBases);
    expect(
      layer
        .sample('reverse', bases.length)
        .map(({ text }) => text)
        .join('')
    ).toBe(
      [...bases]
        .map((base) => {
          const complement = IUPAC_COMPLEMENT[base];
          return complement && complement.trim().length > 0 ? complement : 'n';
        })
        .join('')
    );
    expect(layer.diagnostics()).toMatchObject({
      renderOwner: RETAINED_LINEAR_NUCLEOTIDE_OWNER,
      meshCount: 1,
      instanceCount: bases.length * 2,
      retainedBaseCount: bases.length,
      contentBuildCount: 1,
      cameraUniformUpdateCount: 1,
      bufferCapacity: 6_000,
      visible: true,
    });
    expect(layer.gpuOwnershipAudit()).toMatchObject({
      contract: 'retained-linear-nucleotide-gpu-ownership.v1',
      owner: 'nucleotide',
      supported: true,
      renderOwner: RETAINED_LINEAR_NUCLEOTIDE_OWNER,
      requiredGlyphCount: bases.length * 2,
      meshCount: 1,
      instanceCount: bases.length * 2,
      retainedBaseCount: bases.length,
      bufferCapacity: 6_000,
      bufferResident: true,
      bufferSynchronized: true,
      textureResident: true,
      textureResourceLive: true,
      textureAutoGarbageCollect: false,
      shaderProgramOwned: true,
      atlasBound: true,
      meshAttached: true,
      meshVisible: true,
    });

    for (let index = 0; index < 100; index += 1) {
      layer.paint({
        viewStartBp: 100 + index / 10,
        pixelsPerBp: 0.6 + index / 100,
        forwardY: 20,
        reverseY: 40,
        displayFontSize: 4,
        viewportWidth: 800,
        viewportHeight: 200,
        alpha: 1,
      });
    }
    expect(gpu.updateBuffer).toHaveBeenCalledTimes(1);
    expect(layer.diagnostics()).toMatchObject({
      contentBuildCount: 1,
      cameraUniformUpdateCount: 101,
    });

    layer.destroy();
  });

  it('keeps the complete active owner visible until a prepared replacement is published', () => {
    const gpu = gpuHarness();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('dark'),
      testAtlas()
    );
    const first = { startBp: 0, bases: 'aaaa' };
    const replacement = { startBp: 0, bases: 'cccc' };

    layer.prepare(undefined, first, 0, 4);
    expect(layer.presentPrepared(undefined, first, { startBp: 0, endBp: 4 })).toBe(true);
    layer.paint({
      viewStartBp: 0,
      pixelsPerBp: 8,
      forwardY: 10,
      reverseY: 30,
      displayFontSize: 12,
      viewportWidth: 80,
      viewportHeight: 40,
      alpha: 1,
    });
    expect(layer.baseAt(0, 'forward')).toBe('a');

    layer.prepare(undefined, replacement, 0, 4);
    expect(layer.baseAt(0, 'forward')).toBe('a');
    expect(layer.diagnostics()).toMatchObject({ visible: true, retainedBaseCount: 4 });

    expect(layer.presentPrepared(undefined, replacement, { startBp: 0, endBp: 4 })).toBe(true);
    layer.paint({
      viewStartBp: 0,
      pixelsPerBp: 8,
      forwardY: 10,
      reverseY: 30,
      displayFontSize: 12,
      viewportWidth: 80,
      viewportHeight: 40,
      alpha: 1,
    });
    expect(layer.baseAt(0, 'forward')).toBe('c');
    expect(gpu.updateBuffer).toHaveBeenCalledTimes(2);
    expect(layer.container.children.filter((child) => child.visible)).toHaveLength(1);

    layer.destroy();
  });

  it('invalidates and releases a staged owner when its replacement upload fails', () => {
    const gpu = gpuHarness();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('dark'),
      testAtlas()
    );
    const activeSequence = 'aaaa';
    const stagedSequence = 'cccc';
    const failedSequence = 'gggg';

    layer.prepare(activeSequence, undefined, 0, activeSequence.length);
    layer.presentPrepared(activeSequence, undefined, {
      startBp: 0,
      endBp: activeSequence.length,
    });
    layer.prepare(stagedSequence, undefined, 0, stagedSequence.length);
    gpu.updateBuffer.mockImplementationOnce(() => {
      throw new Error('replacement upload failed');
    });

    expect(() => layer.prepare(failedSequence, undefined, 0, failedSequence.length)).toThrow(
      'replacement upload failed'
    );
    expect(
      layer.presentPrepared(stagedSequence, undefined, {
        startBp: 0,
        endBp: stagedSequence.length,
      })
    ).toBe(false);
    expect(layer.baseAt(0, 'forward')).toBe('a');
    const owners = (
      layer as unknown as {
        readonly owners: ReadonlyArray<{
          readonly sequence: string | undefined;
          readonly forwardBases: string;
          readonly reverseBases: string;
          readonly geometry: { readonly instanceCount: number };
        }>;
      }
    ).owners;
    expect(owners.some((owner) => owner.sequence === stagedSequence)).toBe(false);
    expect(owners.some((owner) => owner.sequence === failedSequence)).toBe(false);
    expect(owners.filter((owner) => owner.sequence !== undefined)).toHaveLength(1);
    expect(owners.filter((owner) => owner.geometry.instanceCount > 0)).toHaveLength(1);

    layer.destroy();
  });

  it('releases the superseded source as soon as prepared content is presented', () => {
    const gpu = gpuHarness();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('light'),
      testAtlas()
    );
    const firstSequence = 'a'.repeat(3_000);
    const replacementSequence = 'c'.repeat(4);

    layer.prepare(firstSequence, undefined, 0, firstSequence.length);
    layer.presentPrepared(firstSequence, undefined, {
      startBp: 0,
      endBp: firstSequence.length,
    });
    layer.prepare(replacementSequence, undefined, 0, replacementSequence.length);
    layer.presentPrepared(replacementSequence, undefined, {
      startBp: 0,
      endBp: replacementSequence.length,
    });

    const owners = (
      layer as unknown as {
        readonly owners: ReadonlyArray<{
          readonly sequence: string | undefined;
          readonly forwardBases: string;
          readonly reverseBases: string;
          readonly geometry: { readonly instanceCount: number };
        }>;
      }
    ).owners;
    expect(owners.some((owner) => owner.sequence === firstSequence)).toBe(false);
    expect(owners.filter((owner) => owner.sequence !== undefined)).toHaveLength(1);
    expect(owners.some((owner) => owner.sequence === replacementSequence)).toBe(true);
    expect(
      owners.some(
        (owner) =>
          owner.forwardBases.length === firstSequence.length ||
          owner.reverseBases.length === firstSequence.length
      )
    ).toBe(false);
    expect(owners.filter((owner) => owner.geometry.instanceCount > 0)).toHaveLength(1);

    layer.clear();
    expect(owners.every((owner) => owner.sequence === undefined)).toBe(true);
    expect(owners.every((owner) => owner.forwardBases.length === 0)).toBe(true);
    expect(owners.every((owner) => owner.reverseBases.length === 0)).toBe(true);
    expect(owners.every((owner) => owner.geometry.instanceCount === 0)).toBe(true);

    layer.destroy();
    expect(owners.every((owner) => owner.sequence === undefined)).toBe(true);
    expect(owners.every((owner) => owner.forwardBases.length === 0)).toBe(true);
    expect(owners.every((owner) => owner.reverseBases.length === 0)).toBe(true);
  });

  it('derives presentation semantics from the retained instance record', () => {
    const gpu = gpuHarness();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('light'),
      testAtlas()
    );
    const window = { startBp: 100, bases: 'ac' };
    layer.prepare(undefined, window, 100, 102);
    layer.presentPrepared(undefined, window, { startBp: 100, endBp: 102 });

    expect(layer.baseAt(100, 'forward')).toBe('a');
    const internals = layer as unknown as {
      readonly activeOwnerIndex: 0 | 1;
      readonly owners: readonly [
        { readonly instanceData: Float32Array },
        { readonly instanceData: Float32Array },
      ];
    };
    const activeData = internals.owners[internals.activeOwnerIndex].instanceData;
    const previousSignatureValue = activeData[7];
    if (previousSignatureValue === undefined) throw new Error('test instance record is missing');
    activeData[7] = Math.fround(previousSignatureValue + 0.125);

    expect(layer.baseAt(100, 'forward')).toBeUndefined();
    layer.destroy();
  });

  it('clamps preparation to the contiguous source window and rejects an oversized owner', () => {
    const gpu = gpuHarness();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('light'),
      testAtlas()
    );
    const window = { startBp: 500, bases: 'acgt' };

    layer.prepare(undefined, window, 0, 10_000);
    expect(layer.presentPrepared(undefined, window, { startBp: 500, endBp: 504 })).toBe(true);
    expect(layer.diagnostics()).toMatchObject({ startBp: 500, endBp: 504, retainedBaseCount: 4 });
    expect(layer.covers(undefined, window, { startBp: 499, endBp: 504 })).toBe(false);
    expect(() => layer.prepare('a'.repeat(3_001), undefined, 0, 3_001)).toThrow(
      'fixed base capacity'
    );

    layer.destroy();
  });

  it('owns and disposes its atlas and GPU wrappers exactly once', () => {
    const gpu = gpuHarness();
    const dispose = vi.fn();
    const layer = new RetainedLinearNucleotideLayer(
      gpu.renderer,
      webglThemeForMode('light'),
      testAtlas(dispose)
    );

    layer.destroy();
    layer.destroy();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(layer.container.destroyed).toBe(true);
  });

  it('releases the atlas when construction rejects ambiguous glyph records', () => {
    const gpu = gpuHarness();
    const dispose = vi.fn();

    expect(
      () =>
        new RetainedLinearNucleotideLayer(
          gpu.renderer,
          webglThemeForMode('light'),
          testAtlas(dispose, false)
        )
    ).toThrow('ambiguous glyph record');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('releases fully allocated owners when GPU initialization fails', () => {
    const gpu = gpuHarness();
    const dispose = vi.fn();
    const destroyBuffer = vi.spyOn(PixiBuffer.prototype, 'destroy');
    gpu.initSource.mockImplementationOnce(() => {
      throw new Error('texture upload failed');
    });

    expect(
      () =>
        new RetainedLinearNucleotideLayer(
          gpu.renderer,
          webglThemeForMode('light'),
          testAtlas(dispose)
        )
    ).toThrow('texture upload failed');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(destroyBuffer).toHaveBeenCalledTimes(4);
    destroyBuffer.mockRestore();
  });

  it('releases partially allocated owner buffers when shader creation fails', () => {
    const gpu = gpuHarness();
    const dispose = vi.fn();
    const destroyBuffer = vi.spyOn(PixiBuffer.prototype, 'destroy');
    const createProgram = vi.spyOn(GlProgram, 'from').mockImplementationOnce(() => {
      throw new Error('shader creation failed');
    });

    expect(
      () =>
        new RetainedLinearNucleotideLayer(
          gpu.renderer,
          webglThemeForMode('light'),
          testAtlas(dispose)
        )
    ).toThrow('shader creation failed');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(destroyBuffer).toHaveBeenCalledTimes(2);
    createProgram.mockRestore();
    destroyBuffer.mockRestore();
  });
});
