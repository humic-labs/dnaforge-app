import EventEmitter from 'eventemitter3';
import { describe, expect, it, vi } from 'vitest';

import {
  CanvasTextMetrics,
  GCManagedHash,
  GlProgram,
  GlobalResourceRegistry,
  Texture,
  type Renderer,
} from 'pixi.js';

type TestableCache = {
  has(key: string): boolean;
  set(key: string, value: object): unknown;
};

type TextMetricsLifecycle = {
  clearMeasurementCache(): void;
};

type TextureBatchModule = {
  getTextureBatchBindGroup(textures: readonly object[], size: number, maxTextures: number): object;
};

type BackBufferSystemModule = {
  GlBackBufferSystem: new (renderer: object) => {
    init(options: { useBackBuffer: boolean; antialias: boolean }): void;
    destroy(): void;
  };
};

type GlShaderSystemModule = {
  GlShaderSystem: new (renderer: object) => {
    contextChange(gl: object): void;
    destroy(): void;
  };
};

type BatcherPipeModule = {
  BatcherPipe: new (
    renderer: { limits: { maxBatchableTextures: number } },
    adaptor: object
  ) => {
    buildStart(instructionSet: { uid: number }): void;
  };
};

type RenderGroupModule = {
  RenderGroup: new () => {
    instructionSet: {
      uid: number;
      renderPipes: { batch: object } | null;
    };
    destroy(): void;
  };
};

type Destructible = {
  destroy(): void;
};

function isTestableCache(value: unknown): value is TestableCache {
  return (
    typeof value === 'object' &&
    value !== null &&
    'has' in value &&
    typeof value.has === 'function' &&
    'set' in value &&
    typeof value.set === 'function'
  );
}

function hasTextMetricsLifecycle(value: unknown): value is TextMetricsLifecycle {
  return (
    typeof value === 'function' &&
    'clearMeasurementCache' in value &&
    typeof value.clearMeasurementCache === 'function'
  );
}

function isTextureBatchModule(value: unknown): value is TextureBatchModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getTextureBatchBindGroup' in value &&
    typeof value.getTextureBatchBindGroup === 'function'
  );
}

function isBackBufferSystemModule(value: unknown): value is BackBufferSystemModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'GlBackBufferSystem' in value &&
    typeof value.GlBackBufferSystem === 'function'
  );
}

function isGlShaderSystemModule(value: unknown): value is GlShaderSystemModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'GlShaderSystem' in value &&
    typeof value.GlShaderSystem === 'function'
  );
}

function isBatcherPipeModule(value: unknown): value is BatcherPipeModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'BatcherPipe' in value &&
    typeof value.BatcherPipe === 'function'
  );
}

function isRenderGroupModule(value: unknown): value is RenderGroupModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'RenderGroup' in value &&
    typeof value.RenderGroup === 'function'
  );
}

function isDestructible(value: unknown): value is Destructible {
  return (
    typeof value === 'object' &&
    value !== null &&
    'destroy' in value &&
    typeof value.destroy === 'function'
  );
}

class FakeGpuResource extends EventEmitter {
  readonly uid = 91_337;
  _gcLastUsed = 0;
  _gpuData: Record<number, { destroy(): void } | null>;

  constructor(rendererUid: number, destroyGpuData: () => void) {
    super();
    this._gpuData = {
      [rendererUid]: { destroy: destroyGpuData },
    };
  }

  unload(): void {
    this.emit('unload', this);
  }
}

describe('Pixi GCManagedHash lifecycle', () => {
  it('keeps repeated shader sources byte-identical across application lifecycles', () => {
    const name = `fixture-reopen-${crypto.randomUUID()}`;
    const options = {
      name,
      vertex: 'void main() { gl_Position = vec4(0.0); }',
      fragment: 'void main() {}',
    };

    const firstLifecycleProgram = new GlProgram(options);
    const secondLifecycleProgram = new GlProgram(options);

    expect(secondLifecycleProgram.vertex).toBe(firstLifecycleProgram.vertex);
    expect(secondLifecycleProgram.fragment).toBe(firstLifecycleProgram.fragment);
    expect(firstLifecycleProgram.vertex).toContain(`#define SHADER_NAME ${name}-vertex`);
    expect(firstLifecycleProgram.fragment).toContain(`#define SHADER_NAME ${name}-fragment`);
  });

  it('detaches the unload listener when a renderer destroys its resource hash', () => {
    const rendererUid = 73_119;
    const destroyGpuData = vi.fn();
    const resource = new FakeGpuResource(rendererUid, destroyGpuData);
    const renderer = Object.create(null) as Renderer;
    Object.assign(renderer, {
      uid: rendererUid,
      gc: {
        now: 0,
        addResourceHash: vi.fn(),
      },
    });
    const resourceHash = new GCManagedHash({
      renderer,
      type: 'resource',
      name: 'lifecycle-regression',
    });

    resourceHash.add(resource);
    expect(resource.listenerCount('unload')).toBe(1);

    resourceHash.destroy();

    expect(destroyGpuData).toHaveBeenCalledOnce();
    expect(resource.listenerCount('unload')).toBe(0);
  });

  it('registers the process-wide text measurement cache for last-renderer release', () => {
    const cache: unknown = Reflect.get(CanvasTextMetrics, '_measurementCache');
    if (!isTestableCache(cache)) throw new Error('Pixi text measurement cache is unavailable');
    const key = `fixture-${crypto.randomUUID()}`;

    cache.set(key, {});
    expect(cache.has(key)).toBe(true);

    GlobalResourceRegistry.release();

    expect(cache.has(key)).toBe(false);
  });

  it('can retire text measurements while a reusable renderer stays alive', () => {
    const cache: unknown = Reflect.get(CanvasTextMetrics, '_measurementCache');
    if (!isTestableCache(cache)) throw new Error('Pixi text measurement cache is unavailable');
    if (!hasTextMetricsLifecycle(CanvasTextMetrics)) {
      throw new Error('Pixi text measurement cache lifecycle is unavailable');
    }
    const key = `fixture-retained-renderer-${crypto.randomUUID()}`;

    cache.set(key, {});
    expect(cache.has(key)).toBe(true);

    CanvasTextMetrics.clearMeasurementCache();

    expect(cache.has(key)).toBe(false);
  });

  it('releases process-wide texture batch bind groups with the last renderer', async () => {
    const moduleValue: unknown =
      await import('../../../../../node_modules/pixi.js/lib/rendering/batcher/gpu/getTextureBatchBindGroup');
    if (!isTextureBatchModule(moduleValue)) {
      throw new Error('Pixi texture batch bind-group module is unavailable');
    }

    const beforeRelease = moduleValue.getTextureBatchBindGroup([], 0, 1);
    expect(moduleValue.getTextureBatchBindGroup([], 0, 1)).toBe(beforeRelease);

    GlobalResourceRegistry.release();

    expect(moduleValue.getTextureBatchBindGroup([], 0, 1)).not.toBe(beforeRelease);
  });

  it('destroys the WebGL back-buffer shader and its texture listener', async () => {
    const moduleValue: unknown =
      await import('../../../../../node_modules/pixi.js/lib/rendering/renderers/gl/GlBackBufferSystem');
    if (!isBackBufferSystemModule(moduleValue)) {
      throw new Error('Pixi WebGL back-buffer system module is unavailable');
    }
    const whiteSource = Texture.WHITE.source;
    const baselineListeners = whiteSource.listenerCount('change');
    const system = new moduleValue.GlBackBufferSystem({
      context: { supports: { msaa: true } },
    });

    system.init({ useBackBuffer: false, antialias: false });
    expect(whiteSource.listenerCount('change')).toBe(baselineListeners + 1);

    system.destroy();

    expect(whiteSource.listenerCount('change')).toBe(baselineListeners);
  });

  it('deletes linked WebGL programs before discarding their wrappers', async () => {
    const moduleValue: unknown =
      await import('../../../../../node_modules/pixi.js/lib/rendering/renderers/gl/shader/GlShaderSystem');
    if (!isGlShaderSystemModule(moduleValue)) {
      throw new Error('Pixi WebGL shader system module is unavailable');
    }
    const nativeProgram = Object.create(null);
    const deleteProgram = vi.fn();
    const destroyProgramData = vi.fn();
    const system = new moduleValue.GlShaderSystem(Object.create(null));
    system.contextChange({ deleteProgram });
    Reflect.set(system, '_programDataHash', {
      lifecycleRegression: {
        program: nativeProgram,
        destroy: destroyProgramData,
      },
    });

    system.destroy();

    expect(deleteProgram).toHaveBeenCalledOnce();
    expect(deleteProgram).toHaveBeenCalledWith(nativeProgram);
    expect(destroyProgramData).toHaveBeenCalledOnce();
  });

  it('destroys batch geometry when its render-group instruction set is retired', async () => {
    const [batcherModuleValue, renderGroupModuleValue]: [unknown, unknown] = await Promise.all([
      import('../../../../../node_modules/pixi.js/lib/rendering/batcher/shared/BatcherPipe'),
      import('../../../../../node_modules/pixi.js/lib/scene/container/RenderGroup'),
    ]);
    if (!isBatcherPipeModule(batcherModuleValue)) {
      throw new Error('Pixi batcher pipe module is unavailable');
    }
    if (!isRenderGroupModule(renderGroupModuleValue)) {
      throw new Error('Pixi render-group module is unavailable');
    }

    const batchPipe = new batcherModuleValue.BatcherPipe(
      { limits: { maxBatchableTextures: 1 } },
      Object.create(null)
    );
    const renderGroup = new renderGroupModuleValue.RenderGroup();
    const { instructionSet } = renderGroup;
    instructionSet.renderPipes = { batch: batchPipe };
    batchPipe.buildStart(instructionSet);

    const batchersByInstructionSet: unknown = Reflect.get(batchPipe, '_batchersByInstructionSet');
    if (typeof batchersByInstructionSet !== 'object' || batchersByInstructionSet === null) {
      throw new Error('Pixi instruction-set batcher registry is unavailable');
    }
    const batchers: unknown = Reflect.get(batchersByInstructionSet, instructionSet.uid);
    if (typeof batchers !== 'object' || batchers === null) {
      throw new Error('Pixi did not allocate batchers for the render group');
    }
    const defaultBatcher: unknown = Reflect.get(batchers, 'default');
    if (!isDestructible(defaultBatcher)) {
      throw new Error('Pixi default batcher is unavailable');
    }
    const destroyBatcher = vi.spyOn(defaultBatcher, 'destroy');

    renderGroup.destroy();

    expect(destroyBatcher).toHaveBeenCalledOnce();
    expect(Reflect.get(batchersByInstructionSet, instructionSet.uid)).toBeUndefined();
  });
});
