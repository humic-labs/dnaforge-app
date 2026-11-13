import { withUserMessage } from '@waypoint/user-messages';
import { isAllowedImageType, isFileSizeAllowed } from './types';

export async function readNotebookImage(
  file: File
): Promise<{ src: string; fileName: string; source: 'upload' }> {
  if (!isAllowedImageType(file.type))
    throw withUserMessage(
      new Error('File must be an image (PNG, JPG, GIF, WebP)'),
      'failure.file-must-be-an-image-png-jpg-gif-webp'
    );
  if (!isFileSizeAllowed(file.size))
    throw withUserMessage(
      new Error('Image too large (max 50MB)'),
      'failure.image-too-large-max-50mb'
    );
  const src = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Failed to read image'));
    reader.onerror = () => reject(new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
  return { src, fileName: file.name, source: 'upload' };
}
