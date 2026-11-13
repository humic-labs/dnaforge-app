import { describe, expect, it, vi } from 'vitest';
import { materializeRendererAvatar } from './materialize-avatar';
import { rendererAvatarSrc } from '../../shared/renderer-avatar';

describe('renderer avatar bytes', () => {
  it('refuses a storage URL in the isolated renderer', () => {
    expect(rendererAvatarSrc('http://127.0.0.1:54321/storage/v1/object/sign/a')).toBeNull();
    expect(rendererAvatarSrc('data:image/jpeg;base64,aaaa')).toBe('data:image/jpeg;base64,aaaa');
    expect(rendererAvatarSrc('blob:http://localhost:1623/id')).toBe(
      'blob:http://localhost:1623/id'
    );
  });

  it('copies a signed JPEG into a data URL the renderer can paint', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImpl = vi.fn(async () => {
      return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });
    const url = await materializeRendererAvatar(
      'http://127.0.0.1:54321/storage/v1/object/sign/account-avatars/a/avatar.jpg?token=secret',
      fetchImpl
    );
    expect(url).toBe(`data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`);
    expect(rendererAvatarSrc(url)).toBe(url);
  });

  it('leaves an existing data URL alone and returns null when the download fails', async () => {
    const fetchImpl = vi.fn();
    const data = 'data:image/png;base64,aaaa';
    expect(await materializeRendererAvatar(data, fetchImpl)).toBe(data);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      await materializeRendererAvatar(
        'https://storage.example/avatar.jpg',
        vi.fn(async () => new Response(null, { status: 403 }))
      )
    ).toBeNull();
  });
});
