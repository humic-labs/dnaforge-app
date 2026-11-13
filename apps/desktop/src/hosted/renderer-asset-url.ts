const HOSTED_RENDERER_PATH = '/hosted/';

function normalizeAssetPath(path: string): string {
  return path.replace(/^\/+/u, '');
}

export function resolveRendererAssetUrl({
  path,
  documentUrl,
  baseUrl,
  hostedBrowser,
}: {
  path: string;
  documentUrl: string;
  baseUrl: string;
  hostedBrowser: boolean;
}): string {
  const normalizedPath = normalizeAssetPath(path);
  if (!hostedBrowser) {
    return new URL(`./${normalizedPath}`, documentUrl).toString();
  }

  const document = new URL(documentUrl);
  if (document.protocol !== 'http:' && document.protocol !== 'https:') {
    return new URL(`./${normalizedPath}`, documentUrl).toString();
  }

  const configuredBase = baseUrl.trim();
  const basePath =
    configuredBase && configuredBase !== '/'
      ? configuredBase
      : document.pathname === '/hosted.html' || document.pathname.startsWith(HOSTED_RENDERER_PATH)
        ? HOSTED_RENDERER_PATH
        : '/';
  return new URL(normalizedPath, new URL(basePath, document.origin)).toString();
}
