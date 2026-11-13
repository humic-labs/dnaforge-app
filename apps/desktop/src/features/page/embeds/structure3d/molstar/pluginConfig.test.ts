import { describe, expect, it, vi } from 'vitest';
import { Binding } from 'molstar/lib/mol-util/binding';
import { ButtonsType, ModifiersKeys } from 'molstar/lib/mol-util/input/input-observer';
import {
  buildInitialCanvas3dProps,
  configureCanvas3dZoomBindings,
  createPluginSpec,
  setPluginSpin,
} from './pluginConfig';
import type { MolstarPlugin } from './cache';

vi.mock('molstar/lib/mol-plugin/spec', () => ({
  PluginSpec: { Behavior: (transformer: unknown) => ({ transformer }) },
  DefaultPluginSpec: () => ({
    behaviors: [],
    canvas3d: {},
    config: [],
  }),
}));
vi.mock('molstar/lib/extensions/mvs/behavior', () => ({ MolViewSpec: { id: 'molviewspec' } }));

vi.mock('molstar/lib/mol-plugin/config', () => ({
  PluginConfig: {
    General: {
      DisablePreserveDrawingBuffer: {
        key: 'plugin-config.disable-preserve-drawing-buffer',
      },

      AllowMajorPerformanceCaveat: {
        key: 'plugin-config.allow-major-performance-caveat',
      },
    },
  },
}));

function fakePlugin(): MolstarPlugin {
  return {
    canvas3d: {
      props: {
        trackball: {
          zoomSpeed: 2,
          animate: { name: 'off', params: {} },
        },
      },
      animate: vi.fn(),
      setProps: vi.fn(),
      setAttribs: vi.fn(),
    },
  } as unknown as MolstarPlugin;
}

describe('setPluginSpin', () => {
  it('passes a complete Molstar spin animation config and restarts animation', () => {
    const plugin = fakePlugin();

    setPluginSpin(plugin, true);

    expect(plugin.canvas3d?.setProps).toHaveBeenCalledWith({
      trackball: expect.objectContaining({
        zoomSpeed: 2,
        animate: {
          name: 'spin',
          params: {
            speed: expect.any(Number),
            axis: [0, -1, 0],
          },
        },
      }),
    });
    expect(plugin.canvas3d?.animate).toHaveBeenCalled();
  });
});

describe('buildInitialCanvas3dProps', () => {
  it('preserves MolStar default antialiasing while disabling cartoon outlines', () => {
    const props = buildInitialCanvas3dProps({
      renderer: { existingRenderer: true },
      marking: { selectEdgeStrength: 1, highlightEdgeStrength: 1 },
      postprocessing: { antialiasing: { name: 'smaa', params: {} } },
      trackball: { animate: { name: 'off', params: {} } },
    });

    expect(props).toMatchObject({
      renderer: {
        existingRenderer: true,
        selectStrength: 0,
      },
      marking: {
        selectEdgeStrength: 1,
        highlightEdgeStrength: 1,
        selectInnerEdgeStrength: 0,
      },
      postprocessing: {
        antialiasing: { name: 'smaa', params: {} },
        occlusion: { name: 'off', params: {} },
        outline: { name: 'off', params: {} },
      },
      trackball: {
        animate: { name: 'off', params: {} },
        zoomSpeed: 2,
      },
    });
  });

  it('binds native wheel zoom in trackball attributes, including held Option and Control', () => {
    const plugin = fakePlugin();
    configureCanvas3dZoomBindings(plugin);
    const attribs = vi.mocked(plugin.canvas3d!.setAttribs).mock.calls[0][0];
    const binding = attribs.trackball?.bindings?.scrollZoom;
    expect(binding).toBeDefined();
    const wheel = ButtonsType.Flag.Auxilary;
    expect(Binding.match(binding!, wheel, ModifiersKeys.create())).toBe(true);
    expect(Binding.match(binding!, wheel, ModifiersKeys.create({ alt: true }))).toBe(true);
    expect(Binding.match(binding!, wheel, ModifiersKeys.create({ control: true }))).toBe(true);
  });

  it('pans the camera with Option plus primary drag', () => {
    const plugin = fakePlugin();
    configureCanvas3dZoomBindings(plugin);
    const attribs = vi.mocked(plugin.canvas3d!.setAttribs).mock.calls[0][0];
    const pan = attribs.trackball?.bindings?.dragPan;
    expect(pan).toBeDefined();
    expect(Binding.match(pan!, ButtonsType.Flag.Primary, ModifiersKeys.create({ alt: true }))).toBe(
      true
    );
  });
});

describe('createPluginSpec', () => {
  it('does not preserve the default framebuffer and leaves transparency at MolStar defaults', async () => {
    const spec = await createPluginSpec();
    const preserveDrawingBufferConfig = spec.config?.find(
      ([item]) => item.key === 'plugin-config.disable-preserve-drawing-buffer'
    );
    const transparencyConfig = spec.config?.find(
      ([item]) => item.key === 'plugin-config.transparency'
    );

    expect(preserveDrawingBufferConfig?.[1]).toBe(true);
    expect(transparencyConfig).toBeUndefined();
  });
});
