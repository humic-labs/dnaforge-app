// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { HostedCapabilityError } from './errors';
import { createHostedGenome } from './genome';

describe('hosted genome', () => {
  it('reads annotation tiles through the prepared reference owner', async () => {
    const tile = { state: 'ready', features: [{ type: 'mRNA' }] };
    const getAnnotationTile = vi.fn().mockResolvedValue(tile);
    const genome = createHostedGenome(async () => ({ getAnnotationTile }) as never);
    const request = {
      trackId: 'chr13:annotations',
      chrom: 'chr13',
      start: 32_200_000,
      end: 33_100_000,
      annotationOwner: { start: 32_505_856, end: 33_030_144 },
      fidelity: 'exact',
      byteBudget: 512 * 1024,
      generation: 1,
      lod: 1,
    } as const;
    await expect(
      genome.getAnnotationTile('reference-session', request, 'coding-page')
    ).resolves.toBe(tile);
    expect(getAnnotationTile).toHaveBeenCalledWith('reference-session', request, 'coding-page');
  });
  it('does not invent sidecar tiles', async () => {
    const genome = createHostedGenome(async () => {
      throw new Error('prepared references are not used by sidecar-only calls');
    });
    await expect(genome.readAssemblyOverviewTexture({} as never)).resolves.toBeNull();
    await expect(genome.getTrackTile('missing', {} as never)).rejects.toBeInstanceOf(
      HostedCapabilityError
    );
  });
});
