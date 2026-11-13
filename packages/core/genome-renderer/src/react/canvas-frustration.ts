import type { WebGLHitTarget } from '../renderers/pixi/shared/hit-targets';

export type CanvasFrustration = {
  component: `sequence-viewer.${WebGLHitTarget['kind']}`;
  action: 'click';
};

function regionKey(hit: WebGLHitTarget): string {
  const payload = hit.payload;
  switch (hit.kind) {
    case 'feature':
      return JSON.stringify([hit.kind, hit.payload.canonicalIdentity ?? hit.payload.id]);
    case 'primer-handle':
      return JSON.stringify([hit.kind, hit.payload.primerId, hit.payload.anchorBp]);
    case 'backbone-boundary-handle':
      return JSON.stringify([hit.kind, hit.payload.regionId, hit.payload.side]);
    case 'backbone-part':
      return JSON.stringify([hit.kind, hit.payload.regionId]);
    case 'cut-site':
      return JSON.stringify([hit.kind, hit.payload.id]);
    case 'read':
      return JSON.stringify([
        hit.kind,
        hit.payload.trackId,
        hit.payload.sourceGenerationKey,
        hit.payload.readId,
      ]);
    case 'pileup-column':
      return JSON.stringify([hit.kind, hit.payload.chrom, hit.payload.globalPosition]);
    default:
      return JSON.stringify([
        hit.kind,
        'start' in payload && payload.start,
        'end' in payload && payload.end,
        'strand' in payload && payload.strand,
      ]);
  }
}

export function createCanvasFrustrationDetector() {
  let region: string | null = null;
  let times: number[] = [];
  let reported = false;
  return (hit: WebGLHitTarget | null, now: number): CanvasFrustration | null => {
    const nextRegion = hit ? regionKey(hit) : null;
    if (
      !hit ||
      nextRegion !== region ||
      now - (times.at(-1) ?? -Infinity) > 1000 ||
      now < (times.at(-1) ?? now)
    ) {
      region = nextRegion;
      times = [];
      reported = false;
    }
    if (!hit || !Number.isFinite(now)) return null;
    times = times.filter((time) => now - time <= 1000);
    times.push(now);
    times = times.slice(-3);
    if (times.length < 3 || reported) return null;
    reported = true;
    times = [now];
    return { component: `sequence-viewer.${hit.kind}`, action: 'click' };
  };
}
