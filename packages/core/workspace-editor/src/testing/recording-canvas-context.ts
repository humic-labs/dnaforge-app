export type CanvasOp =
  | { op: 'fillRect'; x: number; y: number; w: number; h: number }
  | { op: 'strokeRect'; x: number; y: number; w: number; h: number }
  | { op: 'clearRect'; x: number; y: number; w: number; h: number }
  | { op: 'fillText'; text: string; x: number; y: number; maxWidth?: number }
  | { op: 'strokeText'; text: string; x: number; y: number; maxWidth?: number }
  | { op: 'beginPath' }
  | { op: 'closePath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'arc'; x: number; y: number; r: number; startAngle: number; endAngle: number }
  | { op: 'rect'; x: number; y: number; w: number; h: number }
  | { op: 'stroke' }
  | { op: 'fill'; rule?: CanvasFillRule }
  | { op: 'setLineDash'; segments: number[] }
  | { op: 'save' }
  | { op: 'restore' }
  | { op: 'translate'; x: number; y: number }
  | { op: 'scale'; x: number; y: number }
  | { op: 'rotate'; angle: number }
  | { op: 'setTransform'; a: number; b: number; c: number; d: number; e: number; f: number }
  | { op: 'resetTransform' }
  | { op: 'set'; prop: string; value: unknown };

const recordingLogs = new WeakMap<HTMLCanvasElement, CanvasOp[]>();
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext | null = null;

export function getRecordingLog(canvas: HTMLCanvasElement): CanvasOp[] {
  return recordingLogs.get(canvas) ?? [];
}

export function countOp<T extends CanvasOp['op']>(log: CanvasOp[], op: T): number {
  return log.filter((e) => e.op === op).length;
}

export function opsOf<T extends CanvasOp['op']>(
  log: CanvasOp[],
  op: T
): Array<Extract<CanvasOp, { op: T }>> {
  return log.filter((e): e is Extract<CanvasOp, { op: T }> => e.op === op);
}

function createRecordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const log: CanvasOp[] = [];
  recordingLogs.set(canvas, log);

  const push = (e: CanvasOp) => log.push(e);

  const target = {
    canvas,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
  };

  const methodImpls: Record<string, (...args: unknown[]) => unknown> = {
    fillRect: (...a: unknown[]) => {
      push({
        op: 'fillRect',
        x: a[0] as number,
        y: a[1] as number,
        w: a[2] as number,
        h: a[3] as number,
      });
    },
    strokeRect: (...a: unknown[]) => {
      push({
        op: 'strokeRect',
        x: a[0] as number,
        y: a[1] as number,
        w: a[2] as number,
        h: a[3] as number,
      });
    },
    clearRect: (...a: unknown[]) => {
      push({
        op: 'clearRect',
        x: a[0] as number,
        y: a[1] as number,
        w: a[2] as number,
        h: a[3] as number,
      });
    },
    fillText: (...a: unknown[]) => {
      push({
        op: 'fillText',
        text: String(a[0]),
        x: a[1] as number,
        y: a[2] as number,
        maxWidth: a[3] as number | undefined,
      });
    },
    strokeText: (...a: unknown[]) => {
      push({
        op: 'strokeText',
        text: String(a[0]),
        x: a[1] as number,
        y: a[2] as number,
        maxWidth: a[3] as number | undefined,
      });
    },
    beginPath: () => push({ op: 'beginPath' }),
    closePath: () => push({ op: 'closePath' }),
    moveTo: (...a: unknown[]) => push({ op: 'moveTo', x: a[0] as number, y: a[1] as number }),
    lineTo: (...a: unknown[]) => push({ op: 'lineTo', x: a[0] as number, y: a[1] as number }),
    arc: (...a: unknown[]) =>
      push({
        op: 'arc',
        x: a[0] as number,
        y: a[1] as number,
        r: a[2] as number,
        startAngle: a[3] as number,
        endAngle: a[4] as number,
      }),
    rect: (...a: unknown[]) =>
      push({
        op: 'rect',
        x: a[0] as number,
        y: a[1] as number,
        w: a[2] as number,
        h: a[3] as number,
      }),
    roundRect: (...a: unknown[]) =>
      push({
        op: 'rect',
        x: a[0] as number,
        y: a[1] as number,
        w: a[2] as number,
        h: a[3] as number,
      }),
    stroke: () => push({ op: 'stroke' }),
    fill: (...a: unknown[]) => push({ op: 'fill', rule: a[0] as CanvasFillRule | undefined }),
    setLineDash: (...a: unknown[]) => {
      const segments = (a[0] as number[] | undefined) ?? [];
      push({ op: 'setLineDash', segments: [...segments] });
    },
    getLineDash: () => [],
    save: () => push({ op: 'save' }),
    restore: () => push({ op: 'restore' }),
    translate: (...a: unknown[]) => push({ op: 'translate', x: a[0] as number, y: a[1] as number }),
    scale: (...a: unknown[]) => push({ op: 'scale', x: a[0] as number, y: a[1] as number }),
    rotate: (...a: unknown[]) => push({ op: 'rotate', angle: a[0] as number }),
    setTransform: (...a: unknown[]) =>
      push({
        op: 'setTransform',
        a: a[0] as number,
        b: a[1] as number,
        c: a[2] as number,
        d: a[3] as number,
        e: a[4] as number,
        f: a[5] as number,
      }),
    resetTransform: () => push({ op: 'resetTransform' }),
    measureText: (text: unknown) => ({ width: String(text).length * 6 }),
    getImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
    putImageData: () => undefined,
    drawImage: () => undefined,
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => null,
    clip: () => undefined,
    quadraticCurveTo: () => undefined,
    bezierCurveTo: () => undefined,
    ellipse: () => undefined,
    arcTo: () => undefined,
    isPointInPath: () => false,
    isPointInStroke: () => false,
  };

  const handler: ProxyHandler<typeof target> = {
    get(t, prop, receiver) {
      if (typeof prop === 'string' && prop in methodImpls) {
        return methodImpls[prop];
      }
      return Reflect.get(t, prop, receiver);
    },
    set(t, prop, value, receiver) {
      if (typeof prop === 'string' && !(prop in methodImpls)) {
        push({ op: 'set', prop, value });
      }
      return Reflect.set(t, prop, value, receiver);
    },
  };

  return new Proxy(target, handler) as CanvasRenderingContext2D;
}

export function installRecordingCanvas(): void {
  uninstallRecordingCanvas();
  originalGetContext = HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.getContext = function patched(
    this: HTMLCanvasElement,
    type: string,
    options?: unknown
  ): CanvasRenderingContext2D | null {
    if (type === '2d') {
      const existing = recordingLogs.get(this);
      if (existing) {
        existing.length = 0;
      }
      return createRecordingContext(this);
    }
    return Reflect.apply(
      originalGetContext!,
      this,
      options === undefined ? [type] : [type, options]
    ) as CanvasRenderingContext2D | null;
  } as typeof HTMLCanvasElement.prototype.getContext;
}

export function uninstallRecordingCanvas(): void {
  if (originalGetContext) {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    originalGetContext = null;
  }
}
