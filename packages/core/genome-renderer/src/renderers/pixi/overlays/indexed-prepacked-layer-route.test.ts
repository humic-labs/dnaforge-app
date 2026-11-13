import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  prepackedLayerConstructionRoute,
  shouldRejectIncompatibleActiveOwner,
} from './indexed-prepacked-layer-route';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('prepacked layer construction route', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function prepackedLayerConstructionRoute');
    expect(source).not.toContain('function shouldRejectIncompatibleActiveOwner');
  });

  it('prefers trusted v4, then a detail packet, then the legacy compiler', () => {
    expect(
      prepackedLayerConstructionRoute({
        trustedV4Admission: true,
        trustedDetailPacketAdmission: true,
      })
    ).toBe('v4');
    expect(
      prepackedLayerConstructionRoute({
        trustedV4Admission: false,
        trustedDetailPacketAdmission: true,
      })
    ).toBe('detail-packet');
    expect(
      prepackedLayerConstructionRoute({
        trustedV4Admission: false,
        trustedDetailPacketAdmission: false,
      })
    ).toBe('legacy');
  });

  it('rejects only when preserving an active owner whose bank is incompatible', () => {
    expect(
      shouldRejectIncompatibleActiveOwner({
        preserveActiveOwner: true,
        existingIsActiveLayer: true,
        bankCompatible: false,
      })
    ).toBe(true);
    expect(
      shouldRejectIncompatibleActiveOwner({
        preserveActiveOwner: true,
        existingIsActiveLayer: false,
        bankCompatible: false,
      })
    ).toBe(false);
    expect(
      shouldRejectIncompatibleActiveOwner({
        preserveActiveOwner: false,
        existingIsActiveLayer: true,
        bankCompatible: false,
      })
    ).toBe(false);
  });
});
