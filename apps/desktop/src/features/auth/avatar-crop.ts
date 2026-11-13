export const AVATAR_STORED_MAX_BYTES = 512 * 1024;
export const AVATAR_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const AVATAR_OUTPUT_PX = 512;
export const AVATAR_VIEWPORT_PX = 288;
export const AVATAR_MIN_ZOOM = 1;
export const AVATAR_MAX_ZOOM = 3;

export interface ImageSize {
  width: number;
  height: number;
}

export interface AvatarCrop {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface AvatarPlacement {
  width: number;
  height: number;
  left: number;
  top: number;
  crop: AvatarCrop;
}

export function avatarContentType(file: {
  type: string;
  name: string;
}): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp') {
    return file.type;
  }
  const name = file.name.toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  return null;
}

export function avatarFileError(file: { type: string; size: number; name: string }): string | null {
  if (!avatarContentType(file)) return 'Photo must be PNG, JPEG, or WebP.';
  if (file.size <= 0) return 'That file is empty.';
  if (file.size > AVATAR_SOURCE_MAX_BYTES) return 'Photo must be 8 MB or smaller.';
  return null;
}

export function clampAvatarCrop(
  image: ImageSize,
  viewportPx: number,
  crop: AvatarCrop
): AvatarCrop {
  const zoom = Math.min(AVATAR_MAX_ZOOM, Math.max(AVATAR_MIN_ZOOM, crop.zoom));
  const scale = (viewportPx / Math.min(image.width, image.height)) * zoom;
  const maxX = Math.max(0, (image.width * scale - viewportPx) / 2);
  const maxY = Math.max(0, (image.height * scale - viewportPx) / 2);
  return {
    zoom,
    offsetX: Math.min(maxX, Math.max(-maxX, crop.offsetX)),
    offsetY: Math.min(maxY, Math.max(-maxY, crop.offsetY)),
  };
}

export function avatarDisplayPlacement(
  image: ImageSize,
  viewportPx: number,
  crop: AvatarCrop
): AvatarPlacement {
  const clamped = clampAvatarCrop(image, viewportPx, crop);
  const scale = (viewportPx / Math.min(image.width, image.height)) * clamped.zoom;
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    width,
    height,
    left: (viewportPx - width) / 2 + clamped.offsetX,
    top: (viewportPx - height) / 2 + clamped.offsetY,
    crop: clamped,
  };
}

export function avatarSourceRect(
  image: ImageSize,
  viewportPx: number,
  crop: AvatarCrop
): SourceRect {
  const place = avatarDisplayPlacement(image, viewportPx, crop);
  const scale = place.width / image.width;
  return {
    sx: (0 - place.left) / scale,
    sy: (0 - place.top) / scale,
    sw: viewportPx / scale,
    sh: viewportPx / scale,
  };
}

export async function encodeWithinByteBudget(
  draw: (quality: number, size: number) => Promise<Blob | null>,
  maxBytes: number = AVATAR_STORED_MAX_BYTES
): Promise<Blob> {
  const sizes = [AVATAR_OUTPUT_PX, 384, 256, 192];
  const qualities = [0.92, 0.84, 0.76, 0.68, 0.6, 0.5];
  let smallest: Blob | null = null;
  for (const size of sizes) {
    for (const quality of qualities) {
      const blob = await draw(quality, size);
      if (!blob || blob.size === 0) continue;
      if (!smallest || blob.size < smallest.size) smallest = blob;
      if (blob.size <= maxBytes) return blob;
    }
  }
  throw new Error(
    smallest ? 'Cropped photo is still over 512 KB.' : 'Could not encode the cropped photo.'
  );
}

export function drawAvatarJpeg(
  image: CanvasImageSource,
  rect: SourceRect,
  quality: number,
  size: number,
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')
): Promise<Blob | null> {
  const canvas = createCanvas();
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return Promise.resolve(null);
  context.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, size, size);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the cropped photo.'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(blob);
  });
}
