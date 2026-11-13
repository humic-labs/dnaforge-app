declare const __DEV_WP_ASSETS_PATH__: string;

export const WP_ASSETS = __DEV_WP_ASSETS_PATH__ || import.meta.env.VITE_WP_ASSETS_PATH || '';

export function wpAssetsPath(relative: string): string {
  return `${WP_ASSETS}/${relative}`;
}
