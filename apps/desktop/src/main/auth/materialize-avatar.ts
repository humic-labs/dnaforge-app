import { rendererAvatarSrc } from '../../shared/renderer-avatar';

const RENDERABLE_AVATAR_MAX_BYTES = 512 * 1024;
const RENDERABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export async function materializeRendererAvatar(
  url: string | null | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  if (!url) return null;
  if (rendererAvatarSrc(url)) return url;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!RENDERABLE_TYPES.has(type)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > RENDERABLE_AVATAR_MAX_BYTES) return null;
    return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null;
  }
}
