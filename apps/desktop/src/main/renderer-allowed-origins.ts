export const SIDECAR_ALLOWED_ORIGINS_ENV = 'DNAFORGE_ALLOWED_RENDERER_ORIGIN';

export const FILE_DOCUMENT_ORIGIN = 'null';

export function resolveRendererAllowedOrigin(rendererUrl: string | undefined): string {
  if (!rendererUrl) return FILE_DOCUMENT_ORIGIN;
  try {
    return new URL(rendererUrl).origin;
  } catch {
    return FILE_DOCUMENT_ORIGIN;
  }
}

export function rendererAllowedOriginsEnv(
  rendererUrl: string | undefined = process.env.ELECTRON_RENDERER_URL
): Record<string, string> {
  return { [SIDECAR_ALLOWED_ORIGINS_ENV]: resolveRendererAllowedOrigin(rendererUrl) };
}
