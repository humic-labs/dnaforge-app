type MolstarFrameKickPlugin = {
  handleResize?: () => void;
  canvas3d?: unknown;
  animationLoop?: {
    stop: (options?: { noDraw?: boolean }) => void;
    start: (options?: { immediate?: boolean }) => void;
  };
};

type MolstarCanvas3dKicks = {
  handleResize?: () => void;
  requestDraw?: () => void;
  commit?: (force?: boolean) => void;
  animate?: () => void;
  tick?: (time: number, options: { isSynchronous: boolean }) => void;
};

function canvas3dKicks(
  plugin: MolstarFrameKickPlugin | null | undefined
): MolstarCanvas3dKicks | null {
  const canvas3d = plugin?.canvas3d;
  if (!canvas3d || typeof canvas3d !== 'object') return null;
  return canvas3d as MolstarCanvas3dKicks;
}

function requestMolstarFrame(plugin: MolstarFrameKickPlugin | null | undefined): void {
  const canvas3d = canvas3dKicks(plugin);
  if (!canvas3d) return;
  try {
    canvas3d.handleResize?.();
    canvas3d.requestDraw?.();
    canvas3d.commit?.(true);
    canvas3d.animate?.();
  } catch {}
}

export function resizeMolstarViewer(plugin: MolstarFrameKickPlugin): void {
  const canvas3d = canvas3dKicks(plugin);
  if (!canvas3d) return;
  plugin.handleResize?.();
  canvas3d.handleResize?.();
  canvas3d.requestDraw?.();
  canvas3d.tick?.(performance.now(), { isSynchronous: true });
}

export function restartMolstarPaneAnimationLoop(
  plugin: MolstarFrameKickPlugin | null | undefined
): void {
  const loop = plugin?.animationLoop;
  if (!loop) return;
  loop.stop({ noDraw: true });
  loop.start({ immediate: true });
}

const POST_REVEAL_FRAME_KICK_DELAYS_MS = [50, 150, 350, 750, 1250, 2000, 3500] as const;

const POST_VISIBILITY_RESUME_KICK_DELAYS_MS = [50, 150] as const;

export type MolstarFrameKickMode = 'reveal' | 'visibility-resume';

export function scheduleMolstarFrameKicks(
  plugin: MolstarFrameKickPlugin | null | undefined,
  options: {
    isCurrent?: () => boolean;
    mode?: MolstarFrameKickMode;
    requestAnimationFrame?: (callback: FrameRequestCallback) => number;
    setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimeout?: (timeoutId: ReturnType<typeof setTimeout>) => void;
  } = {}
): () => void {
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const raf =
    options.requestAnimationFrame ??
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
  const timers: ReturnType<typeof setTimeout>[] = [];
  let cancelled = false;
  const delays =
    options.mode === 'visibility-resume'
      ? POST_VISIBILITY_RESUME_KICK_DELAYS_MS
      : POST_REVEAL_FRAME_KICK_DELAYS_MS;

  const kick = () => {
    if (cancelled) return;
    if (options.isCurrent && !options.isCurrent()) return;
    requestMolstarFrame(plugin);
  };

  kick();
  raf?.(() => kick());
  for (const delay of delays) {
    timers.push(setTimer(kick, delay));
  }

  return () => {
    cancelled = true;
    for (const timer of timers) clearTimer(timer);
  };
}

export { requestMolstarFrame };
