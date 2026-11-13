import { describe, expect, it } from 'vitest';
import { RendererType, type Renderer } from 'pixi.js';
import { setRenderer, type OverlayLifecycleHost } from './indexed-annotation-lifecycle';

function fakeRenderer(type: RendererType): Renderer {
  return { type } as Renderer;
}

function lifecycleHost(
  overrides: Partial<
    Pick<
      OverlayLifecycleHost,
      'pixiRenderer' | 'prepackedAnnotationSceneResidents' | 'disposePrepackedAnnotationScene'
    >
  > = {}
): OverlayLifecycleHost {
  return {
    pixiRenderer: null,
    prepackedAnnotationSceneResidents: new Map(),
    disposePrepackedAnnotationScene() {},
    ...overrides,
  } as OverlayLifecycleHost;
}

describe('indexed annotation lifecycle', () => {
  it('is a no-op when the same renderer is already attached', () => {
    const webgl = fakeRenderer(RendererType.WEBGL);
    const disposed: string[] = [];
    const host = lifecycleHost({
      pixiRenderer: webgl,
      prepackedAnnotationSceneResidents: new Map([['mRNA', {}]]),
      disposePrepackedAnnotationScene(status) {
        disposed.push(status);
      },
    });
    setRenderer(host, webgl);
    expect(host.pixiRenderer).toBe(webgl);
    expect(disposed).toEqual([]);
  });

  it('disposes prepacked residents when switching away from WebGL', () => {
    const disposed: string[] = [];
    const host = lifecycleHost({
      pixiRenderer: fakeRenderer(RendererType.WEBGL),
      prepackedAnnotationSceneResidents: new Map([['mRNA', {}]]),
      disposePrepackedAnnotationScene(status) {
        disposed.push(status);
      },
    });
    const canvas = fakeRenderer(RendererType.CANVAS);
    setRenderer(host, canvas);
    expect(host.pixiRenderer).toBe(canvas);
    expect(disposed).toEqual(['unsupported-renderer']);
  });
});
