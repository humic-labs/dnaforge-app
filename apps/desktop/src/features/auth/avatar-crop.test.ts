// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  AVATAR_SOURCE_MAX_BYTES,
  AVATAR_STORED_MAX_BYTES,
  AVATAR_VIEWPORT_PX,
  avatarDisplayPlacement,
  avatarFileError,
  avatarSourceRect,
  encodeWithinByteBudget,
} from './avatar-crop';

const WIDE = { width: 1000, height: 500 };

describe('avatar crop', () => {
  it('keeps the stored photo at the account-avatars bucket limit', () => {
    expect(AVATAR_STORED_MAX_BYTES).toBe(524288);
    expect(AVATAR_SOURCE_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('rejects an empty file, a non-image, and a photo over 8 MB', () => {
    expect(avatarFileError({ type: 'image/jpeg', size: 0, name: 'empty.jpg' })).toMatch(/empty/i);
    expect(avatarFileError({ type: 'text/plain', size: 10, name: 'notes.txt' })).toMatch(
      /PNG, JPEG, or WebP/
    );
    expect(
      avatarFileError({
        type: 'image/jpeg',
        size: AVATAR_SOURCE_MAX_BYTES + 1,
        name: 'huge.jpg',
      })
    ).toMatch(/8 MB/);
    expect(avatarFileError({ type: '', size: 20, name: 'banana.JPEG' })).toBeNull();
  });

  it('covers a wide photo with the center square at zoom 1', () => {
    const place = avatarDisplayPlacement(WIDE, AVATAR_VIEWPORT_PX, {
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
    });
    expect(place.left).toBeCloseTo(-144);
    expect(place.top).toBeCloseTo(0);
    expect(place.width).toBeCloseTo(576);
    expect(place.height).toBeCloseTo(288);

    const rect = avatarSourceRect(WIDE, AVATAR_VIEWPORT_PX, { zoom: 1, offsetX: 0, offsetY: 0 });
    expect(rect.sx).toBeCloseTo(250);
    expect(rect.sy).toBeCloseTo(0);
    expect(rect.sw).toBeCloseTo(500);
    expect(rect.sh).toBeCloseTo(500);
  });

  it('clamps a drag so the circle stays covered, including after zooming back out', () => {
    const zoomed = avatarDisplayPlacement(WIDE, AVATAR_VIEWPORT_PX, {
      zoom: 2,
      offsetX: 10_000,
      offsetY: -10_000,
    });
    expect(zoomed.crop.zoom).toBe(2);
    expect(zoomed.crop.offsetX).toBeCloseTo(432);
    expect(zoomed.crop.offsetY).toBeCloseTo(-144);

    const back = avatarDisplayPlacement(WIDE, AVATAR_VIEWPORT_PX, {
      ...zoomed.crop,
      zoom: 1,
    });
    expect(back.crop.offsetX).toBeCloseTo(144);
    expect(back.crop.offsetY).toBeCloseTo(0);
    expect(back.left).toBeCloseTo(0);
  });

  it('returns the first encoded blob that fits under 512 KB', async () => {
    const draw = vi.fn(async (quality: number, size: number) => {
      if (size === 512 && quality > 0.6) return new Blob([new Uint8Array(600 * 1024)]);
      return new Blob([new Uint8Array(100 * 1024)]);
    });
    const blob = await encodeWithinByteBudget(draw);
    expect(blob.size).toBe(100 * 1024);
    expect(draw).toHaveBeenLastCalledWith(0.6, 512);
    expect(draw.mock.calls.some((call) => call[1] === 384)).toBe(false);
  });

  it('refuses a crop that cannot be encoded under 512 KB', async () => {
    await expect(
      encodeWithinByteBudget(async () => new Blob([new Uint8Array(600 * 1024)]))
    ).rejects.toThrow(/512 KB/);
  });
});
