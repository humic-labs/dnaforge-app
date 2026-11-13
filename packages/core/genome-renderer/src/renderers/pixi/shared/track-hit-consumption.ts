const CONSUMED = Symbol.for('waypoint.trackHitConsumed');

type Markable = object & { [CONSUMED]?: boolean };

export function markTrackHitConsumed(event: unknown): void {
  if (event && typeof event === 'object') (event as Markable)[CONSUMED] = true;
}

export function isTrackHitConsumed(event: unknown): boolean {
  return Boolean(event && typeof event === 'object' && (event as Markable)[CONSUMED]);
}
