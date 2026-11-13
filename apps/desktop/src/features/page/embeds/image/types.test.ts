// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { isAllowedImageType, isFileSizeAllowed, IMAGE_CONSTANTS } from './types';

describe('Image types utilities', () => {
  describe('isAllowedImageType', () => {
    it('returns true for PNG', () => {
      expect(isAllowedImageType('image/png')).toBe(true);
    });

    it('returns true for JPEG', () => {
      expect(isAllowedImageType('image/jpeg')).toBe(true);
    });

    it('returns true for GIF', () => {
      expect(isAllowedImageType('image/gif')).toBe(true);
    });

    it('returns true for WebP', () => {
      expect(isAllowedImageType('image/webp')).toBe(true);
    });

    it('returns false for SVG', () => {
      expect(isAllowedImageType('image/svg+xml')).toBe(false);
    });

    it('returns false for non-image types', () => {
      expect(isAllowedImageType('application/pdf')).toBe(false);
      expect(isAllowedImageType('text/plain')).toBe(false);
    });
  });

  describe('isFileSizeAllowed', () => {
    it('returns true for small files', () => {
      expect(isFileSizeAllowed(1024)).toBe(true);
      expect(isFileSizeAllowed(1024 * 1024)).toBe(true);
    });

    it('returns true for files at the limit', () => {
      expect(isFileSizeAllowed(IMAGE_CONSTANTS.MAX_FILE_SIZE)).toBe(true);
    });

    it('returns false for files over the limit', () => {
      expect(isFileSizeAllowed(IMAGE_CONSTANTS.MAX_FILE_SIZE + 1)).toBe(false);
    });

    it('returns true for zero-byte files', () => {
      expect(isFileSizeAllowed(0)).toBe(true);
    });
  });

  describe('IMAGE_CONSTANTS', () => {
    it('has correct max file size (50MB)', () => {
      expect(IMAGE_CONSTANTS.MAX_FILE_SIZE).toBe(50 * 1024 * 1024);
    });

    it('has correct allowed types', () => {
      expect(IMAGE_CONSTANTS.ALLOWED_TYPES).toContain('image/png');
      expect(IMAGE_CONSTANTS.ALLOWED_TYPES).toContain('image/jpeg');
      expect(IMAGE_CONSTANTS.ALLOWED_TYPES).toContain('image/gif');
      expect(IMAGE_CONSTANTS.ALLOWED_TYPES).toContain('image/webp');
      expect(IMAGE_CONSTANTS.ALLOWED_TYPES).toHaveLength(4);
    });

    it('has correct width bounds', () => {
      expect(IMAGE_CONSTANTS.MIN_WIDTH).toBe(20);
      expect(IMAGE_CONSTANTS.MAX_WIDTH).toBe(100);
      expect(IMAGE_CONSTANTS.DEFAULT_WIDTH).toBe(100);
    });
  });
});
