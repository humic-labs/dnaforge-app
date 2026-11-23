import { platform } from '../../platform';
import { HARD_CAP_BYTES } from '../../shared/oversized-guard';
import { getExtension } from '../../utils/fileTypes';

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export function readImageFileBytes(path: string): Promise<Uint8Array> {
  return platform().fs.readFileBounded(path, HARD_CAP_BYTES);
}

export function createImageFileUrl(bytes: Uint8Array, sourcePath: string): string {
  const extension = getExtension(sourcePath);
  return URL.createObjectURL(
    new Blob([bytes], { type: (extension && IMAGE_MIME_BY_EXT[extension]) || '' })
  );
}

export function decodedImageSize(image: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>) {
  const { naturalWidth: width, naturalHeight: height } = image;
  return [width, height].every((value) => Number.isFinite(value) && value > 0)
    ? { width, height }
    : null;
}

export function decodeImageFileUrl(
  url: string
): Promise<'decoded' | 'invalid-size' | 'decode-failed'> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(decodedImageSize(image) ? 'decoded' : 'invalid-size');
    image.onerror = () => resolve('decode-failed');
    image.src = url;
  });
}
