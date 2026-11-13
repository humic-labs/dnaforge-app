import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SequenceAnnotationOverlay } from './sequence-annotation-overlay';
import { SequenceImmediateDrawPresenter } from './sequence-immediate-draw-presenter';
import type { OutlineCommand } from './annotation-feature-geometry';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'sequence-annotation-overlay.ts'), 'utf8');
}

describe('SequenceImmediateDrawPresenter', () => {
  it('holds outline and label caches on the presenter itself', () => {
    const draw = new SequenceImmediateDrawPresenter();
    draw.outlineCache.set(1, []);
    draw.labelCache.set(1, { text: 'lacZ', width: 12 });
    draw.labelOccupancyCache.push({
      xMin: 0,
      xMax: 10,
      yMin: 0,
      yMax: 4,
      kind: 'cds-label-pill',
      featureId: 1,
      text: 'lacZ',
    });
    draw.lastDrawnFeatureCount = 3;
    draw.lastImmediateDrawnLayerTypes.add('CDS');

    expect(draw.outlineCache.get(1)).toEqual([]);
    expect(draw.labelCache.get(1)?.text).toBe('lacZ');
    expect(draw.labelOccupancyCache).toHaveLength(1);
    expect(draw.lastDrawnFeatureCount).toBe(3);
    expect([...draw.lastImmediateDrawnLayerTypes]).toEqual(['CDS']);
  });

  it('does not keep outlineCache as overlay-owned data', () => {
    const overlay = new SequenceAnnotationOverlay();
    const draw = overlay.getImmediateDrawPresenterForTest();

    expect(Object.hasOwn(overlay, 'outlineCache')).toBe(false);
    expect(Object.hasOwn(overlay, 'labelCache')).toBe(false);
    expect(Object.hasOwn(overlay, 'labelOccupancyCache')).toBe(false);
    expect(Object.hasOwn(overlay, 'lastDrawnFeatureCount')).toBe(false);
    expect(draw).toBeInstanceOf(SequenceImmediateDrawPresenter);
    expect(Object.hasOwn(draw, 'outlineCache')).toBe(true);
    expect(draw.outlineCache).toBeInstanceOf(Map);

    const source = overlaySource();
    expect(source).toContain('private readonly immediateDraw = new SequenceImmediateDrawPresenter');
    expect(source).not.toContain('private drawCDSLabelStrip');
    expect(source).not.toContain('private drawLanePillShell');
    expect(source).not.toContain('private drawTranscriptGlyph');
  });

  it('writes CDS/transcript outlines onto the presenter cache', () => {
    const draw = new SequenceImmediateDrawPresenter();
    const commands: OutlineCommand[] = [{ kind: 'poly', pts: [0, 0, 10, 0, 10, 4, 0, 4, 0, 0] }];
    draw.setFeatureOutline(7, commands);
    expect(draw.outlineCache.get(7)).toEqual(commands);
    draw.addFeatureOutline(7, { kind: 'polyline', pts: [0, 2, 10, 2] });
    expect(draw.outlineCache.get(7)).toHaveLength(2);
  });

  it('exposes leftover overlay names through accessors', () => {
    const overlay = new SequenceAnnotationOverlay();
    const draw = overlay.getImmediateDrawPresenterForTest();
    const leftover = overlay as unknown as {
      outlineCache: Map<number, OutlineCommand[]>;
      labelCache: Map<number, { text: string; width: number }>;
    };
    leftover.outlineCache.set(4, []);
    leftover.labelCache.set(4, { text: 'ampR', width: 8 });
    expect(draw.outlineCache.get(4)).toEqual([]);
    expect(draw.labelCache.get(4)?.text).toBe('ampR');
  });

  it('does not require glue for cache-only work', () => {
    const draw = new SequenceImmediateDrawPresenter();
    draw.resetImmediateDrawStats();
    expect(draw.lastDrawnFeatureCount).toBe(0);
    expect(() => draw.graphics).toThrow(/requires overlay glue/);
  });
});
