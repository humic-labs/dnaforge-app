import { describe, expect, it } from 'vitest';
import { DOMParser } from 'linkedom';
import { staticSvgImage } from './static-svg-image';

describe('static SVG image boundary', () => {
  it('keeps case-sensitive geometry, local references and inline paint styles', () => {
    const result = staticSvgImage(
      '<svg viewBox="0 0 20 10"><defs><path id="line" d="M0 5L20 5"/></defs><use href="#line" style="stroke:blue;stroke-width:2"/></svg>'
    );
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') throw new Error('Expected static image');
    const xml = Buffer.from(result.src.split(',')[1], 'base64').toString();
    expect(xml).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(xml).toContain('viewBox="0 0 20 10"');
    expect(xml).toContain('href="#line"');
    expect(xml).toContain('stroke:blue');
  });

  it('binds legacy local xlink references in standalone XML', () => {
    const result = staticSvgImage(
      '<svg><defs><path id="shape" d="M0 0L5 5"/></defs><use xlink:href="#shape"/></svg>'
    );
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') throw new Error('Expected static image');
    expect(Buffer.from(result.src.split(',')[1], 'base64').toString()).toContain(
      'xmlns:xlink="http://www.w3.org/1999/xlink"'
    );
  });

  it('adjusts HTML-lowercased SVG attributes before standalone image rendering', () => {
    const result = staticSvgImage(
      '<svg viewbox="0 0 120 60" preserveaspectratio="xMidYMid meet"><defs><linearGradient id="paint" gradientunits="userSpaceOnUse" gradienttransform="rotate(45)"/></defs><rect fill="url(#paint)"/></svg>'
    );
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') throw new Error('Expected static image');
    const xml = Buffer.from(result.src.split(',')[1], 'base64').toString();
    expect(xml).toContain('viewBox="0 0 120 60"');
    expect(xml).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(xml).toContain('gradientUnits="userSpaceOnUse"');
    expect(xml).toContain('gradientTransform="rotate(45)"');
  });

  it.each([
    '<use href="#absent"/>',
    '<rect fill="url(#absent)"/>',
    '<rect style="clip-path:url(\'#absent\')"/>',
  ])('explains missing local drawing dependencies: %s', (child) => {
    expect(staticSvgImage(`<svg>${child}</svg>`)).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('missing'),
    });
  });

  it('decodes HTML entities without turning escaped text into markup', () => {
    const result = staticSvgImage(
      '<svg aria-label="&alpha;"><text>&alpha;&nbsp;&beta; &lt;circle /&gt; &amp; &#916;</text></svg>'
    );
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') throw new Error('Expected static image');
    const xml = Buffer.from(result.src.split(',')[1], 'base64').toString();
    expect(new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement.textContent).toBe(
      'α β <circle /> & Δ'
    );
    expect(xml).not.toContain('<circle');
  });

  it.each([
    '<svg><script /></svg>',
    '<svg onload="void 0"><rect width="1" height="1"/></svg>',
    '<svg><foreignObject><p>SVG_BOUNDARY_CANARY</p></foreignObject></svg>',
    '<svg><use href="https://example.invalid/figure.svg#shape"/></svg>',
    '<svg><rect fill="url(https://example.invalid/paint.svg)"/></svg>',
    '<svg><style>rect { fill: blue }</style><rect width="1" height="1"/></svg>',
    '<svg><animate attributeName="opacity"/></svg>',
    '<svg xmlns="https://example.invalid/namespace"><rect/></svg>',
    '<svg><g xml:base="https://example.invalid/"><use href="#shape"/></g></svg>',
    '<svg><rect style="background-image:url(https://example.invalid/image)"/></svg>',
    '<!DOCTYPE svg><svg/>',
    '<svg/><svg/>',
    undefined,
  ])('refuses unsupported content with a reason: %s', (source) => {
    expect(staticSvgImage(source)).toMatchObject({
      kind: 'unavailable',
      reason: expect.any(String),
    });
  });

  it('bounds the input before parsing', () => {
    expect(staticSvgImage(`<svg><text>${'a'.repeat(1024 * 1024)}</text></svg>`)).toMatchObject({
      kind: 'unavailable',
    });
  });
});
