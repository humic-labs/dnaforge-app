export function rendererAvatarSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:image/') || url.startsWith('blob:')) return url;
  return null;
}
