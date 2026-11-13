// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildCoverageGpuAtlas,
  coverageGpuAtlasEdgeCoverage,
  coverageGpuAtlasHeightCutoffFill,
  sampleCoverageGpuAtlasSmoothed,
} from './coverage-gpu-atlas';
import {
  PILEUP_COVERAGE_ALPHA,
  PILEUP_COVERAGE_SMOOTH_KERNEL,
  resampleCoverageColumns,
  smoothCoverageColumnsInPlace,
} from './pileup-coverage-resample';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId === 'webgl' || contextId === 'webgl2') return null;
    return {
      font: '',
      fillStyle: '',
      textBaseline: '',
      scale: () => undefined,
      measureText: (text: string) => ({ width: text.length * 6 }),
      fillText: () => undefined,
      clearRect: () => undefined,
      fillRect: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

function atlas() {
  return buildCoverageGpuAtlas({
    sourceIdentity: 'source-a',
    assemblyFingerprint: 'assembly-a',
    statistic: 'fixed-base-peak-mean-v1',
    payloadRevision: 'revision-a',
    assemblyEndBp: 800,
    baseBinSizeBp: 100,
    depthPercentiles: { p50: 5, p90: 10, p95: 12, p99: 15, max: 20 },
    layers: [
      {
        chrom: 'chrA',
        globalStartBp: 0,
        globalEndBp: 400,
        binSizeBp: 100,
        bins: new Float32Array([2, 4, 6, 8]),
      },
      {
        chrom: 'chrB',
        globalStartBp: 400,
        globalEndBp: 800,
        binSizeBp: 100,
        bins: new Float32Array([10, 12, 14, 16]),
      },
    ],
  });
}

function shaderUniformContract(shader: string): {
  declared: ReadonlySet<string>;
  undeclaredReferences: readonly string[];
} {
  const withoutComments = shader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const declared = new Set(
    [
      ...withoutComments.matchAll(
        /\buniform\s+(?:lowp\s+|mediump\s+|highp\s+)?\w+\s+(u[A-Z]\w*)\s*;/g
      ),
    ].map((match) => match[1])
  );
  const referenced = new Set(
    [...withoutComments.matchAll(/\b(u[A-Z]\w*)\b/g)].map((match) => match[1])
  );
  return {
    declared,
    undeclaredReferences: [...referenced].filter((name) => !declared.has(name)).sort(),
  };
}

describe('CoverageGpuAtlasLayer retained lifecycle', () => {
  it('links the atlas program without creating an atlas texture or geometry', async () => {
    const { CoverageGpuAtlasLayer } = await import('./coverage-gpu-atlas-layer');
    const renderer = {
      shader: { bind: vi.fn(), resetState: vi.fn() },
    };

    CoverageGpuAtlasLayer.prepareGpuProgram(renderer as never);

    expect(renderer.shader.bind).toHaveBeenCalledTimes(1);
    expect(renderer.shader.bind).toHaveBeenCalledWith(expect.anything(), true);
    expect(renderer.shader.resetState).toHaveBeenCalledTimes(1);
  });

  it('keeps custom uniforms collision-free from Pixi Mesh local uniforms', async () => {
    const { Container, MeshPipe } = await import('pixi.js');
    const {
      COVERAGE_GPU_ATLAS_FRAGMENT_SHADER,
      COVERAGE_GPU_ATLAS_VERTEX_SHADER,
      CoverageGpuAtlasLayer,
    } = await import('./coverage-gpu-atlas-layer');
    const layer = new CoverageGpuAtlasLayer(new Container());
    layer.syncAtlas(atlas());
    expect(
      layer.paint({
        viewportStartBp: 0,
        viewportEndBp: 800,
        viewportWidthPx: 4,
        viewportHeightPx: 300,
        bandTopPx: 50,
        bandHeightPx: 180,
        maxFill: 0.98,
        cutoffDepth: 15,
        color: 0x4a90d9,
      })
    ).toBe(true);
    expect(layer.diagnostics().depthMax).toBe(20);

    const owned = layer as unknown as {
      shader: {
        resources: {
          coverageAtlasUniforms: {
            uniformStructures: Record<string, { type: string }>;
            uniforms: Record<string, unknown>;
          };
        };
      };
    };
    const meshPipe = new MeshPipe({} as ConstructorParameters<typeof MeshPipe>[0], {
      init: () => undefined,
      execute: () => undefined,
      destroy: () => undefined,
    });
    const pixiMeshLocalUniformTypes = Object.fromEntries(
      Object.entries(meshPipe.localUniforms.uniformStructures).map(([name, descriptor]) => [
        name,
        descriptor.type,
      ])
    );
    expect(pixiMeshLocalUniformTypes).toEqual({
      uTransformMatrix: 'mat3x3<f32>',
      uColor: 'vec4<f32>',
      uRound: 'f32',
    });

    const customGroup = owned.shader.resources.coverageAtlasUniforms;
    const customUniformNames = Object.keys(customGroup.uniformStructures);
    const vertexContract = shaderUniformContract(COVERAGE_GPU_ATLAS_VERTEX_SHADER);
    const fragmentContract = shaderUniformContract(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER);
    expect(vertexContract.undeclaredReferences).toEqual([]);
    expect(fragmentContract.undeclaredReferences).toEqual([]);
    const declaredResourceUniforms = new Set([
      ...vertexContract.declared,
      ...fragmentContract.declared,
    ]);
    declaredResourceUniforms.delete('uCoverageAtlas');
    expect([...declaredResourceUniforms].sort()).toEqual([...customUniformNames].sort());
    expect(customUniformNames.filter((name) => name in pixiMeshLocalUniformTypes)).toEqual([]);
    expect(customGroup.uniformStructures).toHaveProperty('uCoverageColor.type', 'vec3<f32>');
    expect(customGroup.uniformStructures).not.toHaveProperty('uColor');
    expect(customGroup.uniforms).not.toHaveProperty('uColor');
    expect(customGroup.uniforms.uCoverageColor).toEqual(
      new Float32Array([0x4a / 0xff, 0x90 / 0xff, 0xd9 / 0xff])
    );
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).toMatch(/\buniform\s+vec3\s+uCoverageColor\s*;/);
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).toMatch(/\buniform\s+float\s+uBandHeightPx\s*;/);
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).not.toMatch(/\buniform\s+\w+\s+uColor\s*;/);
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).toContain(
      'gl_FragColor = vec4(uCoverageColor * edgeAlpha, edgeAlpha)'
    );

    meshPipe.destroy();
  });

  it('creates retained resources once and makes every camera packet uniform-only', async () => {
    const { Container } = await import('pixi.js');
    const { CoverageGpuAtlasLayer } = await import('./coverage-gpu-atlas-layer');
    const container = new Container();
    const layer = new CoverageGpuAtlasLayer(container);
    const value = atlas();
    expect(layer.syncAtlas(value)).toBe(true);
    expect(layer.syncAtlas(value)).toBe(false);
    const paint = (start: number, end: number) =>
      layer.paint({
        viewportStartBp: start,
        viewportEndBp: end,
        viewportWidthPx: 4,
        viewportHeightPx: 300,
        bandTopPx: 50,
        bandHeightPx: 180,
        maxFill: 0.98,
        cutoffDepth: 15,
        color: 0x4a90d9,
      });
    expect(paint(0, 800)).toBe(true);
    expect(paint(100, 700)).toBe(true);
    expect(paint(200, 600)).toBe(true);
    expect(layer.diagnostics()).toMatchObject({
      textureResourceCreateCount: 1,
      geometryBuildCount: 1,
      cameraUniformUpdateCount: 3,
      active: true,
      authorityKey: value.authorityKey,
    });
  });

  it('reports only renderer-created GPU resources and an actually linked active shader owner', async () => {
    const { Container } = await import('pixi.js');
    const { CoverageGpuAtlasLayer } = await import('./coverage-gpu-atlas-layer');
    const container = new Container();
    const layer = new CoverageGpuAtlasLayer(container);
    layer.syncAtlas(atlas());
    const owned = layer as unknown as {
      source: {
        uid: number;
        width: number;
        height: number;
        emit: (event: string, source: unknown) => void;
        _gpuData: Record<number, { width: number; height: number; texture: object } | undefined>;
      };
      shader: {
        glProgram: {
          _key: number;
          _attributeData: Record<string, unknown> | null;
        };
      };
    };
    const rendererUid = 73;
    const webGlProgram = {};
    let linked = false;
    let contextLost = false;
    const getProgramParameter = vi.fn((program: unknown, parameter: number) => {
      expect(program).toBe(webGlProgram);
      expect(parameter).toBe(0x8b82);
      return linked;
    });
    const createProgramData = vi.fn();
    const renderer = {
      uid: rendererUid,
      gl: { LINK_STATUS: 0x8b82, getProgramParameter, isContextLost: () => contextLost },
      shader: {
        _programDataHash: {} as Record<number, { program: unknown } | undefined>,
        _getProgramData: createProgramData,
      },
    };
    const paint = {
      viewportStartBp: 0,
      viewportEndBp: 800,
      viewportWidthPx: 4,
      viewportHeightPx: 300,
      bandTopPx: 50,
      bandHeightPx: 180,
      maxFill: 0.98,
      cutoffDepth: 15,
      color: 0x4a90d9,
      renderer,
    } as unknown as Parameters<typeof layer.paint>[0];

    expect(layer.paint(paint)).toBe(true);
    expect(layer.diagnostics()).toMatchObject({
      gpuTextureResourceCreateCount: 0,
      gpuTextureUploadCount: 0,
      gpuTextureUploadComplete: false,
      shaderProgramCompiled: false,
      shaderProgramKey: null,
    });

    const glBacking = {
      width: owned.source.width,
      height: owned.source.height,
      texture: {},
    };
    owned.source._gpuData[rendererUid] = glBacking;

    owned.shader.glProgram._attributeData = { aPosition: {} };
    expect(layer.diagnostics()).toMatchObject({
      gpuTextureResourceCreateCount: 1,
      gpuTextureUploadCount: 1,
      gpuTextureUploadComplete: true,
      textureResourceUid: owned.source.uid,
      shaderTextureResourceUid: owned.source.uid,
      shaderTextureResourceBound: true,
      renderOwner: 'coverage-gpu-atlas-fill',
      shaderProgramName: 'coverage-gpu-atlas-fill-fragment',
      shaderProgramCompiled: false,
      active: true,
    });
    expect(layer.diagnostics().shaderProgramKey).toBeNull();
    expect(getProgramParameter).not.toHaveBeenCalled();
    expect(createProgramData).not.toHaveBeenCalled();

    renderer.shader._programDataHash[owned.shader.glProgram._key] = {
      program: webGlProgram,
    };
    expect(layer.diagnostics()).toMatchObject({
      shaderProgramCompiled: false,
      shaderProgramKey: null,
    });

    linked = true;
    expect(layer.diagnostics()).toMatchObject({
      shaderProgramCompiled: true,
      shaderProgramKey: owned.shader.glProgram._key,
    });
    expect(createProgramData).not.toHaveBeenCalled();

    layer.paint(paint);
    expect(layer.diagnostics()).toMatchObject({
      gpuTextureResourceCreateCount: 1,
      gpuTextureUploadCount: 1,
      shaderProgramCompiled: true,
    });
    expect(getProgramParameter).toHaveBeenCalledTimes(2);

    contextLost = true;
    expect(layer.diagnostics()).toMatchObject({
      shaderProgramCompiled: false,
      shaderProgramKey: null,
    });
    expect(getProgramParameter).toHaveBeenCalledTimes(2);
    contextLost = false;
    expect(layer.diagnostics().shaderProgramCompiled).toBe(true);
    expect(getProgramParameter).toHaveBeenCalledTimes(3);

    owned.source.emit('update', owned.source);
    expect(layer.diagnostics()).toMatchObject({
      gpuTextureResourceCreateCount: 1,
      gpuTextureUploadCount: 2,
      gpuTextureUploadComplete: true,
    });
  });

  it('fails the linked-program proof closed on an invalid or lost WebGL context', async () => {
    const { Container } = await import('pixi.js');
    const { CoverageGpuAtlasLayer } = await import('./coverage-gpu-atlas-layer');
    const layer = new CoverageGpuAtlasLayer(new Container());
    layer.syncAtlas(atlas());
    const owned = layer as unknown as {
      shader: { glProgram: { _key: number } };
    };
    const webGlProgram = {};
    const getProgramParameter = vi.fn(() => {
      throw new Error('context lost');
    });
    const createProgramData = vi.fn();
    const renderer = {
      uid: 74,
      gl: { LINK_STATUS: 0x8b82, getProgramParameter },
      shader: {
        _programDataHash: {
          [owned.shader.glProgram._key]: { program: webGlProgram },
        },
        _getProgramData: createProgramData,
      },
    };
    expect(
      layer.paint({
        viewportStartBp: 0,
        viewportEndBp: 800,
        viewportWidthPx: 4,
        viewportHeightPx: 300,
        bandTopPx: 50,
        bandHeightPx: 180,
        maxFill: 0.98,
        cutoffDepth: 15,
        color: 0x4a90d9,
        renderer: renderer as unknown as Parameters<typeof layer.paint>[0]['renderer'],
      })
    ).toBe(true);
    expect(layer.diagnostics()).toMatchObject({
      shaderProgramCompiled: false,
      shaderProgramKey: null,
    });
    expect(getProgramParameter).toHaveBeenCalledWith(webGlProgram, 0x8b82);
    expect(createProgramData).not.toHaveBeenCalled();
  });

  it('holds the last atlas across the exact-owner handoff boundary only when authorized', async () => {
    const { Container } = await import('pixi.js');
    const { CoverageGpuAtlasLayer } = await import('./coverage-gpu-atlas-layer');
    const layer = new CoverageGpuAtlasLayer(new Container());
    layer.syncAtlas(atlas());
    const tooFine = {
      viewportStartBp: 0,
      viewportEndBp: 200,
      viewportWidthPx: 4,
      viewportHeightPx: 300,
      bandTopPx: 50,
      bandHeightPx: 180,
      maxFill: 0.98,
      cutoffDepth: 15,
      color: 0x4a90d9,
    } as const;
    expect(layer.paint(tooFine)).toBe(false);
    expect(layer.paint({ ...tooFine, allowHandoffHold: true })).toBe(true);
    layer.setVisible(false);
    expect(layer.diagnostics().active).toBe(false);
  });

  it('rejects mismatched authority before touching the last-good resources', async () => {
    const { Container } = await import('pixi.js');
    const { CoverageGpuAtlasLayer } = await import('./coverage-gpu-atlas-layer');
    const layer = new CoverageGpuAtlasLayer(new Container());
    const good = atlas();
    layer.syncAtlas(good);
    const forged = { ...good, sourceIdentity: 'source-b' };
    expect(() => layer.syncAtlas(forged)).toThrow(/rejected mismatched/);
    expect(layer.diagnostics()).toMatchObject({
      authorityKey: good.authorityKey,
      textureResourceCreateCount: 1,
      geometryBuildCount: 1,
    });
  });

  it('destroys each owned resource exactly once across replacement and repeated teardown', async () => {
    const { Container } = await import('pixi.js');
    const { CoverageGpuAtlasLayer } = await import('./coverage-gpu-atlas-layer');
    const layer = new CoverageGpuAtlasLayer(new Container());
    const first = atlas();
    layer.syncAtlas(first);
    const owned = layer as unknown as {
      mesh: { destroy: (...args: unknown[]) => void };
      geometry: { destroy: (...args: unknown[]) => void };
      shader: { destroy: (...args: unknown[]) => void };
      source: { destroy: (...args: unknown[]) => void };
    };
    const destroySpies = [
      vi.spyOn(owned.mesh, 'destroy'),
      vi.spyOn(owned.geometry, 'destroy'),
      vi.spyOn(owned.shader, 'destroy'),
      vi.spyOn(owned.source, 'destroy'),
    ];
    const replacement = buildCoverageGpuAtlas({
      sourceIdentity: 'source-a',
      assemblyFingerprint: 'assembly-a',
      statistic: 'fixed-base-peak-mean-v1',
      payloadRevision: 'revision-b',
      assemblyEndBp: 800,
      baseBinSizeBp: 100,
      depthPercentiles: { p50: 5, p90: 10, p95: 12, p99: 15, max: 20 },
      layers: [
        {
          chrom: 'chrA',
          globalStartBp: 0,
          globalEndBp: 400,
          binSizeBp: 100,
          bins: new Float32Array([2, 4, 6, 8]),
        },
        {
          chrom: 'chrB',
          globalStartBp: 400,
          globalEndBp: 800,
          binSizeBp: 100,
          bins: new Float32Array([10, 12, 14, 16]),
        },
      ],
    });

    expect(layer.syncAtlas(replacement)).toBe(true);
    for (const spy of destroySpies) expect(spy).toHaveBeenCalledTimes(1);
    expect(layer.diagnostics()).toMatchObject({
      textureResourceCreateCount: 2,
      geometryBuildCount: 2,
      authorityKey: replacement.authorityKey,
    });
    expect(() => {
      layer.destroy();
      layer.destroy();
    }).not.toThrow();
  });

  it('derives genome position from the vertex varying, never device-pixel gl_FragCoord', async () => {
    const { COVERAGE_GPU_ATLAS_FRAGMENT_SHADER, COVERAGE_GPU_ATLAS_VERTEX_SHADER } =
      await import('./coverage-gpu-atlas-layer');
    expect(COVERAGE_GPU_ATLAS_VERTEX_SHADER).toContain('vGenomeBp = bp');
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).toContain('float bp = vGenomeBp');
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).not.toContain('gl_FragCoord.x');
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).toContain(
      'float bpPerPixel = viewSpan / max(1.0, uViewportSize.x)'
    );
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).toContain(
      'gl_FragColor = vec4(uCoverageColor * edgeAlpha, edgeAlpha)'
    );
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).not.toContain('coverageHeatColor');
  });

  it('anchors partial summary coverage fills to the top of the screen band', async () => {
    const { COVERAGE_GPU_ATLAS_FRAGMENT_SHADER, COVERAGE_GPU_ATLAS_VERTEX_SHADER } =
      await import('./coverage-gpu-atlas-layer');

    expect(COVERAGE_GPU_ATLAS_VERTEX_SHADER).toContain('uBandTopPx + aPosition.y * uBandHeightPx');
    expect(COVERAGE_GPU_ATLAS_VERTEX_SHADER).not.toContain(
      'uBandTopPx + (1.0 - aPosition.y) * uBandHeightPx'
    );
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).toContain(
      '(fill - vBandY) * uBandHeightPx * uCoverageResolution'
    );

    const screenY = (bandY: number): number => 20 + bandY * 100;
    expect(screenY(0)).toBeLessThan(screenY(0.4));
    expect(screenY(0.4)).toBeLessThan(screenY(1));
    expect(coverageGpuAtlasEdgeCoverage(0.25, 0, 100, 1)).toBe(1);
    expect(coverageGpuAtlasEdgeCoverage(0.25, 1, 100, 1)).toBe(0);
  });

  it('preserves fractional silhouette energy through a fixed-span subpixel side-pan', async () => {
    const { COVERAGE_GPU_ATLAS_FRAGMENT_SHADER } = await import('./coverage-gpu-atlas-layer');
    const bandHeightPx = 96;
    const source = buildCoverageGpuAtlas({
      sourceIdentity: 'pan-source',
      assemblyFingerprint: 'pan-assembly',
      statistic: 'fixed-base-peak-mean-v1',
      payloadRevision: 'pan-revision',
      assemblyEndBp: 128 * 256,
      baseBinSizeBp: 256,
      depthPercentiles: { p50: 20, p90: 45, p95: 55, p99: 70, max: 120 },
      layers: [
        {
          chrom: 'chr1',
          globalStartBp: 0,
          globalEndBp: 128 * 256,
          binSizeBp: 256,
          bins: Float32Array.from({ length: 128 }, (_, index) => {
            const wave = 34 + 19 * Math.sin(index * 0.31) + 11 * Math.cos(index * 0.13);
            return Math.max(1, wave);
          }),
        },
      ],
    });
    const viewportPx = 32;
    const spanBp = 32 * 256;
    const maxFill = 0.98;
    const cutoffDepth = 70;
    const interiorColumns = Array.from({ length: 24 }, (_, index) => index + 4);

    for (const rendererResolution of [1, 2]) {
      let maximumBinaryDiscardErrorPx = 0;
      for (let phase = 0; phase < 8; phase += 1) {
        const panPx = phase / 8;
        const viewportStartBp = 8 * 256 + panPx * (spanBp / viewportPx);
        for (const column of interiorColumns) {
          const bp = viewportStartBp + (column + 0.5) * (spanBp / viewportPx);
          const depth = sampleCoverageGpuAtlasSmoothed(source, bp, spanBp, viewportPx);
          const fill = coverageGpuAtlasHeightCutoffFill(depth, cutoffDepth, maxFill);
          const continuousHeightPx = fill * bandHeightPx;
          let integratedCoveragePx = 0;
          let binaryDiscardHeightPx = 0;
          const framebufferRows = bandHeightPx * rendererResolution;
          for (let row = 0; row < framebufferRows; row += 1) {
            const bandY = (row + 0.5) / framebufferRows;
            integratedCoveragePx +=
              coverageGpuAtlasEdgeCoverage(fill, bandY, bandHeightPx, rendererResolution) /
              rendererResolution;
            binaryDiscardHeightPx += (bandY <= fill ? 1 : 0) / rendererResolution;
          }
          expect(integratedCoveragePx).toBeCloseTo(continuousHeightPx, 5);
          maximumBinaryDiscardErrorPx = Math.max(
            maximumBinaryDiscardErrorPx,
            Math.abs(binaryDiscardHeightPx - continuousHeightPx)
          );
        }
      }
      expect(maximumBinaryDiscardErrorPx * rendererResolution).toBeGreaterThan(0.45);
    }

    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).toContain(
      'float edgeCoverage = clamp(edgeDistancePx + 0.5, 0.0, 1.0);'
    );
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).not.toMatch(
      /if\s*\(\s*vBandY\s*>\s*fill\s*\)\s*discard/
    );
  });

  it('matches the exact aggregate visual contract at the physical handoff', async () => {
    const { COVERAGE_GPU_ATLAS_FRAGMENT_SHADER, COVERAGE_GPU_ATLAS_SMOOTH_WEIGHTS } =
      await import('./coverage-gpu-atlas-layer');
    const baseBinSizeBp = 32_768;
    const columnCount = 96;
    const spanBp = baseBinSizeBp * columnCount;
    const viewportPx = columnCount;
    const cutoffDepth = 80;
    const maximumDepth = 160;
    const maxFill = 0.98;
    const bandHeightPx = 180;
    const bins = Float32Array.from({ length: columnCount }, (_, index) =>
      Math.min(maximumDepth, 8 + ((index * 37) % 53) + (index % 23 === 0 ? 95 : 0))
    );
    const value = buildCoverageGpuAtlas({
      sourceIdentity: 'handoff-source',
      assemblyFingerprint: 'handoff-assembly',
      statistic: 'fixed-base-peak-mean-v1',
      payloadRevision: 'handoff-revision',
      assemblyEndBp: spanBp,
      baseBinSizeBp,
      depthPercentiles: {
        p50: 30,
        p90: 60,
        p95: 70,
        p99: cutoffDepth,
        max: maximumDepth,
      },
      layers: [
        {
          chrom: 'chr1',
          globalStartBp: 0,
          globalEndBp: spanBp,
          binSizeBp: baseBinSizeBp,
          bins,
        },
      ],
    });

    const exactDepths = new Float32Array(columnCount);
    resampleCoverageColumns({
      bins,
      binSize: baseBinSizeBp,
      signalStartBp: 0,
      viewStart: 0,
      columnBp: baseBinSizeBp,
      columnCount,
      useMean: true,
      out: exactDepths,
    });
    smoothCoverageColumnsInPlace(exactDepths, new Float32Array(columnCount));

    const kernelRadius = (PILEUP_COVERAGE_SMOOTH_KERNEL.length - 1) >> 1;
    const float32AccumulationTolerance = maximumDepth * 2 ** -23 * 16;
    const framebufferHeightTolerancePx = 1;
    for (let column = kernelRadius; column < columnCount - kernelRadius; column += 1) {
      const centerBp = (column + 0.5) * baseBinSizeBp;
      const atlasDepth = sampleCoverageGpuAtlasSmoothed(value, centerBp, spanBp, viewportPx);
      expect(Math.abs(atlasDepth - exactDepths[column]!)).toBeLessThanOrEqual(
        float32AccumulationTolerance
      );
      const exactFill = coverageGpuAtlasHeightCutoffFill(
        exactDepths[column]!,
        cutoffDepth,
        maxFill
      );
      const atlasFill = coverageGpuAtlasHeightCutoffFill(atlasDepth, cutoffDepth, maxFill);
      expect(Math.abs(atlasFill - exactFill) * bandHeightPx).toBeLessThanOrEqual(
        framebufferHeightTolerancePx
      );
    }

    for (let boundary = kernelRadius + 1; boundary < columnCount - kernelRadius; boundary += 1) {
      const leftFill = coverageGpuAtlasHeightCutoffFill(
        exactDepths[boundary - 1]!,
        cutoffDepth,
        maxFill
      );
      const rightFill = coverageGpuAtlasHeightCutoffFill(
        exactDepths[boundary]!,
        cutoffDepth,
        maxFill
      );
      const exactBoundaryFill = (leftFill + rightFill) * 0.5;
      const atlasBoundaryFill = coverageGpuAtlasHeightCutoffFill(
        sampleCoverageGpuAtlasSmoothed(value, boundary * baseBinSizeBp, spanBp, viewportPx),
        cutoffDepth,
        maxFill
      );
      expect(Math.abs(atlasBoundaryFill - exactBoundaryFill) * bandHeightPx).toBeLessThanOrEqual(
        framebufferHeightTolerancePx
      );
    }

    const highViewStartBp = 2_800_000_000;
    const highViewEndBp = highViewStartBp + spanBp;
    const packedStart = Math.fround(highViewStartBp);
    const packedEnd = Math.fround(highViewEndBp);
    for (let column = 0; column < columnCount; column += 1) {
      const fraction = (column + 0.5) / columnCount;
      const packedBp = Math.fround(
        Math.fround(packedStart * Math.fround(1 - fraction)) +
          Math.fround(packedEnd * Math.fround(fraction))
      );
      const packedX =
        ((packedBp - packedStart) / Math.max(1, packedEnd - packedStart)) * viewportPx;
      expect(Math.abs(packedX - (column + 0.5))).toBeLessThanOrEqual(0.5);
    }

    for (let index = 0; index < PILEUP_COVERAGE_SMOOTH_KERNEL.length; index += 1) {
      expect(COVERAGE_GPU_ATLAS_SMOOTH_WEIGHTS[index]).toBeCloseTo(
        PILEUP_COVERAGE_SMOOTH_KERNEL[index]!,
        7
      );
    }
    expect(PILEUP_COVERAGE_ALPHA).toBe(1);
    expect(COVERAGE_GPU_ATLAS_FRAGMENT_SHADER).toContain(
      'gl_FragColor = vec4(uCoverageColor * edgeAlpha, edgeAlpha)'
    );
  });
});
