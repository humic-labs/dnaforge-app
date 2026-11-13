import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1 } from '../overview/prepacked-annotation-scene';
import {
  inspectPrepackedViewportDetailPacket,
  selectAdmissiblePrepackedViewportDetailRoster,
} from './indexed-prepacked-viewport-detail';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function resident(overrides: {
  ownerKey: string;
  coverageStartBp?: number;
  coverageEndBp?: number;
  fine?: boolean;
  coarse?: boolean;
  missingDetail?: boolean;
}) {
  return {
    ownerKey: overrides.ownerKey,
    input: {
      viewportDetail: overrides.missingDetail
        ? undefined
        : {
            coverageStartBp: overrides.coverageStartBp ?? 0,
            coverageEndBp: overrides.coverageEndBp ?? 1_000,
          },
    },
    layer: {
      areFineViewsPrewarmed: () => overrides.fine ?? true,
      isCoarseFallbackPrepared: overrides.coarse ?? true,
    },
  };
}

describe('selectAdmissiblePrepackedViewportDetailRoster', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function selectAdmissiblePrepackedViewportDetailRoster');
    expect(source).not.toContain('function inspectPrepackedViewportDetailPacket');
  });

  it('rejects an empty camera or an incomplete selected roster', () => {
    expect(
      selectAdmissiblePrepackedViewportDetailRoster({
        viewportStartBp: 100,
        viewportEndBp: 100,
        genomeLengthBp: 1_000,
        roster: [resident({ ownerKey: 'a' })],
      })
    ).toBeNull();
    expect(
      selectAdmissiblePrepackedViewportDetailRoster({
        viewportStartBp: 0,
        viewportEndBp: 100,
        genomeLengthBp: 1_000,
        roster: [resident({ ownerKey: 'a' }), undefined],
      })
    ).toBeNull();
  });

  it('rejects a resident whose packet does not cover the camera or is not prewarmed', () => {
    expect(
      selectAdmissiblePrepackedViewportDetailRoster({
        viewportStartBp: 0,
        viewportEndBp: 200,
        genomeLengthBp: 1_000,
        roster: [resident({ ownerKey: 'short', coverageEndBp: 150 })],
      })
    ).toBeNull();
    expect(
      selectAdmissiblePrepackedViewportDetailRoster({
        viewportStartBp: 0,
        viewportEndBp: 200,
        genomeLengthBp: 1_000,
        roster: [resident({ ownerKey: 'cold', fine: false })],
      })
    ).toBeNull();
    expect(
      selectAdmissiblePrepackedViewportDetailRoster({
        viewportStartBp: 0,
        viewportEndBp: 200,
        genomeLengthBp: 1_000,
        roster: [resident({ ownerKey: 'coarse', coarse: false })],
      })
    ).toBeNull();
  });

  it('returns the clamped camera and complete roster when every resident is ready', () => {
    const ready = resident({ ownerKey: 'ready', coverageStartBp: 0, coverageEndBp: 400 });
    expect(
      selectAdmissiblePrepackedViewportDetailRoster({
        viewportStartBp: -4.2,
        viewportEndBp: 199.1,
        genomeLengthBp: 1_000,
        roster: [ready],
      })
    ).toEqual({
      startBp: 0,
      endBp: 200,
      residents: [ready],
    });
  });
});

const SHA24 = 'ab'.repeat(12);
const SHA64 = 'cd'.repeat(32);

function packet(overrides: Record<string, unknown> = {}) {
  return {
    contract: PREPACKED_ANNOTATION_VIEWPORT_DETAIL_V1,
    packetPayloadSha256: SHA64,
    sourceFingerprint: SHA24,
    interactionPayloadSha256: SHA64,
    sourceScene: {
      byteLength: 64,
      payloadSha256: SHA64,
      contractSha256: SHA64,
    },
    empty: false,
    coverageStartBp: 0,
    coverageEndBp: 400,
    handoffStartBp: 0,
    handoffEndBp: 200,
    ...overrides,
  };
}

function interaction(overrides: Record<string, unknown> = {}) {
  const policyProjection = { id: 'policy' };
  return {
    ownerKey: 'owner-a',
    sourceFingerprint: SHA24,
    interactionPayloadSha256: SHA64,
    policyProjection,
    sourceScene: {
      byteCount: 64,
      payloadSha256: SHA64,
      contractSha256: SHA64,
    },
    ...overrides,
  };
}

describe('inspectPrepackedViewportDetailPacket', () => {
  it('treats a missing packet as valid', () => {
    expect(
      inspectPrepackedViewportDetailPacket({
        viewportDetail: undefined,
        ownerKey: 'owner-a',
        genomeLengthBp: 1_000,
        policyProjection: undefined,
        trustedViewportDetailPacketAdmissionV1: undefined,
        trustedViewportDetailInteractionAdmissionV1: undefined,
        compiledInteraction: null,
      })
    ).toEqual({ valid: true, checks: null });
  });

  it('accepts a digest-joined packet with both trusted capabilities', () => {
    const compiled = interaction();
    const result = inspectPrepackedViewportDetailPacket({
      viewportDetail: packet(),
      ownerKey: 'owner-a',
      genomeLengthBp: 1_000,
      policyProjection: compiled.policyProjection,
      trustedViewportDetailPacketAdmissionV1: {},
      trustedViewportDetailInteractionAdmissionV1: {},
      compiledInteraction: compiled,
    });
    expect(result.valid).toBe(true);
    expect(result.checks).toMatchObject({
      contract: true,
      packetDigest: true,
      compiledInteractionPresent: true,
      owner: true,
      packetCapability: true,
      interactionCapability: true,
    });
  });

  it('fails closed when the interaction join or coverage is wrong', () => {
    const compiled = interaction({ ownerKey: 'other' });
    expect(
      inspectPrepackedViewportDetailPacket({
        viewportDetail: packet({ coverageEndBp: 0 }),
        ownerKey: 'owner-a',
        genomeLengthBp: 1_000,
        policyProjection: compiled.policyProjection,
        trustedViewportDetailPacketAdmissionV1: {},
        trustedViewportDetailInteractionAdmissionV1: {},
        compiledInteraction: compiled,
      }).valid
    ).toBe(false);
    expect(
      inspectPrepackedViewportDetailPacket({
        viewportDetail: packet(),
        ownerKey: 'owner-a',
        genomeLengthBp: 1_000,
        policyProjection: compiled.policyProjection,
        trustedViewportDetailPacketAdmissionV1: {},
        trustedViewportDetailInteractionAdmissionV1: {},
        compiledInteraction: compiled,
      }).valid
    ).toBe(false);
    expect(
      inspectPrepackedViewportDetailPacket({
        viewportDetail: packet(),
        ownerKey: 'owner-a',
        genomeLengthBp: 1_000,
        policyProjection: compiled.policyProjection,
        trustedViewportDetailPacketAdmissionV1: undefined,
        trustedViewportDetailInteractionAdmissionV1: {},
        compiledInteraction: interaction(),
      }).valid
    ).toBe(false);
  });
});
