// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';

let Container: typeof import('pixi.js').Container;
let Text: typeof import('pixi.js').Text;
let CurvedLabelRenderer: typeof import('./curved-label').CurvedLabelRenderer;

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 6 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;

  ({ Container, Text } = await import('pixi.js'));
  ({ CurvedLabelRenderer } = await import('./curved-label'));
});

function maxAdjacentRotationDelta(rotations: number[]): number {
  let maxDelta = 0;
  for (let i = 1; i < rotations.length; i++) {
    let delta = rotations[i] - rotations[i - 1];
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    maxDelta = Math.max(maxDelta, Math.abs(delta));
  }
  return maxDelta;
}

function renderSingleGlyphStyle(color: number): import('pixi.js').TextStyle {
  const parent = new Container();
  const renderer = new CurvedLabelRenderer(parent);
  renderer.renderLabel('A', () => ({ x: 0, y: 0, angle: 0 }), 13, color, 1, false);
  const glyphContainer = parent.children[0];
  if (!(glyphContainer instanceof Container)) {
    throw new Error('Curved label renderer did not attach its glyph container');
  }
  const glyph = glyphContainer.children[0];
  if (!(glyph instanceof Text)) {
    throw new Error('Curved label renderer did not create a Pixi Text glyph');
  }
  const style = glyph.style;
  renderer.destroy();
  return style;
}

describe('CurvedLabelRenderer', () => {
  it('keeps the same glyph objects for a keyed label across frames', () => {
    const parent = new Container();
    const renderer = new CurvedLabelRenderer(parent);
    const arc = (t: number) => ({ x: t * 100, y: 0, angle: 0 });
    const label = (text: string, key: string) =>
      renderer.renderLabel(text, arc, 13, 0x111111, 1, false, 1, undefined, key);

    renderer.reset();
    label('abc', 'feature:1');
    const glyphContainer = parent.children[0] as InstanceType<typeof Container>;
    const first = [...glyphContainer.children] as InstanceType<typeof Text>[];
    expect(first.map((glyph) => glyph.text).join('')).toBe('abc');

    renderer.reset();
    label('zz', 'feature:2');
    label('abc', 'feature:1');
    expect(first.every((glyph) => glyphContainer.children.includes(glyph))).toBe(true);
    expect(first.map((glyph) => glyph.text).join('')).toBe('abc');
    expect(first.every((glyph) => glyph.visible)).toBe(true);

    renderer.reset();
    label('zz', 'feature:2');
    expect(first.every((glyph) => !glyph.visible)).toBe(true);
    renderer.destroy();
  });

  it('reports keyed glyphs in every debug getter, not only in the count', () => {
    const parent = new Container();
    const renderer = new CurvedLabelRenderer(parent);
    const arc = (t: number) => ({ x: Math.cos(t), y: Math.sin(t), angle: t + Math.PI / 2 });
    renderer.reset();
    renderer.renderLabel('abc', arc, 13, 0x111111, 1, false, 1, undefined, 'feature:1');

    expect(renderer.activeCount).toBe(3);
    expect(renderer.activeRotations).toHaveLength(3);
    expect(renderer.activeFontSizes).toHaveLength(3);
    expect(renderer.activeScales).toHaveLength(3);
    expect(renderer.activeResolutions).toHaveLength(3);
    expect(renderer.activePositions).toHaveLength(3);
    expect(renderer.activeTexts.join('')).toBe('abc');
    expect(renderer.activeRotations.some((rotation) => Math.abs(rotation) > 0.01)).toBe(true);
    renderer.destroy();
  });

  it('keeps the flip decision label-level instead of flipping individual glyphs', () => {
    const parent = new Container();
    const renderer = new CurvedLabelRenderer(parent);

    renderer.renderLabel(
      'ABCDE',
      (t) => ({
        x: t * 100,
        y: 50,
        angle: Math.PI / 2 - 0.16 + t * 0.32,
      }),
      10,
      0x333333,
      1,
      false
    );

    expect(renderer.activeCount).toBe(5);
    expect(maxAdjacentRotationDelta(renderer.activeRotations)).toBeLessThan(0.25);

    renderer.destroy();
  });

  it('releases cached TextStyle listeners when the renderer is destroyed', () => {
    const parent = new Container();
    const renderer = new CurvedLabelRenderer(parent);

    renderer.renderLabel('LEAK', (t) => ({ x: t * 100, y: 25, angle: 0 }), 13, 0x123456, 1, false);

    const glyphContainer = parent.children[0];
    if (!(glyphContainer instanceof Container)) {
      throw new Error('Curved label renderer did not attach its glyph container');
    }
    const firstGlyph = glyphContainer.children[0];
    if (!(firstGlyph instanceof Text)) {
      throw new Error('Curved label renderer did not create a Pixi Text glyph');
    }
    const retainedStyle = firstGlyph.style;
    expect(retainedStyle.listenerCount('update')).toBe(4);

    renderer.destroy();

    expect(retainedStyle.listenerCount('update')).toBe(0);
  });

  it('bounds arbitrary annotation-color styles with least-recently-used eviction', () => {
    const first = renderSingleGlyphStyle(0);
    const second = renderSingleGlyphStyle(1);
    for (let color = 2; color < 128; color += 1) renderSingleGlyphStyle(color);

    expect(renderSingleGlyphStyle(0)).toBe(first);
    renderSingleGlyphStyle(128);

    const reloadedSecond = renderSingleGlyphStyle(1);
    expect(reloadedSecond).not.toBe(second);
    expect(renderSingleGlyphStyle(1)).toBe(reloadedSecond);
    expect(renderSingleGlyphStyle(0)).toBe(first);
  });
});
