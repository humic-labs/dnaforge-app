import type {
  Genome,
  PixiLinearRenderer,
  PixiStadiumRenderer,
  RenderState,
} from '@waypoint/genome-renderer';
import { ensureWebGLFrameProbeApi, type WebGLFrameProbeWindow } from './webgl-frame-probe';

type WebGLMapProduct = 'sequence' | 'indexed';

type WebGLTestHooksWindow = WebGLFrameProbeWindow & {
  __webglExposeForTests?: boolean;
  __webglRenderer?: PixiStadiumRenderer | PixiLinearRenderer;
  __webglRendererByProduct?: Partial<
    Record<WebGLMapProduct, PixiStadiumRenderer | PixiLinearRenderer>
  >;
  __webglState?: RenderState;
  __webglGenome?: Genome;
  __webglSetZoom?: (zoom: number) => void;
  __webglSetViewOffset?: (viewOffset: number) => void;
  __webglSetMorph?: (morph: number) => void;
  __webglRequestRender?: () => void;
  __webglRenderNowForTests?: () => void;
  __webglReady?: boolean;
};

export function exposeWebGLTestHooks(params: {
  renderer: PixiStadiumRenderer | PixiLinearRenderer;
  state: RenderState;
  genome: Genome;
  renderNow: () => void;
  product?: WebGLMapProduct;
  requestRender?: () => void;
}): void {
  const testHooks = typeof window !== 'undefined' ? (window as WebGLTestHooksWindow) : null;
  if (!testHooks?.__webglExposeForTests) return;
  ensureWebGLFrameProbeApi();

  testHooks.__webglRenderer = params.renderer;
  if (params.product) {
    testHooks.__webglRendererByProduct = {
      ...testHooks.__webglRendererByProduct,
      [params.product]: params.renderer,
    };
  }
  testHooks.__webglState = params.state;
  testHooks.__webglGenome = params.genome;
  testHooks.__webglSetZoom = (z: number) => {
    params.state.zoom = z;
  };
  testHooks.__webglSetViewOffset = (o: number) => {
    params.state.viewOffset = ((o % 1) + 1) % 1;
  };
  testHooks.__webglSetMorph = (m: number) => {
    params.state.morph = Math.max(0, Math.min(1, m));
  };
  testHooks.__webglRequestRender = params.requestRender;
  testHooks.__webglRenderNowForTests = params.renderNow;
  testHooks.__webglReady = true;
}

export function updateWebGLTestHookGenome(
  renderer: PixiStadiumRenderer | PixiLinearRenderer,
  genome: Genome
): void {
  const testHooks = typeof window !== 'undefined' ? (window as WebGLTestHooksWindow) : null;
  if (!testHooks?.__webglExposeForTests || testHooks.__webglRenderer !== renderer) return;
  testHooks.__webglGenome = genome;
}

export function clearWebGLTestHooks(renderer: PixiStadiumRenderer | PixiLinearRenderer): void {
  const testHooks = typeof window !== 'undefined' ? (window as WebGLTestHooksWindow) : null;
  if (!testHooks?.__webglExposeForTests) return;
  if (testHooks.__webglRendererByProduct) {
    for (const [product, owned] of Object.entries(testHooks.__webglRendererByProduct)) {
      if (owned === renderer) {
        delete testHooks.__webglRendererByProduct[product as 'sequence' | 'indexed'];
      }
    }
    if (Object.keys(testHooks.__webglRendererByProduct).length === 0) {
      delete testHooks.__webglRendererByProduct;
    }
  }
  if (testHooks.__webglRenderer !== renderer) return;
  delete testHooks.__webglRenderer;
  delete testHooks.__webglState;
  delete testHooks.__webglGenome;
  delete testHooks.__webglSetZoom;
  delete testHooks.__webglSetViewOffset;
  delete testHooks.__webglSetMorph;
  delete testHooks.__webglRequestRender;
  delete testHooks.__webglRenderNowForTests;
  delete testHooks.__webglReady;
}
