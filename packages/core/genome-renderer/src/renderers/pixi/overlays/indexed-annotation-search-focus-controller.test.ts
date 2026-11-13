import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IndexedAnnotationOverlay } from './annotation-overlay';
import { AnnotationSearchFocusController } from './indexed-annotation-search-focus-controller';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

describe('AnnotationSearchFocusController', () => {
  it('holds resolved focus identity on the controller itself', () => {
    const focus = new AnnotationSearchFocusController();
    focus.annotationSearchFocusResolvedTrackId = 'mRNA';
    focus.annotationSearchFocusResolvedCanonicalIdentity = 'gene:1';
    focus.annotationSearchFocusPresentationLane = 2;
    focus.annotationSearchFocusMaskDrawCount = 4;
    expect(focus.annotationSearchFocusResolvedTrackId).toBe('mRNA');
    expect(focus.annotationSearchFocusResolvedCanonicalIdentity).toBe('gene:1');
    expect(focus.annotationSearchFocusPresentationLane).toBe(2);
    expect(focus.annotationSearchFocusMaskDrawCount).toBe(4);
  });

  it('does not keep search-focus identity as overlay-owned data', () => {
    const overlay = new IndexedAnnotationOverlay();
    const focus = overlay.getSearchFocusControllerForTest();

    expect(Object.hasOwn(overlay, 'annotationSearchFocusResolvedTrackId')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationSearchFocusResolvedCanonicalIdentity')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationSearchFocusPresentationLane')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationSearchFocusMaskDrawCount')).toBe(false);
    expect(Object.hasOwn(overlay, 'annotationSearchFocusGraphics')).toBe(false);
    expect(focus).toBeInstanceOf(AnnotationSearchFocusController);
    expect(Object.hasOwn(focus, 'annotationSearchFocusResolvedTrackId')).toBe(true);
    expect(Object.hasOwn(focus, 'annotationSearchFocusGraphics')).toBe(true);
    expect(focus.annotationSearchFocusResolvedTrackId).toBeNull();

    const source = overlaySource();
    expect(source).toContain('private readonly searchFocus = new AnnotationSearchFocusController');
    expect(source).not.toContain('this as unknown as SearchFocusOverlayBindings');
  });
});
