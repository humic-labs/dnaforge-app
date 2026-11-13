import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  findReusablePrepackedSamePacketResident,
  isIdempotentPrepackedSceneLoad,
} from './indexed-prepacked-reuse';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

const lease = {
  packetPayloadSha256: 'pkt',
  sourceFingerprint: 'src',
  interactionPayloadSha256: 'ix',
  coverageStartBp: 0,
  coverageEndBp: 100,
  handoffStartBp: 0,
  handoffEndBp: 50,
  empty: false,
};

describe('prepacked scene reuse', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function isIdempotentPrepackedSceneLoad');
    expect(source).not.toContain('function findReusablePrepackedSamePacketResident');
  });

  it('treats the same object identity or the same viewport-detail lease as already loaded', () => {
    const input = { ownerKey: 'a' };
    expect(
      isIdempotentPrepackedSceneLoad({
        existing: { sourceInput: input, input, viewportDetail: lease },
        nextInput: input,
        nextViewportDetail: lease,
      })
    ).toBe(true);
    expect(
      isIdempotentPrepackedSceneLoad({
        existing: { sourceInput: {}, input: {}, viewportDetail: lease },
        nextInput: { ownerKey: 'b' },
        nextViewportDetail: { ...lease },
      })
    ).toBe(true);
    expect(
      isIdempotentPrepackedSceneLoad({
        existing: { sourceInput: {}, input: {}, viewportDetail: lease },
        nextInput: { ownerKey: 'b' },
        nextViewportDetail: { ...lease, packetPayloadSha256: 'other' },
      })
    ).toBe(false);
  });

  it('reuses a hidden resident with the same packet bytes, never a presenting one', () => {
    const hidden = {
      input: { viewportDetail: { packetPayloadSha256: 'pkt' } },
      layer: { isPresenting: false },
    };
    const presenting = {
      input: { viewportDetail: { packetPayloadSha256: 'pkt' } },
      layer: { isPresenting: true },
    };
    expect(
      findReusablePrepackedSamePacketResident({
        packetPayloadSha256: 'pkt',
        candidates: [presenting, hidden],
      })
    ).toBe(hidden);
    expect(
      findReusablePrepackedSamePacketResident({
        packetPayloadSha256: null,
        candidates: [hidden],
      })
    ).toBeNull();
    expect(
      findReusablePrepackedSamePacketResident({
        packetPayloadSha256: 'pkt',
        candidates: [hidden],
        excludedCandidate: hidden,
      })
    ).toBeNull();
  });
});
