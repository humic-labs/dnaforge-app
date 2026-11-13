import type { MolstarPlugin } from './cache';

export const STRUCTURE_FIRST_PAINT_HARD_CEILING_MS = 10_000;
export const STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE =
  '3D structure renderer did not become interactive. Retry or choose another structure.';
export const STRUCTURE_INTERACTION_SETTLE_HARD_CEILING_MS = 30_000;
export const STRUCTURE_INTERACTION_SETTLE_TIMEOUT_MESSAGE =
  '3D structure renderer did not finish preparing interactions. Retry or choose another structure.';

export type CanvasPaintState = {
  painted: boolean;
  reason: string;
  uniqueColors?: number;
  nonWhitePixels?: number;
  width?: number;
  height?: number;
};

export type FirstPaintReadiness = {
  resolution: 'sampled-pixels' | 'molstar-draw-signal';
  elapsedMs: number;
  attempts: number;
  structureCount: number;
  representationCount: number;
  drawEvents: number;
  canvasRepresentationCount: number;
  paintState?: CanvasPaintState;
};

type PaintableCanvas3D = {
  handleResize?: () => void;
  requestDraw?: () => void;
  commit?: (isSynchronous?: boolean) => void;
  animate?: () => void;
  didDraw?: {
    subscribe?: (listener: () => void) => { unsubscribe?: () => void };
  };
  reprCount?: { value?: number };
};

export async function waitForDimensions(
  container: HTMLDivElement,
  canvas: HTMLCanvasElement,
  fallbackHeight: number,
  checkTimeout: () => void
): Promise<void> {
  let hasDimensions = false;
  for (let i = 0; i < 200; i++) {
    checkTimeout();
    const cw = container.offsetWidth || 0;
    const ch = container.offsetHeight || 0;
    if (cw > 0 && ch > 0) {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      hasDimensions = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!hasDimensions) {
    canvas.width = 600;
    canvas.height = fallbackHeight;
  }
}

function readCanvasPaintState(canvas: HTMLCanvasElement): CanvasPaintState {
  const gl = (canvas.getContext('webgl2') ||
    canvas.getContext('webgl') ||
    canvas.getContext('experimental-webgl')) as
    | WebGLRenderingContext
    | WebGL2RenderingContext
    | null;
  if (!gl) return { painted: false, reason: 'no_webgl_context_available_to_probe' };

  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  if (width < 40 || height < 40) {
    return { painted: false, reason: 'drawing_buffer_too_small', width, height };
  }

  const pixels = new Uint8Array(4);
  const unique = new Set<string>();
  let nonWhitePixels = 0;
  for (let yi = 1; yi <= 15; yi += 1) {
    for (let xi = 1; xi <= 15; xi += 1) {
      const x = Math.max(0, Math.min(width - 1, Math.floor((width * xi) / 16)));
      const y = Math.max(0, Math.min(height - 1, Math.floor((height * yi) / 16)));
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      unique.add(`${pixels[0]},${pixels[1]},${pixels[2]},${pixels[3]}`);
      if (pixels[3] > 0 && (pixels[0] < 245 || pixels[1] < 245 || pixels[2] < 245)) {
        nonWhitePixels += 1;
      }
    }
  }

  const painted = nonWhitePixels >= 1 && unique.size >= 2;
  return {
    painted,
    reason: painted ? 'painted' : 'blank',
    uniqueColors: unique.size,
    nonWhitePixels,
    width,
    height,
  };
}

function readPluginContentReadiness(plugin: MolstarPlugin): {
  structureCount: number;
  representationCount: number;
} {
  const structures = plugin.managers?.structure?.hierarchy?.current?.structures ?? [];
  const representationCount = structures.reduce((sum: number, structure: unknown) => {
    const components = (structure as { components?: unknown[] })?.components ?? [];
    return (
      sum +
      components.reduce((componentSum: number, component: unknown) => {
        const representations =
          (component as { representations?: unknown[] })?.representations ?? [];
        return componentSum + representations.length;
      }, 0)
    );
  }, 0);
  return { structureCount: structures.length, representationCount };
}

export type InteractionReadiness = {
  elapsedMs: number;
  attempts: number;
  structureCount: number;
  representationCount: number;
  canvasRepresentationCount: number;
};

export async function waitForPluginInteractionReady(
  plugin: MolstarPlugin,
  options: {
    hardCeilingMs?: number;
    stableMs?: number;
    pollMs?: number;
    includeCamera?: boolean;
    isCurrent?: () => boolean;
  } = {}
): Promise<InteractionReadiness | null> {
  const hardCeilingMs = options.hardCeilingMs ?? STRUCTURE_INTERACTION_SETTLE_HARD_CEILING_MS;
  const stableMs = options.stableMs ?? 100;
  const pollMs = options.pollMs ?? 25;
  const startedAt = Date.now();
  let attempts = 0;
  let stableSince: number | null = null;
  let stableSignature: string | null = null;

  for (;;) {
    if (options.isCurrent?.() === false) return null;
    attempts += 1;
    const now = Date.now();
    const content = readPluginContentReadiness(plugin);
    const canvasRepresentationCount =
      (plugin.canvas3d as { reprCount?: { value?: number } } | undefined)?.reprCount?.value ?? 0;
    const isUpdating = plugin.behaviors?.state?.isUpdating?.value === true;
    const camera = options.includeCamera ? plugin.canvas3d?.camera : undefined;
    const isBusy = plugin.isBusy === true || isUpdating || camera?.transition.inTransition === true;
    const signature = `${content.structureCount}:${content.representationCount}:${canvasRepresentationCount}:${camera ? JSON.stringify(camera.getSnapshot()) : ''}`;

    if (!isBusy && signature === stableSignature) {
      stableSince ??= now;
      if (now - stableSince >= stableMs) {
        return {
          elapsedMs: now - startedAt,
          attempts,
          ...content,
          canvasRepresentationCount,
        };
      }
    } else {
      stableSignature = signature;
      stableSince = isBusy ? null : now;
    }

    if (now - startedAt >= hardCeilingMs) {
      throw new Error(STRUCTURE_INTERACTION_SETTLE_TIMEOUT_MESSAGE);
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, pollMs));
  }
}

export async function waitForFirstPaintBeforeReveal(
  plugin: MolstarPlugin,
  canvas: HTMLCanvasElement,
  checkTimeout: () => void
): Promise<FirstPaintReadiness> {
  const canvas3d = plugin.canvas3d as PaintableCanvas3D | undefined;
  if (!canvas3d) {
    throw new Error(STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE);
  }

  const startedAt = Date.now();
  let attempts = 0;
  let drawEvents = 0;
  const drawSubscription = canvas3d.didDraw?.subscribe?.(() => {
    drawEvents += 1;
  });
  const initialDrawEvents = drawEvents;
  let lastState = readCanvasPaintState(canvas);
  try {
    for (;;) {
      checkTimeout();
      attempts += 1;
      canvas3d.handleResize?.();
      canvas3d.requestDraw?.();
      canvas3d.commit?.(true);
      canvas3d.animate?.();

      await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 16);
        }
      });

      lastState = readCanvasPaintState(canvas);
      const elapsedMs = Date.now() - startedAt;
      const content = readPluginContentReadiness(plugin);
      const canvasRepresentationCount = canvas3d.reprCount?.value ?? 0;
      const readinessBase = {
        elapsedMs,
        attempts,
        ...content,
        drawEvents: Math.max(0, drawEvents - initialDrawEvents),
        canvasRepresentationCount,
        paintState: lastState,
      };
      if (lastState.painted && content.structureCount > 0 && content.representationCount > 0) {
        return { resolution: 'sampled-pixels', ...readinessBase };
      }
      if (drawEvents > initialDrawEvents && canvasRepresentationCount > 0) {
        return { resolution: 'molstar-draw-signal', ...readinessBase };
      }
      if (elapsedMs >= STRUCTURE_FIRST_PAINT_HARD_CEILING_MS) {
        throw new Error(STRUCTURE_FIRST_PAINT_TIMEOUT_MESSAGE);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    drawSubscription?.unsubscribe?.();
  }
}
