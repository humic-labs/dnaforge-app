export type ImageSource = 'upload' | 'url' | 'captured';

export interface ImageAttrs {
  src?: string;
  alt?: string;
  caption?: string;
  fileName?: string;
  width?: number;
  source?: ImageSource;
  error?: string;
  archiveHash?: string;
  sourceRef?: string;
  mediaType?: string;
  migrationRunId?: string;
  notebookPackagePath?: string;
}

export const IMAGE_CONSTANTS = {
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  ALLOWED_TYPES: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const,
  MIN_WIDTH: 20,
  MAX_WIDTH: 100,
  DEFAULT_WIDTH: 100,
} as const;

export function isAllowedImageType(type: string): boolean {
  return IMAGE_CONSTANTS.ALLOWED_TYPES.includes(
    type as (typeof IMAGE_CONSTANTS.ALLOWED_TYPES)[number]
  );
}

export function isFileSizeAllowed(size: number): boolean {
  return size <= IMAGE_CONSTANTS.MAX_FILE_SIZE;
}
