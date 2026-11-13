type Phase = 'before-handler' | 'after-handler';
let barrier:
  | { phase: Phase; actionId?: string; hit: boolean; wait: Promise<void>; release(): void }
  | undefined;

export function armRendererOperationBarrier(phase: Phase): void {
  if (barrier) throw new Error('Renderer operation barrier is already armed.');
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  barrier = { phase, hit: false, wait, release };
}
export function rendererOperationBarrierState() {
  return barrier ? { phase: barrier.phase, actionId: barrier.actionId, hit: barrier.hit } : null;
}
export function releaseRendererOperationBarrier(): void {
  barrier?.release();
  barrier = undefined;
}
export async function waitAtRendererOperationBarrier(
  phase: Phase,
  actionId: string
): Promise<void> {
  const current = barrier;
  if (!current || current.phase !== phase || current.hit) return;
  current.hit = true;
  current.actionId = actionId;
  await current.wait;
}
