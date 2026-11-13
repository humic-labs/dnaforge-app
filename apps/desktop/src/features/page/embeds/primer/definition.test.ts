/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockContentHash } = vi.hoisted(() => ({ mockContentHash: vi.fn() }));

vi.mock('../../../../platform', () => ({
  platform: () => ({ fs: { contentHash: mockContentHash } }),
}));

import { primerCommand } from './definition';
import type { PickerResult } from '../types';

async function complete(data: Record<string, unknown>): Promise<PickerResult> {
  return (await primerCommand.picker.onComplete(data)) as PickerResult;
}

describe('primerCommand.onComplete', () => {
  beforeEach(() => {
    mockContentHash.mockReset();
    mockContentHash.mockResolvedValue(`sha256:${'f'.repeat(64)}`);
  });

  it('builds a portable record for an artifact-backed primer', async () => {
    const result = await complete({
      primerId: 'p1',
      primerName: 'M13-fwd',
      path: 'primers/M13-fwd.primer.json',
      owningRoot: '/ws/beta',
    });

    expect(result).toMatchObject({
      nodeType: 'mention',
      entityType: 'primer',
      entityId: 'p1',
      label: 'M13-fwd',
      path: 'primers/M13-fwd.primer.json',
      contentHash: `sha256:${'f'.repeat(64)}`,
    });
  });

  it('still inserts a chip for a local-only primer, with no path', async () => {
    const result = await complete({
      primerId: 'p2',
      primerName: 'hand-entered',
      path: null,
      localOnly: true,
      owningRoot: '/ws/beta',
    });

    expect(result).toMatchObject({
      nodeType: 'mention',
      entityId: 'p2',
      label: 'hand-entered',
      path: null,
      contentHash: null,
    });
  });

  it('does not attempt to hash a primer with no file', async () => {
    await complete({ primerId: 'p2', primerName: 'x', path: null, owningRoot: '/ws/beta' });
    expect(mockContentHash).not.toHaveBeenCalled();
  });

  it('keeps the local id so a local-only chip still resolves in this install', async () => {
    const result = await complete({ primerId: 'p2', primerName: 'x', path: null });
    expect((result as { entityId: string }).entityId).toBe('p2');
  });

  it('refuses picker data with no primer id', async () => {
    await expect(complete({ primerName: 'x' })).rejects.toThrow(/primerId/);
  });
});
