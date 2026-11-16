import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jsQR from 'jsqr';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { renderInventoryItemLabel } from './inventory-labels';
import { inventoryLabelFont } from './inventory-label-font';
import type { InventoryLabelSpec, InventoryRenderedLabel } from './inventory-label-types';

function fixture(value = ' 00123^FNC1^029ABCabc '): InventoryLabelSpec {
  return {
    scope: { projectId: 'ws1', inventoryId: 'lab' },
    sourceRevision: 9,
    binding: {
      id: 'code-1',
      namespace: 'lab:freezer-1',
      value,
      item: { kind: 'vessel', id: 'tube-1' },
    },
    mediaProfileId: 'qr-50x30-300dpi',
  };
}

function rendered(spec = fixture()): InventoryRenderedLabel {
  const result = renderInventoryItemLabel(spec);
  if (result.kind === 'refused') throw new Error(`${result.code}: ${result.message}`);
  return result.artifact;
}

async function pixels(svg: string, profile?: InventoryRenderedLabel['media']) {
  const image = sharp(Buffer.from(svg), { density: 300 });
  if (profile) {
    image.resize(Math.round(profile.widthDots), Math.round(profile.heightDots), {
      fit: 'fill',
      kernel: 'nearest',
    });
  }
  return image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

describe('bounded exact item-code QR labels', () => {
  it('includes a bounded path for every printable glyph and explicit space advance', () => {
    expect(inventoryLabelFont.glyphs).toHaveLength(95);
    for (const [index, glyph] of inventoryLabelFont.glyphs.entries()) {
      expect(Boolean(glyph.d)).toBe(index !== 0);
      expect(glyph.advance).toBeGreaterThan(0);
      expect(glyph.left).toBeGreaterThanOrEqual(0);
      expect(glyph.right).toBeLessThanOrEqual(glyph.advance);
      expect(glyph.top).toBeGreaterThanOrEqual(-inventoryLabelFont.ascentDots);
      expect(glyph.bottom).toBeLessThanOrEqual(inventoryLabelFont.descentDots);
    }
    expect(inventoryLabelFont.ascentDots + inventoryLabelFont.descentDots).toBeLessThanOrEqual(40);
  });
  it.each([
    ' 00123^FNC1^029ABCabc ',
    '00aA\\u0041^ECI000026"<script>&',
    Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).join(''),
  ])('decodes literal bytes from the saved final SVG for %j', async (value) => {
    const spec = { ...fixture(value), mediaProfileId: 'qr-80x50-300dpi' as const };
    const artifact = rendered(spec);
    const folder = await mkdtemp(join(tmpdir(), 'inventory-label-'));
    try {
      const path = join(folder, 'label.svg');
      await writeFile(path, artifact.svg, 'utf8');
      const saved = await readFile(path, 'utf8');
      expect(saved).toBe(artifact.svg);
      const { data, info } = await pixels(saved);
      const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height, {
        inversionAttempts: 'dontInvert',
      });
      expect(decoded?.binaryData).toEqual(
        Array.from(value, (character) => character.charCodeAt(0))
      );
      const profile = await pixels(saved, artifact.media);
      const profileDecoded = jsQR(
        new Uint8ClampedArray(profile.data),
        profile.info.width,
        profile.info.height,
        { inversionAttempts: 'dontInvert' }
      );
      expect(profileDecoded?.binaryData).toEqual(
        Array.from(value, (character) => character.charCodeAt(0))
      );
      expect(artifact.humanText.find((field) => field.role === 'code')?.text).toBe(value);
      expect(
        artifact.humanText
          .find((field) => field.role === 'code')
          ?.lines.map((line) => line.text)
          .join('')
      ).toBe(`Code: ${JSON.stringify(value)}`);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it.each(['qr-50x30-300dpi', 'qr-80x50-300dpi'] as const)(
    'keeps black geometry, full text and four clear modules inside %s',
    async (mediaProfileId) => {
      const artifact = rendered({ ...fixture(), mediaProfileId });
      const { symbol, media } = artifact;
      expect(artifact.svg).toContain(`width="${media.widthMm}mm" height="${media.heightMm}mm"`);
      expect(artifact.svg).not.toMatch(/<text|<image|<script|<foreignObject|font-|href=|url\(|<!/i);
      expect(symbol.sizeDots).toBe(symbol.modules * 4);
      expect((symbol.modules - 21) % 4).toBe(0);
      for (const coordinate of [symbol.xDots, symbol.yDots, symbol.sizeDots])
        expect(Number.isInteger(coordinate)).toBe(true);
      const { data, info } = await pixels(artifact.svg);
      const white = (x: number, y: number) =>
        Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4));
      const pixelScaleX = info.width / media.widthDots;
      const pixelScaleY = info.height / media.heightDots;
      const quiet = symbol.quietZoneModules * symbol.dotsPerModule;
      for (
        let y = Math.ceil((symbol.yDots - quiet) * pixelScaleY);
        y < Math.floor((symbol.yDots + symbol.sizeDots + quiet) * pixelScaleY);
        y += 1
      ) {
        for (
          let x = Math.ceil((symbol.xDots - quiet) * pixelScaleX);
          x < Math.floor((symbol.xDots + symbol.sizeDots + quiet) * pixelScaleX);
          x += 1
        ) {
          if (
            x < Math.floor(symbol.xDots * pixelScaleX) ||
            y < Math.floor(symbol.yDots * pixelScaleY) ||
            x >= Math.ceil((symbol.xDots + symbol.sizeDots) * pixelScaleX) ||
            y >= Math.ceil((symbol.yDots + symbol.sizeDots) * pixelScaleY)
          ) {
            expect(white(x, y), `${x},${y} raster ${info.width}x${info.height}`).toEqual([
              255, 255, 255, 255,
            ]);
          }
        }
      }
      for (const field of artifact.humanText) {
        for (const line of field.lines) {
          expect(line.xDots + line.widthDots).toBeLessThanOrEqual(Math.floor(media.widthDots) - 12);
          expect(line.baselineDots + inventoryLabelFont.descentDots).toBeLessThanOrEqual(
            Math.floor(media.heightDots) - 12
          );
        }
      }
    }
  );

  it('fails independent decode when the actual SVG symbol geometry is erased', async () => {
    const artifact = rendered();
    const { xDots, yDots, sizeDots } = artifact.symbol;
    const damaged = artifact.svg.replace(
      '</svg>',
      `<rect x="${xDots}" y="${yDots}" width="${sizeDots}" height="${sizeDots}" fill="#FFFFFF"/></svg>`
    );
    const { data, info } = await pixels(damaged);
    expect(
      jsQR(new Uint8ClampedArray(data), info.width, info.height, {
        inversionAttempts: 'dontInvert',
      })
    ).toBeNull();
  });

  it('refuses overflow without shrinking, truncating, changing payload or choosing another media profile', () => {
    const small = fixture('x'.repeat(140));
    expect(renderInventoryItemLabel(small)).toMatchObject({
      kind: 'refused',
      code: 'LAYOUT_OVERFLOW',
    });
    expect(renderInventoryItemLabel({ ...small, mediaProfileId: 'qr-80x50-300dpi' })).toMatchObject(
      { kind: 'rendered' }
    );
    expect(renderInventoryItemLabel(fixture('x'.repeat(512)))).toMatchObject({
      kind: 'refused',
      code: 'LAYOUT_OVERFLOW',
    });
    expect(
      renderInventoryItemLabel({
        ...small,
        binding: { ...small.binding, item: { kind: 'vessel', id: 'x'.repeat(500) } },
      })
    ).toMatchObject({ kind: 'refused', code: 'LAYOUT_OVERFLOW' });
  });

  it.each(['β', '😀', '\n', '\r', '\0', '\x7f'])(
    'refuses unsupported mandatory text %j',
    (value) => {
      expect(renderInventoryItemLabel(fixture(`001${value}`))).toMatchObject({
        kind: 'refused',
        code: 'UNSUPPORTED_TEXT',
      });
      const spec = fixture();
      expect(
        renderInventoryItemLabel({
          ...spec,
          binding: { ...spec.binding, item: { kind: 'vessel', id: `tube${value}1` } },
        })
      ).toMatchObject({ kind: 'refused' });
    }
  );

  it('does not accept encoder settings or invalid scope/revision/profile/namespace', () => {
    for (const spec of [
      { ...fixture(), parse: true },
      { ...fixture(), sourceRevision: -1 },
      { ...fixture(), sourceRevision: NaN },
      { ...fixture(), sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...fixture(), mediaProfileId: 'custom' },
      { ...fixture(), scope: { projectId: '', inventoryId: 'lab' } },
      { ...fixture(), binding: { ...fixture().binding, namespace: 'bad\n' } },
      { ...fixture(), binding: { ...fixture().binding, value: ' '.repeat(10) } },
    ])
      expect(renderInventoryItemLabel(spec as InventoryLabelSpec)).toMatchObject({
        kind: 'refused',
        code: 'INVALID_SPEC',
      });
  });

  it('snapshots immutable deterministic artifact facts independently of caller mutation', () => {
    const spec = fixture();
    const before = JSON.stringify(spec);
    const artifact = rendered(spec);
    expect(JSON.stringify(spec)).toBe(before);
    expect(rendered(spec)).toEqual(artifact);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.spec.binding.item)).toBe(true);
    expect(artifact.spec).not.toBe(spec);
    expect(artifact.spec.binding).not.toBe(spec.binding);
    expect(artifact.template).toBe('dnaforge.inventory-label.qr.v1');
    expect(artifact.encoder).toEqual({ name: 'qrcode', version: '1.5.4' });
    expect(artifact.font.name).toBe('DNAForgeInventoryLabelAscii');
    expect(artifact.humanText.find((field) => field.role === 'target')?.text).toBe('vessel:tube-1');
  });
});
